import ExcelJS from "exceljs";
import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import PayrollEmployeeSnapshot from "../../schemas/Payroll/PayrollEmployeeSnapshot.schema";
import PayrollFinalizedResult from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import { ensurePayrollRunManager, resolvePayrollCompany } from "./payroll.utils";

const text = (value: unknown) => String(value ?? "").trim();
const id = (value: unknown) => String((value as any)?._id || value || "");
const number = (value: unknown) => Number(value || 0);

type StatutoryModuleDefinition = {
  key: "provident_fund" | "employee_state_insurance" | "professional_tax" | "labour_welfare_fund" | "income_tax_withholding";
  label: string;
  registrationKey: string;
  identifierKey?: string;
  identifierLabel?: string;
};

const STATUTORY_MODULES: readonly StatutoryModuleDefinition[] = [
  { key: "provident_fund", label: "Provident fund", registrationKey: "providentFundEstablishmentCode", identifierKey: "uan", identifierLabel: "UAN" },
  { key: "employee_state_insurance", label: "Employee State Insurance", registrationKey: "employeeStateInsuranceCode", identifierKey: "esiInsuranceNumber", identifierLabel: "ESI insurance number" },
  { key: "professional_tax", label: "Professional tax", registrationKey: "professionalTaxRegistrationNumber" },
  { key: "labour_welfare_fund", label: "Labour welfare fund", registrationKey: "labourWelfareFundRegistrationNumber" },
  { key: "income_tax_withholding", label: "Income-tax withholding", registrationKey: "taxDeductionAccountNumber", identifierKey: "panNumber", identifierLabel: "PAN" },
] as const;

type ModuleKey = (typeof STATUTORY_MODULES)[number]["key"];

export type StatutoryContributionLine = {
  moduleKey: string;
  code: string;
  name: string;
  side: "employee_deduction" | "employer_contribution";
  wageBaseMinor: number;
  rateBps: number;
  amountMinor: number;
  ruleVersion: string;
  ruleEffectiveFrom: string;
  metadata?: Record<string, string | number | boolean>;
};

type ReportResult = {
  _id?: unknown;
  employee: unknown;
  employeeSnapshotVersion: number;
  identity?: Record<string, unknown>;
  organization?: Record<string, unknown>;
  payrollDays?: Record<string, number>;
  statutoryContributions?: StatutoryContributionLine[];
  totals?: Record<string, number>;
  finalizedAt?: Date | string;
  snapshotHash?: string;
};

type ReportSnapshot = {
  employee: unknown;
  snapshotVersion: number;
  statutory?: Record<string, any>;
};

type AggregatedLine = {
  moduleKey: string;
  code: string;
  name: string;
  side: string;
  ruleVersion: string;
  ruleEffectiveFrom: string;
  employeeCount: number;
  wageBaseMinor: number;
  amountMinor: number;
};

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function pageNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function finalizationVersion(value: unknown, maximum: number) {
  const parsed = value === undefined ? maximum : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw generateError("Invalid payroll finalization version", 422);
  }
  return parsed;
}

function moduleKey(value: unknown): "all" | ModuleKey {
  const normalized = text(value || "all").toLowerCase();
  if (normalized === "all") return "all";
  if (!STATUTORY_MODULES.some((module) => module.key === normalized)) {
    throw generateError("Invalid statutory report module", 422);
  }
  return normalized as ModuleKey;
}

function snapshotKey(employee: unknown, version: unknown) {
  return `${id(employee)}:${Number(version || 0)}`;
}

function maskEnd(value: unknown, visible = 4) {
  const normalized = text(value);
  if (!normalized) return "";
  if (normalized.length <= visible) return "*".repeat(normalized.length);
  return `${"*".repeat(normalized.length - visible)}${normalized.slice(-visible)}`;
}

