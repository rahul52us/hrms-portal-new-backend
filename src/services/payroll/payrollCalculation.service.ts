import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import EmployeePayrollResult from "../../schemas/Payroll/EmployeePayrollResult.schema";
import PayrollEmployeeInput from "../../schemas/Payroll/PayrollEmployeeInput.schema";
import PayrollEmployeeSnapshot from "../../schemas/Payroll/PayrollEmployeeSnapshot.schema";
import PayrollOneTimeInput from "../../schemas/Payroll/PayrollOneTimeInput.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

export const PAYROLL_RESULT_TOTAL_FIELDS = [
  "scheduledEarningsMinor",
  "earningProrationReductionMinor",
  "recurringEarningsMinor",
  "oneTimeEarningsMinor",
  "arrearsMinor",
  "grossEarningsMinor",
  "recurringDeductionsMinor",
  "oneTimeDeductionsMinor",
  "recoveriesMinor",
  "totalDeductionsMinor",
  "recurringReimbursementsMinor",
  "oneTimeReimbursementsMinor",
  "totalReimbursementsMinor",
  "employerContributionsMinor",
  "taxableEarningsMinor",
  "netPayMinor",
  "employerCostMinor",
] as const;

type ResultIssue = {
  code: string;
  severity: "error" | "warning";
  category: "identity" | "organization" | "bank" | "statutory" | "attendance" | "compensation" | "one_time_input" | "calculation";
  message: string;
};

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
    throw generateError("Calculation reason must contain 3 to 500 characters", 422);
  }
  return reason;
}

function addIssue(issues: ResultIssue[], issue: ResultIssue) {
  if (!issues.some((item) => item.code === issue.code && item.category === issue.category)) issues.push(issue);
}

function safeMinor(value: unknown, label: string) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return amount;
}

function safeSum(values: number[], label: string) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error(`${label} exceeds the supported currency range`);
  return total;
}

function roundDivision(numerator: number, denominator: number, mode: string) {
  if (mode === "floor") return Math.floor(numerator / denominator);
  if (mode === "ceil") return Math.ceil(numerator / denominator);
  return Math.floor((numerator + denominator / 2) / denominator);
}

export function prorateMinorAmount(
  amountInput: unknown,
  paidUnits: number,
  totalUnits: number,
  roundingMode: string
) {
  const amount = safeMinor(amountInput, "Salary component amount");
  if (!Number.isSafeInteger(paidUnits) || !Number.isSafeInteger(totalUnits) || paidUnits < 0 || totalUnits < 1 || paidUnits > totalUnits) {
    throw new Error("Payroll days are invalid for proration");
  }
  const quotient = Math.floor(amount / totalUnits);
  const remainder = amount % totalUnits;
  const whole = quotient * paidUnits;
  const fractionNumerator = remainder * paidUnits;
  const result = whole + roundDivision(fractionNumerator, totalUnits, roundingMode);
  if (!Number.isSafeInteger(result) || result < 0 || result > amount) {
    throw new Error("Prorated salary amount exceeds the supported range");
  }
  return result;
}

function attendanceIssueMessage(code: string) {
  const messages: Record<string, string> = {
    missing_monthly_summary: "The employee has an adjustment but no monthly attendance summary",
    negative_paid_days: "Resolved paid days are negative",
    negative_unpaid_days: "Resolved unpaid days are negative",
    negative_approved_overtime: "Resolved approved overtime minutes are negative",
  };
  return messages[code] || code.replace(/_/g, " ");
}

function emptyTotals() {
  return Object.fromEntries(PAYROLL_RESULT_TOTAL_FIELDS.map((field) => [field, 0])) as Record<string, number>;
}

