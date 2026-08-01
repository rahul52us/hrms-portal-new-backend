import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import AttendancePolicy from "../schemas/WorkforcePolicy/AttendancePolicy.schema";
import AttendancePolicyVersion from "../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import WorkSchedule from "../schemas/WorkforcePolicy/WorkSchedule.schema";
import WorkScheduleVersion, {
  WorkScheduleRules,
  WORK_SCHEDULE_DAYS,
  WORK_SCHEDULE_SATURDAY_RULES,
} from "../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import WorkforcePolicyAssignment from "../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import WorkforcePolicyAuditLog from "../schemas/WorkforcePolicy/WorkforcePolicyAuditLog.schema";
import { isDateRangeOverlapping } from "../services/workforcePolicy/workforcePolicy.utils";

const applyChanges = process.argv.includes("--apply");

const legacyScheduleQuery = {
  $or: [
    { "rules.timezone": { $exists: true } },
    { "rules.workingDays": { $exists: true } },
    { "rules.saturdayRule": { $exists: true } },
    { "rules.customSaturdayOffWeeks": { $exists: true } },
    { "rules.alternateSaturdayAnchorDate": { $exists: true } },
    { "rules.officeStartTime": { $exists: true } },
    { "rules.officeEndTime": { $exists: true } },
  ],
};

const legacyScheduleFields = {
  "rules.timezone": "",
  "rules.workingDays": "",
  "rules.saturdayRule": "",
  "rules.customSaturdayOffWeeks": "",
  "rules.alternateSaturdayAnchorDate": "",
  "rules.officeStartTime": "",
  "rules.officeEndTime": "",
};

function normalizeScheduleRules(rules: any): WorkScheduleRules {
  const sourceDays = Array.isArray(rules?.workingDays)
    ? Array.from(new Set<string>(rules.workingDays.map(String)))
    : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const workingDays = sourceDays.filter(
    (day) => day !== "Saturday" && WORK_SCHEDULE_DAYS.includes(day as any)
  );
  const legacySaturdayRule = String(rules?.saturdayRule || "");
  const saturdayRuleAliases: Record<string, WorkScheduleRules["saturdayRule"]> = {
    alternate_from_anchor: "second_and_fourth_off",
    alternate: "second_and_fourth_off",
    every_other: "second_and_fourth_off",
    all_working: "working",
  };
  const mappedSaturdayRule = saturdayRuleAliases[legacySaturdayRule] || legacySaturdayRule;
  const saturdayRule = WORK_SCHEDULE_SATURDAY_RULES.includes(mappedSaturdayRule as any)
    ? (mappedSaturdayRule as WorkScheduleRules["saturdayRule"])
    : sourceDays.includes("Saturday")
      ? "working"
      : "all_off";
  const customSaturdayOffWeeks =
    saturdayRule === "custom_weeks_off" && Array.isArray(rules?.customSaturdayOffWeeks)
      ? Array.from(
          new Set<number>(
            rules.customSaturdayOffWeeks
              .map(Number)
              .filter((week: number) => Number.isInteger(week) && week >= 1 && week <= 5)
          )
        ).sort((left, right) => left - right)
      : [];

  return {
    timezone: String(rules?.timezone || "Asia/Kolkata"),
    workingDays,
    saturdayRule,
    customSaturdayOffWeeks,
    startTime: String(rules?.officeStartTime || "09:30"),
    endTime: String(rules?.officeEndTime || "18:30"),
    unpaidBreakMinutes: 60,
  };
}

