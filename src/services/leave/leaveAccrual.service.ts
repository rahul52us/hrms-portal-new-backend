import mongoose from "mongoose";
import User from "../../schemas/User/User";
import LeaveBalanceTransaction from "../../schemas/Leave/LeaveBalanceTransaction.schema";
import { resolveEmployeeDayContext } from "../attendance/employeeDayContext.service";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import { postLeaveBalanceTransaction } from "./leaveBalance.service";
import {
  PlannedLeaveRuleCredit,
  planLeaveRuleAccrualCredits,
} from "./leaveAccrualCalculator.utils";
import { resolveLeaveYear } from "./leaveRequestCalculator.utils";

const LEGACY_ACCRUAL_ENGINE_VERSION = "v1";
const COMPONENT_ACCRUAL_ENGINE_VERSION = "v2";
const EMPLOYEE_FIELDS =
  "_id company name username code role joiningDate employmentEndDate department team officeLocation is_enabled deletedAt";

function objectId(value: unknown, label: string) {
  const normalized = String((value as any)?._id || value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return new mongoose.Types.ObjectId(normalized);
}

function dateKey(value: unknown, label: string) {
  const raw = value instanceof Date ? value.toISOString() : String(value || "").trim();
  return parseAttendanceDate(raw.slice(0, 10) || raw).dateKey;
}

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function duplicateKey(error: any) {
  return Number(error?.code) === 11000;
}

function employeeAccrualIdempotencyKey(options: {
  employeeId: unknown;
  leaveTypeId: unknown;
  leaveYearKey: string;
  periodKey: string;
}) {
  return [
    "leave-accrual",
    LEGACY_ACCRUAL_ENGINE_VERSION,
    String(options.employeeId),
    String(options.leaveTypeId),
    options.leaveYearKey,
    options.periodKey,
  ].join(":");
}

function componentAccrualIdempotencyKey(options: {
  employeeId: unknown;
  leaveTypeId: unknown;
  leavePolicyId: unknown;
  componentId: string;
  leaveYearKey: string;
  periodKey: string;
  oneTime: boolean;
}) {
  return [
    "leave-accrual",
    COMPONENT_ACCRUAL_ENGINE_VERSION,
    String(options.employeeId),
    String(options.leaveTypeId),
    String(options.leavePolicyId),
    options.componentId,
    options.oneTime ? "first_eligibility" : options.leaveYearKey,
    ...(options.oneTime ? [] : [options.periodKey]),
  ].join(":");
}

export interface EnsureEmployeeLeaveAccrualsResult {
  employeeId: string;
  asOf: string;
  policyResolved: boolean;
  plannedCredits: number;
  postedCredits: number;
  existingCredits: number;
  postedUnits: number;
}

type PlannedEmployeeLeaveCredit = PlannedLeaveRuleCredit & {
  leaveTypeId: mongoose.Types.ObjectId;
  leaveTypeCode: string;
  idempotencyKey: string;
};

export async function ensureEmployeeLeaveAccruals(options: {
  companyId: unknown;
  employee: any;
  asOf?: unknown;
  context?: any;
}): Promise<EnsureEmployeeLeaveAccrualsResult> {
  const company = objectId(options.companyId, "company id");
  const employeeId = objectId(options.employee?._id || options.employee, "employee id");
  const requestedAsOf = dateKey(options.asOf || currentDateKey(), "accrual date");
  const asOf = requestedAsOf > currentDateKey() ? currentDateKey() : requestedAsOf;
  const employee = options.employee?._id
    ? options.employee
    : await User.findOne({
        _id: employeeId,
        company,
        deletedAt: { $exists: false },
        is_enabled: { $ne: false },
      })
        .select(EMPLOYEE_FIELDS)
        .lean();
  if (!employee) throw new Error("Employee not found for leave accrual");

  const context = options.context || await resolveEmployeeDayContext({
    companyId: company,
    employeeId,
    attendanceDate: asOf,
  });
  const resolvedPolicy = context?.policies?.leavePolicy;
  const assignment = resolvedPolicy?.assignment;
  const version = resolvedPolicy?.version;
  if (!assignment || !version) {
    return {
      employeeId: String(employeeId),
      asOf,
      policyResolved: false,
      plannedCredits: 0,
      postedCredits: 0,
      existingCredits: 0,
      postedUnits: 0,
    };
  }

  const leaveYear = resolveLeaveYear(
    asOf,
    Number(version.leaveYearStartMonth || 1),
    Number(version.leaveYearStartDay || 1)
  );
  const createdBy = objectId(
    assignment.createdBy || version.publishedBy || version.createdBy,
    "policy credit actor"
  );
  const assignmentId = objectId(assignment._id, "leave policy assignment id");
  const resourceId = objectId(
    assignment.resource?._id || assignment.resource || version.policy,
    "leave policy id"
  );
  const versionId = objectId(version._id, "leave policy version id");
  const planned: PlannedEmployeeLeaveCredit[] = (version.rules || []).flatMap((rule: any) => {
    const leaveTypeId = objectId(rule.leaveType?._id || rule.leaveType, "leave type id");
    return planLeaveRuleAccrualCredits({
      asOf,
      leaveYearStart: leaveYear.leaveYearStart,
      leaveYearEnd: leaveYear.leaveYearEnd,
      assignmentEffectiveFrom: assignment.effectiveFrom,
      versionEffectiveFrom: version.effectiveFrom,
      joiningDate: employee.joiningDate,
      employmentEndDate: employee.employmentEndDate,
      rule: {
        balanceTracked: rule.balanceTracked !== false,
        annualEntitlement: Number(rule.annualEntitlement || 0),
        accrualFrequency: rule.accrualFrequency || "none",
        accrualAmount: Number(rule.accrualAmount || 0),
        prorateOnJoining: rule.prorateOnJoining !== false,
        prorateOnExit: rule.prorateOnExit !== false,
        creditComponents: Array.isArray(rule.creditComponents)
          ? rule.creditComponents.map((component: any) => ({
              componentId: String(component.componentId || ""),
              frequency: component.frequency,
              amount: Number(component.amount || 0),
              upfrontTiming: component.upfrontTiming || "leave_year_start",
              prorateOnJoining: component.prorateOnJoining !== false,
              prorateOnExit: component.prorateOnExit !== false,
            }))
          : [],
      },
    }).map((credit) => ({
      ...credit,
      leaveTypeId,
      leaveTypeCode: String(rule.leaveTypeCodeSnapshot || "Leave"),
      idempotencyKey: credit.legacyIdempotency
        ? employeeAccrualIdempotencyKey({
            employeeId,
            leaveTypeId,
            leaveYearKey: leaveYear.leaveYearKey,
            periodKey: credit.periodKey,
          })
        : componentAccrualIdempotencyKey({
            employeeId,
            leaveTypeId,
            leavePolicyId: resourceId,
            componentId: credit.componentId,
            leaveYearKey: leaveYear.leaveYearKey,
            periodKey: credit.periodKey,
            oneTime: credit.upfrontTiming === "first_eligibility",
          }),
    }));
  });

  if (!planned.length) {
    return {
      employeeId: String(employeeId),
      asOf,
      policyResolved: true,
      plannedCredits: 0,
      postedCredits: 0,
      existingCredits: 0,
      postedUnits: 0,
    };
  }

  let postedCredits = 0;
  let postedUnits = 0;
  let existingCredits = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await LeaveBalanceTransaction.find({
      company,
      idempotencyKey: { $in: planned.map((credit) => credit.idempotencyKey) },
    })
      .select("idempotencyKey")
      .lean();
    const existingKeys = new Set(existing.map((transaction) => transaction.idempotencyKey));
    const missing = planned.filter((credit) => !existingKeys.has(credit.idempotencyKey));
    existingCredits = planned.length - missing.length;
    if (!missing.length) break;

    try {
      await mongoose.connection.transaction(async (session) => {
        for (const credit of missing) {
          await postLeaveBalanceTransaction({
            key: {
              company,
              employee: employeeId,
              leaveType: credit.leaveTypeId,
              ...leaveYear,
            },
            units: credit.units,
            transactionType: credit.transactionType,
            sourceType: "policy",
            sourceId: versionId,
            effectiveDate: credit.effectiveDate,
            idempotencyKey: credit.idempotencyKey,
            reason: `Automatic ${credit.frequency.replace("_", " ")} credit for ${credit.leaveTypeCode}`,
            leavePolicyAssignment: assignmentId,
            leavePolicy: resourceId,
            leavePolicyVersion: versionId,
            createdBy,
            session,
          });
        }
      });
      postedCredits = missing.length;
      postedUnits = missing.reduce((total, credit) => total + credit.units, 0);
      break;
    } catch (error: any) {
      if (!duplicateKey(error) || attempt === 2) throw error;
    }
  }

  return {
    employeeId: String(employeeId),
    asOf,
    policyResolved: true,
    plannedCredits: planned.length,
    postedCredits,
    existingCredits,
    postedUnits: Math.round((postedUnits + Number.EPSILON) * 10000) / 10000,
  };
}

