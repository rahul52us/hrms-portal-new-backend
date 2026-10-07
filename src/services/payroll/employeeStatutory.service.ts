import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import EmployeeStatutoryAssignment from "../../schemas/Payroll/EmployeeStatutoryAssignment.schema";
import EmployeeTaxDeclaration from "../../schemas/Payroll/EmployeeTaxDeclaration.schema";
import ProfileDetails from "../../schemas/User/ProfileDetails";
import User from "../../schemas/User/User";
import {
  ensureEmployeeStatutoryManager,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";
import { getStatutoryProvider, listStatutoryProviders } from "./statutory/statutoryProvider.registry";
import { resolveCompanyStatutorySnapshot } from "./statutoryProfile.service";

const text = (value: unknown) => String(value ?? "").trim();
const idString = (value: any) => String(value?._id || value || "");
const escapeRegex = (value: string) => value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError("Invalid " + label, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function parseDate(value: unknown, label: string) {
  const normalized = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw generateError(label + " must use YYYY-MM-DD", 422);
  const date = new Date(normalized + "T00:00:00.000Z");
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw generateError(label + " is invalid", 422);
  }
  return date;
}

function dateKey(value?: Date | string | null) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.PAYROLL_TIMEZONE || "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function taxYearForDate(value: string | Date) {
  const key = dateKey(value);
  if (!key) throw generateError("Tax year date is invalid", 422);
  const [year, month] = key.split("-").map(Number);
  const startYear = month >= 4 ? year : year - 1;
  return String(startYear) + "-" + String((startYear + 1) % 100).padStart(2, "0");
}

function validateTaxYear(value: unknown) {
  const normalized = text(value);
  const match = /^(\d{4})-(\d{2})$/.exec(normalized);
  if (!match || Number(match[2]) !== (Number(match[1]) + 1) % 100) {
    throw generateError("Tax year must use the financial-year format YYYY-YY, for example 2026-27", 422);
  }
  return normalized;
}

function requiredReason(value: unknown, label = "Reason") {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) throw generateError(label + " must contain 3 to 500 characters", 422);
  return reason;
}

function requiredRevision(value: unknown) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw generateError("Expected declaration revision is required", 422);
  return revision;
}

function pageNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

async function findEmployee(company: mongoose.Types.ObjectId, employeeInput: unknown) {
  const employeeId = objectId(employeeInput, "employee id");
  const employee: any = await User.findOne({
    _id: employeeId,
    company,
    deletedAt: null,
    role: { $ne: "superadmin" },
  })
    .select("_id name username code designation role pic is_enabled joiningDate employmentEndDate")
    .lean();
  if (!employee) throw generateError("Employee not found", 404);
  return employee;
}

async function providerContext(company: mongoose.Types.ObjectId, asOfDate: string, session?: mongoose.ClientSession) {
  const snapshot: any = await resolveCompanyStatutorySnapshot(company, asOfDate, session);
  if (!snapshot) throw generateError("Publish a company statutory profile effective on " + asOfDate + " first", 409);
  const provider = getStatutoryProvider(snapshot.statutoryProviderKey);
  if (!provider) throw generateError("The effective statutory provider is not available", 409);
  return { snapshot, provider };
}

function providerMetadata(providerKey: string) {
  return listStatutoryProviders().find((item) => item.key === providerKey) || null;
}

