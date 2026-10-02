import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import BankDetail from "../../schemas/User/BankDetails";
import ProfileDetails from "../../schemas/User/ProfileDetails";
import User from "../../schemas/User/User";
import EmployeeCompensationAssignment from "../../schemas/Payroll/EmployeeCompensationAssignment.schema";
import PayrollEmployeeInput from "../../schemas/Payroll/PayrollEmployeeInput.schema";
import PayrollEmployeeSnapshot from "../../schemas/Payroll/PayrollEmployeeSnapshot.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

export const PAYROLL_COMPENSATION_TOTAL_FIELDS = [
  "monthlyGrossMinor",
  "monthlyDeductionsMinor",
  "monthlyReimbursementsMinor",
  "monthlyEmployerContributionsMinor",
  "monthlyNetMinor",
  "monthlyEmployerCostMinor",
] as const;

const text = (value: unknown) => String(value ?? "").trim();
const idString = (value: any) => String(value?._id || value || "");
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pageNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function requiredReason(value: unknown) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) {
    throw generateError("Snapshot reason must contain 3 to 500 characters", 422);
  }
  return reason;
}

function addIssue(
  issues: Array<Record<string, string>>,
  code: string,
  severity: "error" | "warning",
  category: "identity" | "organization" | "bank" | "statutory" | "compensation",
  message: string
) {
  issues.push({ code, severity, category, message });
}

function compensationSnapshot(assignment: any) {
  if (!assignment) {
    return {
      assigned: false,
      componentAmounts: [],
      totals: {},
    };
  }
  return {
    assigned: true,
    structureName: text(assignment.structureNameSnapshot),
    structureCode: text(assignment.structureCodeSnapshot).toUpperCase(),
    structureVersionNumber: Number(assignment.structureVersionNumber),
    effectiveFrom: assignment.effectiveFrom,
    currency: text(assignment.currency).toUpperCase(),
    currencyMinorUnits: Number(assignment.currencyMinorUnits),
    payFrequency: assignment.payFrequency,
    roundingMode: assignment.roundingMode,
    componentAmounts: (assignment.componentAmounts || []).map((component: any) => ({
      salaryComponent: component.salaryComponent,
      componentCode: text(component.componentCodeSnapshot).toUpperCase(),
      componentName: text(component.componentNameSnapshot),
      category: component.categorySnapshot,
      taxable: Boolean(component.taxableSnapshot),
      prorateOnUnpaidDays: Boolean(component.prorateOnUnpaidDaysSnapshot),
      monthlyAmountMinor: Number(component.monthlyAmountMinor || 0),
      annualAmountMinor: Number(component.annualAmountMinor || 0),
      overridden: Boolean(component.overridden),
    })),
    totals: assignment.totals || {},
  };
}