export function buildDraftPayrollResults(options: {
  run: any;
  payrollInputs: any[];
  employeeSnapshots: any[];
  oneTimeInputs: any[];
  actorId: mongoose.Types.ObjectId;
  calculationVersion: number;
  calculatedAt?: Date;
}) {
  const calculatedAt = options.calculatedAt || new Date();
  const snapshotsByEmployee = new Map(options.employeeSnapshots.map((item) => [idString(item.employee), item]));
  const oneTimeByEmployee = new Map<string, any[]>();
  for (const input of options.oneTimeInputs) {
    const key = idString(input.employee);
    oneTimeByEmployee.set(key, [...(oneTimeByEmployee.get(key) || []), input]);
  }

  const documents = options.payrollInputs.map((payrollInput) => {
    const employeeId = idString(payrollInput.employee);
    const snapshot: any = snapshotsByEmployee.get(employeeId);
    const employeeOneTimeInputs = oneTimeByEmployee.get(employeeId) || [];
    const issues: ResultIssue[] = [];

    for (const issue of snapshot?.issues || []) {
      addIssue(issues, {
        code: text(issue.code),
        severity: issue.severity === "warning" ? "warning" : "error",
        category: issue.category,
        message: text(issue.message),
      });
    }
    for (const code of payrollInput.inputIssues || []) {
      addIssue(issues, {
        code: text(code),
        severity: "error",
        category: "attendance",
        message: attendanceIssueMessage(text(code)),
      });
    }
    if (!snapshot) {
      addIssue(issues, {
        code: "missing_employee_snapshot",
        severity: "error",
        category: "calculation",
        message: "The employee is missing from the selected payroll snapshot version",
      });
    }

    const paidDays = Math.round(Number(payrollInput.payrollAttendance?.paidDays || 0) * 100) / 100;
    const unpaidDays = Math.round(Number(payrollInput.payrollAttendance?.unpaidDays || 0) * 100) / 100;
    const totalDays = Math.round((paidDays + unpaidDays) * 100) / 100;
    const approvedOvertimeMinutes = Math.round(Number(payrollInput.payrollAttendance?.approvedOvertimeMinutes || 0));
    const dayValuesValid = [paidDays, unpaidDays, totalDays].every(Number.isFinite)
      && paidDays >= 0
      && unpaidDays >= 0
      && totalDays > 0
      && totalDays <= 366;
    const paidUnits = dayValuesValid ? Math.round(paidDays * 100) : 0;
    const totalUnits = dayValuesValid ? Math.round(totalDays * 100) : 0;
    if (!dayValuesValid) {
      addIssue(issues, {
        code: "invalid_payroll_days",
        severity: "error",
        category: "attendance",
        message: "Paid and unpaid days must resolve to a positive payroll basis of at most 366 days",
      });
    }
    if (approvedOvertimeMinutes > 0) {
      addIssue(issues, {
        code: "approved_overtime_requires_amount",
        severity: "warning",
        category: "attendance",
        message: `${approvedOvertimeMinutes} approved overtime minute(s) are not monetized automatically; add the approved amount as a one-time earning`,
      });
    }

    const compensation = snapshot?.compensation || {};
    const compensationReady = Boolean(
      compensation.assigned
      && text(compensation.currency).toUpperCase() === text(options.run.currency).toUpperCase()
      && Array.isArray(compensation.componentAmounts)
      && compensation.componentAmounts.length > 0
    );
    const recurringComponents: any[] = [];
    if (compensationReady) {
      for (const component of compensation.componentAmounts) {
        try {
          const scheduledAmountMinor = safeMinor(component.monthlyAmountMinor, `${text(component.componentName)} amount`);
          const prorateOnUnpaidDays = Boolean(component.prorateOnUnpaidDays);
          const payableAmountMinor = prorateOnUnpaidDays
            ? dayValuesValid
              ? prorateMinorAmount(scheduledAmountMinor, paidUnits, totalUnits, options.run.roundingMode)
              : 0
            : scheduledAmountMinor;
          recurringComponents.push({
            salaryComponent: component.salaryComponent,
            componentCode: text(component.componentCode),
            componentName: text(component.componentName),
            category: component.category,
            taxable: Boolean(component.taxable),
            prorateOnUnpaidDays,
            overridden: Boolean(component.overridden),
            scheduledAmountMinor,
            payableAmountMinor,
            prorationReductionMinor: scheduledAmountMinor - payableAmountMinor,
          });
        } catch (error: any) {
          addIssue(issues, {
            code: `invalid_component_amount_${text(component.componentCode).toLowerCase() || "unknown"}`,
            severity: "error",
            category: "compensation",
            message: error?.message || "A compensation component amount is invalid",
          });
        }
      }
    }

    const oneTimeInputs = employeeOneTimeInputs.map((input) => ({
      payrollOneTimeInput: input._id,
      salaryComponent: input.salaryComponent,
      componentCode: text(input.componentCodeSnapshot),
      componentName: text(input.componentNameSnapshot),
      category: input.componentCategorySnapshot,
      taxable: Boolean(input.componentTaxableSnapshot),
      inputType: input.inputType,
      amountMinor: safeMinor(input.amountMinor, `${text(input.componentNameSnapshot)} one-time amount`),
      reason: text(input.reason),
      reference: text(input.reference),
    }));

    const recurringByCategory = (category: string) => recurringComponents
      .filter((item) => item.category === category)
      .map((item) => Number(item.payableAmountMinor));
    const oneTimeByType = (inputType: string) => oneTimeInputs
      .filter((item) => item.inputType === inputType)
      .map((item) => Number(item.amountMinor));
    const scheduledEarningsMinor = safeSum(
      recurringComponents.filter((item) => item.category === "earning").map((item) => Number(item.scheduledAmountMinor)),
      "Scheduled earnings"
    );
    const recurringEarningsMinor = safeSum(recurringByCategory("earning"), "Recurring earnings");
    const oneTimeEarningsMinor = safeSum(oneTimeByType("earning"), "One-time earnings");
    const arrearsMinor = safeSum(oneTimeByType("arrear"), "Arrears");
    const grossEarningsMinor = safeSum([recurringEarningsMinor, oneTimeEarningsMinor, arrearsMinor], "Gross earnings");
    const recurringDeductionsMinor = safeSum(recurringByCategory("deduction"), "Recurring deductions");
    const oneTimeDeductionsMinor = safeSum(oneTimeByType("deduction"), "One-time deductions");
    const recoveriesMinor = safeSum(oneTimeByType("recovery"), "Recoveries");
    const totalDeductionsMinor = safeSum([recurringDeductionsMinor, oneTimeDeductionsMinor, recoveriesMinor], "Total deductions");
    const recurringReimbursementsMinor = safeSum(recurringByCategory("reimbursement"), "Recurring reimbursements");
    const oneTimeReimbursementsMinor = safeSum(oneTimeByType("reimbursement"), "One-time reimbursements");
    const totalReimbursementsMinor = safeSum([recurringReimbursementsMinor, oneTimeReimbursementsMinor], "Total reimbursements");
    const employerContributionsMinor = safeSum(recurringByCategory("employer_contribution"), "Employer contributions");
    const taxableEarningsMinor = safeSum([
      ...recurringComponents.filter((item) => item.category === "earning" && item.taxable).map((item) => Number(item.payableAmountMinor)),
      ...oneTimeInputs.filter((item) => ["earning", "arrear"].includes(item.inputType) && item.taxable).map((item) => Number(item.amountMinor)),
    ], "Taxable earnings");
    const netPayMinor = safeSum([grossEarningsMinor, -totalDeductionsMinor, totalReimbursementsMinor], "Net pay");
    const employerCostMinor = safeSum([grossEarningsMinor, employerContributionsMinor, totalReimbursementsMinor], "Employer cost");
    if (netPayMinor < 0) {
      addIssue(issues, {
        code: "negative_net_pay",
        severity: "error",
        category: "calculation",
        message: "Deductions and recoveries exceed payable earnings and reimbursements",
      });
    }

    const totals = {
      scheduledEarningsMinor,
      earningProrationReductionMinor: scheduledEarningsMinor - recurringEarningsMinor,
      recurringEarningsMinor,
      oneTimeEarningsMinor,
      arrearsMinor,
      grossEarningsMinor,
      recurringDeductionsMinor,
      oneTimeDeductionsMinor,
      recoveriesMinor,
      totalDeductionsMinor,
      recurringReimbursementsMinor,
      oneTimeReimbursementsMinor,
      totalReimbursementsMinor,
      employerContributionsMinor,
      taxableEarningsMinor,
      netPayMinor,
      employerCostMinor,
    };

    return {
      company: options.run.company,
      payrollRun: options.run._id,
      periodKey: options.run.periodKey,
      calculationVersion: options.calculationVersion,
      sourceRunVersion: Number(options.run.version),
      employeeSnapshotVersion: Number(options.run.employeeSnapshotVersion),
      employee: payrollInput.employee,
      payrollEmployeeInput: payrollInput._id,
      payrollEmployeeSnapshot: snapshot?._id || null,
      identity: {
        name: text(snapshot?.identity?.name || payrollInput.employeeNameSnapshot) || "Employee",
        code: text(snapshot?.identity?.code || payrollInput.employeeCodeSnapshot) || employeeId,
        username: text(snapshot?.identity?.username),
      },
      organization: snapshot?.organization || {
        designation: text(payrollInput.designationSnapshot),
        department: payrollInput.department || null,
        departmentName: text(payrollInput.departmentNameSnapshot),
        teamId: payrollInput.teamId || null,
        teamName: text(payrollInput.teamNameSnapshot),
        officeLocation: payrollInput.officeLocation || null,
        officeLocationName: text(payrollInput.officeLocationNameSnapshot),
      },
      payrollDays: { paidDays, unpaidDays, totalDays, approvedOvertimeMinutes },
      recurringComponents,
      oneTimeInputs,
      totals,
      issues,
      hasErrors: issues.some((issue) => issue.severity === "error"),
      hasWarnings: issues.some((issue) => issue.severity === "warning"),
      calculatedAt,
      calculatedBy: options.actorId,
    };
  });

  const totals = emptyTotals();
  for (const document of documents) {
    for (const field of PAYROLL_RESULT_TOTAL_FIELDS) {
      totals[field] = safeSum([totals[field], Number(document.totals[field] || 0)], `Payroll ${field}`);
    }
  }
  return {
    documents,
    totals,
    issueCount: documents.filter((document) => document.issues.length > 0).length,
    errorCount: documents.filter((document) => document.hasErrors).length,
    warningCount: documents.filter((document) => document.hasWarnings).length,
  };
}