export function deriveStatutoryAssignmentRanges(assignments: any[], asOf = todayKey()) {
  const assigned = assignments
    .filter((item) => item.status === "assigned")
    .sort((a, b) => dateKey(a.effectiveFrom).localeCompare(dateKey(b.effectiveFrom)));
  const ranges = assigned.map((item, index) => {
    const next = assigned[index + 1];
    const effectiveFrom = dateKey(item.effectiveFrom);
    let effectiveTo: string | null = null;
    if (next) {
      const date = new Date(dateKey(next.effectiveFrom) + "T00:00:00.000Z");
      date.setUTCDate(date.getUTCDate() - 1);
      effectiveTo = dateKey(date);
    }
    return {
      ...item,
      effectiveFrom,
      effectiveTo,
      isCurrent: effectiveFrom <= asOf && (!effectiveTo || effectiveTo >= asOf),
      isUpcoming: effectiveFrom > asOf,
    };
  });
  const cancelled = assignments
    .filter((item) => item.status === "cancelled")
    .map((item) => ({ ...item, effectiveFrom: dateKey(item.effectiveFrom), effectiveTo: null, isCurrent: false, isUpcoming: false }));
  return [...ranges, ...cancelled].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
}

function maskedIdentifierSummary(assignment: any) {
  const value = assignment?.identifiers?.panNumber || assignment?.identifiers?.uan || assignment?.identifiers?.esiInsuranceNumber || "";
  if (!value) return "";
  return value.length <= 4 ? "*".repeat(value.length) : "*".repeat(value.length - 4) + value.slice(-4);
}

export async function listEmployeeStatutoryService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeStatutoryManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 20, 100);
    const search = text(req.query?.search);
    const setup = text(req.query?.setup || "all").toLowerCase();
    if (!["all", "configured", "missing"].includes(setup)) throw generateError("Invalid statutory setup filter", 422);
    const match: any = { company: companyObjectId, deletedAt: null, role: { $ne: "superadmin" } };
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$or = [{ name: regex }, { username: regex }, { code: regex }, { designation: regex }];
    }
    const asOf = todayKey();
    if (setup !== "all") {
      const configuredEmployeeIds = await EmployeeStatutoryAssignment.distinct("employee", {
        company: companyObjectId,
        status: "assigned",
        effectiveFrom: { $lte: new Date(asOf + "T23:59:59.999Z") },
      });
      match._id = setup === "configured" ? { $in: configuredEmployeeIds } : { $nin: configuredEmployeeIds };
    }
    const totalCandidates = await User.countDocuments(match);
    const candidates: any[] = await User.find(match)
      .select("_id name username code designation role pic is_enabled joiningDate employmentEndDate")
      .sort({ name: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    const employeeIds = candidates.map((item) => item._id);
    const taxYear = taxYearForDate(asOf);
    const [assignments, declarations]: any[][] = await Promise.all([
      EmployeeStatutoryAssignment.find({
        company: companyObjectId,
        employee: { $in: employeeIds },
        status: "assigned",
        effectiveFrom: { $lte: new Date(asOf + "T23:59:59.999Z") },
      }).sort({ employee: 1, effectiveFrom: -1 }).lean(),
      EmployeeTaxDeclaration.find({
        company: companyObjectId,
        employee: { $in: employeeIds },
        taxYear,
        status: { $in: ["draft", "submitted", "verified", "returned"] },
      }).sort({ employee: 1, versionNumber: -1 }).lean(),
    ]);
    const assignmentByEmployee = new Map<string, any>();
    for (const assignment of assignments) {
      const key = idString(assignment.employee);
      if (!assignmentByEmployee.has(key)) assignmentByEmployee.set(key, assignment);
    }
    const declarationByEmployee = new Map<string, any>();
    for (const declaration of declarations) {
      const key = idString(declaration.employee);
      if (!declarationByEmployee.has(key)) declarationByEmployee.set(key, declaration);
    }
    const rows = candidates.map((employee) => {
      const assignment = assignmentByEmployee.get(idString(employee._id));
      const declaration = declarationByEmployee.get(idString(employee._id));
      return {
        ...employee,
        statutorySetup: assignment
          ? {
              assignmentId: assignment._id,
              effectiveFrom: dateKey(assignment.effectiveFrom),
              countryCode: assignment.countryCode,
              providerKey: assignment.providerKey,
              identifierPreview: maskedIdentifierSummary(assignment),
            }
          : null,
        currentTaxYear: taxYear,
        taxDeclaration: declaration
          ? { _id: declaration._id, versionNumber: declaration.versionNumber, status: declaration.status, taxRegime: declaration.taxRegime }
          : null,
      };
    });
    return res.status(200).json({
      success: true,
      data: rows,
      asOf,
      taxYear,
      pagination: { page, limit, total: totalCandidates, totalPages: Math.ceil(totalCandidates / limit) },
    });
  } catch (error) {
    next(error);
  }
}

