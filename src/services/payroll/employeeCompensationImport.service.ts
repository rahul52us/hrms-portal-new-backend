import crypto from "crypto";
import { NextFunction, Response } from "express";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { Readable } from "stream";
import { generateError } from "../../config/Error/functions";
import CompensationImportBatch from "../../schemas/Payroll/CompensationImportBatch.schema";
import CompensationImportRow from "../../schemas/Payroll/CompensationImportRow.schema";
import EmployeeCompensationAssignment from "../../schemas/Payroll/EmployeeCompensationAssignment.schema";
import PayrollAuditLog from "../../schemas/Payroll/PayrollAuditLog.schema";
import SalaryStructure from "../../schemas/Payroll/SalaryStructure.schema";
import SalaryStructureVersion from "../../schemas/Payroll/SalaryStructureVersion.schema";
import User from "../../schemas/User/User";
import {
  buildCompensationSnapshot,
  parseCompensationDate,
  validateCompensationEmployeeDates,
  validateCompensationVersionEffectiveOn,
} from "./employeeCompensation.service";
import { ensureEmployeeCompensationManager, getPayrollActorId, resolvePayrollCompany } from "./payroll.utils";

type ImportRow = {
  rowNumber: number;
  employeeCode: string;
  salaryStructureCode: string;
  effectiveFrom: string;
  assignmentReason: string;
  overrideInputs: Array<{ componentCode: string; amount: string }>;
};

type ValidatedRow = ImportRow & {
  status: "valid" | "invalid";
  errors: string[];
  employee?: any;
  structure?: any;
  version?: any;
  resolvedOverrides: Array<{
    salaryComponent: mongoose.Types.ObjectId;
    componentCodeSnapshot: string;
    componentNameSnapshot: string;
    monthlyAmountMinor: number;
  }>;
  previewTotals?: Record<string, number>;
};

const text = (value: unknown) => String(value ?? "").trim();
const employeeCode = (value: unknown) => text(value).toUpperCase();
const payrollCode = (value: unknown) => text(value).toUpperCase().replace(/[\s-]+/g, "_");
const dateKey = (value: Date | string | null | undefined) => value ? new Date(value).toISOString().slice(0, 10) : "";

function errorText(error: any) {
  return String(error?.message || error?.data || "Invalid compensation row");
}

function headerKey(value: unknown) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cellValue(value: any) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((item: any) => item.text || "").join("");
    if (value.result !== undefined) return cellValue(value.result);
    if (value.text !== undefined) return text(value.text);
  }
  return text(value);
}

export function parseCompensationAmountToMinor(value: unknown, minorUnits: number) {
  const normalized = text(value).replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Override amount must be a non-negative number");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > minorUnits) throw new Error(`Override amount supports at most ${minorUnits} decimal places`);
  const amount = Number(whole) * 10 ** minorUnits + Number(fraction.padEnd(minorUnits, "0") || "0");
  if (!Number.isSafeInteger(amount)) throw new Error("Override amount is too large");
  return amount;
}

export async function parseCompensationImportFile(file: any): Promise<ImportRow[]> {
  if (!file?.buffer) throw generateError("Compensation CSV or XLSX file is required", 400);
  const fileName = text(file.originalname).toLowerCase();
  if (!fileName.endsWith(".csv") && !fileName.endsWith(".xlsx")) {
    throw generateError("Upload a CSV or XLSX compensation file", 422);
  }
  const workbook = new ExcelJS.Workbook();
  if (fileName.endsWith(".csv")) await workbook.csv.read(Readable.from([file.buffer]) as any);
  else await workbook.xlsx.load(file.buffer as any);
  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount < 2) throw generateError("Compensation import has no data rows", 422);

  const standardHeaders: Record<string, keyof Omit<ImportRow, "rowNumber" | "overrideInputs">> = {
    employeecode: "employeeCode",
    salarystructurecode: "salaryStructureCode",
    effectivefrom: "effectiveFrom",
    assignmentreason: "assignmentReason",
  };
  const standardColumns = new Map<number, keyof Omit<ImportRow, "rowNumber" | "overrideInputs">>();
  const overrideColumns = new Map<number, string>();
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    const rawHeader = cellValue(cell.value);
    const mapped = standardHeaders[headerKey(rawHeader)];
    if (mapped) {
      standardColumns.set(columnNumber, mapped);
      return;
    }
    const match = rawHeader.match(/^override(?:\s+|\s*[:_-]\s*)(.+)$/i);
    if (match?.[1]) overrideColumns.set(columnNumber, payrollCode(match[1]));
  });
  for (const required of Object.values(standardHeaders)) {
    if (![...standardColumns.values()].includes(required)) throw generateError(`Missing ${required} column`, 422);
  }

  const rows: ImportRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: any = {};
    standardColumns.forEach((key, columnNumber) => { raw[key] = cellValue(row.getCell(columnNumber).value); });
    const overrideInputs = [...overrideColumns.entries()]
      .map(([columnNumber, componentCode]) => ({ componentCode, amount: cellValue(row.getCell(columnNumber).value) }))
      .filter((item) => item.amount !== "");
    if (![...Object.values(raw), ...overrideInputs.map((item) => item.amount)].some((value) => text(value))) return;
    rows.push({
      rowNumber,
      employeeCode: employeeCode(raw.employeeCode),
      salaryStructureCode: payrollCode(raw.salaryStructureCode),
      effectiveFrom: text(raw.effectiveFrom),
      assignmentReason: text(raw.assignmentReason),
      overrideInputs,
    });
  });
  if (!rows.length) throw generateError("Compensation import has no data rows", 422);
  if (rows.length > 1000) throw generateError("Compensation import cannot exceed 1000 rows", 422);
  return rows;
}