function filteredLines(result: ReportResult, selectedModule: "all" | ModuleKey) {
  const lines = Array.isArray(result.statutoryContributions) ? result.statutoryContributions : [];
  return selectedModule === "all" ? lines : lines.filter((line) => line.moduleKey === selectedModule);
}

function buildSnapshotMap(snapshots: ReportSnapshot[]) {
  return new Map(snapshots.map((snapshot) => [snapshotKey(snapshot.employee, snapshot.snapshotVersion), snapshot]));
}

export function buildStatutoryReportModules(options: {
  enabledModules?: string[];
  configuration?: Record<string, unknown>;
  lines: AggregatedLine[];
  resultReferences: Array<{ employee: unknown; employeeSnapshotVersion: number; moduleKeys: string[] }>;
  snapshots: ReportSnapshot[];
}) {
  const configuration = options.configuration || {};
  const enabled = new Set((options.enabledModules || []).map(text));
  const snapshotMap = buildSnapshotMap(options.snapshots);

  return STATUTORY_MODULES
    .filter((definition) => enabled.has(definition.key) || options.lines.some((line) => line.moduleKey === definition.key))
    .map((definition) => {
      const lines = options.lines.filter((line) => line.moduleKey === definition.key);
      const references = options.resultReferences.filter((reference) => reference.moduleKeys.includes(definition.key));
      const employeeIds = new Set(references.map((reference) => id(reference.employee)));
      let missingIdentifierCount = 0;
      if (definition.identifierKey) {
        for (const reference of references) {
          const snapshot = snapshotMap.get(snapshotKey(reference.employee, reference.employeeSnapshotVersion));
          if (!text(snapshot?.statutory?.[definition.identifierKey])) missingIdentifierCount += 1;
        }
      }
      const registrationConfigured = Boolean(text(configuration[definition.registrationKey]));
      const blockers: string[] = [];
      if (!registrationConfigured) blockers.push(`${definition.label} employer registration is missing from the frozen statutory profile`);
      if (missingIdentifierCount && definition.identifierLabel) blockers.push(`${missingIdentifierCount} employee(s) are missing ${definition.identifierLabel}`);
      return {
        key: definition.key,
        label: definition.label,
        employeeCount: employeeIds.size,
        employeeDeductionMinor: lines.filter((line) => line.side === "employee_deduction").reduce((sum, line) => sum + number(line.amountMinor), 0),
        employerContributionMinor: lines.filter((line) => line.side === "employer_contribution").reduce((sum, line) => sum + number(line.amountMinor), 0),
        registrationConfigured,
        missingIdentifierCount,
        registerReady: blockers.length === 0,
        blockers,
      };
    });
}

export function serializeStatutoryReportEmployee(
  result: ReportResult,
  snapshot: ReportSnapshot | undefined,
  selectedModule: "all" | ModuleKey
) {
  const statutory = snapshot?.statutory || {};
  return {
    _id: result._id,
    employee: result.employee,
    identity: result.identity || {},
    organization: result.organization || {},
    payrollDays: result.payrollDays || {},
    totals: result.totals || {},
    identifiers: {
      panMasked: maskEnd(statutory.panNumber, 3),
      uanMasked: maskEnd(statutory.uan),
      pfMemberIdMasked: maskEnd(statutory.pfMemberId),
      esiInsuranceNumberMasked: maskEnd(statutory.esiInsuranceNumber),
    },
    contributions: filteredLines(result, selectedModule),
    snapshotHash: result.snapshotHash || "",
  };
}