export async function getEmployeeStatutoryService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeStatutoryManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const employee = await findEmployee(companyObjectId, req.params.employeeId);
    const [assignments, declarations, legacyProfile]: any[] = await Promise.all([
      EmployeeStatutoryAssignment.find({ company: companyObjectId, employee: employee._id })
        .sort({ effectiveFrom: -1, createdAt: -1 })
        .populate("createdBy cancelledBy", "name username code")
        .lean(),
      EmployeeTaxDeclaration.find({ company: companyObjectId, employee: employee._id })
        .sort({ taxYear: -1, versionNumber: -1 })
        .populate("createdBy updatedBy submittedBy reviewedBy cancelledBy", "name username code")
        .lean(),
      ProfileDetails.findOne({ user: employee._id })
        .select("statutoryDetails personalDetails.nationality")
        .lean(),
    ]);
    const current = deriveStatutoryAssignmentRanges(assignments).find((item) => item.isCurrent) || null;
    const companyStatutory: any = await resolveCompanyStatutorySnapshot(companyObjectId, todayKey());
    const providerKey = current?.providerKey || companyStatutory?.statutoryProviderKey || "";
    const provider = providerKey ? providerMetadata(providerKey) : listStatutoryProviders()[0] || null;
    return res.status(200).json({
      success: true,
      data: {
        employee,
        provider,
        assignments: deriveStatutoryAssignmentRanges(assignments),
        declarations,
        currentTaxYear: taxYearForDate(todayKey()),
        enabledModules: current?.enabledModulesSnapshot || companyStatutory?.statutoryEnabledModules || [],
        legacyIdentifiers: current
          ? null
          : {
              panNumber: text(legacyProfile?.statutoryDetails?.panNumber).toUpperCase(),
              nameAsPerPan: text(legacyProfile?.statutoryDetails?.nameAsPerPan),
              aadhaarNumber: text(legacyProfile?.statutoryDetails?.aadharNumber),
              nameAsPerAadhaar: text(legacyProfile?.statutoryDetails?.nameAsPerAadhar),
              nationality: text(legacyProfile?.statutoryDetails?.nationality || legacyProfile?.personalDetails?.nationality).toLowerCase(),
            },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function createEmployeeStatutoryAssignmentService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeStatutoryManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage employee statutory data");
    const actorId = getPayrollActorId(req);
    const employee = await findEmployee(companyObjectId, req.body?.employeeId);
    const effectiveFrom = parseDate(req.body?.effectiveFrom, "Effective date");
    const effectiveKey = dateKey(effectiveFrom);
    if (employee.joiningDate && effectiveKey < dateKey(employee.joiningDate)) {
      throw generateError("Statutory identifiers cannot start before the employee joining date", 409);
    }
    if (employee.employmentEndDate && effectiveKey > dateKey(employee.employmentEndDate)) {
      throw generateError("Statutory identifiers cannot start after the employee employment end date", 409);
    }
    const assignmentReason = requiredReason(req.body?.assignmentReason, "Assignment reason");
    const { snapshot, provider } = await providerContext(companyObjectId, effectiveKey);
    const normalized = provider.validateEmployeeStatutory({
      identifiers: req.body?.identifiers,
      applicability: req.body?.applicability,
      enabledModules: snapshot.statutoryEnabledModules,
    });
    if (normalized.errors.length) throw generateError(normalized.errors.join("; "), 422);
    let assignment: any;
    await mongoose.connection.transaction(async (session) => {
      const duplicate = await EmployeeStatutoryAssignment.exists({
        company: companyObjectId,
        employee: employee._id,
        effectiveFrom,
        status: "assigned",
      }).session(session);
      if (duplicate) throw generateError("This employee already has statutory identifiers starting on this date", 409);
      [assignment] = await EmployeeStatutoryAssignment.create([{
        company: companyObjectId,
        employee: employee._id,
        employeeNameSnapshot: employee.name || employee.username,
        employeeCodeSnapshot: employee.code,
        statutoryProfile: snapshot.statutoryProfile,
        statutoryProfileVersion: snapshot.statutoryProfileVersion,
        statutoryProfileVersionNumber: snapshot.statutoryProfileVersionNumber,
        countryCode: snapshot.statutoryCountryCode,
        providerKey: snapshot.statutoryProviderKey,
        providerImplementationVersion: provider.implementationVersion,
        enabledModulesSnapshot: snapshot.statutoryEnabledModules,
        effectiveFrom,
        identifiers: normalized.identifiers,
        applicability: normalized.applicability,
        assignmentReason,
        createdBy: actorId,
      }], { session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "employee_statutory",
        entityId: assignment._id,
        action: "assigned",
        actor: actorId,
        reason: assignmentReason,
        details: {
          employee: employee._id,
          employeeCode: employee.code,
          effectiveFrom: effectiveKey,
          providerKey: snapshot.statutoryProviderKey,
          statutoryProfileVersionNumber: snapshot.statutoryProfileVersionNumber,
          populatedIdentifierKeys: Object.entries(normalized.identifiers).filter(([, value]) => Boolean(value)).map(([key]) => key),
          applicability: normalized.applicability,
        },
      }, session);
    });
    return res.status(201).json({ success: true, data: assignment, message: "Employee statutory identifiers assigned" });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("This employee already has statutory identifiers starting on this date", 409));
    next(error);
  }
}