async function validateRows(company: mongoose.Types.ObjectId, rows: ImportRow[]): Promise<ValidatedRow[]> {
  const employeeCodes = [...new Set(rows.map((row) => row.employeeCode).filter(Boolean))];
  const structureCodes = [...new Set(rows.map((row) => row.salaryStructureCode).filter(Boolean))];
  const [employees, structures]: any[][] = await Promise.all([
    User.find({ company, code: { $in: employeeCodes }, deletedAt: null, role: { $ne: "superadmin" } })
      .select("_id name username code joiningDate employmentEndDate is_enabled")
      .lean(),
    SalaryStructure.find({ company, code: { $in: structureCodes } }).lean(),
  ]);
  const employeeByCode = new Map(employees.map((employee) => [employeeCode(employee.code), employee]));
  const structureByCode = new Map(structures.map((structure) => [payrollCode(structure.code), structure]));
  const versions: any[] = structures.length
    ? await SalaryStructureVersion.find({
        company,
        salaryStructure: { $in: structures.map((structure) => structure._id) },
        status: "published",
      }).sort({ effectiveFrom: 1 }).lean()
    : [];
  const versionsByStructure = new Map<string, any[]>();
  versions.forEach((version) => {
    const key = String(version.salaryStructure);
    versionsByStructure.set(key, [...(versionsByStructure.get(key) || []), version]);
  });

  const seen = new Set<string>();
  const validated: ValidatedRow[] = rows.map((row) => {
    const errors: string[] = [];
    const employee: any = employeeByCode.get(row.employeeCode);
    const structure: any = structureByCode.get(row.salaryStructureCode);
    let effectiveFrom: Date | null = null;
    let version: any = null;
    let resolvedOverrides: ValidatedRow["resolvedOverrides"] = [];
    let previewTotals: Record<string, number> | undefined;

    if (!row.employeeCode) errors.push("Employee code is required");
    else if (!employee) errors.push("Employee code was not found in this company");
    if (!row.salaryStructureCode) errors.push("Salary structure code is required");
    else if (!structure) errors.push("Salary structure code was not found in this company");
    else if (structure.status !== "active") errors.push("Salary structure is archived");
    try { effectiveFrom = parseCompensationDate(row.effectiveFrom, "Effective-from date"); }
    catch (error) { errors.push(errorText(error)); }
    if (row.assignmentReason.length < 3) errors.push("Assignment reason must contain at least 3 characters");
    if (row.assignmentReason.length > 500) errors.push("Assignment reason cannot exceed 500 characters");

    if (employee && effectiveFrom) {
      try { validateCompensationEmployeeDates(employee, effectiveFrom); }
      catch (error) { errors.push(errorText(error)); }
    }
    if (structure && effectiveFrom) {
      version = (versionsByStructure.get(String(structure._id)) || []).find((candidate) => {
        const starts = dateKey(candidate.effectiveFrom);
        const ends = dateKey(candidate.effectiveTo);
        const requested = dateKey(effectiveFrom);
        return starts && starts <= requested && (!ends || ends >= requested);
      });
      if (!version) errors.push("No published salary structure version covers this effective date");
    }

    if (employee && effectiveFrom) {
      const duplicateKey = `${employee._id}:${dateKey(effectiveFrom)}`;
      if (seen.has(duplicateKey)) errors.push("Duplicate employee and effective date in this file");
      seen.add(duplicateKey);
    }

    if (version) {
      const ruleByCode = new Map((version.rules || []).map((rule: any) => [payrollCode(rule.componentCodeSnapshot), rule]));
      const overridePayload: any[] = [];
      for (const input of row.overrideInputs) {
        const rule: any = ruleByCode.get(input.componentCode);
        if (!rule) {
          errors.push(`Override ${input.componentCode} is not part of this salary structure version`);
          continue;
        }
        if (!rule.allowEmployeeOverride) {
          errors.push(`Override ${input.componentCode} is not permitted by this salary structure`);
          continue;
        }
        try {
          const monthlyAmountMinor = parseCompensationAmountToMinor(input.amount, version.currencyMinorUnits);
          resolvedOverrides.push({
            salaryComponent: rule.salaryComponent,
            componentCodeSnapshot: rule.componentCodeSnapshot,
            componentNameSnapshot: rule.componentNameSnapshot,
            monthlyAmountMinor,
          });
          overridePayload.push({ salaryComponentId: rule.salaryComponent, monthlyAmountMinor });
        } catch (error) {
          errors.push(`${input.componentCode}: ${errorText(error)}`);
        }
      }
      if (!errors.length) {
        try { previewTotals = buildCompensationSnapshot(version, overridePayload).totals; }
        catch (error) { errors.push(errorText(error)); }
      }
    }
    return {
      ...row,
      status: errors.length ? "invalid" : "valid",
      errors,
      employee,
      structure,
      version,
      resolvedOverrides,
      previewTotals,
    };
  });

  const validCandidates = validated.filter((row) => row.employee && row.effectiveFrom && !row.errors.length);
  if (validCandidates.length) {
    const existing: any[] = await EmployeeCompensationAssignment.find({
      company,
      status: "assigned",
      employee: { $in: validCandidates.map((row) => row.employee._id) },
      effectiveFrom: { $in: validCandidates.map((row) => new Date(`${row.effectiveFrom}T00:00:00.000Z`)) },
    }).select("employee effectiveFrom").lean();
    const existingKeys = new Set(existing.map((assignment) => `${assignment.employee}:${dateKey(assignment.effectiveFrom)}`));
    validated.forEach((row) => {
      if (row.employee && existingKeys.has(`${row.employee._id}:${row.effectiveFrom}`)) {
        row.errors.push("An active compensation assignment already starts on this date");
        row.status = "invalid";
      }
    });
  }
  return validated;
}

