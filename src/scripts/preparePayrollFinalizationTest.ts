import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import EmployeePayrollResult from "../schemas/Payroll/EmployeePayrollResult.schema";
import EmployeeCompensationAssignment from "../schemas/Payroll/EmployeeCompensationAssignment.schema";
import PayrollRun from "../schemas/Payroll/PayrollRun.schema";
import SalaryStructure from "../schemas/Payroll/SalaryStructure.schema";
import SalaryStructureVersion from "../schemas/Payroll/SalaryStructureVersion.schema";
import User from "../schemas/User/User";
import Company from "../schemas/company/Company";
import {
  buildCompensationSnapshot,
} from "../services/payroll/employeeCompensation.service";
import { calculateDraftPayrollService } from "../services/payroll/payrollCalculation.service";
import { preparePayrollEmployeeSnapshotsService } from "../services/payroll/payrollEmployeeSnapshot.service";
import { decidePayrollValidationIssueService } from "../services/payroll/payrollValidation.service";
import { payrollReviewBlockers } from "../services/payroll/payrollRunReview.service";
import { writePayrollAudit } from "../services/payroll/payroll.utils";

const applyChanges = process.argv.includes("--apply");
const acknowledgeWarnings = process.argv.includes("--acknowledge-warnings");
const REASON = "Development payroll finalization test-data preparation";

function argument(name: string) {
  const prefix = `--${name}=`;
  return String(process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "").trim();
}

function positionalArguments() {
  return process.argv.slice(2).filter((value) => !value.startsWith("--"));
}

function formatMoney(amountMinor: number, currency: string, minorUnits: number) {
  return `${currency} ${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  }).format(amountMinor / 10 ** minorUnits)}`;
}

function dateKey(value: unknown) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function objectId(value: unknown, label: string) {
  const normalized = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw new Error(`Invalid ${label}: ${normalized}`);
  return new mongoose.Types.ObjectId(normalized);
}

function companyQuery(value: string) {
  return mongoose.Types.ObjectId.isValid(value)
    ? { _id: new mongoose.Types.ObjectId(value) }
    : { companyCode: value.toUpperCase() };
}

function warningReason(issue: any) {
  if (issue.code === "approved_overtime_requires_amount") {
    return "Test payroll only: acknowledge overtime without adding a monetary amount";
  }
  if (issue.code === "missing_bank_details") {
    return "Test payroll only: acknowledge missing bank details before payout setup";
  }
  if (issue.code === "missing_pan") {
    return "Test payroll only: acknowledge missing PAN before statutory filing setup";
  }
  return `Test payroll only: acknowledge ${String(issue.message || issue.code).slice(0, 420)}`;
}

async function invokeService(service: any, req: any) {
  let payload: any;
  let failure: any;
  const res: any = {
    statusCode: 200,
    status(value: number) {
      this.statusCode = value;
      return this;
    },
    json(value: any) {
      payload = value;
      return value;
    },
  };
  await service(req, res, (error: any) => {
    failure = error;
  });
  if (failure) throw failure;
  return payload;
}

async function resolveTarget() {
  const positional = positionalArguments();
  const companyInput = argument("company") || positional[0] || "";
  const periodKey = argument("period") || positional[1] || "2026-09";
  if (!companyInput) throw new Error("Pass --company=<company id or code>");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) throw new Error("Period must use YYYY-MM");

  const company: any = await Company.findOne(companyQuery(companyInput))
    .select("_id company_name companyCode")
    .lean();
  if (!company) throw new Error("Company was not found");
  const run: any = await PayrollRun.findOne({ company: company._id, periodKey }).lean();
  if (!run) throw new Error(`Payroll run ${periodKey} was not found for ${company.companyCode}`);
  if (run.status !== "draft") {
    throw new Error(`Payroll run must be draft for preparation; current status is ${run.status}`);
  }

  const actorInput = argument("actor").toLowerCase();
  const actorQuery: any = {
    company: company._id,
    role: { $in: ["admin", "hradmin"] },
    is_enabled: true,
    deletedAt: null,
  };
  if (actorInput) actorQuery.username = actorInput;
  const actor: any = await User.findOne(actorQuery)
    .sort({ role: 1, createdAt: 1 })
    .select("_id name username code role company permissions")
    .lean();
  if (!actor) throw new Error("An enabled Company Admin or HR Admin is required as the audit actor");
  return { company, run, actor, periodKey };
}