function aggregateLines(results: ReportResult[], selectedModule: "all" | ModuleKey): AggregatedLine[] {
  const groups = new Map<string, AggregatedLine & { employees: Set<string> }>();
  for (const result of results) {
    for (const line of filteredLines(result, selectedModule)) {
      const key = [line.moduleKey, line.code, line.side, line.ruleVersion, line.ruleEffectiveFrom].join("|");
      const existing = groups.get(key) || {
        moduleKey: text(line.moduleKey),
        code: text(line.code),
        name: text(line.name),
        side: text(line.side),
        ruleVersion: text(line.ruleVersion),
        ruleEffectiveFrom: text(line.ruleEffectiveFrom),
        employeeCount: 0,
        wageBaseMinor: 0,
        amountMinor: 0,
        employees: new Set<string>(),
      };
      existing.employees.add(id(result.employee));
      existing.wageBaseMinor += number(line.wageBaseMinor);
      existing.amountMinor += number(line.amountMinor);
      groups.set(key, existing);
    }
  }
  return [...groups.values()]
    .map(({ employees, ...line }) => ({ ...line, employeeCount: employees.size }))
    .sort((left, right) => `${left.moduleKey}:${left.code}:${left.side}`.localeCompare(`${right.moduleKey}:${right.code}:${right.side}`));
}

function resultReferences(results: ReportResult[]) {
  return results.map((result) => ({
    employee: result.employee,
    employeeSnapshotVersion: number(result.employeeSnapshotVersion),
    moduleKeys: [...new Set((result.statutoryContributions || []).map((line) => text(line.moduleKey)).filter(Boolean))],
  }));
}

export function buildStatutoryReportData(options: {
  run: any;
  results: ReportResult[];
  snapshots: ReportSnapshot[];
  finalizationVersion: number;
  selectedModule?: "all" | ModuleKey;
}) {
  const selectedModule = options.selectedModule || "all";
  const lines = aggregateLines(options.results, selectedModule);
  const modules = buildStatutoryReportModules({
    enabledModules: options.run.statutoryEnabledModules || [],
    configuration: options.run.statutoryConfigurationSnapshot || {},
    lines,
    resultReferences: resultReferences(options.results),
    snapshots: options.snapshots,
  }).filter((module) => selectedModule === "all" || module.key === selectedModule);
  const employees = new Set<string>();
  for (const result of options.results) {
    if (filteredLines(result, selectedModule).length) employees.add(id(result.employee));
  }
  return {
    source: {
      payrollRunId: options.run._id,
      periodKey: options.run.periodKey,
      finalizationVersion: options.finalizationVersion,
      finalizedAt: options.results[0]?.finalizedAt || options.run.finalizedAt,
      providerKey: options.run.statutoryProviderKey || "",
      providerImplementationVersion: options.run.statutoryProviderImplementationVersion || "",
      statutoryProfileVersionNumber: options.run.statutoryProfileVersionNumber || 0,
    },
    scope: selectedModule,
    employeeCount: employees.size,
    employeeDeductionMinor: lines.filter((line) => line.side === "employee_deduction").reduce((sum, line) => sum + line.amountMinor, 0),
    employerContributionMinor: lines.filter((line) => line.side === "employer_contribution").reduce((sum, line) => sum + line.amountMinor, 0),
    modules,
    lines,
  };
}

function money(value: unknown, minorUnits: number) {
  return number(value) / 10 ** minorUnits;
}

function styleWorksheet(sheet: ExcelJS.Worksheet, frozenRows = 1) {
  sheet.views = [{ state: "frozen", ySplit: frozenRows }];
  sheet.autoFilter = frozenRows === 1 ? { from: "A1", to: sheet.getRow(1).getCell(sheet.columnCount).address } : undefined;
  const header = sheet.getRow(frozenRows);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E5EFF" } };
  header.alignment = { vertical: "middle" };
  sheet.columns.forEach((column) => {
    let width = 12;
    column.eachCell?.({ includeEmpty: false }, (cell) => { width = Math.max(width, Math.min(40, text(cell.value).length + 2)); });
    column.width = width;
  });
}

