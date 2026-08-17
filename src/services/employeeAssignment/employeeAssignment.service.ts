import mongoose, { ClientSession } from "mongoose";
import Department from "../../schemas/Department/Department.schema";
import EmployeeAssignmentHistory from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import User from "../../schemas/User/User";

export type EmployeeAssignmentSnapshot = {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  department?: mongoose.Types.ObjectId;
  departmentNameSnapshot: string;
  teamId?: mongoose.Types.ObjectId;
  teamNameSnapshot: string;
  officeLocation?: mongoose.Types.ObjectId;
  officeLocationNameSnapshot: string;
  designationSnapshot: string;
  reportingManager?: mongoose.Types.ObjectId;
  reportingManagerNameSnapshot: string;
  roleSnapshot: string;
  isDepartmentHead: boolean;
};

type SnapshotContext = {
  department?: any | null;
  team?: any | null;
  officeLocation?: any | null;
  reportingManager?: any | null;
};

const normalizeText = (value: unknown) => String(value || "").trim();

const normalizeRole = (value: unknown) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead");

const normalizeObjectId = (value: any) => {
  const normalized = String(value?._id || value || "").trim();
  return mongoose.Types.ObjectId.isValid(normalized)
    ? new mongoose.Types.ObjectId(normalized)
    : undefined;
};

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const withSession = <T>(query: any, session?: ClientSession): Promise<T> =>
  (session ? query.session(session) : query) as Promise<T>;

const findTeam = (department: any, teamName: string) =>
  (Array.isArray(department?.teams) ? department.teams : []).find(
    (team: any) =>
      normalizeText(team?.name).toLowerCase() === normalizeText(teamName).toLowerCase()
  );

export async function buildEmployeeAssignmentSnapshot(
  user: any,
  options: { session?: ClientSession; context?: SnapshotContext } = {}
): Promise<EmployeeAssignmentSnapshot> {
  const company = normalizeObjectId(user?.company);
  const employee = normalizeObjectId(user?._id);

  if (!company || !employee) {
    throw new Error("Employee assignment requires company and employee ids");
  }

  const departmentName = normalizeText(user?.department);
  let department =
    options.context && Object.prototype.hasOwnProperty.call(options.context, "department")
      ? options.context.department
      : null;

  if (!department && departmentName) {
    department = await withSession<any>(
      Department.findOne({
        company,
        departmentName: {
          $regex: new RegExp(`^${escapeRegex(departmentName)}$`, "i"),
        },
      }).lean(),
      options.session
    );
  }

  const teamName = normalizeText(user?.team);
  const team =
    options.context && Object.prototype.hasOwnProperty.call(options.context, "team")
      ? options.context.team
      : findTeam(department, teamName);

  const officeLocationId = normalizeObjectId(user?.officeLocation);
  let officeLocation =
    options.context && Object.prototype.hasOwnProperty.call(options.context, "officeLocation")
      ? options.context.officeLocation
      : null;

  if (!officeLocation && officeLocationId) {
    officeLocation = await withSession<any>(
      OfficeLocation.findOne({ _id: officeLocationId, company })
        .select("name code")
        .lean(),
      options.session
    );
  }

  const reportingManagerId = normalizeObjectId(user?.reportingManager);
  let reportingManager =
    options.context && Object.prototype.hasOwnProperty.call(options.context, "reportingManager")
      ? options.context.reportingManager
      : null;

  if (!reportingManager && reportingManagerId) {
    reportingManager = await withSession<any>(
      User.findOne({ _id: reportingManagerId, company })
        .select("name username")
        .lean(),
      options.session
    );
  }

  const role = normalizeRole(user?.role);

  return {
    company,
    employee,
    department: normalizeObjectId(department),
    departmentNameSnapshot:
      normalizeText(department?.departmentName) || departmentName,
    teamId: normalizeObjectId(team),
    teamNameSnapshot: normalizeText(team?.name) || teamName,
    officeLocation: officeLocationId,
    officeLocationNameSnapshot:
      normalizeText(officeLocation?.name) || normalizeText(officeLocation?.code),
    designationSnapshot: normalizeText(user?.designation),
    reportingManager: reportingManagerId,
    reportingManagerNameSnapshot:
      normalizeText(reportingManager?.name) ||
      normalizeText(reportingManager?.username),
    roleSnapshot: role,
    isDepartmentHead: role === "departmenthead",
  };
}