async function currentResults(run: any) {
  return EmployeePayrollResult.find({
    company: run.company,
    payrollRun: run._id,
    calculationVersion: run.calculationVersion,
  }).sort({ "identity.code": 1 }).lean();
}

async function resolveStructureVersion(company: mongoose.Types.ObjectId, cycleEndDate: string) {
  const requested = argument("structure-version");
  const match: any = {
    company,
    status: "published",
    effectiveFrom: { $lte: new Date(`${cycleEndDate}T23:59:59.999Z`) },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: new Date(`${cycleEndDate}T00:00:00.000Z`) } }],
  };
  if (requested) match._id = objectId(requested, "salary structure version id");
  const versions: any[] = await SalaryStructureVersion.find(match).sort({ effectiveFrom: -1 }).lean();
  const activeVersions: Array<{ version: any; structure: any }> = [];
  for (const version of versions) {
    const structure: any = await SalaryStructure.findOne({
      _id: version.salaryStructure,
      company,
      status: "active",
    }).lean();
    if (structure) activeVersions.push({ version, structure });
  }
  if (!activeVersions.length) throw new Error(`No published salary structure is effective on ${cycleEndDate}`);
  if (!requested && activeVersions.length > 1) {
    throw new Error(`Multiple salary structures are effective; pass --structure-version=<id>: ${activeVersions.map((item) => `${item.structure.code}=${item.version._id}`).join(", ")}`);
  }
  return activeVersions[0];
}

function compatibleOverrides(version: any, futureAssignment: any) {
  if (!futureAssignment || String(futureAssignment.salaryStructureVersion) !== String(version._id)) return [];
  const allowed = new Set((version.rules || []).filter((rule: any) => rule.allowEmployeeOverride).map((rule: any) => String(rule.salaryComponent)));
  return (futureAssignment.overrides || [])
    .filter((override: any) => allowed.has(String(override.salaryComponent)))
    .map((override: any) => ({
      salaryComponentId: override.salaryComponent,
      monthlyAmountMinor: Number(override.monthlyAmountMinor),
    }));
}

async function buildPlans(options: {
  company: any;
  run: any;
  results: any[];
  version: any;
  structure: any;
}) {
  const missingResultIds = new Set(
    options.results
      .filter((result) => (result.issues || []).some((issue: any) => issue.severity === "error" && issue.code === "missing_compensation_assignment"))
      .map((result) => String(result.employee))
  );
  const employees: any[] = await User.find({
    _id: { $in: [...missingResultIds].map((value) => objectId(value, "employee id")) },
    company: options.company._id,
    deletedAt: null,
  }).select("_id name username code joiningDate employmentEndDate").lean();
  const plans = [];
  for (const employee of employees) {
    const current = await EmployeeCompensationAssignment.findOne({
      company: options.company._id,
      employee: employee._id,
      status: "assigned",
      effectiveFrom: { $lte: new Date(`${options.run.cycleEndDate}T23:59:59.999Z`) },
    }).sort({ effectiveFrom: -1 }).lean();
    if (current) continue;
    const future: any = await EmployeeCompensationAssignment.findOne({
      company: options.company._id,
      employee: employee._id,
      status: "assigned",
      effectiveFrom: { $gt: new Date(`${options.run.cycleEndDate}T23:59:59.999Z`) },
    }).sort({ effectiveFrom: 1 }).lean();
    const effectiveFromCandidates = [
      dateKey(options.version.effectiveFrom),
      dateKey(employee.joiningDate),
    ].filter(Boolean).sort();
    const effectiveFromKey = effectiveFromCandidates[effectiveFromCandidates.length - 1];
    if (!effectiveFromKey || effectiveFromKey > options.run.cycleEndDate) {
      throw new Error(`${employee.name || employee.username} cannot receive compensation effective by ${options.run.cycleEndDate}`);
    }
    const overrides = compatibleOverrides(options.version, future);
    const snapshot = buildCompensationSnapshot(options.version, overrides);
    plans.push({
      employee,
      future,
      effectiveFromKey,
      overrides,
      snapshot,
      source: overrides.length ? `copied from ${dateKey(future.effectiveFrom)} assignment` : "published structure defaults",
    });
  }
  return plans;
}

