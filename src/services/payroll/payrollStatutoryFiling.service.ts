import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import PayrollEmployeeSnapshot from "../../schemas/Payroll/PayrollEmployeeSnapshot.schema";
import PayrollFinalizedResult from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import { ensurePayrollRunManager, resolvePayrollCompany } from "./payroll.utils";

const text = (value: unknown) => String(value ?? "").trim();
const id = (value: unknown) => String((value as any)?._id || value || "");

type ContributionLine = {
  moduleKey?: string;
  code?: string;
  wageBaseMinor?: number;
  amountMinor?: number;
};

type FilingResult = {
  employee: unknown;
  employeeSnapshotVersion: number;
  identity?: { name?: string; code?: string };
  payrollDays?: { unpaidDays?: number };
  statutoryContributions?: ContributionLine[];
  totals?: { grossEarningsMinor?: number };
};

type FilingSnapshot = {
  employee: unknown;
  snapshotVersion: number;
  statutory?: { uan?: string; nameAsPerUan?: string; applicability?: Record<string, boolean> };
};

export type EpfoEcrBlocker = {
  code: string;
  message: string;
  employeeCode?: string;
  employeeName?: string;
};

export type EpfoEcrRow = {
  employeeCode: string;
  employeeName: string;
  uan: string;
  memberName: string;
  grossWages: number;
  epfWages: number;
  epsWages: number;
  edliWages: number;
  employeePfContribution: number;
  employerEpsContribution: number;
  employerPfContribution: number;
  ncpDays: number;
  refundOfAdvance: number;
};

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function version(value: unknown, maximum: number) {
  const parsed = value === undefined ? maximum : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw generateError("Invalid payroll finalization version", 422);
  }
  return parsed;
}

function snapshotKey(employee: unknown, snapshotVersion: unknown) {
  return `${id(employee)}:${Number(snapshotVersion || 0)}`;
}

function maskEnd(value: unknown, visible = 4) {
  const normalized = text(value);
  if (!normalized) return "";
  if (normalized.length <= visible) return "*".repeat(normalized.length);
  return `${"*".repeat(normalized.length - visible)}${normalized.slice(-visible)}`;
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

function line(result: FilingResult, code: string) {
  return (result.statutoryContributions || []).find((item) => text(item.code) === code);
}

function majorWages(value: unknown, label: string, add: (code: string, message: string) => void) {
  const minor = Number(value);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    add("invalid_minor_amount", `${label} is not a valid non-negative minor-unit amount`);
    return 0;
  }
  return Math.round(minor / 100);
}

function majorContribution(value: unknown, label: string, add: (code: string, message: string) => void) {
  const minor = Number(value);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    add("invalid_contribution_amount", `${label} is not a valid non-negative minor-unit amount`);
    return 0;
  }
  if (minor % 100 !== 0) {
    add("fractional_contribution", `${label} is not rounded to a whole rupee`);
  }
  return Math.round(minor / 100);
}