export async function cancelFutureEmployeeStatutoryAssignmentService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeStatutoryManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage employee statutory data");
    const actorId = getPayrollActorId(req);
    const assignmentId = objectId(req.params.assignmentId, "employee statutory assignment id");
    const reason = requiredReason(req.body?.reason, "Cancellation reason");
    await mongoose.connection.transaction(async (session) => {
      const assignment: any = await EmployeeStatutoryAssignment.findOne({
        _id: assignmentId,
        company: companyObjectId,
        status: "assigned",
      }).session(session);
      if (!assignment) throw generateError("Active employee statutory assignment not found", 404);
      if (dateKey(assignment.effectiveFrom) <= todayKey()) {
        throw generateError("Only a future statutory assignment can be cancelled. Create a new effective-dated record for active changes.", 409);
      }
      assignment.status = "cancelled";
      assignment.cancelledAt = new Date();
      assignment.cancelledBy = actorId;
      assignment.cancellationReason = reason;
      await assignment.save({ session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "employee_statutory",
        entityId: assignment._id,
        action: "future_assignment_cancelled",
        actor: actorId,
        reason,
        details: { employee: assignment.employee, effectiveFrom: dateKey(assignment.effectiveFrom) },
      }, session);
    });
    return res.status(200).json({ success: true, message: "Future employee statutory assignment cancelled" });
  } catch (error) {
    next(error);
  }
}