const snapshotKey = (snapshot: EmployeeAssignmentSnapshot) =>
  JSON.stringify({
    department: String(snapshot.department || ""),
    departmentName: snapshot.departmentNameSnapshot.toLowerCase(),
    teamId: String(snapshot.teamId || ""),
    teamName: snapshot.teamNameSnapshot.toLowerCase(),
    officeLocation: String(snapshot.officeLocation || ""),
    designation: snapshot.designationSnapshot.toLowerCase(),
    reportingManager: String(snapshot.reportingManager || ""),
    role: snapshot.roleSnapshot,
    isDepartmentHead: snapshot.isDepartmentHead,
  });

const inferChangeType = (
  previous: EmployeeAssignmentSnapshot | null,
  next: EmployeeAssignmentSnapshot
) => {
  if (!previous) return "initial_assignment";
  if (String(previous.department || "") !== String(next.department || "")) {
    return "department_transfer";
  }
  if (
    String(previous.teamId || "") !== String(next.teamId || "") ||
    previous.teamNameSnapshot !== next.teamNameSnapshot
  ) {
    return "team_change";
  }
  if (String(previous.officeLocation || "") !== String(next.officeLocation || "")) {
    return "location_change";
  }
  if (String(previous.reportingManager || "") !== String(next.reportingManager || "")) {
    return "manager_change";
  }
  if (previous.designationSnapshot !== next.designationSnapshot) {
    return "designation_change";
  }
  if (previous.isDepartmentHead !== next.isDepartmentHead) {
    return "department_head_change";
  }
  return "assignment_update";
};

const serializeSnapshot = (snapshot: EmployeeAssignmentSnapshot) => ({
  company: snapshot.company,
  employee: snapshot.employee,
  department: snapshot.department || null,
  departmentNameSnapshot: snapshot.departmentNameSnapshot,
  teamId: snapshot.teamId || null,
  teamNameSnapshot: snapshot.teamNameSnapshot,
  officeLocation: snapshot.officeLocation || null,
  officeLocationNameSnapshot: snapshot.officeLocationNameSnapshot,
  designationSnapshot: snapshot.designationSnapshot,
  reportingManager: snapshot.reportingManager || null,
  reportingManagerNameSnapshot: snapshot.reportingManagerNameSnapshot,
  roleSnapshot: snapshot.roleSnapshot,
  isDepartmentHead: snapshot.isDepartmentHead,
});

export async function recordEmployeeAssignmentChange(options: {
  user: any;
  previousUser?: any | null;
  previousSnapshot?: EmployeeAssignmentSnapshot | null;
  nextSnapshot?: EmployeeAssignmentSnapshot;
  changedBy?: string;
  changeReason?: string;
  changeType?: string;
  changeBatchId?: string;
  source?: string;
  effectiveAt?: Date;
  session?: ClientSession;
}) {
  const effectiveAt = options.effectiveAt || new Date();
  const nextSnapshot =
    options.nextSnapshot ||
    (await buildEmployeeAssignmentSnapshot(options.user, {
      session: options.session,
    }));
  const previousSnapshot =
    options.previousSnapshot !== undefined
      ? options.previousSnapshot
      : options.previousUser
        ? await buildEmployeeAssignmentSnapshot(options.previousUser, {
            session: options.session,
          })
        : null;

  let currentQuery = EmployeeAssignmentHistory.findOne({
    company: nextSnapshot.company,
    employee: nextSnapshot.employee,
    isCurrent: true,
  });
  if (options.session) currentQuery = currentQuery.session(options.session);
  const current = await currentQuery;

  if (current) {
    const currentSnapshot: EmployeeAssignmentSnapshot = {
      company: current.company,
      employee: current.employee,
      department: current.department || undefined,
      departmentNameSnapshot: current.departmentNameSnapshot || "",
      teamId: current.teamId || undefined,
      teamNameSnapshot: current.teamNameSnapshot || "",
      officeLocation: current.officeLocation || undefined,
      officeLocationNameSnapshot: current.officeLocationNameSnapshot || "",
      designationSnapshot: current.designationSnapshot || "",
      reportingManager: current.reportingManager || undefined,
      reportingManagerNameSnapshot: current.reportingManagerNameSnapshot || "",
      roleSnapshot: current.roleSnapshot || "",
      isDepartmentHead: Boolean(current.isDepartmentHead),
    };

    if (snapshotKey(currentSnapshot) === snapshotKey(nextSnapshot)) {
      return current;
    }

    current.isCurrent = false;
    current.effectiveTo = effectiveAt;
    current.endChangeType =
      options.changeType || inferChangeType(currentSnapshot, nextSnapshot);
    current.endReason = normalizeText(options.changeReason);
    current.endedBy = normalizeObjectId(options.changedBy);
    await current.save({ session: options.session });
  } else if (
    previousSnapshot &&
    snapshotKey(previousSnapshot) !== snapshotKey(nextSnapshot)
  ) {
    await EmployeeAssignmentHistory.create(
      [
        {
          ...serializeSnapshot(previousSnapshot),
          effectiveFrom:
            options.previousUser?.joiningDate ||
            options.previousUser?.createdAt ||
            effectiveAt,
          effectiveTo: effectiveAt,
          isCurrent: false,
          changeType: "initial_assignment",
          endChangeType:
            options.changeType || inferChangeType(previousSnapshot, nextSnapshot),
          endReason: normalizeText(options.changeReason),
          endedBy: normalizeObjectId(options.changedBy),
          changedBy: normalizeObjectId(options.changedBy),
          changeBatchId: normalizeText(options.changeBatchId),
          source: normalizeText(options.source),
        },
      ],
      { session: options.session }
    );
  }

  const baseline = current
    ? ({
        company: current.company,
        employee: current.employee,
        department: current.department || undefined,
        departmentNameSnapshot: current.departmentNameSnapshot || "",
        teamId: current.teamId || undefined,
        teamNameSnapshot: current.teamNameSnapshot || "",
        officeLocation: current.officeLocation || undefined,
        officeLocationNameSnapshot: current.officeLocationNameSnapshot || "",
        designationSnapshot: current.designationSnapshot || "",
        reportingManager: current.reportingManager || undefined,
        reportingManagerNameSnapshot: current.reportingManagerNameSnapshot || "",
        roleSnapshot: current.roleSnapshot || "",
        isDepartmentHead: Boolean(current.isDepartmentHead),
      } as EmployeeAssignmentSnapshot)
    : previousSnapshot;

  const [created] = await EmployeeAssignmentHistory.create(
    [
      {
        ...serializeSnapshot(nextSnapshot),
        effectiveFrom:
          !baseline && options.user?.joiningDate
            ? options.user.joiningDate
            : effectiveAt,
        effectiveTo: null,
        isCurrent: true,
        changeType:
          options.changeType || inferChangeType(baseline || null, nextSnapshot),
        changeReason: normalizeText(options.changeReason),
        changedBy: normalizeObjectId(options.changedBy),
        changeBatchId: normalizeText(options.changeBatchId),
        source: normalizeText(options.source),
      },
    ],
    { session: options.session }
  );

  return created;
}