export function buildEpfoEcrFiling(options: {
  run: any;
  finalizationVersion: number;
  results: FilingResult[];
  snapshots: FilingSnapshot[];
}) {
  const blockers: EpfoEcrBlocker[] = [];
  const rows: EpfoEcrRow[] = [];
  const snapshotMap = new Map(options.snapshots.map((snapshot) => [snapshotKey(snapshot.employee, snapshot.snapshotVersion), snapshot]));
  const configuration = options.run.statutoryConfigurationSnapshot || {};

  if (text(options.run.statutoryProviderKey) !== "india_standard") {
    blockers.push({ code: "unsupported_provider", message: "EPFO ECR is available only for the India statutory provider" });
  }
  if (!providerAtLeast(options.run.statutoryProviderImplementationVersion, "1.5.0")) {
    blockers.push({ code: "provider_upgrade_required", message: "Create and finalize payroll with India provider 1.5.0 or later so employer PF and EPS are frozen separately" });
  }
  if (!(options.run.statutoryEnabledModules || []).includes("provident_fund")) {
    blockers.push({ code: "pf_module_disabled", message: "Provident fund is not enabled in the frozen statutory profile" });
  }
  if (!text(configuration.providentFundEstablishmentCode)) {
    blockers.push({ code: "missing_pf_establishment", message: "Provident fund establishment code is missing from the frozen statutory profile" });
  }
  if (text(options.run.currency) !== "INR" || Number(options.run.currencyMinorUnits) !== 2) {
    blockers.push({ code: "invalid_currency", message: "EPFO ECR requires an INR payroll run with two minor currency units" });
  }
  if (!options.results.length) {
    blockers.push({ code: "no_pf_employees", message: "No finalized employees have provident-fund contribution lines in this payroll version" });
  }

  const uanOwners = new Map<string, string>();
  for (const result of options.results) {
    const employeeCode = text(result.identity?.code) || id(result.employee);
    const employeeName = text(result.identity?.name) || "Employee";
    const add = (code: string, message: string) => blockers.push({ code, message, employeeCode, employeeName });
    const snapshot = snapshotMap.get(snapshotKey(result.employee, result.employeeSnapshotVersion));
    const statutory = snapshot?.statutory || {};
    const uan = text(statutory.uan);
    const memberName = text(statutory.nameAsPerUan);
    if (!snapshot) add("missing_employee_snapshot", "The exact employee statutory snapshot used by this finalization is missing");
    if (!/^\d{12}$/.test(uan)) add("invalid_uan", "UAN must contain exactly 12 digits");
    if (!memberName) add("missing_name_as_per_uan", "Name as per UAN is required");
    if (memberName.includes("#~#") || /[\r\n]/.test(memberName)) add("invalid_uan_name", "Name as per UAN contains characters that cannot be written to ECR");
    const existingOwner = uanOwners.get(uan);
    if (uan && existingOwner && existingOwner !== employeeCode) add("duplicate_uan", `UAN is also assigned to employee ${existingOwner}`);
    if (uan) uanOwners.set(uan, employeeCode);

    const employeePf = line(result, "EPF_EMPLOYEE");
    const employerEps = line(result, "EPS_EMPLOYER");
    const employerPf = line(result, "EPF_EMPLOYER");
    const employerEdli = line(result, "EDLI_EMPLOYER");
    if (!employeePf) add("missing_employee_pf_line", "Finalized employee PF contribution is missing");
    if (!employerEps) add("missing_employer_eps_line", "Finalized employer EPS contribution is missing");
    if (!employerPf) add("missing_employer_pf_line", "Finalized employer PF contribution is missing");
    if (!employerEdli) add("missing_edli_line", "Finalized EDLI wage evidence is missing");

    const grossWages = majorWages(result.totals?.grossEarningsMinor, "Gross wages", add);
    const epfWages = majorWages(employeePf?.wageBaseMinor, "EPF wages", add);
    const epsWages = majorWages(employerEps?.wageBaseMinor, "EPS wages", add);
    const edliWages = majorWages(employerEdli?.wageBaseMinor, "EDLI wages", add);
    const employeePfContribution = majorContribution(employeePf?.amountMinor, "Employee PF contribution", add);
    const employerEpsContribution = majorContribution(employerEps?.amountMinor, "Employer EPS contribution", add);
    const employerPfContribution = majorContribution(employerPf?.amountMinor, "Employer PF contribution", add);
    if (employerEpsContribution + employerPfContribution !== employeePfContribution) {
      add("employer_split_mismatch", "Employer PF plus EPS does not reconcile to the employee PF contribution");
    }
    if (epfWages > grossWages) add("epf_wages_exceed_gross", "EPF wages cannot exceed gross wages");
    if (epsWages > epfWages) add("eps_wages_exceed_epf", "EPS wages cannot exceed EPF wages");
    if (edliWages > epfWages) add("edli_wages_exceed_epf", "EDLI wages cannot exceed EPF wages");

    const ncpDays = Number(result.payrollDays?.unpaidDays || 0);
    if (!Number.isInteger(ncpDays) || ncpDays < 0 || ncpDays > 31) {
      add("invalid_ncp_days", "NCP days must be a whole number from 0 to 31; resolve fractional or invalid unpaid days before filing");
    }

    rows.push({
      employeeCode,
      employeeName,
      uan,
      memberName,
      grossWages,
      epfWages,
      epsWages,
      edliWages,
      employeePfContribution,
      employerEpsContribution,
      employerPfContribution,
      ncpDays: Number.isInteger(ncpDays) && ncpDays >= 0 ? ncpDays : 0,
      refundOfAdvance: 0,
    });
  }

  return {
    adapter: { key: "epfo_ecr_regular", version: "2025-v3", format: "text/plain", fieldCount: 11 },
    source: {
      payrollRunId: options.run._id,
      periodKey: options.run.periodKey,
      finalizationVersion: options.finalizationVersion,
      providerImplementationVersion: options.run.statutoryProviderImplementationVersion,
      providentFundEstablishmentCode: text(configuration.providentFundEstablishmentCode),
      contributionRate: text(configuration.providentFundContributionRate || "12"),
    },
    ready: blockers.length === 0,
    employeeCount: rows.length,
    blockers,
    rows,
  };
}