export function buildPayrollEmployeeSnapshots(options: {
  run: any;
  payrollInputs: any[];
  users: any[];
  banks: any[];
  profiles: any[];
  compensationAssignments: any[];
  actorId: mongoose.Types.ObjectId;
  snapshotVersion: number;
  preparedAt?: Date;
}) {
  const usersById = new Map(options.users.map((item) => [idString(item._id), item]));
  const profilesByEmployee = new Map(options.profiles.map((item) => [idString(item.user), item]));
  const banksByEmployee = new Map<string, any[]>();
  for (const bank of options.banks) {
    const key = idString(bank.user);
    banksByEmployee.set(key, [...(banksByEmployee.get(key) || []), bank]);
  }
  const assignmentsByEmployee = new Map<string, any>();
  for (const assignment of options.compensationAssignments) {
    const key = idString(assignment.employee);
    if (!assignmentsByEmployee.has(key)) assignmentsByEmployee.set(key, assignment);
  }
  const preparedAt = options.preparedAt || new Date();
  const compensationTotals = Object.fromEntries(PAYROLL_COMPENSATION_TOTAL_FIELDS.map((field) => [field, 0])) as Record<string, number>;

  const documents = options.payrollInputs.map((input) => {
    const employeeId = idString(input.employee);
    const user: any = usersById.get(employeeId);
    const profile: any = profilesByEmployee.get(employeeId);
    const banks = banksByEmployee.get(employeeId) || [];
    const bank: any = banks[0];
    const assignment: any = assignmentsByEmployee.get(employeeId);
    const issues: Array<Record<string, string>> = [];

    if (!user) addIssue(issues, "missing_employee_record", "error", "identity", "Employee record is missing from the company");
    if (!text(user?.username)) addIssue(issues, "missing_username", "warning", "identity", "Employee login email is missing");
    if (!text(input.designationSnapshot)) addIssue(issues, "missing_designation", "warning", "organization", "Designation is missing for the payroll period");
    if (!text(input.departmentNameSnapshot)) addIssue(issues, "missing_department", "warning", "organization", "Department is missing for the payroll period");
    if (!bank) {
      addIssue(issues, "missing_bank_details", "warning", "bank", "Bank details are missing");
    } else {
      if (!text(bank.accountNo)) addIssue(issues, "missing_bank_account", "warning", "bank", "Bank account number is missing");
      if (!text(bank.ifsc)) addIssue(issues, "missing_bank_ifsc", "warning", "bank", "Bank IFSC is missing");
      if (banks.length > 1) addIssue(issues, "multiple_bank_records", "warning", "bank", "Multiple active bank records exist; the latest record was snapshotted");
    }
    if (!profile) {
      addIssue(issues, "missing_statutory_profile", "warning", "statutory", "Employee statutory profile is missing");
    } else if (!text(profile.statutoryDetails?.panNumber)) {
      addIssue(issues, "missing_pan", "warning", "statutory", "PAN is missing from statutory details");
    }
    if (!assignment) {
      addIssue(issues, "missing_compensation_assignment", "error", "compensation", `No compensation assignment is effective on ${options.run.cycleEndDate}`);
    } else {
      if (text(assignment.currency).toUpperCase() !== text(options.run.currency).toUpperCase()) {
        addIssue(issues, "compensation_currency_mismatch", "error", "compensation", "Compensation currency does not match the payroll run currency");
      }
      if (!Array.isArray(assignment.componentAmounts) || assignment.componentAmounts.length === 0) {
        addIssue(issues, "missing_compensation_components", "error", "compensation", "Compensation assignment has no resolved component amounts");
      }
      if (text(assignment.currency).toUpperCase() === text(options.run.currency).toUpperCase()) {
        for (const field of PAYROLL_COMPENSATION_TOTAL_FIELDS) {
          compensationTotals[field] += Number(assignment.totals?.[field] || 0);
        }
      }
    }

    return {
      company: options.run.company,
      payrollRun: options.run._id,
      periodKey: options.run.periodKey,
      snapshotVersion: options.snapshotVersion,
      snapshotAsOfDate: options.run.cycleEndDate,
      employee: input.employee,
      payrollEmployeeInput: input._id,
      identity: {
        name: text(input.employeeNameSnapshot) || text(user?.name) || "Employee",
        code: text(input.employeeCodeSnapshot) || text(user?.code) || employeeId,
        username: text(user?.username),
        mobileNumber: text(user?.mobileNumber),
        role: text(user?.role),
        gender: user?.gender ?? undefined,
        dateOfBirth: user?.dateOfBirth || null,
        joiningDate: user?.joiningDate || null,
        confirmationDate: user?.confirmationDate || null,
        employmentEndDate: user?.employmentEndDate || null,
      },
      organization: {
        designation: text(input.designationSnapshot),
        department: input.department || null,
        departmentName: text(input.departmentNameSnapshot),
        teamId: input.teamId || null,
        teamName: text(input.teamNameSnapshot),
        officeLocation: input.officeLocation || null,
        officeLocationName: text(input.officeLocationNameSnapshot),
        reportingManager: input.reportingManager || null,
        reportingManagerName: text(input.reportingManagerNameSnapshot),
      },
      bankDetail: bank?._id || null,
      bank: {
        accountHolderName: text(bank?.nameAsPerBank),
        bankName: text(bank?.name),
        accountNumber: text(bank?.accountNo),
        branch: text(bank?.branch),
        ifsc: text(bank?.ifsc).toUpperCase(),
      },
      profileDetails: profile?._id || null,
      statutory: {
        aadharNumber: text(profile?.statutoryDetails?.aadharNumber),
        nameAsPerAadhar: text(profile?.statutoryDetails?.nameAsPerAadhar),
        panNumber: text(profile?.statutoryDetails?.panNumber).toUpperCase(),
        nameAsPerPan: text(profile?.statutoryDetails?.nameAsPerPan),
        nationality: text(profile?.statutoryDetails?.nationality || profile?.personalDetails?.nationality).toLowerCase(),
      },
      compensationAssignment: assignment?._id || null,
      compensation: compensationSnapshot(assignment),
      issues,
      hasErrors: issues.some((issue) => issue.severity === "error"),
      hasWarnings: issues.some((issue) => issue.severity === "warning"),
      preparedAt,
      preparedBy: options.actorId,
    };
  });

  return {
    documents,
    compensationTotals,
    issueCount: documents.filter((document) => document.issues.length > 0).length,
    errorCount: documents.filter((document) => document.hasErrors).length,
    warningCount: documents.filter((document) => document.hasWarnings).length,
  };
}