export async function ensureCurrentEmployeeAssignment(options: {
  user: any;
  changedBy?: string;
  source?: string;
  session?: ClientSession;
}) {
  const employeeId = normalizeObjectId(options.user?._id);
  const companyId = normalizeObjectId(options.user?.company);
  if (!employeeId || !companyId) return null;

  let existingQuery = EmployeeAssignmentHistory.findOne({
    company: companyId,
    employee: employeeId,
    isCurrent: true,
  });
  if (options.session) existingQuery = existingQuery.session(options.session);
  const existing = await existingQuery;
  if (existing) return existing;

  try {
    return await recordEmployeeAssignmentChange({
      user: options.user,
      changedBy: options.changedBy,
      changeType: "initial_assignment",
      changeReason: "Initial HRMS assignment history",
      source: options.source || "history_backfill",
      effectiveAt:
        options.user?.joiningDate || options.user?.createdAt || new Date(),
      session: options.session,
    });
  } catch (error: any) {
    if (error?.code !== 11000) throw error;

    let concurrentQuery = EmployeeAssignmentHistory.findOne({
      company: companyId,
      employee: employeeId,
      isCurrent: true,
    });
    if (options.session) concurrentQuery = concurrentQuery.session(options.session);
    const concurrent = await concurrentQuery;
    if (concurrent) return concurrent;
    throw error;
  }
}

export async function closeCurrentEmployeeAssignment(options: {
  employeeId: string;
  companyId: string;
  changedBy?: string;
  endChangeType: string;
  endReason?: string;
  effectiveAt?: Date;
  session?: ClientSession;
}) {
  const update = {
    $set: {
      isCurrent: false,
      effectiveTo: options.effectiveAt || new Date(),
      endChangeType: normalizeText(options.endChangeType),
      endReason: normalizeText(options.endReason),
      endedBy: normalizeObjectId(options.changedBy),
    },
  };

  const query = EmployeeAssignmentHistory.findOneAndUpdate(
    {
      company: normalizeObjectId(options.companyId),
      employee: normalizeObjectId(options.employeeId),
      isCurrent: true,
    },
    update,
    { new: true }
  );

  return options.session ? query.session(options.session) : query;
}

export async function getEmployeeAssignmentHistory(options: {
  employeeId: string;
  companyId: string;
}) {
  return EmployeeAssignmentHistory.find({
    company: normalizeObjectId(options.companyId),
    employee: normalizeObjectId(options.employeeId),
  })
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .populate("changedBy", "name username")
    .populate("endedBy", "name username")
    .lean();
}