async function populatedRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId | string) {
  return PayrollRun.findOne({ _id: runId, company })
    .populate(
      "createdBy attendanceLockedBy attendanceInputsPreparedBy employeeSnapshotsPreparedBy calculatedBy",
      "name username code role"
    )
    .lean();
}

export async function calculateDraftPayrollService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "calculate this payroll run"
    );
    const actorId = getPayrollActorId(req);
    const runId = text(req.params.runId);
    if (!mongoose.Types.ObjectId.isValid(runId)) throw generateError("Invalid payroll run id", 400);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw generateError("Expected payroll run version is required", 422);
    const reason = requiredReason(req.body?.reason);
    let recalculated = false;

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);
      if (run.status !== "draft") throw generateError("Only a draft payroll run can be calculated", 409);
      if (run.attendanceInputStatus !== "prepared") throw generateError("Import attendance inputs before calculating payroll", 409);
      if (run.employeeSnapshotStatus !== "prepared") throw generateError("Prepare employee payroll snapshots before calculating payroll", 409);
      if (Number(run.version) !== expectedVersion) throw generateError("Payroll run changed. Refresh and try again", 409);
      const calculationVersion = Number(run.calculationVersion || 0) + 1;
      const payrollInputs: any[] = await PayrollEmployeeInput.find({ company: companyObjectId, payrollRun: run._id })
        .sort({ employeeCodeSnapshot: 1 })
        .session(session)
        .lean();
      if (!payrollInputs.length) throw generateError("Payroll run has no employee inputs to calculate", 409);
      if (payrollInputs.length !== Number(run.employeeInputCount || 0)) {
        throw generateError("Payroll employee input count does not match the run", 409);
      }
      const employeeSnapshots: any[] = await PayrollEmployeeSnapshot.find({
        company: companyObjectId,
        payrollRun: run._id,
        snapshotVersion: run.employeeSnapshotVersion,
      }).sort({ "identity.code": 1 }).session(session).lean();
      if (employeeSnapshots.length !== Number(run.employeeSnapshotCount || 0) || employeeSnapshots.length !== payrollInputs.length) {
        throw generateError("Employee snapshot count does not match the payroll inputs", 409);
      }
      const oneTimeInputs: any[] = await PayrollOneTimeInput.find({
        company: companyObjectId,
        payrollRun: run._id,
        status: "active",
      }).sort({ employeeCodeSnapshot: 1, createdAt: 1 }).session(session).lean();
      if (oneTimeInputs.length !== Number(run.oneTimeInputCount || 0)) {
        throw generateError("Active one-time input count does not match the payroll run", 409);
      }
      const built = buildDraftPayrollResults({
        run,
        payrollInputs,
        employeeSnapshots,
        oneTimeInputs,
        actorId,
        calculationVersion,
      });
      for (let index = 0; index < built.documents.length; index += 500) {
        await EmployeePayrollResult.insertMany(built.documents.slice(index, index + 500), { session, ordered: true });
      }
      const calculatedAt = built.documents[0]?.calculatedAt || new Date();
      const update = await PayrollRun.updateOne(
        { _id: run._id, company: companyObjectId, status: "draft", version: expectedVersion },
        {
          $set: {
            calculationStatus: "calculated",
            calculationVersion,
            calculationEmployeeSnapshotVersion: Number(run.employeeSnapshotVersion),
            calculationOneTimeInputCount: oneTimeInputs.length,
            payrollResultCount: built.documents.length,
            payrollResultIssueCount: built.issueCount,
            payrollResultErrorCount: built.errorCount,
            payrollResultWarningCount: built.warningCount,
            payrollResultTotals: built.totals,
            lastCalculationReason: reason,
            calculatedAt,
            calculatedBy: actorId,
          },
          $inc: { version: 1 },
        },
        { session }
      );
      if (update.modifiedCount !== 1) throw generateError("Payroll run changed while it was being calculated", 409);
      recalculated = Number(run.calculationVersion || 0) > 0;
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "payroll_run",
        entityId: run._id,
        action: recalculated ? "draft_payroll_recalculated" : "draft_payroll_calculated",
        actor: actorId,
        reason,
        details: {
          periodKey: run.periodKey,
          calculationVersion,
          sourceRunVersion: run.version,
          employeeSnapshotVersion: run.employeeSnapshotVersion,
          oneTimeInputCount: oneTimeInputs.length,
          employeeCount: built.documents.length,
          issueCount: built.issueCount,
          errorCount: built.errorCount,
          warningCount: built.warningCount,
          totals: built.totals,
        },
      }, session);
    });

    const run = await populatedRun(companyObjectId, runId);
    return res.status(201).json({
      success: true,
      message: recalculated ? "Draft payroll recalculated" : "Draft payroll calculated",
      data: run,
    });
  } catch (error) {
    next(error);
  }
}

export async function listDraftPayrollResultsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = text(req.params.runId);
    if (!mongoose.Types.ObjectId.isValid(runId)) throw generateError("Invalid payroll run id", 400);
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 25, 100);
    const search = text(req.query?.search);
    const issues = text(req.query?.issues || "all").toLowerCase();
    if (!["all", "errors", "warnings", "clean"].includes(issues)) throw generateError("Invalid payroll result issue filter", 422);
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
      calculationVersion: Number(run.calculationVersion || 0),
      ...issueMatch,
      ...(regex ? {
        $or: [
          { "identity.name": regex },
          { "identity.code": regex },
          { "organization.designation": regex },
          { "organization.departmentName": regex },
          { "organization.teamName": regex },
          { "organization.officeLocationName": regex },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      EmployeePayrollResult.find(match)
        .sort({ "identity.code": 1, "identity.name": 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      EmployeePayrollResult.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: { run, items },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}