async function createAssignments(options: {
  company: any;
  actor: any;
  version: any;
  structure: any;
  plans: any[];
}) {
  await mongoose.connection.transaction(async (session) => {
    for (const plan of options.plans) {
      const duplicate = await EmployeeCompensationAssignment.exists({
        company: options.company._id,
        employee: plan.employee._id,
        effectiveFrom: new Date(`${plan.effectiveFromKey}T00:00:00.000Z`),
        status: "assigned",
      }).session(session);
      if (duplicate) continue;
      const [assignment]: any[] = await EmployeeCompensationAssignment.create([{
        company: options.company._id,
        employee: plan.employee._id,
        employeeNameSnapshot: plan.employee.name || plan.employee.username,
        employeeCodeSnapshot: plan.employee.code,
        salaryStructure: options.structure._id,
        salaryStructureVersion: options.version._id,
        structureNameSnapshot: options.structure.name,
        structureCodeSnapshot: options.structure.code,
        structureVersionNumber: options.version.versionNumber,
        structureEffectiveFromSnapshot: options.version.effectiveFrom,
        structureEffectiveToSnapshot: options.version.effectiveTo || null,
        currency: options.version.currency,
        currencyMinorUnits: options.version.currencyMinorUnits,
        payFrequency: options.version.payFrequency,
        roundingMode: options.version.roundingMode,
        effectiveFrom: new Date(`${plan.effectiveFromKey}T00:00:00.000Z`),
        status: "assigned",
        assignmentReason: `${REASON}: ${plan.source}`,
        ...plan.snapshot,
        createdBy: options.actor._id,
      }], { session });
      await writePayrollAudit({
        company: options.company._id,
        entityType: "employee_compensation",
        entityId: assignment._id,
        action: "historical_test_assignment_created",
        actor: options.actor._id,
        reason: REASON,
        details: {
          employee: plan.employee._id,
          employeeCode: plan.employee.code,
          salaryStructure: options.structure._id,
          salaryStructureVersion: options.version._id,
          effectiveFrom: plan.effectiveFromKey,
          source: plan.source,
          totals: plan.snapshot.totals,
        },
      }, session);
    }
  });
}

async function refreshAndRecalculate(company: any, actor: any, runId: mongoose.Types.ObjectId) {
  let run: any = await PayrollRun.findById(runId).lean();
  await invokeService(preparePayrollEmployeeSnapshotsService, {
    bodyData: actor,
    params: { runId: String(runId) },
    body: {
      companyId: String(company._id),
      expectedVersion: run.version,
      refresh: true,
      reason: REASON,
    },
  });
  run = await PayrollRun.findById(runId).lean();
  await invokeService(calculateDraftPayrollService, {
    bodyData: actor,
    params: { runId: String(runId) },
    body: {
      companyId: String(company._id),
      expectedVersion: run.version,
      reason: REASON,
    },
  });
}

async function acknowledgeCurrentWarnings(company: any, actor: any, runId: mongoose.Types.ObjectId) {
  const run: any = await PayrollRun.findById(runId).lean();
  const results = await currentResults(run);
  const errors = results.flatMap((result) => (result.issues || []).filter((issue: any) => issue.severity === "error")
    .map((issue: any) => `${result.identity?.code}: ${issue.message}`));
  if (errors.length) throw new Error(`Recalculation still has blocking errors:\n- ${errors.join("\n- ")}`);
  let acknowledged = 0;
  for (const result of results) {
    for (const issue of result.issues || []) {
      if (issue.severity !== "warning") continue;
      const latestRun: any = await PayrollRun.findById(runId).lean();
      await invokeService(decidePayrollValidationIssueService, {
        bodyData: actor,
        params: {
          runId: String(runId),
          resultId: String(result._id),
          issueCode: encodeURIComponent(issue.code),
        },
        body: {
          companyId: String(company._id),
          issueCategory: issue.category,
          action: "acknowledge",
          reason: warningReason(issue),
          expectedVersion: latestRun.version,
        },
      });
      acknowledged += 1;
    }
  }
  return acknowledged;
}

