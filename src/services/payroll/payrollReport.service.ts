import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import PayrollFinalizedResult from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import { writePayrollAccessLog } from "./payrollAccess.service";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
} from "./payroll.utils";

export const PAYROLL_REPORT_TYPES = ["register", "variance", "cost", "deductions", "departments"] as const;
export type PayrollReportType = (typeof PAYROLL_REPORT_TYPES)[number];

const text = (value: unknown) => String(value ?? "").trim();
const amount = (value: unknown) => Number(value || 0);

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

function reportType(value: unknown): PayrollReportType {
  const normalized = text(value).toLowerCase();
  if (!PAYROLL_REPORT_TYPES.includes(normalized as PayrollReportType)) {
    throw generateError("Invalid payroll report type", 422);
  }
  return normalized as PayrollReportType;
}

function safeRegex(value: string) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function resultMatch(options: {
  company: mongoose.Types.ObjectId;
  run: mongoose.Types.ObjectId;
  finalizationVersion: number;
  search?: string;
}) {
  const regex = options.search ? safeRegex(options.search) : null;
  return {
    company: options.company,
    payrollRun: options.run,
    finalizationVersion: options.finalizationVersion,
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
}

async function reportContext(company: mongoose.Types.ObjectId, runIdInput: unknown, requestedVersion?: unknown) {
  const runId = objectId(runIdInput, "payroll run id");
  const run: any = await PayrollRun.findOne({ _id: runId, company }).lean();
  if (!run) throw generateError("Payroll run not found", 404);
  const version = requestedVersion === undefined || requestedVersion === ""
    ? Number(run.finalizationVersion || 0)
    : Number(requestedVersion);
  if (!Number.isInteger(version) || version < 1 || version > Number(run.finalizationVersion || 0)) {
    throw generateError("A finalized payroll version is required", 409);
  }
  return { run, runId, version };
}

function source(run: any, version: number, previousRun?: any | null, finalizedAt?: Date | string | null) {
  return {
    payrollRunId: run._id,
    periodKey: run.periodKey,
    cycleStartDate: run.cycleStartDate,
    cycleEndDate: run.cycleEndDate,
    finalizationVersion: version,
    finalizedAt: finalizedAt || run.finalizedAt,
    currency: run.currency,
    currencyMinorUnits: run.currencyMinorUnits,
    previousPayrollRunId: previousRun?._id || null,
    previousPeriodKey: previousRun?.periodKey || null,
  };
}

export function serializePayrollRegisterRow(result: any) {
  return {
    employeeId: result.employee,
    employeeCode: text(result.identity?.code),
    employeeName: text(result.identity?.name),
    designation: text(result.organization?.designation),
    department: text(result.organization?.departmentName) || "Unassigned",
    team: text(result.organization?.teamName) || "Unassigned",
    location: text(result.organization?.officeLocationName) || "Unassigned",
    paidDays: amount(result.payrollDays?.paidDays),
    unpaidDays: amount(result.payrollDays?.unpaidDays),
    grossEarningsMinor: amount(result.totals?.grossEarningsMinor),
    totalDeductionsMinor: amount(result.totals?.totalDeductionsMinor),
    totalReimbursementsMinor: amount(result.totals?.totalReimbursementsMinor),
    netPayMinor: amount(result.totals?.netPayMinor),
    employerCostMinor: amount(result.totals?.employerCostMinor),
    snapshotHash: text(result.snapshotHash),
  };
}

export function serializePayrollVarianceRow(current: any, previous?: any) {
  const currentRow = serializePayrollRegisterRow(current);
  const prior = previous ? serializePayrollRegisterRow(previous) : null;
  return {
    ...currentRow,
    previousGrossEarningsMinor: prior?.grossEarningsMinor || 0,
    grossVarianceMinor: currentRow.grossEarningsMinor - (prior?.grossEarningsMinor || 0),
    previousDeductionsMinor: prior?.totalDeductionsMinor || 0,
    deductionVarianceMinor: currentRow.totalDeductionsMinor - (prior?.totalDeductionsMinor || 0),
    previousNetPayMinor: prior?.netPayMinor || 0,
    netVarianceMinor: currentRow.netPayMinor - (prior?.netPayMinor || 0),
    previousEmployerCostMinor: prior?.employerCostMinor || 0,
    employerCostVarianceMinor: currentRow.employerCostMinor - (prior?.employerCostMinor || 0),
    comparisonAvailable: Boolean(prior),
  };
}

type MoneyGroup = {
  key: string;
  label: string;
  employeeIds: Set<string>;
  grossEarningsMinor: number;
  totalDeductionsMinor: number;
  netPayMinor: number;
  employerContributionsMinor: number;
  employerCostMinor: number;
};

function addMoneyGroup(groups: Map<string, MoneyGroup>, key: string, label: string, result: any) {
  const group = groups.get(key) || {
    key,
    label,
    employeeIds: new Set<string>(),
    grossEarningsMinor: 0,
    totalDeductionsMinor: 0,
    netPayMinor: 0,
    employerContributionsMinor: 0,
    employerCostMinor: 0,
  };
  group.employeeIds.add(String(result.employee));
  group.grossEarningsMinor += amount(result.totals?.grossEarningsMinor);
  group.totalDeductionsMinor += amount(result.totals?.totalDeductionsMinor);
  group.netPayMinor += amount(result.totals?.netPayMinor);
  group.employerContributionsMinor += amount(result.totals?.employerContributionsMinor);
  group.employerCostMinor += amount(result.totals?.employerCostMinor);
  groups.set(key, group);
}

function moneyGroupRows(groups: Map<string, MoneyGroup>) {
  return [...groups.values()]
    .map(({ employeeIds, ...group }) => ({ ...group, employeeCount: employeeIds.size }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

type DeductionGroup = {
  key: string;
  code: string;
  name: string;
  source: string;
  employeeIds: Set<string>;
  amountMinor: number;
};

function addDeduction(groups: Map<string, DeductionGroup>, input: {
  employee: unknown;
  code: unknown;
  name: unknown;
  source: string;
  amountMinor: unknown;
}) {
  const code = text(input.code).toUpperCase() || "UNSPECIFIED";
  const key = `${input.source}:${code}`;
  const group = groups.get(key) || {
    key,
    code,
    name: text(input.name) || code,
    source: input.source,
    employeeIds: new Set<string>(),
    amountMinor: 0,
  };
  group.employeeIds.add(String(input.employee));
  group.amountMinor += amount(input.amountMinor);
  groups.set(key, group);
}

export async function buildPayrollReport(options: {
  company: mongoose.Types.ObjectId;
  run: any;
  finalizationVersion: number;
  type: PayrollReportType;
  page?: number;
  limit?: number;
  search?: string;
  exportAll?: boolean;
}) {
  const page = options.page || 1;
  const limit = options.limit || 25;
  const match = resultMatch({
    company: options.company,
    run: options.run._id,
    finalizationVersion: options.finalizationVersion,
    search: options.search,
  });
  const [summary] = await PayrollFinalizedResult.aggregate([
    {
      $match: {
        company: options.company,
        payrollRun: options.run._id,
        finalizationVersion: options.finalizationVersion,
      },
    },
    {
      $group: {
        _id: null,
        employeeCount: { $sum: 1 },
        grossEarningsMinor: { $sum: "$totals.grossEarningsMinor" },
        totalDeductionsMinor: { $sum: "$totals.totalDeductionsMinor" },
        totalReimbursementsMinor: { $sum: "$totals.totalReimbursementsMinor" },
        netPayMinor: { $sum: "$totals.netPayMinor" },
        employerContributionsMinor: { $sum: "$totals.employerContributionsMinor" },
        employerCostMinor: { $sum: "$totals.employerCostMinor" },
        finalizedAt: { $min: "$finalizedAt" },
      },
    },
  ]);
  const { _id: _summaryId, finalizedAt, ...baseSummary } = summary || {
    employeeCount: 0,
    grossEarningsMinor: 0,
    totalDeductionsMinor: 0,
    totalReimbursementsMinor: 0,
    netPayMinor: 0,
    employerContributionsMinor: 0,
    employerCostMinor: 0,
    finalizedAt: null,
  };

  if (options.type === "register" || options.type === "variance") {
    const total = await PayrollFinalizedResult.countDocuments(match);
    if (options.exportAll && total > 50_000) {
      throw generateError("This export exceeds 50,000 employees. Narrow the search or export in smaller scopes", 422);
    }
    const query = PayrollFinalizedResult.find(match).sort({ "identity.code": 1, "identity.name": 1 });
    if (!options.exportAll) query.skip((page - 1) * limit).limit(limit);
    const current: any[] = await query.lean();
    let previousRun: any = null;
    let items: any[] = current.map(serializePayrollRegisterRow);
    if (options.type === "variance") {
      previousRun = await PayrollRun.findOne({
        company: options.company,
        periodKey: { $lt: options.run.periodKey },
        finalizationVersion: { $gte: 1 },
      }).sort({ periodKey: -1 }).lean();
      const previous = previousRun
        ? await PayrollFinalizedResult.find({
            company: options.company,
            payrollRun: previousRun._id,
            finalizationVersion: previousRun.finalizationVersion,
            employee: { $in: current.map((item) => item.employee) },
          }).lean()
        : [];
      const previousByEmployee = new Map(previous.map((item: any) => [String(item.employee), item]));
      items = current.map((item) => serializePayrollVarianceRow(item, previousByEmployee.get(String(item.employee))));
    }
    return {
      type: options.type,
      source: source(options.run, options.finalizationVersion, previousRun, finalizedAt),
      summary: baseSummary,
      items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  if (options.type === "deductions") {
    const groups = new Map<string, DeductionGroup>();
    const cursor = PayrollFinalizedResult.find(match)
      .select("employee recurringComponents oneTimeInputs statutoryContributions")
      .lean()
      .cursor();
    for await (const result of cursor as any) {
      for (const line of result.recurringComponents || []) {
        if (line.category === "deduction") addDeduction(groups, { employee: result.employee, code: line.componentCode, name: line.componentName, source: "Recurring", amountMinor: line.payableAmountMinor });
      }
      for (const line of result.oneTimeInputs || []) {
        if (["deduction", "recovery"].includes(line.inputType) || line.category === "deduction") addDeduction(groups, { employee: result.employee, code: line.componentCode, name: line.componentName, source: "One-time", amountMinor: line.amountMinor });
      }
      for (const line of result.statutoryContributions || []) {
        if (line.side === "employee_deduction") addDeduction(groups, { employee: result.employee, code: line.code, name: line.name, source: "Statutory", amountMinor: line.amountMinor });
      }
    }
    const allItems = [...groups.values()]
      .map(({ employeeIds, ...item }) => ({ ...item, employeeCount: employeeIds.size }))
      .sort((left, right) => right.amountMinor - left.amountMinor || left.code.localeCompare(right.code));
    const items = options.exportAll ? allItems : allItems.slice((page - 1) * limit, page * limit);
    return {
      type: options.type,
      source: source(options.run, options.finalizationVersion, null, finalizedAt),
      summary: { ...baseSummary, deductionLineCount: allItems.length },
      items,
      pagination: { page, limit, total: allItems.length, totalPages: Math.max(1, Math.ceil(allItems.length / limit)) },
    };
  }

  const groups = new Map<string, MoneyGroup>();
  const cursor = PayrollFinalizedResult.find(match)
    .select("employee organization totals")
    .lean()
    .cursor();
  for await (const result of cursor as any) {
    const value = options.type === "cost"
      ? text(result.organization?.officeLocationName) || "Unassigned location"
      : text(result.organization?.departmentName) || "Unassigned department";
    const groupId = options.type === "cost"
      ? text(result.organization?.officeLocation) || value.toLowerCase()
      : text(result.organization?.department) || value.toLowerCase();
    addMoneyGroup(groups, groupId, value, result);
  }
  const allItems = moneyGroupRows(groups);
  const items = options.exportAll ? allItems : allItems.slice((page - 1) * limit, page * limit);
  return {
    type: options.type,
    source: source(options.run, options.finalizationVersion, null, finalizedAt),
    summary: { ...baseSummary, groupCount: allItems.length },
    items,
    pagination: { page, limit, total: allItems.length, totalPages: Math.max(1, Math.ceil(allItems.length / limit)) },
  };
}

function csvCell(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value);
  const protectedValue = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${protectedValue.replace(/"/g, '""')}"`;
}

export function reportCsv(report: any) {
  const rows = report.items || [];
  if (!rows.length) return "No data\r\n";
  const keys = Object.keys(rows[0]).filter((key) => !["employeeId", "snapshotHash", "key"].includes(key));
  const minorUnits = Number(report?.source?.currencyMinorUnits ?? 2);
  const currency = text(report?.source?.currency || "INR").toUpperCase();
  const headers = keys.map((key) => key.endsWith("Minor") ? `${key.slice(0, -5)} (${currency})` : key);
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row: any) => keys.map((key) => csvCell(key.endsWith("Minor") ? amount(row[key]) / 10 ** minorUnits : row[key])).join(",")),
  ].join("\r\n");
}

export async function getPayrollReportService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId, company } = await resolvePayrollCompany(req, req.query?.companyId);
    const type = reportType(req.params.reportType);
    const context = await reportContext(companyObjectId, req.query?.runId, req.query?.finalizationVersion);
    const page = boundedInteger(req.query?.page, 1, 1, 100_000);
    const limit = boundedInteger(req.query?.limit, 25, 1, 100);
    const report = await buildPayrollReport({
      company: companyObjectId,
      run: context.run,
      finalizationVersion: context.version,
      type,
      page,
      limit,
      search: text(req.query?.search),
    });
    await writePayrollAccessLog({
      req,
      company: companyObjectId,
      actor: getPayrollActorId(req),
      action: "report_viewed",
      resourceType: "payroll_report",
      resourceId: `${type}:${context.runId}:${context.version}`,
      payrollRun: context.runId,
      metadata: { type, finalizationVersion: context.version, page, limit, filtered: Boolean(text(req.query?.search)) },
      retentionDays: Number((company as any)?.payrollSettings?.accessLogRetentionDays || 365),
    });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    return res.status(200).json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
}

export async function exportPayrollReportService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId, company } = await resolvePayrollCompany(req, req.query?.companyId);
    const type = reportType(req.params.reportType);
    const context = await reportContext(companyObjectId, req.query?.runId, req.query?.finalizationVersion);
    const report = await buildPayrollReport({
      company: companyObjectId,
      run: context.run,
      finalizationVersion: context.version,
      type,
      page: 1,
      limit: 50_000,
      search: text(req.query?.search),
      exportAll: true,
    });
    await writePayrollAccessLog({
      req,
      company: companyObjectId,
      actor: getPayrollActorId(req),
      action: "report_exported",
      resourceType: "payroll_report",
      resourceId: `${type}:${context.runId}:${context.version}`,
      payrollRun: context.runId,
      purpose: text(req.query?.purpose) || "Payroll report export",
      metadata: { type, finalizationVersion: context.version, rowCount: report.items.length, filtered: Boolean(text(req.query?.search)) },
      retentionDays: Number((company as any)?.payrollSettings?.accessLogRetentionDays || 365),
    });
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="payroll-${type}-${context.run.periodKey}-v${context.version}.csv"`);
    return res.status(200).send(`\uFEFF${reportCsv(report)}`);
  } catch (error) {
    next(error);
  }
}