export async function createEmployeeTaxDeclarationService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeStatutoryManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage employee tax declarations");
    const actorId = getPayrollActorId(req);
    const employee = await findEmployee(companyObjectId, req.body?.employeeId);
    const taxYear = validateTaxYear(req.body?.taxYear);
    const reason = requiredReason(req.body?.changeReason, "Change reason");
    const { snapshot, provider } = await providerContext(companyObjectId, todayKey());
    let declaration: any;
    await mongoose.connection.transaction(async (session) => {
      const existingDraft = await EmployeeTaxDeclaration.exists({
        company: companyObjectId,
        employee: employee._id,
        taxYear,
        status: "draft",
      }).session(session);
      if (existingDraft) throw generateError("Finish or cancel the existing tax declaration draft first", 409);
      const submitted = await EmployeeTaxDeclaration.exists({
        company: companyObjectId,
        employee: employee._id,
        taxYear,
        status: "submitted",
      }).session(session);
      if (submitted) throw generateError("The submitted tax declaration must be reviewed before another version is created", 409);
      const latest: any = await EmployeeTaxDeclaration.findOne({
        company: companyObjectId,
        employee: employee._id,
        taxYear,
      }).sort({ versionNumber: -1 }).session(session).lean();
      const normalized = provider.validateTaxDeclaration({
        taxRegime: req.body?.taxRegime ?? latest?.taxRegime,
        declarations: req.body?.declarations ?? latest?.declarations,
        forSubmit: false,
      });
      if (normalized.errors.length) throw generateError(normalized.errors.join("; "), 422);
      [declaration] = await EmployeeTaxDeclaration.create([{
        company: companyObjectId,
        employee: employee._id,
        employeeNameSnapshot: employee.name || employee.username,
        employeeCodeSnapshot: employee.code,
        taxYear,
        versionNumber: Number(latest?.versionNumber || 0) + 1,
        statutoryProfile: snapshot.statutoryProfile,
        statutoryProfileVersion: snapshot.statutoryProfileVersion,
        statutoryProfileVersionNumber: snapshot.statutoryProfileVersionNumber,
        countryCode: snapshot.statutoryCountryCode,
        providerKey: snapshot.statutoryProviderKey,
        providerImplementationVersion: provider.implementationVersion,
        currency: provider.currencyCode,
        currencyMinorUnits: provider.currencyMinorUnits,
        taxRegime: normalized.taxRegime,
        declarations: normalized.declarations,
        changeReason: reason,
        createdBy: actorId,
        updatedBy: actorId,
      }], { session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "employee_tax_declaration",
        entityId: declaration._id,
        action: "draft_created",
        actor: actorId,
        reason,
        details: { employee: employee._id, employeeCode: employee.code, taxYear, versionNumber: declaration.versionNumber },
      }, session);
    });
    return res.status(201).json({ success: true, data: declaration, message: "Tax declaration draft created" });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("A tax declaration draft already exists for this employee and tax year", 409));
    next(error);
  }
}

export async function updateEmployeeTaxDeclarationService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeStatutoryManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage employee tax declarations");
    const actorId = getPayrollActorId(req);
    const declarationId = objectId(req.params.declarationId, "tax declaration id");
    const revision = requiredRevision(req.body?.expectedRevision);
    const reason = requiredReason(req.body?.changeReason, "Change reason");
    await mongoose.connection.transaction(async (session) => {
      const declaration: any = await EmployeeTaxDeclaration.findOne({
        _id: declarationId,
        company: companyObjectId,
        status: "draft",
        revision,
      }).session(session).lean();
      if (!declaration) throw generateError("Tax declaration draft not found or changed. Refresh and try again", 409);
      const provider = getStatutoryProvider(declaration.providerKey);
      if (!provider) throw generateError("The declaration statutory provider is not available", 409);
      const normalized = provider.validateTaxDeclaration({
        taxRegime: req.body?.taxRegime,
        declarations: req.body?.declarations,
        forSubmit: false,
      });
      if (normalized.errors.length) throw generateError(normalized.errors.join("; "), 422);
      const updated = await EmployeeTaxDeclaration.updateOne(
        { _id: declarationId, company: companyObjectId, status: "draft", revision },
        {
          $set: {
            taxRegime: normalized.taxRegime,
            declarations: normalized.declarations,
            changeReason: reason,
            updatedBy: actorId,
          },
          $inc: { revision: 1 },
        },
        { session }
      );
      if (updated.modifiedCount !== 1) throw generateError("Tax declaration changed while it was being saved", 409);
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "employee_tax_declaration",
        entityId: declarationId,
        action: "draft_updated",
        actor: actorId,
        reason,
        details: { employee: declaration.employee, taxYear: declaration.taxYear, versionNumber: declaration.versionNumber },
      }, session);
    });
    const data = await EmployeeTaxDeclaration.findById(declarationId).lean();
    return res.status(200).json({ success: true, data, message: "Tax declaration draft updated" });
  } catch (error) {
    next(error);
  }
}