function rowDocument(company: mongoose.Types.ObjectId, batch: mongoose.Types.ObjectId, row: ValidatedRow) {
  return {
    company,
    batch,
    rowNumber: row.rowNumber,
    employeeCode: row.employeeCode,
    salaryStructureCode: row.salaryStructureCode,
    effectiveFrom: row.effectiveFrom,
    assignmentReason: row.assignmentReason,
    overrideInputs: row.overrideInputs,
    status: row.status,
    validationErrors: row.errors,
    employee: row.employee?._id || null,
    employeeNameSnapshot: row.employee ? row.employee.name || row.employee.username : undefined,
    salaryStructure: row.structure?._id || null,
    salaryStructureVersion: row.version?._id || null,
    structureNameSnapshot: row.structure?.name,
    structureVersionNumber: row.version?.versionNumber || null,
    currency: row.version?.currency,
    currencyMinorUnits: row.version?.currencyMinorUnits ?? null,
    resolvedOverrides: row.resolvedOverrides,
    previewTotals: row.previewTotals || {},
  };
}

function serializeRow(row: any) {
  return {
    _id: row._id,
    rowNumber: row.rowNumber,
    employeeCode: row.employeeCode,
    employeeName: row.employeeNameSnapshot || null,
    salaryStructureCode: row.salaryStructureCode,
    structureName: row.structureNameSnapshot || null,
    structureVersionNumber: row.structureVersionNumber || null,
    effectiveFrom: row.effectiveFrom,
    assignmentReason: row.assignmentReason,
    overrideInputs: row.overrideInputs || [],
    status: row.status,
    errors: row.validationErrors || [],
    currency: row.currency || null,
    currencyMinorUnits: row.currencyMinorUnits ?? null,
    previewTotals: row.previewTotals || {},
    assignment: row.assignment || null,
  };
}