export async function runCompanyLeaveAccrualCatchUp(options: {
  companyId: unknown;
  asOf?: unknown;
  employeeId?: unknown;
}) {
  const company = objectId(options.companyId, "company id");
  const asOf = dateKey(options.asOf || currentDateKey(), "accrual date");
  const match: any = {
    company,
    role: { $in: ["user", "departmenthead", "hr", "hradmin"] },
    deletedAt: { $exists: false },
    is_enabled: { $ne: false },
  };
  if (options.employeeId) match._id = objectId(options.employeeId, "employee id");

  let lastId: mongoose.Types.ObjectId | null = null;
  let processedEmployees = 0;
  let employeesWithPolicy = 0;
  let postedCredits = 0;
  let postedUnits = 0;
  const failures: Array<{ employeeId: string; message: string }> = [];

  while (true) {
    const pageMatch = lastId ? { ...match, _id: { $gt: lastId } } : match;
    const employees = await User.find(pageMatch)
      .select(EMPLOYEE_FIELDS)
      .sort({ _id: 1 })
      .limit(100)
      .lean();
    if (!employees.length) break;

    for (const employee of employees) {
      processedEmployees += 1;
      try {
        const result = await ensureEmployeeLeaveAccruals({ companyId: company, employee, asOf });
        if (result.policyResolved) employeesWithPolicy += 1;
        postedCredits += result.postedCredits;
        postedUnits += result.postedUnits;
      } catch (error: any) {
        failures.push({
          employeeId: String(employee._id),
          message: String(error?.message || "Leave accrual failed"),
        });
      }
    }
    lastId = employees[employees.length - 1]._id as mongoose.Types.ObjectId;
    if (employees.length < 100 || options.employeeId) break;
  }

  return {
    companyId: String(company),
    asOf,
    processedEmployees,
    employeesWithPolicy,
    postedCredits,
    postedUnits: Math.round((postedUnits + Number.EPSILON) * 10000) / 10000,
    failedEmployees: failures.length,
    failures: failures.slice(0, 50),
  };
}

export async function runAllCompaniesLeaveAccrualCatchUp(asOf: unknown = currentDateKey()) {
  const companies = await User.distinct("company", {
    company: { $ne: null },
    role: { $in: ["user", "departmenthead", "hr", "hradmin"] },
    deletedAt: { $exists: false },
    is_enabled: { $ne: false },
  });
  const results = [];
  for (const companyId of companies) {
    try {
      results.push(await runCompanyLeaveAccrualCatchUp({ companyId, asOf }));
    } catch (error: any) {
      results.push({
        companyId: String(companyId),
        asOf: dateKey(asOf, "accrual date"),
        failedEmployees: 1,
        failures: [{ employeeId: "", message: String(error?.message || "Company accrual failed") }],
      });
    }
  }
  return results;
}