function maskEnd(value: unknown, visible = 4) {
  const normalized = text(value);
  if (!normalized) return "";
  if (normalized.length <= visible) return "*".repeat(normalized.length);
  return `${"*".repeat(normalized.length - visible)}${normalized.slice(-visible)}`;
}

export function serializePayrollEmployeeSnapshot(snapshot: any) {
  return {
    _id: snapshot._id,
    snapshotVersion: snapshot.snapshotVersion,
    snapshotAsOfDate: snapshot.snapshotAsOfDate,
    employee: snapshot.employee,
    identity: {
      name: snapshot.identity?.name || "Employee",
      code: snapshot.identity?.code || "",
      username: snapshot.identity?.username || "",
      mobileNumberMasked: maskEnd(snapshot.identity?.mobileNumber),
      role: snapshot.identity?.role || "",
      joiningDate: snapshot.identity?.joiningDate || null,
      employmentEndDate: snapshot.identity?.employmentEndDate || null,
    },
    organization: snapshot.organization || {},
    bank: {
      bankName: snapshot.bank?.bankName || "",
      accountHolderName: snapshot.bank?.accountHolderName || "",
      accountNumberMasked: maskEnd(snapshot.bank?.accountNumber),
      branch: snapshot.bank?.branch || "",
      ifsc: snapshot.bank?.ifsc || "",
    },
    statutory: {
      panNumberMasked: maskEnd(snapshot.statutory?.panNumber, 3),
      aadharNumberMasked: maskEnd(snapshot.statutory?.aadharNumber),
      nationality: snapshot.statutory?.nationality || "",
    },
    compensation: {
      assigned: Boolean(snapshot.compensation?.assigned),
      structureName: snapshot.compensation?.structureName || "",
      structureCode: snapshot.compensation?.structureCode || "",
      structureVersionNumber: snapshot.compensation?.structureVersionNumber || null,
      effectiveFrom: snapshot.compensation?.effectiveFrom || null,
      currency: snapshot.compensation?.currency || "",
      currencyMinorUnits: snapshot.compensation?.currencyMinorUnits ?? 2,
      componentCount: snapshot.compensation?.componentAmounts?.length || 0,
      totals: snapshot.compensation?.totals || {},
    },
    issues: snapshot.issues || [],
    hasErrors: Boolean(snapshot.hasErrors),
    hasWarnings: Boolean(snapshot.hasWarnings),
    preparedAt: snapshot.preparedAt,
  };
}

async function populatedRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId | string) {
  return PayrollRun.findOne({ _id: runId, company })
    .populate("createdBy attendanceLockedBy attendanceInputsPreparedBy employeeSnapshotsPreparedBy", "name username code role")
    .lean();
}

export async function preparePayrollEmployeeSnapshotsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "prepare employee snapshots for this payroll run"
    );
    const actorId = getPayrollActorId(req);
    const runId = text(req.params.runId);
    if (!mongoose.Types.ObjectId.isValid(runId)) throw generateError("Invalid payroll run id", 400);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw generateError("Expected payroll run version is required", 422);
    const refresh = req.body?.refresh === true;
    const reason = requiredReason(req.body?.reason);
    let prepared = false;
    let refreshed = false;

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);
      if (run.employeeSnapshotStatus === "prepared" && !refresh) return;
      if (run.status !== "draft") throw generateError("Employee snapshots can only be prepared for a draft payroll run", 409);
      if (run.attendanceInputStatus !== "prepared") throw generateError("Import employee attendance inputs before preparing employee snapshots", 409);
      if (Number(run.version) !== expectedVersion) throw generateError("Payroll run changed. Refresh and try again", 409);
      const snapshotVersion = Number(run.employeeSnapshotVersion || 0) + 1;
      const payrollInputs: any[] = await PayrollEmployeeInput.find({
        company: companyObjectId,
        payrollRun: run._id,
      }).sort({ employeeCodeSnapshot: 1 }).session(session).lean();
      if (payrollInputs.length !== Number(run.employeeInputCount || 0)) {
        throw generateError("Payroll employee input count does not match the run snapshot", 409);
      }
      const employeeIds = payrollInputs.map((input) => input.employee);
      const users: any[] = await User.find({ company: companyObjectId, _id: { $in: employeeIds } })
        .select("_id name username mobileNumber code role gender dateOfBirth joiningDate confirmationDate employmentEndDate")
        .session(session)
        .lean();
      const banks: any[] = await BankDetail.find({
        user: { $in: employeeIds },
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      }).sort({ user: 1, updatedAt: -1, createdAt: -1 }).session(session).lean();
      const profiles: any[] = await ProfileDetails.find({ user: { $in: employeeIds } })
        .select("_id user personalDetails.nationality statutoryDetails")
        .session(session)
        .lean();
      const compensationAssignments: any[] = await EmployeeCompensationAssignment.find({
        company: companyObjectId,
        employee: { $in: employeeIds },
        status: "assigned",
        effectiveFrom: { $lte: new Date(`${run.cycleEndDate}T23:59:59.999Z`) },
      }).sort({ employee: 1, effectiveFrom: -1, createdAt: -1 }).session(session).lean();
      const built = buildPayrollEmployeeSnapshots({
        run,
        payrollInputs,
        users,
        banks,
        profiles,
        compensationAssignments,
        actorId,
        snapshotVersion,
      });
      for (let index = 0; index < built.documents.length; index += 500) {
        await PayrollEmployeeSnapshot.insertMany(built.documents.slice(index, index + 500), {
          session,
          ordered: true,
        });
      }
      const preparedAt = built.documents[0]?.preparedAt || new Date();
      const update = await PayrollRun.updateOne(
        {
          _id: run._id,
          company: companyObjectId,
          status: "draft",
          version: expectedVersion,
          ...(run.employeeSnapshotStatus === "prepared"
            ? { employeeSnapshotStatus: "prepared" }
            : { employeeSnapshotStatus: { $in: ["pending", null] } }),
        },
        {
          $set: {
            employeeSnapshotStatus: "prepared",
            employeeSnapshotVersion: snapshotVersion,
            employeeSnapshotCount: built.documents.length,
            employeeSnapshotIssueCount: built.issueCount,
            employeeSnapshotErrorCount: built.errorCount,
            employeeSnapshotWarningCount: built.warningCount,
            employeeSnapshotCompensationTotals: built.compensationTotals,
            employeeSnapshotsPreparedAt: preparedAt,
            employeeSnapshotsPreparedBy: actorId,
            calculationStatus: Number(run.calculationVersion || 0) > 0 ? "stale" : "pending",
          },
          $inc: { version: 1 },
        },
        { session }
      );
      if (update.modifiedCount !== 1) throw generateError("Payroll run changed while employee snapshots were being prepared", 409);
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "payroll_run",
        entityId: run._id,
        action: run.employeeSnapshotStatus === "prepared" ? "employee_snapshots_refreshed" : "employee_snapshots_prepared",
        actor: actorId,
        reason,
        details: {
          periodKey: run.periodKey,
          snapshotVersion,
          snapshotAsOfDate: run.cycleEndDate,
          employeeCount: built.documents.length,
          issueCount: built.issueCount,
          errorCount: built.errorCount,
          warningCount: built.warningCount,
          compensationTotals: built.compensationTotals,
        },
      }, session);
      refreshed = run.employeeSnapshotStatus === "prepared";
      prepared = true;
    });

    const run = await populatedRun(companyObjectId, runId);
    return res.status(prepared ? 201 : 200).json({
      success: true,
      message: prepared
        ? refreshed ? "Payroll employee snapshots refreshed" : "Payroll employee snapshots prepared"
        : "Payroll employee snapshots were already prepared",
      data: run,
    });
  } catch (error) {
    next(error);
  }
}

export async function listPayrollEmployeeSnapshotsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = text(req.params.runId);
    if (!mongoose.Types.ObjectId.isValid(runId)) throw generateError("Invalid payroll run id", 400);
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 25, 100);
    const search = text(req.query?.search);
    const issues = text(req.query?.issues || "all").toLowerCase();
    if (!["all", "errors", "warnings", "clean"].includes(issues)) throw generateError("Invalid employee snapshot issue filter", 422);
    const run: any = await populatedRun(companyObjectId, runId);
    if (!run) throw generateError("Payroll run not found", 404);
    const regex = search ? new RegExp(escapeRegex(search), "i") : null;
    const issueMatch = issues === "errors"
      ? { hasErrors: true }
      : issues === "warnings"
        ? { hasWarnings: true }
        : issues === "clean"
          ? { hasErrors: false, hasWarnings: false }
          : {};
    const match: any = {
      company: companyObjectId,
      payrollRun: new mongoose.Types.ObjectId(runId),
      snapshotVersion: Number(run.employeeSnapshotVersion || 0),
      ...issueMatch,
      ...(regex ? {
        $or: [
          { "identity.name": regex },
          { "identity.code": regex },
          { "organization.designation": regex },
          { "organization.departmentName": regex },
          { "organization.teamName": regex },
          { "compensation.structureName": regex },
          { "compensation.structureCode": regex },
        ],
      } : {}),
    };
    const [snapshots, total] = await Promise.all([
      PayrollEmployeeSnapshot.find(match)
        .sort({ "identity.code": 1, "identity.name": 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PayrollEmployeeSnapshot.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: { run, items: snapshots.map(serializePayrollEmployeeSnapshot) },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}