async function readiness(run: any) {
  const results = await currentResults(run);
  const resultIds = results.map((result) => result._id);
  const latestDecisions = await mongoose.connection.collection("payrollvalidationdecisions").aggregate([
    { $match: { company: run.company, payrollRun: run._id, calculationVersion: run.calculationVersion, employeePayrollResult: { $in: resultIds } } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $group: { _id: { result: "$employeePayrollResult", category: "$issueCategory", code: "$issueCode" }, action: { $first: "$action" } } },
  ]).toArray();
  const acknowledged = new Set(latestDecisions.filter((item) => item.action === "acknowledge")
    .map((item) => `${item._id.result}|${item._id.category}|${item._id.code}`));
  const errors = results.filter((result) => result.hasErrors).length;
  const openWarnings = results.reduce((total, result) => total + (result.issues || []).filter((issue: any) =>
    issue.severity === "warning" && !acknowledged.has(`${result._id}|${issue.category}|${issue.code}`)
  ).length, 0);
  const statistics = { resultCount: results.length, errorResultCount: errors, openWarningCount: openWarnings };
  return { results, statistics, blockers: payrollReviewBlockers(run, statistics) };
}

async function run() {
  await connectToDatabase();
  const target = await resolveTarget();
  const results = await currentResults(target.run);
  const otherErrors = results.flatMap((result) => (result.issues || [])
    .filter((issue: any) => issue.severity === "error" && issue.code !== "missing_compensation_assignment")
    .map((issue: any) => `${result.identity?.code}: ${issue.message}`));
  if (otherErrors.length) throw new Error(`Unsupported blocking errors:\n- ${otherErrors.join("\n- ")}`);
  const selected = await resolveStructureVersion(target.company._id, target.run.cycleEndDate);
  const plans = await buildPlans({ ...target, results, ...selected });
  const initialWarnings = results.reduce((total, result) => total + (result.issues || []).filter((issue: any) => issue.severity === "warning").length, 0);
  const initialReadiness = await readiness(target.run);

  console.log(`${applyChanges ? "Applying" : "Dry run for"} payroll finalization test preparation`);
  console.log(`Company: ${target.company.company_name} (${target.company.companyCode})`);
  console.log(`Payroll period: ${target.periodKey}, cycle end ${target.run.cycleEndDate}`);
  console.log(`Run: ${target.run._id}, version ${target.run.version}, calculation v${target.run.calculationVersion}`);
  console.log(`Salary structure: ${selected.structure.name} (${selected.structure.code}) v${selected.version.versionNumber}`);
  console.log(`Blocking compensation assignments to create: ${plans.length}`);
  plans.forEach((plan) => console.log(`- ${plan.employee.name} (${plan.employee.code}): ${plan.effectiveFromKey}, ${plan.source}, monthly gross ${formatMoney(plan.snapshot.totals.monthlyGrossMinor, selected.version.currency, selected.version.currencyMinorUnits)}`));
  console.log(`Current non-blocking warnings: ${initialWarnings} (${initialReadiness.statistics.openWarningCount} open)`);
  if (!acknowledgeWarnings && initialReadiness.statistics.openWarningCount) {
    console.log("Warnings will remain open. Add --acknowledge-warnings only for this test payroll after reviewing the list in the UI.");
  }
  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this plan.");
    return;
  }

  await createAssignments({ ...target, ...selected, plans });
  await refreshAndRecalculate(target.company, target.actor, target.run._id);
  const acknowledged = acknowledgeWarnings
    ? await acknowledgeCurrentWarnings(target.company, target.actor, target.run._id)
    : 0;
  const finalRun: any = await PayrollRun.findById(target.run._id).lean();
  const finalReadiness = await readiness(finalRun);
  console.log(`Compensation assignments created: ${plans.length}`);
  console.log(`Employee snapshot version: ${finalRun.employeeSnapshotVersion}`);
  console.log(`Payroll calculation version: ${finalRun.calculationVersion}`);
  console.log(`Warnings acknowledged: ${acknowledged}`);
  if (finalReadiness.blockers.length) {
    console.error("Remaining review blockers:");
    finalReadiness.blockers.forEach((blocker) => console.error(`- ${blocker}`));
    process.exitCode = 1;
  } else {
    console.log("Payroll is ready to submit for independent review in the UI.");
  }
}

run()
  .catch((error) => {
    console.error("Payroll finalization test preparation failed:", error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