export async function previewCompensationImportService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const rows = await parseCompensationImportFile(req.file);
    const validated = await validateRows(companyObjectId, rows);
    const validRows = validated.filter((row) => row.status === "valid").length;
    const invalidRows = validated.length - validRows;
    const fileHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    let batch: any;
    await mongoose.connection.transaction(async (session) => {
      [batch] = await CompensationImportBatch.create([{
        company: companyObjectId,
        fileName: text(req.file.originalname),
        fileHash,
        status: "previewed",
        totalRows: validated.length,
        validRows,
        invalidRows,
        createdBy: actorId,
      }], { session });
      await CompensationImportRow.insertMany(
        validated.map((row) => rowDocument(companyObjectId, batch._id, row)),
        { session, ordered: true }
      );
      await PayrollAuditLog.create([{
        company: companyObjectId,
        entityType: "compensation_import",
        entityId: batch._id,
        action: "previewed",
        actor: actorId,
        details: { fileName: batch.fileName, fileHash, totalRows: validated.length, validRows, invalidRows },
      }], { session });
    });
    const firstRows: any[] = await CompensationImportRow.find({ company: companyObjectId, batch: batch._id })
      .sort({ rowNumber: 1 }).limit(50).lean();
    return res.status(201).json({
      success: true,
      data: {
        batch: { _id: batch._id, status: batch.status, fileName: batch.fileName, totalRows: validated.length, validRows, invalidRows },
        rows: firstRows.map(serializeRow),
        pagination: { page: 1, limit: 50, total: validated.length, totalPages: Math.ceil(validated.length / 50) },
      },
      message: invalidRows ? "Preview created with validation errors" : "Compensation import is ready to commit",
    });
  } catch (error) {
    next(error);
  }
}