export async function submitEmployeeTaxDeclarationService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeStatutoryManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "submit employee tax declarations");
    const actorId = getPayrollActorId(req);
    const declarationId = objectId(req.params.declarationId, "tax declaration id");
    const revision = requiredRevision(req.body?.expectedRevision);
    const reason = requiredReason(req.body?.reason, "Submission reason");
    await mongoose.connection.transaction(async (session) => {
      const declaration: any = await EmployeeTaxDeclaration.findOne({
        _id: declarationId,
        company: companyObjectId,
        status: "draft",
        revision,
      }).session(session).lean();
      if (!declaration) throw generateError("Tax declaration draft not found or changed. Refresh and try again", 409);
      const provider = getStatutoryProvider(declaration.providerKey);
      if (!provider) throw generateError("The declaration statutory provider is not available", 409);
      const normalized = provider.validateTaxDeclaration({
        taxRegime: declaration.taxRegime,
        declarations: declaration.declarations,
        forSubmit: true,
      });
      if (normalized.errors.length) throw generateError(normalized.errors.join("; "), 422);
      const submitted = await EmployeeTaxDeclaration.updateOne(
        { _id: declarationId, company: companyObjectId, status: "draft", revision },
        {
          $set: {
            status: "submitted",
            taxRegime: normalized.taxRegime,
            declarations: normalized.declarations,
            changeReason: reason,
            submittedAt: new Date(),
            submittedBy: actorId,
            updatedBy: actorId,
          },
          $inc: { revision: 1 },
        },
        { session }
      );
      if (submitted.modifiedCount !== 1) throw generateError("Tax declaration changed while it was being submitted", 409);
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "employee_tax_declaration",
        entityId: declarationId,
        action: "submitted",
        actor: actorId,
        reason,
        details: { employee: declaration.employee, taxYear: declaration.taxYear, versionNumber: declaration.versionNumber },
      }, session);
    });
    const data = await EmployeeTaxDeclaration.findById(declarationId).lean();
    return res.status(200).json({ success: true, data, message: "Tax declaration submitted for review" });
  } catch (error) {
    next(error);
  }
}

export async function reviewEmployeeTaxDeclarationService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeStatutoryManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "review employee tax declarations");
    const actorId = getPayrollActorId(req);
    const declarationId = objectId(req.params.declarationId, "tax declaration id");
    const revision = requiredRevision(req.body?.expectedRevision);
    const decision = text(req.body?.decision).toLowerCase();
    if (!["verify", "return"].includes(decision)) throw generateError("Decision must be verify or return", 422);
    const reason = requiredReason(req.body?.reason, "Review reason");
    await mongoose.connection.transaction(async (session) => {
      const declaration: any = await EmployeeTaxDeclaration.findOne({
        _id: declarationId,
        company: companyObjectId,
        status: "submitted",
        revision,
      }).session(session).lean();
      if (!declaration) throw generateError("Submitted tax declaration not found or changed. Refresh and try again", 409);
      if (decision === "verify") {
        await EmployeeTaxDeclaration.updateMany(
          {
            company: companyObjectId,
            employee: declaration.employee,
            taxYear: declaration.taxYear,
            status: "verified",
            _id: { $ne: declarationId },
          },
          { $set: { status: "superseded", reviewedAt: new Date(), reviewedBy: actorId, reviewReason: "Superseded by verified version " + declaration.versionNumber } },
          { session }
        );
      }
      const status = decision === "verify" ? "verified" : "returned";
      const reviewed = await EmployeeTaxDeclaration.updateOne(
        { _id: declarationId, company: companyObjectId, status: "submitted", revision },
        {
          $set: { status, reviewedAt: new Date(), reviewedBy: actorId, reviewReason: reason, updatedBy: actorId },
          $inc: { revision: 1 },
        },
        { session }
      );
      if (reviewed.modifiedCount !== 1) throw generateError("Tax declaration changed while it was being reviewed", 409);
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "employee_tax_declaration",
        entityId: declarationId,
        action: status,
        actor: actorId,
        reason,
        details: { employee: declaration.employee, taxYear: declaration.taxYear, versionNumber: declaration.versionNumber },
      }, session);
    });
    const data = await EmployeeTaxDeclaration.findById(declarationId).lean();
    return res.status(200).json({ success: true, data, message: decision === "verify" ? "Tax declaration verified" : "Tax declaration returned" });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("Another verified declaration already exists for this employee and tax year", 409));
    next(error);
  }
}

