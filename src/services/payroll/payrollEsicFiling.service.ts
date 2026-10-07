import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import * as XLSX from "@e965/xlsx";
import { generateError } from "../../config/Error/functions";
import PayrollEmployeeSnapshot from "../../schemas/Payroll/PayrollEmployeeSnapshot.schema";
import PayrollFinalizedResult from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import PayrollStatutoryFilingInput from "../../schemas/Payroll/PayrollStatutoryFilingInput.schema";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

const ADAPTER_KEY = "esic_monthly_contribution";
const ADAPTER_VERSION = "2025-mc-xls-v1";
const DATE_REASON_CODES = new Set([2, 3, 4, 5, 6, 10]);

export const ESIC_MONTHLY_REASON_CODES = [
  { code: 1, label: "On Leave", requiresLastWorkingDay: false },
  { code: 2, label: "Left Service", requiresLastWorkingDay: true },
  { code: 3, label: "Retired", requiresLastWorkingDay: true },
  { code: 4, label: "Out of Coverage", requiresLastWorkingDay: true },
  { code: 5, label: "Expired", requiresLastWorkingDay: true },
  { code: 6, label: "Non-Implemented Area", requiresLastWorkingDay: true },
  { code: 7, label: "Compliance by Immediate Employer", requiresLastWorkingDay: false },
  { code: 8, label: "Suspension of Work", requiresLastWorkingDay: false },
  { code: 9, label: "Strike/Lockout", requiresLastWorkingDay: false },
  { code: 10, label: "Retrenchment", requiresLastWorkingDay: true },
  { code: 11, label: "No Work", requiresLastWorkingDay: false },
  { code: 12, label: "Does Not Belong to This Employer", requiresLastWorkingDay: false },
  { code: 13, label: "Duplicate IP", requiresLastWorkingDay: false },
] as const;

const text = (value: unknown) => String(value ?? "").trim();
const id = (value: unknown) => String((value as any)?._id || value || "");

type ContributionLine = {
  moduleKey?: string;
  code?: string;
  wageBaseMinor?: number;
  amountMinor?: number;
};

type EsicResult = {
  employee: unknown;
  employeeSnapshotVersion: number;
  identity?: { name?: string; code?: string };
  payrollDays?: { paidDays?: number; unpaidDays?: number; totalDays?: number };
  statutoryContributions?: ContributionLine[];
};

type EsicSnapshot = {
  employee: unknown;
  snapshotVersion: number;
  identity?: { employmentEndDate?: Date | string | null };
  statutory?: {
    esiInsuranceNumber?: string;
    nameAsPerEsi?: string;
    applicability?: Record<string, boolean>;
  };
};

type EsicInput = {
  employee: unknown;
  revisionNumber: number;
  reasonCode: number;
  lastWorkingDay?: string;
};

export type EsicMonthlyBlocker = {
  code: string;
  message: string;
  employeeCode?: string;
  employeeName?: string;
};

export type EsicMonthlyRow = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  insuranceNumber: string;
  insuredPersonName: string;
  paidDays: number;
  totalMonthlyWages: number;
  reasonCode: number | null;
  reasonLabel: string;
  lastWorkingDay: string;
  reasonSource: "none" | "employment_exit" | "manual" | "missing";
  employeeContribution: number;
  employerContribution: number;
  inputRevision: number | null;
};

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function finalizationVersion(value: unknown, maximum: number) {
  const parsed = value === undefined || value === "" ? maximum : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw generateError("Invalid payroll finalization version", 422);
  }
  return parsed;
}

function snapshotKey(employee: unknown, snapshotVersion: unknown) {
  return `${id(employee)}:${Number(snapshotVersion || 0)}`;
}