export function serializeEpfoEcrPreview(filing: ReturnType<typeof buildEpfoEcrFiling>) {
  return {
    ...filing,
    rows: filing.rows.map((row) => ({
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      uanMasked: maskEnd(row.uan),
      grossWages: row.grossWages,
      epfWages: row.epfWages,
      epsWages: row.epsWages,
      employeePfContribution: row.employeePfContribution,
      employerEpsContribution: row.employerEpsContribution,
      employerPfContribution: row.employerPfContribution,
      ncpDays: row.ncpDays,
    })),
  };
}

export function renderEpfoEcrText(rows: EpfoEcrRow[]) {
  return `${rows.map((row) => [
    row.uan,
    row.memberName,
    row.grossWages,
    row.epfWages,
    row.epsWages,
    row.edliWages,
    row.employeePfContribution,
    row.employerEpsContribution,
    row.employerPfContribution,
    row.ncpDays,
    row.refundOfAdvance,
  ].join("#~#")).join("\r\n")}\r\n`;
}

async function loadFilingSource(req: any) {
  ensurePayrollRunManager(req);
  const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
  const runId = objectId(req.params.runId, "payroll run id");
  const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).lean();
  if (!run) throw generateError("Payroll run not found", 404);
  if (!Number(run.finalizationVersion || 0)) throw generateError("Finalize payroll before preparing statutory filings", 409);
  const selectedVersion = version(req.query?.finalizationVersion, Number(run.finalizationVersion));
  const results = await PayrollFinalizedResult.find({
    company: companyObjectId,
    payrollRun: runId,
    finalizationVersion: selectedVersion,
    statutoryContributions: { $elemMatch: { moduleKey: "provident_fund" } },
  })
    .select("employee employeeSnapshotVersion identity payrollDays statutoryContributions totals")
    .sort({ "identity.code": 1, "identity.name": 1 })
    .lean() as unknown as FilingResult[];
  const employeeIds = results.map((result) => result.employee);
  const snapshotVersions = [...new Set(results.map((result) => Number(result.employeeSnapshotVersion)))];
  const snapshots = results.length
    ? await PayrollEmployeeSnapshot.find({
        company: companyObjectId,
        payrollRun: runId,
        employee: { $in: employeeIds },
        snapshotVersion: { $in: snapshotVersions },
      }).select("employee snapshotVersion statutory.uan statutory.nameAsPerUan statutory.applicability").lean() as unknown as FilingSnapshot[]
    : [];
  return { run, selectedVersion, results, snapshots };
}

export async function getEpfoEcrReadinessService(req: any, res: Response, next: NextFunction) {
  try {
    const source = await loadFilingSource(req);
    const filing = buildEpfoEcrFiling({ run: source.run, finalizationVersion: source.selectedVersion, results: source.results, snapshots: source.snapshots });
    return res.status(200).json({ success: true, data: serializeEpfoEcrPreview(filing) });
  } catch (error) {
    next(error);
  }
}

export async function exportEpfoEcrService(req: any, res: Response, next: NextFunction) {
  try {
    const source = await loadFilingSource(req);
    const filing = buildEpfoEcrFiling({ run: source.run, finalizationVersion: source.selectedVersion, results: source.results, snapshots: source.snapshots });
    if (!filing.ready) {
      throw generateError(`EPFO ECR is not ready: ${filing.blockers.slice(0, 10).map((blocker) => blocker.employeeCode ? `${blocker.employeeCode}: ${blocker.message}` : blocker.message).join("; ")}`, 409);
    }
    const body = renderEpfoEcrText(filing.rows);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="EPFO-ECR-${source.run.periodKey}-v${source.selectedVersion}.txt"`);
    return res.status(200).send(Buffer.from(body, "utf8"));
  } catch (error) {
    next(error);
  }
}