export async function cancelEmployeeTaxDeclarationDraftService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeStatutoryManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true, "manage employee tax declarations");
    const actorId = getPayrollActorId(req);
    const declarationId = objectId(req.params.declarationId, "tax declaration id");
    const revision = requiredRevision(req.body?.expectedRevision);
    const reason = requiredReason(req.body?.reason, "Cancellation reason");
    await mongoose.connection.transaction(async (session) => {
      const declaration: any = await EmployeeTaxDeclaration.findOneAndUpdate(
        { _id: declarationId, company: companyObjectId, status: "draft", revision },
        {
          $set: { status: "cancelled", cancelledAt: new Date(), cancelledBy: actorId, cancellationReason: reason, updatedBy: actorId },
          $inc: { revision: 1 },
        },
        { new: true, session }
      );
      if (!declaration) throw generateError("Tax declaration draft not found or changed. Refresh and try again", 409);
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "employee_tax_declaration",
        entityId: declarationId,
        action: "draft_cancelled",
        actor: actorId,
        reason,
        details: { employee: declaration.employee, taxYear: declaration.taxYear, versionNumber: declaration.versionNumber },
      }, session);
    });
    return res.status(200).json({ success: true, message: "Tax declaration draft cancelled" });
  } catch (error) {
    next(error);
  }
}

export async function resolveEmployeeStatutoryForPayroll(
  company: mongoose.Types.ObjectId,
  employees: mongoose.Types.ObjectId[],
  asOfDate: string,
  session?: mongoose.ClientSession
) {
  const asOf = parseDate(asOfDate, "Payroll snapshot date");
  const taxYear = taxYearForDate(asOfDate);
  const assignmentQuery = EmployeeStatutoryAssignment.find({
    company,
    employee: { $in: employees },
    status: "assigned",
    effectiveFrom: { $lte: new Date(asOf.getTime() + 86_399_999) },
  }).sort({ employee: 1, effectiveFrom: -1, createdAt: -1 }).lean();
  const declarationQuery = EmployeeTaxDeclaration.find({
    company,
    employee: { $in: employees },
    taxYear,
    status: "verified",
  }).sort({ employee: 1, versionNumber: -1 }).lean();
  if (session) {
    assignmentQuery.session(session);
    declarationQuery.session(session);
  }
  const [assignments, declarations] = await Promise.all([assignmentQuery, declarationQuery]);
  const assignmentByEmployee = new Map<string, any>();
  for (const assignment of assignments) {
    const key = idString(assignment.employee);
    if (!assignmentByEmployee.has(key)) assignmentByEmployee.set(key, assignment);
  }
  const declarationByEmployee = new Map<string, any>();
  for (const declaration of declarations) {
    const key = idString(declaration.employee);
    if (!declarationByEmployee.has(key)) declarationByEmployee.set(key, declaration);
  }
  return { taxYear, assignments, declarations, assignmentByEmployee, declarationByEmployee };
}