async function nextScheduleCode(company: mongoose.Types.ObjectId, policyCode: string) {
  const base = `${policyCode || "ATTENDANCE"}-WS`
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let candidate = base;
  let suffix = 2;
  while (await WorkSchedule.exists({ company, code: candidate })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function writeMigrationAudit(options: {
  company: mongoose.Types.ObjectId;
  entityType: "attendance_version" | "work_schedule" | "work_schedule_version" | "assignment";
  entityId: mongoose.Types.ObjectId;
  actor: mongoose.Types.ObjectId;
  details: Record<string, unknown>;
}) {
  await WorkforcePolicyAuditLog.create({
    ...options,
    action: "migrated_attendance_schedule_split",
  });
}

async function migrate() {
  await connectToDatabase();

  const legacyVersions = await AttendancePolicyVersion.collection
    .find(legacyScheduleQuery)
    .sort({ company: 1, policy: 1, versionNumber: 1 })
    .toArray();
  const policyIds = Array.from(
    new Set(legacyVersions.map((version) => String(version.policy)))
  ).map((id) => new mongoose.Types.ObjectId(id));
  const policies = await AttendancePolicy.find({ _id: { $in: policyIds } }).lean();
  if (policies.length !== policyIds.length) {
    const foundPolicyIds = new Set(policies.map((policy) => String(policy._id)));
    const missingPolicyIds = policyIds.filter((policyId) => !foundPolicyIds.has(String(policyId)));
    throw new Error(
      `Cannot migrate orphan attendance versions. Missing policies: ${missingPolicyIds.join(", ")}`
    );
  }
  const assignments = policyIds.length
    ? await WorkforcePolicyAssignment.find({
        resourceType: "attendance_policy",
        resource: { $in: policyIds },
      }).lean()
    : [];

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} attendance schedule split: ` +
      `${policies.length} policies, ${legacyVersions.length} versions, ${assignments.length} assignments.`
  );
  if (!applyChanges || legacyVersions.length === 0) {
    if (!applyChanges && legacyVersions.length > 0) {
      console.log("No data changed. Run again with --apply to perform the migration.");
    }
    return;
  }

  let schedulesCreated = 0;
  let versionsCreated = 0;
  let assignmentsCreated = 0;

  for (const policy of policies) {
    const company = policy.company as mongoose.Types.ObjectId;
    const policyId = policy._id as mongoose.Types.ObjectId;
    const policyVersions = legacyVersions.filter(
      (version) => String(version.policy) === String(policyId)
    );
    const policyAssignments = assignments.filter(
      (assignment) => String(assignment.resource) === String(policyId)
    );
    const actor = policy.createdBy || policyVersions[0]?.createdBy;
    if (!actor) throw new Error(`Attendance policy ${policyId} has no migration actor`);

    let schedule = await WorkSchedule.findOne({
      company,
      sourceAttendancePolicy: policyId,
    }).select("+sourceAttendancePolicy");
    if (!schedule) {
      schedule = await WorkSchedule.create({
        company,
        name: `${policy.name} Work Schedule`,
        code: await nextScheduleCode(company, policy.code),
        description: `Schedule migrated from attendance policy ${policy.name}.`,
        status: policy.status,
        latestVersionNumber: Math.max(
          0,
          ...policyVersions.map((version) => Number(version.versionNumber || 0))
        ),
        createdBy: actor,
        sourceAttendancePolicy: policyId,
        archivedAt: policy.archivedAt || null,
        archivedBy: policy.archivedBy || null,
        archiveReason: policy.archiveReason,
      });
      schedulesCreated += 1;
      await writeMigrationAudit({
        company,
        entityType: "work_schedule",
        entityId: schedule._id as mongoose.Types.ObjectId,
        actor,
        details: { sourceAttendancePolicy: policyId },
      });
    }

    for (const sourceVersion of policyVersions) {
      let scheduleVersion = await WorkScheduleVersion.findOne({
        company,
        schedule: schedule._id,
        versionNumber: sourceVersion.versionNumber,
      });
      if (!scheduleVersion) {
        scheduleVersion = await WorkScheduleVersion.create({
          company,
          schedule: schedule._id,
          versionNumber: sourceVersion.versionNumber,
          status: sourceVersion.status,
          effectiveFrom: sourceVersion.effectiveFrom || null,
          changeReason: sourceVersion.changeReason
            ? `Migrated: ${sourceVersion.changeReason}`
            : "Migrated from attendance policy schedule settings",
          rules: normalizeScheduleRules(sourceVersion.rules),
          createdBy: sourceVersion.createdBy || actor,
          publishedAt: sourceVersion.publishedAt || null,
          publishedBy: sourceVersion.publishedBy || null,
        });
        versionsCreated += 1;
        await writeMigrationAudit({
          company,
          entityType: "work_schedule_version",
          entityId: scheduleVersion._id as mongoose.Types.ObjectId,
          actor: sourceVersion.createdBy || actor,
          details: {
            sourceAttendancePolicy: policyId,
            sourceAttendanceVersion: sourceVersion._id,
          },
        });
      }
    }

    for (const sourceAssignment of policyAssignments) {
      const exactAssignment = await WorkforcePolicyAssignment.findOne({
        company,
        resourceType: "work_schedule",
        resource: schedule._id,
        scopeType: sourceAssignment.scopeType,
        scopeId: sourceAssignment.scopeId || null,
        effectiveFrom: sourceAssignment.effectiveFrom,
        effectiveTo: sourceAssignment.effectiveTo || null,
      });
      if (exactAssignment) continue;

      const sameScopeAssignments = await WorkforcePolicyAssignment.find({
        company,
        resourceType: "work_schedule",
        scopeType: sourceAssignment.scopeType,
        scopeId: sourceAssignment.scopeId || null,
      })
        .select("effectiveFrom effectiveTo")
        .lean();
      const conflict = sameScopeAssignments.find((candidate) =>
        isDateRangeOverlapping({
          existingStart: new Date(candidate.effectiveFrom),
          existingEnd: candidate.effectiveTo ? new Date(candidate.effectiveTo) : null,
          requestedStart: new Date(sourceAssignment.effectiveFrom),
          requestedEnd: sourceAssignment.effectiveTo
            ? new Date(sourceAssignment.effectiveTo)
            : null,
        })
      );
      if (conflict) {
        throw new Error(
          `Cannot migrate assignment ${sourceAssignment._id}: overlapping work schedule assignment ${conflict._id}`
        );
      }

      const assignment = await WorkforcePolicyAssignment.create({
        company,
        resourceType: "work_schedule",
        resourceModel: "WorkSchedule",
        resource: schedule._id,
        scopeType: sourceAssignment.scopeType,
        scopeId: sourceAssignment.scopeId || null,
        scopeNameSnapshot: sourceAssignment.scopeNameSnapshot,
        priority: sourceAssignment.priority,
        effectiveFrom: sourceAssignment.effectiveFrom,
        effectiveTo: sourceAssignment.effectiveTo || null,
        changeReason: `Migrated with attendance schedule split: ${sourceAssignment.changeReason}`,
        createdBy: sourceAssignment.createdBy || actor,
        endedBy: sourceAssignment.endedBy || null,
        endedAt: sourceAssignment.endedAt || null,
        endReason: sourceAssignment.endReason,
      });
      assignmentsCreated += 1;
      await writeMigrationAudit({
        company,
        entityType: "assignment",
        entityId: assignment._id as mongoose.Types.ObjectId,
        actor: sourceAssignment.createdBy || actor,
        details: {
          sourceAttendanceAssignment: sourceAssignment._id,
          workSchedule: schedule._id,
        },
      });
    }

    await AttendancePolicyVersion.collection.updateMany(
      { _id: { $in: policyVersions.map((version) => version._id) } },
      { $unset: legacyScheduleFields }
    );
    await WorkforcePolicyAuditLog.insertMany(
      policyVersions.map((version) => ({
        company,
        entityType: "attendance_version",
        entityId: version._id,
        action: "migrated_attendance_schedule_split",
        actor: version.createdBy || actor,
        details: { workSchedule: schedule!._id },
      }))
    );
  }

  console.log(
    `Migration complete. Created ${schedulesCreated} schedules, ${versionsCreated} versions, ` +
      `${assignmentsCreated} assignments; cleaned ${legacyVersions.length} attendance versions.`
  );
}

migrate()
  .catch((error) => {
    console.error("Attendance schedule migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