function providerAtLeast(actual: unknown, required: string) {
  const left = text(actual).split(".").map((part) => Number(part));
  const right = required.split(".").map((part) => Number(part));
  if (left.length !== 3 || left.some((part) => !Number.isInteger(part) || part < 0)) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function line(result: EsicResult, code: string) {
  return (result.statutoryContributions || []).find((item) => text(item.code) === code);
}

function maskEnd(value: unknown, visible = 4) {
  const normalized = text(value);
  if (!normalized) return "";
  if (normalized.length <= visible) return "*".repeat(normalized.length);
  return `${"*".repeat(normalized.length - visible)}${normalized.slice(-visible)}`;
}

function isoDate(value: unknown) {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function formatPortalDate(value: string) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function reasonDefinition(code: number | null) {
  return ESIC_MONTHLY_REASON_CODES.find((item) => item.code === code);
}

function wholeRupees(value: unknown, label: string, add: (code: string, message: string) => void) {
  const minor = Number(value);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    add("invalid_minor_amount", `${label} is not a valid non-negative minor-unit amount`);
    return 0;
  }
  if (minor % 100 !== 0) add("fractional_rupee_amount", `${label} must be a whole-rupee amount for the ESIC upload`);
  return Math.round(minor / 100);
}

function validateReason(options: {
  reasonCode: number | null;
  lastWorkingDay: string;
  totalMonthlyWages: number;
  cycleEndDate: string;
  periodKey: string;
  add: (code: string, message: string) => void;
}) {
  const definition = reasonDefinition(options.reasonCode);
  if (options.reasonCode !== null && !definition) {
    options.add("invalid_reason_code", "ESIC reason code must be a supported numeric code from 1 to 13");
    return;
  }
  if (options.totalMonthlyWages === 0 && !definition) {
    options.add("missing_zero_wage_reason", "Select an ESIC reason for this zero-wage employee");
  }
  if (options.totalMonthlyWages > 0 && definition && !DATE_REASON_CODES.has(definition.code)) {
    options.add("reason_requires_zero_wages", `${definition.label} can be used only when monthly wages are zero`);
  }
  if (definition?.requiresLastWorkingDay) {
    if (!validIsoDate(options.lastWorkingDay)) {
      options.add("missing_last_working_day", `${definition.label} requires a valid last working day`);
    } else if (options.lastWorkingDay > options.cycleEndDate) {
      options.add("last_working_day_after_cycle", "Last working day cannot be after the payroll cycle end date");
    }
  } else if (options.lastWorkingDay) {
    options.add("unexpected_last_working_day", "Last working day must be blank for the selected ESIC reason");
  }
  if (definition?.code === 4 && !options.periodKey.endsWith("-04") && !options.periodKey.endsWith("-10")) {
    options.add("out_of_coverage_period", "Out of Coverage can be filed only for April or October");
  }
}

export function buildEsicMonthlyContributionFiling(options: {
  run: any;
  finalizationVersion: number;
  results: EsicResult[];
  snapshots: EsicSnapshot[];
  filingInputs?: EsicInput[];
}) {
  const blockers: EsicMonthlyBlocker[] = [];
  const rows: EsicMonthlyRow[] = [];
  const snapshotMap = new Map(options.snapshots.map((snapshot) => [snapshotKey(snapshot.employee, snapshot.snapshotVersion), snapshot]));
  const inputMap = new Map((options.filingInputs || []).map((input) => [id(input.employee), input]));
  const configuration = options.run.statutoryConfigurationSnapshot || {};

  if (text(options.run.statutoryProviderKey) !== "india_standard") {
    blockers.push({ code: "unsupported_provider", message: "ESIC monthly contribution export is available only for the India statutory provider" });
  }
  if (!providerAtLeast(options.run.statutoryProviderImplementationVersion, "1.6.0")) {
    blockers.push({ code: "provider_upgrade_required", message: "Create and finalize payroll with India provider 1.6.0 or later so name-as-per-ESIC evidence is frozen" });
  }
  if (!(options.run.statutoryEnabledModules || []).includes("employee_state_insurance")) {
    blockers.push({ code: "esi_module_disabled", message: "Employee State Insurance is not enabled in the frozen statutory profile" });
  }
  if (!text(configuration.employeeStateInsuranceCode)) {
    blockers.push({ code: "missing_esi_establishment", message: "ESI employer code is missing from the frozen statutory profile" });
  }
  if (text(options.run.currency) !== "INR" || Number(options.run.currencyMinorUnits) !== 2) {
    blockers.push({ code: "invalid_currency", message: "ESIC monthly contribution export requires an INR payroll run with two minor currency units" });
  }
  if (!options.results.length) {
    blockers.push({ code: "no_esi_employees", message: "No finalized employees are marked as ESI applicable in this payroll version" });
  }

  const insuranceOwners = new Map<string, string>();
  for (const result of options.results) {
    const employeeId = id(result.employee);
    const employeeCode = text(result.identity?.code) || employeeId;
    const employeeName = text(result.identity?.name) || "Employee";
    const add = (code: string, message: string) => blockers.push({ code, message, employeeCode, employeeName });
    const snapshot = snapshotMap.get(snapshotKey(result.employee, result.employeeSnapshotVersion));
    const statutory = snapshot?.statutory || {};
    const insuranceNumber = text(statutory.esiInsuranceNumber);
    const insuredPersonName = text(statutory.nameAsPerEsi).replace(/\s+/g, " ");

    if (!snapshot) add("missing_employee_snapshot", "The exact employee statutory snapshot used by this finalization is missing");
    if (!/^\d{10}$/.test(insuranceNumber)) add("invalid_esi_number", "ESI insurance number must contain exactly 10 digits");
    if (!insuredPersonName) add("missing_name_as_per_esi", "Name as per ESIC is required");
    else if (!/^[A-Za-z ]+$/.test(insuredPersonName)) add("invalid_name_as_per_esi", "Name as per ESIC may contain only letters and spaces");
    const existingOwner = insuranceOwners.get(insuranceNumber);
    if (insuranceNumber && existingOwner && existingOwner !== employeeCode) add("duplicate_esi_number", `ESI insurance number is also assigned to employee ${existingOwner}`);
    if (insuranceNumber) insuranceOwners.set(insuranceNumber, employeeCode);

    const employeeLine = line(result, "ESI_EMPLOYEE");
    const employerLine = line(result, "ESI_EMPLOYER");
    const paidDaysRaw = Number(result.payrollDays?.paidDays ?? 0);
    if (!Number.isFinite(paidDaysRaw) || paidDaysRaw < 0 || paidDaysRaw > 31) {
      add("invalid_paid_days", "Paid days must be a number from 0 to 31");
    }
    const paidDays = Number.isFinite(paidDaysRaw) && paidDaysRaw >= 0 ? Math.ceil(paidDaysRaw) : 0;
    const totalMonthlyWages = employeeLine ? wholeRupees(employeeLine.wageBaseMinor, "ESI monthly wages", add) : 0;
    const employeeContribution = employeeLine ? wholeRupees(employeeLine.amountMinor, "Employee ESI contribution", add) : 0;
    const employerContribution = employerLine ? wholeRupees(employerLine.amountMinor, "Employer ESI contribution", add) : 0;
    if (paidDays > 0 && !employeeLine) add("missing_employee_esi_line", "Finalized employee ESI contribution and wage evidence is missing");
    if (totalMonthlyWages > 0 && !employerLine) add("missing_employer_esi_line", "Finalized employer ESI contribution is missing");
    if (employeeLine && employerLine && Number(employeeLine.wageBaseMinor) !== Number(employerLine.wageBaseMinor)) {
      add("esi_wage_base_mismatch", "Employee and employer ESI wage bases do not match");
    }
    if (paidDays > 0 && totalMonthlyWages === 0) add("zero_wages_with_paid_days", "Zero ESI wages cannot have paid days");
    if (paidDays === 0 && totalMonthlyWages > 0) add("wages_with_zero_paid_days", "Positive ESI wages require at least one paid day");

    const filingInput = inputMap.get(employeeId);
    const employmentEndDate = isoDate(snapshot?.identity?.employmentEndDate);
    const endedByCycleEnd = Boolean(employmentEndDate && employmentEndDate <= text(options.run.cycleEndDate));
    const reasonCode = filingInput?.reasonCode || (endedByCycleEnd ? 2 : totalMonthlyWages === 0 ? null : 0);
    const lastWorkingDay = filingInput?.lastWorkingDay || (endedByCycleEnd ? employmentEndDate : "");
    const reasonSource = filingInput ? "manual" : endedByCycleEnd ? "employment_exit" : totalMonthlyWages === 0 ? "missing" : "none";
    validateReason({
      reasonCode: reasonCode || null,
      lastWorkingDay,
      totalMonthlyWages,
      cycleEndDate: text(options.run.cycleEndDate),
      periodKey: text(options.run.periodKey),
      add,
    });

    rows.push({
      employeeId,
      employeeCode,
      employeeName,
      insuranceNumber,
      insuredPersonName,
      paidDays,
      totalMonthlyWages,
      reasonCode: reasonCode || null,
      reasonLabel: reasonDefinition(reasonCode || null)?.label || "",
      lastWorkingDay,
      reasonSource,
      employeeContribution,
      employerContribution,
      inputRevision: filingInput?.revisionNumber || null,
    });
  }

  return {
    adapter: { key: ADAPTER_KEY, version: ADAPTER_VERSION, format: "application/vnd.ms-excel", fieldCount: 6 },
    source: {
      payrollRunId: options.run._id,
      periodKey: options.run.periodKey,
      finalizationVersion: options.finalizationVersion,
      providerImplementationVersion: options.run.statutoryProviderImplementationVersion,
      employeeStateInsuranceCode: text(configuration.employeeStateInsuranceCode),
    },
    ready: blockers.length === 0,
    employeeCount: rows.length,
    zeroWageEmployeeCount: rows.filter((row) => row.totalMonthlyWages === 0).length,
    employeeContributionTotal: rows.reduce((sum, row) => sum + row.employeeContribution, 0),
    employerContributionTotal: rows.reduce((sum, row) => sum + row.employerContribution, 0),
    reasonCodes: ESIC_MONTHLY_REASON_CODES,
    blockers,
    rows,
  };
}

export function serializeEsicMonthlyPreview(filing: ReturnType<typeof buildEsicMonthlyContributionFiling>) {
  return {
    ...filing,
    rows: filing.rows.map((row) => ({
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      insuranceNumberMasked: maskEnd(row.insuranceNumber),
      paidDays: row.paidDays,
      totalMonthlyWages: row.totalMonthlyWages,
      reasonCode: row.reasonCode,
      reasonLabel: row.reasonLabel,
      lastWorkingDay: row.lastWorkingDay,
      reasonSource: row.reasonSource,
      employeeContribution: row.employeeContribution,
      employerContribution: row.employerContribution,
      inputRevision: row.inputRevision,
    })),
  };
}

export function renderEsicMonthlyContributionXls(rows: EsicMonthlyRow[]) {
  const values = [
    [
      "IP Number (10 Digits)",
      "IP Name (Only Alphabets and Space)",
      "No of Days for which wages paid/payable during the month",
      "Total Monthly Wages",
      "Reason Code for Zero workings days",
      "Last Working Day",
    ],
    ...rows.map((row) => [
      row.insuranceNumber,
      row.insuredPersonName,
      String(row.paidDays),
      String(row.totalMonthlyWages),
      String(row.reasonCode || 0),
      formatPortalDate(row.lastWorkingDay),
    ]),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(values, { cellDates: false });
  for (const address of Object.keys(worksheet)) {
    if (address.startsWith("!")) continue;
    worksheet[address].t = "s";
    worksheet[address].z = "@";
    worksheet[address].v = String(worksheet[address].v ?? "");
  }
  worksheet["!cols"] = [{ wch: 22 }, { wch: 38 }, { wch: 58 }, { wch: 24 }, { wch: 38 }, { wch: 22 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "MC");
  return XLSX.write(workbook, { type: "buffer", bookType: "biff8" }) as Buffer;
}

async function loadEsicFilingSource(req: any) {
  ensurePayrollRunManager(req);
  const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
  const runId = objectId(req.params.runId, "payroll run id");
  const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).lean();
  if (!run) throw generateError("Payroll run not found", 404);
  if (!Number(run.finalizationVersion || 0)) throw generateError("Finalize payroll before preparing statutory filings", 409);
  const selectedVersion = finalizationVersion(req.query?.finalizationVersion, Number(run.finalizationVersion));
  const allResults = await PayrollFinalizedResult.find({
    company: companyObjectId,
    payrollRun: runId,
    finalizationVersion: selectedVersion,
  })
    .select("employee employeeSnapshotVersion identity payrollDays statutoryContributions")
    .sort({ "identity.code": 1, "identity.name": 1 })
    .lean() as unknown as EsicResult[];
  const employeeIds = allResults.map((result) => result.employee);
  const snapshotVersions = [...new Set(allResults.map((result) => Number(result.employeeSnapshotVersion)))];
  const allSnapshots = allResults.length
    ? await PayrollEmployeeSnapshot.find({
        company: companyObjectId,
        payrollRun: runId,
        employee: { $in: employeeIds },
        snapshotVersion: { $in: snapshotVersions },
      }).select("employee snapshotVersion identity.employmentEndDate statutory.esiInsuranceNumber statutory.nameAsPerEsi statutory.applicability").lean() as unknown as EsicSnapshot[]
    : [];
  const snapshotMap = new Map(allSnapshots.map((snapshot) => [snapshotKey(snapshot.employee, snapshot.snapshotVersion), snapshot]));
  const results = allResults.filter((result) =>
    snapshotMap.get(snapshotKey(result.employee, result.employeeSnapshotVersion))?.statutory?.applicability?.employeeStateInsurance === true
    || (result.statutoryContributions || []).some((item) => text(item.moduleKey) === "employee_state_insurance")
  );
  const includedEmployeeIds = results.map((result) => result.employee);
  const inputDocuments = includedEmployeeIds.length
    ? await PayrollStatutoryFilingInput.find({
        company: companyObjectId,
        payrollRun: runId,
        finalizationVersion: selectedVersion,
        adapterKey: ADAPTER_KEY,
        employee: { $in: includedEmployeeIds },
      }).sort({ employee: 1, revisionNumber: -1 }).lean() as unknown as EsicInput[]
    : [];
  const latestInputs = new Map<string, EsicInput>();
  for (const input of inputDocuments) {
    if (!latestInputs.has(id(input.employee))) latestInputs.set(id(input.employee), input);
  }
  return {
    companyObjectId,
    run,
    selectedVersion,
    finalizationVersion: selectedVersion,
    results,
    snapshots: allSnapshots,
    filingInputs: [...latestInputs.values()],
  };
}

export async function getEsicMonthlyReadinessService(req: any, res: Response, next: NextFunction) {
  try {
    const source = await loadEsicFilingSource(req);
    const filing = buildEsicMonthlyContributionFiling(source);
    return res.status(200).json({ success: true, data: serializeEsicMonthlyPreview(filing) });
  } catch (error) {
    next(error);
  }
}

export async function exportEsicMonthlyContributionService(req: any, res: Response, next: NextFunction) {
  try {
    const source = await loadEsicFilingSource(req);
    const filing = buildEsicMonthlyContributionFiling(source);
    if (!filing.ready) {
      throw generateError(`ESIC monthly contribution file is not ready: ${filing.blockers.slice(0, 10).map((blocker) => blocker.employeeCode ? `${blocker.employeeCode}: ${blocker.message}` : blocker.message).join("; ")}`, 409);
    }
    const body = renderEsicMonthlyContributionXls(filing.rows);
    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader("Content-Disposition", `attachment; filename="ESIC-MC-${source.run.periodKey}-v${source.selectedVersion}.xls"`);
    return res.status(200).send(body);
  } catch (error) {
    next(error);
  }
}

export async function createEsicMonthlyFilingInputService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "prepare an ESIC monthly contribution filing"
    );
    const runId = objectId(req.params.runId, "payroll run id");
    const employeeId = objectId(req.body?.employeeId, "employee id");
    const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).lean();
    if (!run) throw generateError("Payroll run not found", 404);
    if (!Number(run.finalizationVersion || 0)) throw generateError("Finalize payroll before preparing statutory filings", 409);
    const selectedVersion = finalizationVersion(req.body?.finalizationVersion, Number(run.finalizationVersion));
    const result = await PayrollFinalizedResult.findOne({
      company: companyObjectId,
      payrollRun: runId,
      finalizationVersion: selectedVersion,
      employee: employeeId,
    }).select("employee employeeSnapshotVersion identity payrollDays statutoryContributions").lean() as unknown as EsicResult | null;
    if (!result) throw generateError("Finalized employee payroll result not found", 404);
    const snapshot = await PayrollEmployeeSnapshot.findOne({
      company: companyObjectId,
      payrollRun: runId,
      employee: employeeId,
      snapshotVersion: result.employeeSnapshotVersion,
    }).select("employee snapshotVersion statutory.applicability").lean() as unknown as EsicSnapshot | null;
    if (!snapshot?.statutory?.applicability?.employeeStateInsurance) {
      throw generateError("Employee State Insurance does not apply to this finalized employee snapshot", 422);
    }

    const reasonCode = Number(req.body?.reasonCode);
    const lastWorkingDay = text(req.body?.lastWorkingDay);
    const changeReason = text(req.body?.changeReason);
    if (!changeReason || changeReason.length < 3 || changeReason.length > 500) {
      throw generateError("Change reason must contain 3 to 500 characters", 422);
    }
    const employeeLine = line(result, "ESI_EMPLOYEE");
    const totalMonthlyWages = employeeLine ? Math.round(Number(employeeLine.wageBaseMinor || 0) / 100) : 0;
    const validationErrors: string[] = [];
    validateReason({
      reasonCode,
      lastWorkingDay,
      totalMonthlyWages,
      cycleEndDate: text(run.cycleEndDate),
      periodKey: text(run.periodKey),
      add: (_code, message) => validationErrors.push(message),
    });
    if (validationErrors.length) throw generateError(validationErrors.join("; "), 422);

    const actor = getPayrollActorId(req);
    const session = await mongoose.startSession();
    let created: any;
    try {
      await session.withTransaction(async () => {
        const latest: any = await PayrollStatutoryFilingInput.findOne({
          company: companyObjectId,
          payrollRun: runId,
          finalizationVersion: selectedVersion,
          adapterKey: ADAPTER_KEY,
          employee: employeeId,
        }).sort({ revisionNumber: -1 }).session(session).lean();
        [created] = await PayrollStatutoryFilingInput.create([{
          company: companyObjectId,
          payrollRun: runId,
          periodKey: run.periodKey,
          finalizationVersion: selectedVersion,
          adapterKey: ADAPTER_KEY,
          employee: employeeId,
          employeeSnapshotVersion: result.employeeSnapshotVersion,
          revisionNumber: Number(latest?.revisionNumber || 0) + 1,
          reasonCode,
          lastWorkingDay: lastWorkingDay || undefined,
          changeReason,
          createdBy: actor,
        }], { session });
        await writePayrollAudit({
          company: companyObjectId,
          entityType: "statutory_filing",
          entityId: runId,
          action: "esic_monthly_input_revised",
          actor,
          reason: changeReason,
          details: {
            finalizationVersion: selectedVersion,
            employee: employeeId,
            employeeSnapshotVersion: result.employeeSnapshotVersion,
            revisionNumber: created.revisionNumber,
            reasonCode,
            lastWorkingDay: lastWorkingDay || null,
          },
        }, session);
      });
    } finally {
      await session.endSession();
    }
    if (!created) throw generateError("ESIC filing input could not be saved", 500);
    return res.status(201).json({
      success: true,
      message: "ESIC monthly filing input saved",
      data: {
        employeeId,
        finalizationVersion: selectedVersion,
        revisionNumber: created.revisionNumber,
        reasonCode: created.reasonCode,
        lastWorkingDay: created.lastWorkingDay || "",
      },
    });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("Another ESIC filing revision was saved. Refresh and try again", 409));
    next(error);
  }
}