export async function listCompensationImportRowsService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const batchId = text(req.params.batchId);
    if (!mongoose.Types.ObjectId.isValid(batchId)) throw generateError("Invalid compensation import batch id", 400);
    const batch: any = await CompensationImportBatch.findOne({ _id: batchId, company: companyObjectId }).lean();
    if (!batch) throw generateError("Compensation import batch not found", 404);
    const page = Math.max(1, Number.parseInt(text(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(text(req.query.limit || "50"), 10) || 50));
    const status = text(req.query.status || "all").toLowerCase();
    if (!["all", "valid", "invalid", "committed"].includes(status)) throw generateError("Invalid import row status", 422);
    const match: any = { company: companyObjectId, batch: batch._id };
    if (status !== "all") match.status = status;
    const [rows, total] = await Promise.all([
      CompensationImportRow.find(match).sort({ rowNumber: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      CompensationImportRow.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: { batch, rows: rows.map(serializeRow) },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
}

export async function listCompensationImportBatchesService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const page = Math.max(1, Number.parseInt(text(req.query.page || "1"), 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(text(req.query.limit || "20"), 10) || 20));
    const status = text(req.query.status || "all").toLowerCase();
    if (!["all", "previewed", "completed", "failed"].includes(status)) throw generateError("Invalid compensation import status", 422);
    const match: any = { company: companyObjectId };
    if (status !== "all") match.status = status;
    const [batches, total] = await Promise.all([
      CompensationImportBatch.find(match)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("createdBy committedBy", "name username code")
        .lean(),
      CompensationImportBatch.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: batches,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
}

export async function commitCompensationImportService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const batchId = text(req.params.batchId);
    if (!mongoose.Types.ObjectId.isValid(batchId)) throw generateError("Invalid compensation import batch id", 400);
    const existing: any = await CompensationImportBatch.findOne({ _id: batchId, company: companyObjectId }).lean();
    if (!existing) throw generateError("Compensation import batch not found", 404);
    if (existing.status === "completed") {
      return res.status(200).json({ success: true, replayed: true, data: existing.result });
    }
    if (existing.invalidRows > 0) throw generateError("Fix all row validation errors and create a new preview before committing", 422);

    let result: any;
    await mongoose.connection.transaction(async (session) => {
      const batch: any = await CompensationImportBatch.findOne({
        _id: new mongoose.Types.ObjectId(batchId),
        company: companyObjectId,
        status: "previewed",
      }).session(session);
      if (!batch) throw generateError("Compensation import was already committed or is no longer available", 409);
      const rows: any[] = await CompensationImportRow.find({ company: companyObjectId, batch: batch._id, status: "valid" })
        .sort({ rowNumber: 1 }).session(session).lean();
      if (rows.length !== batch.totalRows) throw generateError("Compensation import rows changed after preview", 409);

      const [employees, structures, versions]: any[][] = await Promise.all([
        User.find({ company: companyObjectId, _id: { $in: rows.map((row) => row.employee) }, deletedAt: null })
          .select("_id name username code joiningDate employmentEndDate").session(session).lean(),
        SalaryStructure.find({ company: companyObjectId, _id: { $in: rows.map((row) => row.salaryStructure) }, status: "active" })
          .session(session).lean(),
        SalaryStructureVersion.find({ company: companyObjectId, _id: { $in: rows.map((row) => row.salaryStructureVersion) }, status: "published" })
          .session(session).lean(),
      ]);
      const employeeById = new Map(employees.map((item) => [String(item._id), item]));
      const structureById = new Map(structures.map((item) => [String(item._id), item]));
      const versionById = new Map(versions.map((item) => [String(item._id), item]));
      const dates = rows.map((row) => new Date(`${row.effectiveFrom}T00:00:00.000Z`));
      const duplicateAssignments: any[] = await EmployeeCompensationAssignment.find({
        company: companyObjectId,
        employee: { $in: rows.map((row) => row.employee) },
        effectiveFrom: { $in: dates },
        status: "assigned",
      }).select("employee effectiveFrom").session(session).lean();
      const requestedKeys = new Set(rows.map((row) => `${row.employee}:${row.effectiveFrom}`));
      const hasExactConflict = duplicateAssignments.some((assignment) =>
        requestedKeys.has(`${assignment.employee}:${dateKey(assignment.effectiveFrom)}`)
      );
      if (hasExactConflict) throw generateError("Compensation changed after preview. Create a new preview before committing.", 409);

      const assignmentPayloads = rows.map((row) => {
        const employee: any = employeeById.get(String(row.employee));
        const structure: any = structureById.get(String(row.salaryStructure));
        const version: any = versionById.get(String(row.salaryStructureVersion));
        if (!employee || !structure || !version || String(version.salaryStructure) !== String(structure._id)) {
          throw generateError(`Row ${row.rowNumber} references compensation data that is no longer available`, 409);
        }
        const effectiveFrom = parseCompensationDate(row.effectiveFrom, "Effective-from date");
        validateCompensationEmployeeDates(employee, effectiveFrom);
        validateCompensationVersionEffectiveOn(version, effectiveFrom);
        const snapshot = buildCompensationSnapshot(version, (row.resolvedOverrides || []).map((override: any) => ({
          salaryComponentId: override.salaryComponent,
          monthlyAmountMinor: override.monthlyAmountMinor,
        })));
        return {
          company: companyObjectId,
          employee: employee._id,
          employeeNameSnapshot: employee.name || employee.username,
          employeeCodeSnapshot: employee.code,
          salaryStructure: structure._id,
          salaryStructureVersion: version._id,
          structureNameSnapshot: structure.name,
          structureCodeSnapshot: structure.code,
          structureVersionNumber: version.versionNumber,
          structureEffectiveFromSnapshot: version.effectiveFrom,
          structureEffectiveToSnapshot: version.effectiveTo || null,
          currency: version.currency,
          currencyMinorUnits: version.currencyMinorUnits,
          payFrequency: version.payFrequency,
          roundingMode: version.roundingMode,
          effectiveFrom,
          status: "assigned",
          assignmentReason: row.assignmentReason,
          ...snapshot,
          createdBy: actorId,
        };
      });
      const assignments: any[] = await EmployeeCompensationAssignment.insertMany(assignmentPayloads, { session, ordered: true });
      await PayrollAuditLog.insertMany([
        ...assignments.map((assignment, index) => ({
          company: companyObjectId,
          entityType: "employee_compensation",
          entityId: assignment._id,
          action: "bulk_assigned",
          actor: actorId,
          reason: rows[index].assignmentReason,
          details: {
            compensationImportBatch: batch._id,
            rowNumber: rows[index].rowNumber,
            employee: assignment.employee,
            salaryStructureVersion: assignment.salaryStructureVersion,
            effectiveFrom: assignment.effectiveFrom,
            totals: assignment.totals,
          },
        })),
        {
          company: companyObjectId,
          entityType: "compensation_import",
          entityId: batch._id,
          action: "committed",
          actor: actorId,
          details: { fileName: batch.fileName, fileHash: batch.fileHash, committedRows: assignments.length },
        },
      ], { session, ordered: true });
      await CompensationImportRow.bulkWrite(rows.map((row, index) => ({
        updateOne: {
          filter: { _id: row._id, company: companyObjectId, batch: batch._id, status: "valid" },
          update: { $set: { status: "committed", assignment: assignments[index]._id } },
        },
      })), { session, ordered: true });
      result = { batchId: batch._id, totalRows: batch.totalRows, committedRows: assignments.length };
      batch.status = "completed";
      batch.committedRows = assignments.length;
      batch.committedBy = actorId;
      batch.committedAt = new Date();
      batch.result = result;
      await batch.save({ session });
    });
    return res.status(200).json({ success: true, data: result, message: "Compensation import committed" });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("Compensation changed after preview. Create a new preview before committing.", 409));
    next(error);
  }
}

export async function downloadCompensationImportTemplateService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const structures: any[] = await SalaryStructure.find({ company: companyObjectId, status: "active" }).sort({ name: 1 }).lean();
    const versions: any[] = structures.length
      ? await SalaryStructureVersion.find({
          company: companyObjectId,
          salaryStructure: { $in: structures.map((structure) => structure._id) },
          status: "published",
        }).sort({ salaryStructure: 1, effectiveFrom: 1 }).lean()
      : [];
    const structureById = new Map(structures.map((structure) => [String(structure._id), structure]));
    const overrideCodes = [...new Set(versions.flatMap((version) => (version.rules || [])
      .filter((rule: any) => rule.allowEmployeeOverride)
      .map((rule: any) => payrollCode(rule.componentCodeSnapshot))))].sort();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Compensation Import");
    sheet.columns = [
      { header: "Employee Code", key: "employeeCode", width: 22 },
      { header: "Salary Structure Code", key: "salaryStructureCode", width: 28 },
      { header: "Effective From", key: "effectiveFrom", width: 18 },
      { header: "Assignment Reason", key: "assignmentReason", width: 42 },
      ...overrideCodes.map((componentCode) => ({ header: `Override ${componentCode}`, key: `override_${componentCode}`, width: 22 })),
    ];
    const exampleStructure: any = structures.find((structure) => versions.some((version) => String(version.salaryStructure) === String(structure._id)));
    const exampleVersion: any = exampleStructure
      ? versions.find((version) => String(version.salaryStructure) === String(exampleStructure._id))
      : null;
    sheet.addRow({
      employeeCode: "ACME-101",
      salaryStructureCode: exampleStructure?.code || "STANDARD_MONTHLY",
      effectiveFrom: dateKey(exampleVersion?.effectiveFrom) || "2026-10-01",
      assignmentReason: "Approved compensation revision",
    });
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const references = workbook.addWorksheet("Published Structures");
    references.columns = [
      { header: "Structure Code", key: "structureCode", width: 26 },
      { header: "Structure Name", key: "structureName", width: 34 },
      { header: "Version", key: "version", width: 12 },
      { header: "Effective From", key: "effectiveFrom", width: 18 },
      { header: "Effective To", key: "effectiveTo", width: 18 },
      { header: "Currency", key: "currency", width: 12 },
      { header: "Permitted Overrides", key: "overrides", width: 50 },
    ];
    versions.forEach((version) => {
      const structure: any = structureById.get(String(version.salaryStructure));
      references.addRow({
        structureCode: structure?.code,
        structureName: structure?.name,
        version: version.versionNumber,
        effectiveFrom: dateKey(version.effectiveFrom),
        effectiveTo: dateKey(version.effectiveTo) || "Onward",
        currency: version.currency,
        overrides: (version.rules || []).filter((rule: any) => rule.allowEmployeeOverride).map((rule: any) => rule.componentCodeSnapshot).join(", ") || "None",
      });
    });
    references.getRow(1).font = { bold: true };
    references.views = [{ state: "frozen", ySplit: 1 }];

    const instructions = workbook.addWorksheet("Instructions");
    [
      ["Field", "Rule"],
      ["Employee Code", "Required. Must exactly match an employee code in this company."],
      ["Salary Structure Code", "Required. Use an active structure listed in Published Structures."],
      ["Effective From", "Required. Use YYYY-MM-DD. A published structure version must cover the date."],
      ["Assignment Reason", "Required. Enter 3-500 characters for permanent audit history."],
      ["Override columns", "Optional. Enter normal currency amounts such as 60000.00, not minor units. Blank uses the structure value."],
      ["Commit behavior", "Every row must pass preview. Commit is atomic: either every assignment is created or none are."],
    ].forEach((row) => instructions.addRow(row));
    instructions.getRow(1).font = { bold: true };
    instructions.columns = [{ width: 25 }, { width: 100 }];

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="compensation-import-template.xlsx"');
    return res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
}