function contributionRows(results: ReportResult[], snapshots: ReportSnapshot[], selectedModule: "all" | ModuleKey, minorUnits: number) {
  const snapshotMap = buildSnapshotMap(snapshots);
  return results.flatMap((result) => {
    const snapshot = snapshotMap.get(snapshotKey(result.employee, result.employeeSnapshotVersion));
    const statutory = snapshot?.statutory || {};
    return filteredLines(result, selectedModule).map((line) => ({
      employeeCode: text(result.identity?.code),
      employeeName: text(result.identity?.name),
      username: text(result.identity?.username),
      department: text(result.organization?.departmentName),
      team: text(result.organization?.teamName),
      location: text(result.organization?.officeLocationName),
      state: text(result.organization?.officeLocationState),
      paidDays: number(result.payrollDays?.paidDays),
      unpaidDays: number(result.payrollDays?.unpaidDays),
      pan: text(statutory.panNumber),
      uan: text(statutory.uan),
      pfMemberId: text(statutory.pfMemberId),
      esiInsuranceNumber: text(statutory.esiInsuranceNumber),
      module: text(line.moduleKey),
      code: text(line.code),
      contribution: text(line.name),
      side: text(line.side),
      wageBase: money(line.wageBaseMinor, minorUnits),
      ratePercent: number(line.rateBps) / 100,
      amount: money(line.amountMinor, minorUnits),
      ruleVersion: text(line.ruleVersion),
      ruleEffectiveFrom: text(line.ruleEffectiveFrom),
      snapshotHash: text(result.snapshotHash),
    }));
  });
}

