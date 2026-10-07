import { createHash } from "node:crypto";
import { NextFunction, Response } from "express";
import axios from "axios";
import mongoose from "mongoose";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { generateError } from "../../config/Error/functions";
import Company from "../../schemas/company/Company";
import PayrollFinalizedResult from "../../schemas/Payroll/PayrollFinalizedResult.schema";
import PayrollPayslip, { PAYSLIP_TEMPLATE_VERSION } from "../../schemas/Payroll/PayrollPayslip.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import {
  ensurePayrollRunManager,
  getPayrollActor,
  getPayrollActorId,
  normalizePayrollRole,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

const text = (value: unknown) => String(value ?? "").trim();
const id = (value: any) => String(value?._id || value || "");

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function pageNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function requiredReason(value: unknown) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) {
    throw generateError("Payslip issuance reason must contain 3 to 500 characters", 422);
  }
  return reason;
}

function canonical(value: any): any {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.keys(value).sort().reduce<Record<string, any>>((result, key) => {
      result[key] = canonical(value[key]);
      return result;
    }, {});
  }
  return value;
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function safeCode(value: unknown, fallback: string) {
  const normalized = text(value).toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function payrollPayslipNumber(options: {
  companyCode: unknown;
  periodKey: string;
  employeeCode: unknown;
  finalizationVersion: number;
}) {
  const companyCode = safeCode(options.companyCode, "COMPANY");
  const employeeCode = safeCode(options.employeeCode, "EMPLOYEE");
  return `${companyCode}-${options.periodKey.replace("-", "")}-${employeeCode}-F${options.finalizationVersion}`;
}

export function payslipContentHash(value: {
  payslipNumber: string;
  templateVersion: string;
  periodKey: string;
  finalizationVersion: number;
  currency: string;
  currencyMinorUnits: number;
  companySnapshot: Record<string, unknown>;
  employeeSnapshot: Record<string, unknown>;
  amountsSnapshot: Record<string, number>;
  sourceSnapshotHash: string;
  issuedAt: Date | string;
}) {
  return sha256(value);
}

export function buildPayrollPayslipDocuments(options: {
  run: any;
  results: any[];
  company: any;
  actorId: mongoose.Types.ObjectId;
  issuedAt: Date;
}) {
  const registeredAddress = {
    addressLine1: text(options.company?.registeredAddress?.addressLine1),
    addressLine2: text(options.company?.registeredAddress?.addressLine2),
    city: text(options.company?.registeredAddress?.city),
    state: text(options.company?.registeredAddress?.state),
    postalCode: text(options.company?.registeredAddress?.postalCode),
    country: text(options.company?.registeredAddress?.country),
  };
  const address = [
    registeredAddress.addressLine1,
    registeredAddress.addressLine2,
    [registeredAddress.city, registeredAddress.state, registeredAddress.postalCode]
      .filter(Boolean)
      .join(", "),
    registeredAddress.country,
  ].map(text).filter(Boolean);
  const companySnapshot = {
    name: text(options.run.companyNameSnapshot || options.company?.company_name),
    code: text(options.run.companyCodeSnapshot || options.company?.companyCode).toUpperCase(),
    logo: options.company?.logo?.url
      ? {
          name: text(options.company.logo.name),
          url: text(options.company.logo.url),
          type: text(options.company.logo.type).toLowerCase(),
        }
      : null,
    registeredAddress,
    address,
  };

  return options.results.map((result) => {
    const employeeSnapshot = {
      name: text(result.identity?.name),
      code: text(result.identity?.code),
      username: text(result.identity?.username).toLowerCase(),
      designation: text(result.organization?.designation),
      departmentName: text(result.organization?.departmentName),
      teamName: text(result.organization?.teamName),
      officeLocationName: text(result.organization?.officeLocationName),
    };
    const amountsSnapshot = {
      grossEarningsMinor: Number(result.totals?.grossEarningsMinor || 0),
      totalDeductionsMinor: Number(result.totals?.totalDeductionsMinor || 0),
      totalReimbursementsMinor: Number(result.totals?.totalReimbursementsMinor || 0),
      netPayMinor: Number(result.totals?.netPayMinor || 0),
      employerContributionsMinor: Number(result.totals?.employerContributionsMinor || 0),
    };
    const currency = text(result.currency || options.run.currency).toUpperCase();
    const currencyMinorUnits = Number(result.currencyMinorUnits ?? options.run.currencyMinorUnits ?? 2);
    const payslipNumber = payrollPayslipNumber({
      companyCode: companySnapshot.code,
      periodKey: options.run.periodKey,
      employeeCode: employeeSnapshot.code,
      finalizationVersion: Number(options.run.finalizationVersion),
    });
    const hashInput = {
      payslipNumber,
      templateVersion: PAYSLIP_TEMPLATE_VERSION,
      periodKey: options.run.periodKey,
      finalizationVersion: Number(options.run.finalizationVersion),
      currency,
      currencyMinorUnits,
      companySnapshot,
      employeeSnapshot,
      amountsSnapshot,
      sourceSnapshotHash: text(result.snapshotHash),
      issuedAt: options.issuedAt,
    };
    return {
      company: options.run.company,
      payrollRun: options.run._id,
      finalizedResult: result._id,
      employee: result.employee,
      periodKey: options.run.periodKey,
      finalizationVersion: Number(options.run.finalizationVersion),
      currency,
      currencyMinorUnits,
      payslipNumber,
      templateVersion: PAYSLIP_TEMPLATE_VERSION,
      companySnapshot,
      employeeSnapshot,
      amountsSnapshot,
      sourceSnapshotHash: text(result.snapshotHash),
      contentHash: payslipContentHash(hashInput),
      issuedAt: options.issuedAt,
      issuedBy: options.actorId,
    };
  });
}

type MoneyLine = { label: string; code?: string; amountMinor: number };

function ascii(value: unknown) {
  return text(value).replace(/[^\x20-\x7E]/g, "?");
}

function periodLabel(periodKey: string) {
  const [year, month] = periodKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatMoney(amountMinor: unknown, currency: string, minorUnits: number) {
  const amount = Number(amountMinor || 0) / 10 ** minorUnits;
  return `${ascii(currency || "INR")} ${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  }).format(amount)}`;
}

function short(value: unknown, maximum = 64) {
  const normalized = ascii(value);
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 3))}...`;
}

function fitPdfText(value: unknown, font: PDFFont, size: number, maximumWidth: number) {
  const normalized = ascii(value);
  if (font.widthOfTextAtSize(normalized, size) <= maximumWidth) return normalized;
  let fitted = normalized;
  while (fitted && font.widthOfTextAtSize(`${fitted}...`, size) > maximumWidth) {
    fitted = fitted.slice(0, -1);
  }
  return fitted ? `${fitted}...` : "";
}

function lineLabel(line: MoneyLine) {
  return line.code ? `${line.label} (${line.code})` : line.label;
}

const MAX_PAYSLIP_LOGO_BYTES = 2_000_000;
const PAYSLIP_LOGO_TYPES = new Set(["image/png", "image/jpeg"]);

async function loadPayslipLogo(logo: any) {
  const configuredType = text(logo?.type).toLowerCase();
  const source = text(logo?.url);
  if (!source || !PAYSLIP_LOGO_TYPES.has(configuredType)) return null;

  if (source.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg));base64,([a-z0-9+/=]+)$/i.exec(source);
    if (!match || match[1].toLowerCase() !== configuredType) return null;
    const bytes = Buffer.from(match[2], "base64");
    return bytes.length <= MAX_PAYSLIP_LOGO_BYTES
      ? { bytes, type: configuredType }
      : null;
  }

  try {
    const url = new URL(source);
    const configuredHosts = text(process.env.COMPANY_LOGO_ASSET_HOSTS)
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    const allowedHosts = new Set(["res.cloudinary.com", ...configuredHosts]);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) return null;

    const response = await axios.get<ArrayBuffer>(url.toString(), {
      responseType: "arraybuffer",
      timeout: 5000,
      maxContentLength: MAX_PAYSLIP_LOGO_BYTES,
      maxBodyLength: MAX_PAYSLIP_LOGO_BYTES,
    });
    const responseType = text(response.headers["content-type"]).split(";")[0].toLowerCase();
    if (responseType && responseType !== configuredType) return null;
    const bytes = Buffer.from(response.data);
    return bytes.length <= MAX_PAYSLIP_LOGO_BYTES
      ? { bytes, type: configuredType }
      : null;
  } catch {
    return null;
  }
}

export async function renderPayrollPayslipPdf(options: {
  payslip: any;
  run: any;
  result: any;
}) {
  const { payslip, run, result } = options;
  const currency = text(result.currency || run.currency || "INR").toUpperCase();
  const minorUnits = Number(result.currencyMinorUnits ?? run.currencyMinorUnits ?? 2);
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logoAsset = await loadPayslipLogo(payslip.companySnapshot?.logo);
  let logoImage: any = null;
  if (logoAsset) {
    try {
      logoImage = logoAsset.type === "image/png"
        ? await pdf.embedPng(logoAsset.bytes)
        : await pdf.embedJpg(logoAsset.bytes);
    } catch {
      logoImage = null;
    }
  }
  const issuedAt = new Date(payslip.issuedAt);
  pdf.setTitle(`Payslip ${payslip.payslipNumber}`);
  pdf.setAuthor(ascii(payslip.companySnapshot?.name || run.companyNameSnapshot));
  pdf.setSubject(`Payroll payslip for ${periodLabel(payslip.periodKey)}`);
  pdf.setCreator("HRMS Payroll");
  pdf.setProducer("HRMS Payroll");
  pdf.setCreationDate(issuedAt);
  pdf.setModificationDate(issuedAt);

  const width = 595.28;
  const height = 841.89;
  const margin = 42;
  const navy = rgb(0.08, 0.16, 0.29);
  const blue = rgb(0.12, 0.37, 0.78);
  const muted = rgb(0.35, 0.40, 0.48);
  const line = rgb(0.84, 0.87, 0.91);
  const pale = rgb(0.95, 0.97, 1);
  let page: PDFPage = pdf.addPage([width, height]);
  let y = height - margin;

  const drawText = (value: unknown, x: number, currentY: number, size = 9, font: PDFFont = regular, color = navy) => {
    page.drawText(short(value, 88), { x, y: currentY, size, font, color });
  };

  const newPage = (continuation = false) => {
    page = pdf.addPage([width, height]);
    y = height - margin;
    if (continuation) {
      drawText(`${payslip.companySnapshot?.name || "Company"} - Payslip ${payslip.payslipNumber}`, margin, y, 9, bold, navy);
      y -= 22;
      page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.8, color: line });
      y -= 18;
    }
  };

  const ensureSpace = (needed: number) => {
    if (y - needed < 58) newPage(true);
  };

  const detail = (label: string, value: unknown, x: number, valueX: number, currentY: number) => {
    drawText(label.toUpperCase(), x, currentY, 7.5, bold, muted);
    drawText(value || "-", valueX, currentY, 8.5, regular, navy);
  };

  const drawMoneySection = (title: string, rows: MoneyLine[], totalLabel: string, totalMinor: number) => {
    ensureSpace(64 + rows.length * 18);
    drawText(title, margin, y, 11, bold, blue);
    y -= 15;
    page.drawRectangle({ x: margin, y: y - 17, width: width - margin * 2, height: 20, color: pale });
    drawText("COMPONENT", margin + 9, y - 10, 7.5, bold, muted);
    drawText("AMOUNT", width - margin - 95, y - 10, 7.5, bold, muted);
    y -= 21;
    if (!rows.length) {
      drawText("No entries", margin + 9, y - 11, 8.5, regular, muted);
      y -= 22;
    } else {
      for (const row of rows) {
        ensureSpace(25);
        drawText(lineLabel(row), margin + 9, y - 11, 8.5, regular, navy);
        drawText(formatMoney(row.amountMinor, currency, minorUnits), width - margin - 120, y - 11, 8.5, regular, navy);
        page.drawLine({ start: { x: margin, y: y - 15 }, end: { x: width - margin, y: y - 15 }, thickness: 0.5, color: line });
        y -= 18;
      }
    }
    drawText(totalLabel, margin + 9, y - 11, 8.5, bold, navy);
    drawText(formatMoney(totalMinor, currency, minorUnits), width - margin - 120, y - 11, 8.5, bold, navy);
    y -= 26;
  };

  page.drawRectangle({ x: 0, y: height - 116, width, height: 116, color: navy });
  let companyTextX = margin;
  if (logoImage) {
    const boxWidth = 62;
    const boxHeight = 56;
    const dimensions = logoImage.scale(1);
    const scale = Math.min(52 / dimensions.width, 46 / dimensions.height);
    const logoWidth = dimensions.width * scale;
    const logoHeight = dimensions.height * scale;
    const boxY = height - 94;
    page.drawRectangle({ x: margin, y: boxY, width: boxWidth, height: boxHeight, color: rgb(1, 1, 1) });
    page.drawImage(logoImage, {
      x: margin + (boxWidth - logoWidth) / 2,
      y: boxY + (boxHeight - logoHeight) / 2,
      width: logoWidth,
      height: logoHeight,
    });
    companyTextX += boxWidth + 14;
  }
  const registeredAddress = payslip.companySnapshot?.registeredAddress || {};
  const addressLines = [
    [registeredAddress.addressLine1, registeredAddress.addressLine2]
      .map(text)
      .filter(Boolean)
      .join(", "),
    [registeredAddress.city, registeredAddress.state, registeredAddress.postalCode, registeredAddress.country]
      .map(text)
      .filter(Boolean)
      .join(", "),
  ].filter(Boolean);
  const legacyAddress = Array.isArray(payslip.companySnapshot?.address)
    ? payslip.companySnapshot.address.map(text).filter(Boolean)
    : [];
  const displayedAddress = addressLines.length ? addressLines : legacyAddress;
  drawText(
    fitPdfText(
      payslip.companySnapshot?.name || run.companyNameSnapshot || "Company",
      bold,
      19,
      width - margin - 128 - companyTextX
    ),
    companyTextX,
    height - 50,
    19,
    bold,
    rgb(1, 1, 1)
  );
  displayedAddress.slice(0, 2).forEach((addressLine: string, index: number) => {
    drawText(
      fitPdfText(addressLine, regular, 8, width - margin - 128 - companyTextX),
      companyTextX,
      height - 70 - index * 14,
      8,
      regular,
      rgb(0.82, 0.88, 0.97)
    );
  });
  drawText("PAYSLIP", width - margin - 94, height - 51, 15, bold, rgb(1, 1, 1));
  drawText(periodLabel(payslip.periodKey), width - margin - 112, height - 72, 9, regular, rgb(0.82, 0.88, 0.97));
  y = height - 145;

  drawText(payslip.employeeSnapshot?.name || result.identity?.name, margin, y, 14, bold, navy);
  drawText(`${payslip.employeeSnapshot?.code || result.identity?.code}${payslip.employeeSnapshot?.designation ? ` | ${payslip.employeeSnapshot.designation}` : ""}`, margin, y - 18, 9, regular, muted);
  drawText(`Payslip no. ${payslip.payslipNumber}`, width - margin - 210, y, 8.5, bold, navy);
  y -= 54;

  page.drawRectangle({ x: margin, y: y - 55, width: width - margin * 2, height: 64, borderColor: line, borderWidth: 0.8 });
  detail("Department", payslip.employeeSnapshot?.departmentName, margin + 10, margin + 78, y - 10);
  detail("Team", payslip.employeeSnapshot?.teamName, width / 2 + 5, width / 2 + 45, y - 10);
  detail("Location", payslip.employeeSnapshot?.officeLocationName, margin + 10, margin + 78, y - 29);
  detail("Payroll cycle", `${run.cycleStartDate} to ${run.cycleEndDate}`, width / 2 + 5, width / 2 + 79, y - 29);
  detail("Paid days", result.payrollDays?.paidDays, margin + 10, margin + 78, y - 48);
  detail("LOP days", result.payrollDays?.unpaidDays, width / 2 + 5, width / 2 + 59, y - 48);
  y -= 80;

  const recurring = Array.isArray(result.recurringComponents) ? result.recurringComponents : [];
  const oneTime = Array.isArray(result.oneTimeInputs) ? result.oneTimeInputs : [];
  const statutory = Array.isArray(result.statutoryContributions) ? result.statutoryContributions : [];
  const recurringLines = (category: string): MoneyLine[] => recurring
    .filter((item: any) => item.category === category)
    .map((item: any) => ({ label: text(item.componentName), code: text(item.componentCode), amountMinor: Number(item.payableAmountMinor || 0) }));
  const oneTimeLines = (types: string[]): MoneyLine[] => oneTime
    .filter((item: any) => types.includes(text(item.inputType)))
    .map((item: any) => ({ label: text(item.componentName), code: text(item.componentCode), amountMinor: Number(item.amountMinor || 0) }));
  const statutoryLines = (side: string): MoneyLine[] => statutory
    .filter((item: any) => item.side === side)
    .map((item: any) => ({ label: text(item.name), code: text(item.code), amountMinor: Number(item.amountMinor || 0) }));

  drawMoneySection(
    "Earnings",
    [...recurringLines("earning"), ...oneTimeLines(["earning", "arrear"])],
    "Gross earnings",
    Number(result.totals?.grossEarningsMinor || 0)
  );
  drawMoneySection(
    "Deductions",
    [...recurringLines("deduction"), ...oneTimeLines(["deduction", "recovery"]), ...statutoryLines("employee_deduction")],
    "Total deductions",
    Number(result.totals?.totalDeductionsMinor || 0)
  );
  if (Number(result.totals?.totalReimbursementsMinor || 0) || recurringLines("reimbursement").length || oneTimeLines(["reimbursement"]).length) {
    drawMoneySection(
      "Reimbursements",
      [...recurringLines("reimbursement"), ...oneTimeLines(["reimbursement"])],
      "Total reimbursements",
      Number(result.totals?.totalReimbursementsMinor || 0)
    );
  }
  if (Number(result.totals?.employerContributionsMinor || 0) || recurringLines("employer_contribution").length || statutoryLines("employer_contribution").length) {
    drawMoneySection(
      "Employer contributions (not deducted from net pay)",
      [...recurringLines("employer_contribution"), ...statutoryLines("employer_contribution")],
      "Total employer contributions",
      Number(result.totals?.employerContributionsMinor || 0)
    );
  }

  ensureSpace(116);
  page.drawRectangle({ x: margin, y: y - 76, width: width - margin * 2, height: 84, color: navy });
  drawText("NET PAY", margin + 16, y - 20, 10, bold, rgb(0.75, 0.84, 0.97));
  drawText(formatMoney(result.totals?.netPayMinor, currency, minorUnits), margin + 16, y - 51, 22, bold, rgb(1, 1, 1));
  drawText(`Gross ${formatMoney(result.totals?.grossEarningsMinor, currency, minorUnits)}`, width / 2 + 8, y - 24, 8.5, regular, rgb(0.85, 0.90, 0.97));
  drawText(`Deductions ${formatMoney(result.totals?.totalDeductionsMinor, currency, minorUnits)}`, width / 2 + 8, y - 43, 8.5, regular, rgb(0.85, 0.90, 0.97));
  drawText(`Reimbursements ${formatMoney(result.totals?.totalReimbursementsMinor, currency, minorUnits)}`, width / 2 + 8, y - 62, 8.5, regular, rgb(0.85, 0.90, 0.97));
  y -= 104;
  drawText("This system-generated payslip is based on an immutable finalized payroll result.", margin, y, 8, regular, muted);

  const pages = pdf.getPages();
  pages.forEach((pdfPage, index) => {
    pdfPage.drawLine({ start: { x: margin, y: 38 }, end: { x: width - margin, y: 38 }, thickness: 0.5, color: line });
    pdfPage.drawText(`Payslip ${payslip.payslipNumber}`, { x: margin, y: 23, size: 7, font: regular, color: muted });
    pdfPage.drawText(`Page ${index + 1} of ${pages.length}`, { x: width - margin - 58, y: 23, size: 7, font: regular, color: muted });
  });

  return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
}

async function payrollRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId) {
  return PayrollRun.findOne({ _id: runId, company }).lean();
}

export async function issuePayrollPayslipsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "issue payslips for this company");
    const actorId = getPayrollActorId(req);
    const runId = objectId(req.params.runId, "payroll run id");
    const reason = requiredReason(req.body?.reason);
    let issuedNow = 0;
    let total = 0;
    let finalizationVersion = 0;

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);
      if (run.status !== "finalized" || Number(run.finalizationVersion || 0) < 1) {
        throw generateError("Finalize payroll before issuing payslips", 409);
      }
      finalizationVersion = Number(run.finalizationVersion);
      const results: any[] = await PayrollFinalizedResult.find({
        company: companyObjectId,
        payrollRun: run._id,
        finalizationVersion,
      }).sort({ "identity.code": 1, employee: 1 }).session(session).lean();
      if (!results.length || results.length !== Number(run.finalizedResultCount || 0)) {
        throw generateError("Finalized employee results do not reconcile with the payroll run", 409);
      }
      total = results.length;
      const company: any = await Company.findById(companyObjectId)
        .select("company_name companyCode logo registeredAddress")
        .session(session)
        .lean();
      if (!company) throw generateError("Company not found", 404);
      const existing = await PayrollPayslip.find({
        company: companyObjectId,
        payrollRun: run._id,
        finalizationVersion,
      }).select("employee").session(session).lean();
      const existingEmployees = new Set(existing.map((item: any) => id(item.employee)));
      const issuedAt = new Date();
      const documents = buildPayrollPayslipDocuments({ run, results, company, actorId, issuedAt })
        .filter((item) => !existingEmployees.has(id(item.employee)));
      issuedNow = documents.length;
      if (documents.length) {
        await PayrollPayslip.insertMany(documents, { session, ordered: true });
        await writePayrollAudit({
          company: companyObjectId,
          entityType: "payslip",
          entityId: run._id,
          action: "issued",
          actor: actorId,
          reason,
          details: {
            periodKey: run.periodKey,
            finalizationVersion,
            issuedCount: documents.length,
            totalFinalizedEmployees: results.length,
            templateVersion: PAYSLIP_TEMPLATE_VERSION,
          },
        }, session);
      }
    });

    return res.status(issuedNow ? 201 : 200).json({
      success: true,
      message: issuedNow ? `${issuedNow} payslip(s) issued` : "Payslips are already issued for this finalization",
      data: { payrollRun: runId, finalizationVersion, issuedNow, issuedTotal: total },
    });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("Payslips were issued by another request. Refresh and try again", 409));
    next(error);
  }
}

export async function listPayrollPayslipsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = objectId(req.params.runId, "payroll run id");
    const run: any = await payrollRun(companyObjectId, runId);
    if (!run) throw generateError("Payroll run not found", 404);
    const finalizationVersion = req.query?.finalizationVersion === undefined
      ? Number(run.finalizationVersion || 0)
      : Number(req.query.finalizationVersion);
    if (!Number.isInteger(finalizationVersion) || finalizationVersion < 1 || finalizationVersion > Number(run.finalizationVersion || 0)) {
      throw generateError("Invalid payroll finalization version", 422);
    }
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 25, 100);
    const search = text(req.query?.search);
    if (search.length > 100) throw generateError("Payslip search is too long", 400);
    const regex = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
    const match: any = {
      company: companyObjectId,
      payrollRun: runId,
      finalizationVersion,
      ...(regex ? { $or: [
        { "employeeSnapshot.name": regex },
        { "employeeSnapshot.code": regex },
        { "employeeSnapshot.departmentName": regex },
        { "employeeSnapshot.teamName": regex },
        { "employeeSnapshot.officeLocationName": regex },
      ] } : {}),
    };
    const [items, total] = await Promise.all([
      PayrollPayslip.find(match).sort({ "employeeSnapshot.code": 1, employee: 1 }).skip((page - 1) * limit).limit(limit).populate("issuedBy", "name username code").lean(),
      PayrollPayslip.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: { run, finalizationVersion, issuedCount: total, expectedCount: Number(run.finalizedResultCount || 0), items },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

function assertSelfPayslipActor(req: any) {
  const actor = getPayrollActor(req);
  if (normalizePayrollRole(actor?.role) === "superadmin") {
    throw generateError("Superadmin does not have an employee payslip profile", 403);
  }
  return getPayrollActorId(req);
}

export async function listMyPayrollPayslipsService(req: any, res: Response, next: NextFunction) {
  try {
    const actorId = assertSelfPayslipActor(req);
    const { companyObjectId } = await resolvePayrollCompany(req);
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 12, 50);
    const match = { company: companyObjectId, employee: actorId };
    const [items, total] = await Promise.all([
      PayrollPayslip.find(match).sort({ periodKey: -1, finalizationVersion: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PayrollPayslip.countDocuments(match),
    ]);
    const latestVersions = await PayrollPayslip.aggregate([
      { $match: match },
      { $group: { _id: "$periodKey", finalizationVersion: { $max: "$finalizationVersion" } } },
    ]);
    const latestByPeriod = new Map(latestVersions.map((item: any) => [item._id, Number(item.finalizationVersion)]));
    return res.status(200).json({
      success: true,
      data: items.map((item: any) => ({
        ...item,
        isLatest: Number(item.finalizationVersion) === Number(latestByPeriod.get(item.periodKey)),
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

async function sendPayslipPdf(res: Response, payslip: any) {
  const [run, result] = await Promise.all([
    PayrollRun.findOne({ _id: payslip.payrollRun, company: payslip.company }).lean(),
    PayrollFinalizedResult.findOne({
      _id: payslip.finalizedResult,
      company: payslip.company,
      payrollRun: payslip.payrollRun,
      employee: payslip.employee,
      finalizationVersion: payslip.finalizationVersion,
    }).lean(),
  ]);
  if (!run || !result) throw generateError("Payslip source payroll result is unavailable", 409);
  if (text(result.snapshotHash) !== text(payslip.sourceSnapshotHash)) {
    throw generateError("Payslip source integrity verification failed", 409);
  }
  const expectedHash = payslipContentHash({
    payslipNumber: payslip.payslipNumber,
    templateVersion: payslip.templateVersion,
    periodKey: payslip.periodKey,
    finalizationVersion: payslip.finalizationVersion,
    currency: payslip.currency,
    currencyMinorUnits: payslip.currencyMinorUnits,
    companySnapshot: payslip.companySnapshot,
    employeeSnapshot: payslip.employeeSnapshot,
    amountsSnapshot: payslip.amountsSnapshot,
    sourceSnapshotHash: payslip.sourceSnapshotHash,
    issuedAt: payslip.issuedAt,
  });
  if (expectedHash !== text(payslip.contentHash)) throw generateError("Payslip integrity verification failed", 409);
  const buffer = await renderPayrollPayslipPdf({ payslip, run, result });
  const filename = `${safeCode(payslip.payslipNumber, "PAYSLIP")}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  return res.status(200).send(buffer);
}

export async function downloadPayrollPayslipService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = objectId(req.params.runId, "payroll run id");
    const payslipId = objectId(req.params.payslipId, "payslip id");
    const payslip: any = await PayrollPayslip.findOne({ _id: payslipId, company: companyObjectId, payrollRun: runId }).lean();
    if (!payslip) throw generateError("Payslip not found", 404);
    return await sendPayslipPdf(res, payslip);
  } catch (error) {
    next(error);
  }
}

export async function downloadMyPayrollPayslipService(req: any, res: Response, next: NextFunction) {
  try {
    const actorId = assertSelfPayslipActor(req);
    const { companyObjectId } = await resolvePayrollCompany(req);
    const payslipId = objectId(req.params.payslipId, "payslip id");
    const payslip: any = await PayrollPayslip.findOne({ _id: payslipId, company: companyObjectId, employee: actorId }).lean();
    if (!payslip) throw generateError("Payslip not found", 404);
    return await sendPayslipPdf(res, payslip);
  } catch (error) {
    next(error);
  }
}