export async function buildStatutoryReportWorkbook(options: {
  run: any;
  results: ReportResult[];
  snapshots: ReportSnapshot[];
  finalizationVersion: number;
  selectedModule?: "all" | ModuleKey;
}) {
  const selectedModule = options.selectedModule || "all";
  const report = buildStatutoryReportData({ ...options, selectedModule });
  const minorUnits = number(options.run.currencyMinorUnits ?? 2);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "HRMS";
  workbook.created = new Date();

  const cover = workbook.addWorksheet("Report information");
  cover.addRows([
    ["Statutory review workbook"],
    ["Purpose", "Payroll statutory reconciliation and filing preparation"],
    ["Authority upload file", "No - validate the current authority template or utility before submission"],
    ["Company", options.run.companyNameSnapshot],
    ["Company code", options.run.companyCodeSnapshot],
    ["Payroll period", options.run.periodKey],
    ["Cycle", `${options.run.cycleStartDate} to ${options.run.cycleEndDate}`],
    ["Finalization version", options.finalizationVersion],
    ["Finalized at", options.results[0]?.finalizedAt ? new Date(options.results[0].finalizedAt).toISOString() : ""],
    ["Provider", options.run.statutoryProviderKey],
    ["Provider implementation", options.run.statutoryProviderImplementationVersion],
    ["Statutory profile version", options.run.statutoryProfileVersionNumber],
    ["Scope", selectedModule],
    ["Currency", options.run.currency],
  ]);
  cover.getRow(1).font = { bold: true, size: 16, color: { argb: "FF1E5EFF" } };
  cover.mergeCells("A1:B1");
  cover.getColumn(1).width = 30;
  cover.getColumn(2).width = 80;

  const registration = workbook.addWorksheet("Frozen registrations");
  registration.columns = [{ header: "Configuration key", key: "key" }, { header: "Frozen value", key: "value" }];
  Object.entries(options.run.statutoryConfigurationSnapshot || {}).forEach(([key, value]) => registration.addRow({ key, value: text(value) }));
  styleWorksheet(registration);

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Module", key: "module" }, { header: "Code", key: "code" }, { header: "Contribution", key: "name" },
    { header: "Side", key: "side" }, { header: "Employees", key: "employeeCount" }, { header: "Wage base", key: "wageBase" },
    { header: "Amount", key: "amount" }, { header: "Rule version", key: "ruleVersion" }, { header: "Effective from", key: "ruleEffectiveFrom" },
  ];
  report.lines.forEach((line) => summary.addRow({ ...line, module: line.moduleKey, wageBase: money(line.wageBaseMinor, minorUnits), amount: money(line.amountMinor, minorUnits) }));
  summary.getColumn("wageBase").numFmt = "#,##0.00";
  summary.getColumn("amount").numFmt = "#,##0.00";
  styleWorksheet(summary);

  const readiness = workbook.addWorksheet("Readiness");
  readiness.columns = [
    { header: "Module", key: "label" }, { header: "Employees", key: "employeeCount" },
    { header: "Registration configured", key: "registrationConfigured" }, { header: "Missing employee IDs", key: "missingIdentifierCount" },
    { header: "Register ready", key: "registerReady" }, { header: "Blockers", key: "blockers" },
  ];
  report.modules.forEach((module) => readiness.addRow({ ...module, registrationConfigured: module.registrationConfigured ? "Yes" : "No", registerReady: module.registerReady ? "Yes" : "No", blockers: module.blockers.join("; ") }));
  styleWorksheet(readiness);

  const allRows = contributionRows(options.results, options.snapshots, selectedModule, minorUnits);
  const addContributionSheet = (name: string, rows: typeof allRows) => {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = [
      { header: "Employee code", key: "employeeCode" }, { header: "Employee name", key: "employeeName" }, { header: "Username", key: "username" },
      { header: "Department", key: "department" }, { header: "Team", key: "team" }, { header: "Location", key: "location" }, { header: "State", key: "state" },
      { header: "Paid days", key: "paidDays" }, { header: "Unpaid days", key: "unpaidDays" }, { header: "PAN", key: "pan" }, { header: "UAN", key: "uan" },
      { header: "PF member ID", key: "pfMemberId" }, { header: "ESI insurance number", key: "esiInsuranceNumber" }, { header: "Module", key: "module" },
      { header: "Code", key: "code" }, { header: "Contribution", key: "contribution" }, { header: "Side", key: "side" },
      { header: "Wage base", key: "wageBase" }, { header: "Rate %", key: "ratePercent" }, { header: "Amount", key: "amount" },
      { header: "Rule version", key: "ruleVersion" }, { header: "Rule effective from", key: "ruleEffectiveFrom" }, { header: "Finalized result hash", key: "snapshotHash" },
    ];
    rows.forEach((row) => sheet.addRow(row));
    sheet.getColumn("wageBase").numFmt = "#,##0.00";
    sheet.getColumn("ratePercent").numFmt = "0.00";
    sheet.getColumn("amount").numFmt = "#,##0.00";
    styleWorksheet(sheet);
  };
  addContributionSheet("All contributions", allRows);
  for (const definition of STATUTORY_MODULES) {
    const rows = allRows.filter((row) => row.module === definition.key);
    if (rows.length) addContributionSheet(definition.label.slice(0, 31), rows);
  }
  return workbook.xlsx.writeBuffer();
}

async function loadRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId) {
  const run: any = await PayrollRun.findOne({ _id: runId, company }).lean();
  if (!run) throw generateError("Payroll run not found", 404);
  if (!number(run.finalizationVersion)) throw generateError("Finalize payroll before generating statutory reports", 409);
  if (!text(run.statutoryProviderKey)) throw generateError("This payroll run has no frozen statutory provider", 409);
  if (text(run.statutoryProviderKey) !== "india_standard") {
    throw generateError(`Statutory reports are not implemented for provider ${run.statutoryProviderKey}`, 422);
  }
  return run;
}

async function loadSnapshots(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId, results: ReportResult[]) {
  if (!results.length) return [];
  const employeeIds = [...new Set(results.map((result) => id(result.employee)))].map((value) => new mongoose.Types.ObjectId(value));
  const versions = [...new Set(results.map((result) => number(result.employeeSnapshotVersion)))];
  return PayrollEmployeeSnapshot.find({ company, payrollRun: runId, employee: { $in: employeeIds }, snapshotVersion: { $in: versions } })
    .select("employee snapshotVersion statutory")
    .lean() as unknown as Promise<ReportSnapshot[]>;
}

function reportMatch(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId, version: number, selectedModule: "all" | ModuleKey, regex?: RegExp) {
  return {
    company,
    payrollRun: runId,
    finalizationVersion: version,
    ...(selectedModule === "all" ? {} : { statutoryContributions: { $elemMatch: { moduleKey: selectedModule } } }),
    ...(regex ? { $or: [{ "identity.name": regex }, { "identity.code": regex }, { "identity.username": regex }] } : {}),
  };
}

export async function getPayrollStatutoryReportService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = objectId(req.params.runId, "payroll run id");
    const run = await loadRun(companyObjectId, runId);
    const version = finalizationVersion(req.query?.finalizationVersion, number(run.finalizationVersion));
    const selectedModule = moduleKey(req.query?.module);
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 25, 100);
    const search = text(req.query?.search);
    const regex = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : undefined;
    const sourceMatch = reportMatch(companyObjectId, runId, version, "all");
    const itemMatch = reportMatch(companyObjectId, runId, version, selectedModule, regex);
    const sourceProjection = "employee employeeSnapshotVersion statutoryContributions finalizedAt";
    const itemProjection = "employee employeeSnapshotVersion identity organization payrollDays statutoryContributions totals finalizedAt snapshotHash";
    const [sourceResults, items, total] = await Promise.all([
      PayrollFinalizedResult.find(sourceMatch).select(sourceProjection).lean(),
      PayrollFinalizedResult.find(itemMatch).select(itemProjection).sort({ "identity.code": 1, "identity.name": 1 }).skip((page - 1) * limit).limit(limit).lean(),
      PayrollFinalizedResult.countDocuments(itemMatch),
    ]);
    const reportResults = sourceResults as unknown as ReportResult[];
    const snapshotResults = selectedModule === "all"
      ? reportResults
      : reportResults.filter((result) => filteredLines(result, selectedModule).length > 0);
    const [sourceSnapshots, itemSnapshots] = await Promise.all([
      loadSnapshots(companyObjectId, runId, snapshotResults),
      loadSnapshots(companyObjectId, runId, items as unknown as ReportResult[]),
    ]);
    const itemSnapshotMap = buildSnapshotMap(itemSnapshots);
    const report = buildStatutoryReportData({ run, results: reportResults, snapshots: sourceSnapshots, finalizationVersion: version, selectedModule });
    return res.status(200).json({
      success: true,
      data: {
        run,
        report,
        items: (items as unknown as ReportResult[]).map((result) => serializeStatutoryReportEmployee(result, itemSnapshotMap.get(snapshotKey(result.employee, result.employeeSnapshotVersion)), selectedModule)),
      },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

export async function exportPayrollStatutoryReportService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = objectId(req.params.runId, "payroll run id");
    const run = await loadRun(companyObjectId, runId);
    const version = finalizationVersion(req.query?.finalizationVersion, number(run.finalizationVersion));
    const selectedModule = moduleKey(req.query?.module);
    const results = await PayrollFinalizedResult.find(reportMatch(companyObjectId, runId, version, "all"))
      .select("employee employeeSnapshotVersion identity organization payrollDays statutoryContributions totals finalizedAt snapshotHash")
      .sort({ "identity.code": 1, "identity.name": 1 })
      .lean();
    if (!results.length) throw generateError("No finalized statutory contribution rows are available for this report", 404);
    const snapshots = await loadSnapshots(companyObjectId, runId, results as unknown as ReportResult[]);
    const buffer = await buildStatutoryReportWorkbook({ run, results: results as unknown as ReportResult[], snapshots, finalizationVersion: version, selectedModule });
    const scope = selectedModule === "all" ? "all" : selectedModule.replace(/_/g, "-");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="statutory-report-${run.periodKey}-v${version}-${scope}.xlsx"`);
    return res.status(200).send(Buffer.from(buffer as ArrayBuffer));
  } catch (error) {
    next(error);
  }
}
