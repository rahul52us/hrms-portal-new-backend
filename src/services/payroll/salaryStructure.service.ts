import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import Company from "../../schemas/company/Company";
import SalaryComponent from "../../schemas/Payroll/SalaryComponent.schema";
import SalaryStructure from "../../schemas/Payroll/SalaryStructure.schema";
import SalaryStructureVersion, {
  SALARY_RULE_TYPES,
  SalaryStructureRuleI,
} from "../../schemas/Payroll/SalaryStructureVersion.schema";
import {
  ensurePayrollConfigurationManager,
  ensurePayrollViewer,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";
import {
  calculateSalaryStructurePreview,
  PayrollRoundingMode,
} from "./salaryStructureCalculator";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type PayrollSettings = {
  currency: string;
  currencyMinorUnits: number;
  payFrequency: "monthly";
  payDay: number;
  roundingMode: PayrollRoundingMode;
  employeeCompensationVisibility: "hidden" | "current" | "history";
};

export function settingsFromCompany(company: any): PayrollSettings {
  return {
    currency: String(company?.payrollSettings?.currency || "INR").toUpperCase(),
    currencyMinorUnits: Number(company?.payrollSettings?.currencyMinorUnits ?? 2),
    payFrequency: "monthly",
    payDay: Number(company?.payrollSettings?.payDay || 31),
    roundingMode: (company?.payrollSettings?.roundingMode || "nearest") as PayrollRoundingMode,
    employeeCompensationVisibility: (["current", "history"].includes(company?.payrollSettings?.employeeCompensationVisibility)
      ? company.payrollSettings.employeeCompensationVisibility
      : "hidden") as PayrollSettings["employeeCompensationVisibility"],
  };
}

export function normalizeSettings(body: any, defaults?: PayrollSettings): PayrollSettings {
  const settings: PayrollSettings = {
    currency: String(body?.currency || "").trim().toUpperCase(),
    currencyMinorUnits: Number(body?.currencyMinorUnits),
    payFrequency: "monthly",
    payDay: Number(body?.payDay),
    roundingMode: String(body?.roundingMode || "").trim().toLowerCase() as PayrollRoundingMode,
    employeeCompensationVisibility: String(
      body?.employeeCompensationVisibility ?? defaults?.employeeCompensationVisibility ?? "hidden"
    ).trim().toLowerCase() as PayrollSettings["employeeCompensationVisibility"],
  };
  if (!/^[A-Z]{3}$/.test(settings.currency)) throw generateError("Currency must be a three-letter ISO-style code", 422);
  if (!Number.isInteger(settings.currencyMinorUnits) || settings.currencyMinorUnits < 0 || settings.currencyMinorUnits > 3) {
    throw generateError("Currency minor units must be between 0 and 3", 422);
  }
  if (!Number.isInteger(settings.payDay) || settings.payDay < 1 || settings.payDay > 31) {
    throw generateError("Pay day must be between 1 and 31", 422);
  }
  if (!["nearest", "floor", "ceil"].includes(settings.roundingMode)) {
    throw generateError("Invalid payroll rounding mode", 422);
  }
  if (!["hidden", "current", "history"].includes(settings.employeeCompensationVisibility)) {
    throw generateError("Invalid employee compensation visibility", 422);
  }
  return settings;
}

function parseEffectiveDate(value: unknown) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw generateError("Effective-from date must use YYYY-MM-DD", 422);
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw generateError("Invalid effective-from date", 422);
  }
  return date;
}

function priorDay(date: Date) {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() - 1);
  return value;
}

function validateIdentity(body: any) {
  const name = String(body?.name || "").trim();
  const code = String(body?.code || "").trim().toUpperCase();
  const description = String(body?.description || "").trim();
  if (name.length < 2 || name.length > 100) throw generateError("Structure name must be between 2 and 100 characters", 422);
  if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) {
    throw generateError("Structure code must be 2-30 characters and use uppercase letters, numbers, or underscores", 422);
  }
  if (description.length > 500) throw generateError("Description cannot exceed 500 characters", 422);
  return { name, code, description };
}

function validateReason(value: unknown, label: string) {
  const reason = String(value || "").trim();
  if (reason.length < 3 || reason.length > 500) throw generateError(`${label} must be between 3 and 500 characters`, 422);
  return reason;
}

async function companySettings(companyId: mongoose.Types.ObjectId) {
  const company = await Company.findById(companyId).select("payrollSettings").lean();
  if (!company) throw generateError("Company not found", 404);
  return settingsFromCompany(company);
}

async function normalizeRules(options: {
  company: mongoose.Types.ObjectId;
  input: any;
  requireActive?: boolean;
  roundingMode?: PayrollRoundingMode;
}) {
  if (!Array.isArray(options.input) || options.input.length < 1 || options.input.length > 100) {
    throw generateError("A salary structure needs between 1 and 100 component rules", 422);
  }

  const componentIds = options.input.map((item: any) => String(item?.salaryComponent || item?.salaryComponentId || "").trim());
  if (componentIds.some((value: string) => !mongoose.Types.ObjectId.isValid(value))) {
    throw generateError("Every salary rule needs a valid salary component", 422);
  }
  if (new Set(componentIds).size !== componentIds.length) {
    throw generateError("A salary component can appear only once", 422);
  }

  const components = await SalaryComponent.find({
    company: options.company,
    _id: { $in: componentIds.map((value: string) => new mongoose.Types.ObjectId(value)) },
  }).lean();
  const byId = new Map(components.map((component) => [String(component._id), component]));
  if (byId.size !== componentIds.length) throw generateError("One or more salary components do not belong to this company", 422);

  const inactive = components.filter((component) => component.status !== "active");
  if (options.requireActive && inactive.length) {
    throw generateError(`Archived components cannot be published: ${inactive.map((item) => item.code).join(", ")}`, 409);
  }

  const rules = options.input.map((item: any, index: number) => {
    const componentId = String(item?.salaryComponent || item?.salaryComponentId || "").trim();
    const component: any = byId.get(componentId);
    const calculationType = String(item?.calculationType || "").trim().toLowerCase();
    if (!SALARY_RULE_TYPES.includes(calculationType as any)) {
      throw generateError(`Invalid calculation type for ${component.name}`, 422);
    }

    const monthlyAmountMinor = item?.monthlyAmountMinor === null || item?.monthlyAmountMinor === undefined
      ? null
      : Number(item.monthlyAmountMinor);
    const percentageBps = item?.percentageBps === null || item?.percentageBps === undefined
      ? null
      : Number(item.percentageBps);
    const percentageOfComponent = String(item?.percentageOfComponent || item?.percentageOfComponentId || "").trim();

    if (["fixed", "variable"].includes(calculationType) && (!Number.isSafeInteger(monthlyAmountMinor) || Number(monthlyAmountMinor) < 0)) {
      throw generateError(`${component.name} needs a non-negative monthly amount in minor currency units`, 422);
    }
    if (calculationType === "percentage") {
      if (!Number.isInteger(percentageBps) || Number(percentageBps) < 1 || Number(percentageBps) > 10000) {
        throw generateError(`${component.name} percentage must be between 0.01 and 100`, 422);
      }
      if (!mongoose.Types.ObjectId.isValid(percentageOfComponent)) {
        throw generateError(`${component.name} needs a valid percentage basis component`, 422);
      }
    }

    return {
      salaryComponent: new mongoose.Types.ObjectId(componentId),
      componentCodeSnapshot: component.code,
      componentNameSnapshot: component.name,
      categorySnapshot: component.category,
      taxableSnapshot: Boolean(component.taxable),
      prorateOnUnpaidDaysSnapshot: Boolean(component.prorateOnUnpaidDays),
      statutoryWageBasesSnapshot: component.statutoryWageBases || [],
      calculationType,
      monthlyAmountMinor: calculationType === "percentage" ? null : monthlyAmountMinor,
      percentageBps: calculationType === "percentage" ? percentageBps : null,
      percentageOfComponent: calculationType === "percentage" ? new mongoose.Types.ObjectId(percentageOfComponent) : null,
      allowEmployeeOverride: item?.allowEmployeeOverride === true,
      displayOrder: Number.isInteger(Number(item?.displayOrder)) && Number(item.displayOrder) >= 0
        ? Number(item.displayOrder)
        : index,
    } as SalaryStructureRuleI;
  });

  try {
    const preview = calculateSalaryStructurePreview(rules as any, options.roundingMode || "nearest");
    return { rules, preview };
  } catch (error: any) {
    throw generateError(error?.message || "Invalid salary structure calculation", 422);
  }
}

function versionConfig(body: any, defaults: PayrollSettings) {
  const currency = String(body?.currency || defaults.currency).trim().toUpperCase();
  const currencyMinorUnits = body?.currencyMinorUnits === undefined
    ? defaults.currencyMinorUnits
    : Number(body.currencyMinorUnits);
  const payFrequency = "monthly" as const;
  const roundingMode = String(body?.roundingMode || defaults.roundingMode).trim().toLowerCase() as PayrollRoundingMode;
  if (!/^[A-Z]{3}$/.test(currency)) throw generateError("Currency must be a three-letter ISO-style code", 422);
  if (!Number.isInteger(currencyMinorUnits) || currencyMinorUnits < 0 || currencyMinorUnits > 3) {
    throw generateError("Currency minor units must be between 0 and 3", 422);
  }
  if (!["nearest", "floor", "ceil"].includes(roundingMode)) throw generateError("Invalid salary rounding mode", 422);
  return { currency, currencyMinorUnits, payFrequency, roundingMode };
}

function validateId(value: unknown, label: string) {
  const normalized = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return normalized;
}

async function getStructure(company: mongoose.Types.ObjectId, structureIdInput: unknown) {
  const structureId = String(structureIdInput || "").trim();
  if (!mongoose.Types.ObjectId.isValid(structureId)) throw generateError("Invalid salary structure id", 400);
  const structure = await SalaryStructure.findOne({ _id: structureId, company });
  if (!structure) throw generateError("Salary structure not found", 404);
  return structure;
}

export async function getPayrollSettingsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollViewer(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query.companyId);
    return res.status(200).json({ success: true, data: await companySettings(companyObjectId) });
  } catch (error) {
    next(error);
  }
}

export async function updatePayrollSettingsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const beforeCompany = await Company.findById(companyObjectId).select("payrollSettings").lean();
    if (!beforeCompany) throw generateError("Company not found", 404);
    const before = settingsFromCompany(beforeCompany);
    const settings = normalizeSettings(req.body, before);

    await mongoose.connection.transaction(async (session) => {
      await Company.updateOne(
        { _id: companyObjectId },
        {
          $set: {
            "payrollSettings.currency": settings.currency,
            "payrollSettings.currencyMinorUnits": settings.currencyMinorUnits,
            "payrollSettings.payFrequency": settings.payFrequency,
            "payrollSettings.payDay": settings.payDay,
            "payrollSettings.roundingMode": settings.roundingMode,
            "payrollSettings.employeeCompensationVisibility": settings.employeeCompensationVisibility,
            updatedAt: new Date(),
          },
        },
        { session, runValidators: true }
      );
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "payroll_settings",
        entityId: companyObjectId,
        action: "updated",
        actor: actorId,
        details: { before, after: settings },
      }, session);
    });

    return res.status(200).json({ success: true, data: settings, message: "Payroll settings updated" });
  } catch (error) {
    next(error);
  }
}

export async function listSalaryStructuresService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollViewer(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query.companyId);
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "20"), 10) || 20));
    const status = String(req.query.status || "active").trim().toLowerCase();
    const search = String(req.query.search || "").trim();
    if (!["active", "archived", "all"].includes(status)) throw generateError("Invalid salary structure status", 422);

    const query: any = { company: companyObjectId };
    if (status !== "all") query.status = status;
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [{ name: regex }, { code: regex }, { description: regex }];
    }

    const [structures, total] = await Promise.all([
      SalaryStructure.find(query).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      SalaryStructure.countDocuments(query),
    ]);
    const structureIds = structures.map((item) => item._id);
    const versions = structureIds.length
      ? await SalaryStructureVersion.find({ company: companyObjectId, salaryStructure: { $in: structureIds }, status: { $in: ["draft", "published"] } })
          .sort({ versionNumber: -1 })
          .lean()
      : [];
    const data = structures.map((structure) => ({
      ...structure,
      draftVersion: versions.find((version) => String(version.salaryStructure) === String(structure._id) && version.status === "draft") || null,
      latestPublishedVersion: versions.find((version) => String(version.salaryStructure) === String(structure._id) && version.status === "published") || null,
    }));

    return res.status(200).json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
}

export async function getSalaryStructureService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollViewer(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query.companyId);
    const structure = await getStructure(companyObjectId, req.params.structureId);
    const versions = await SalaryStructureVersion.find({ company: companyObjectId, salaryStructure: structure._id })
      .sort({ versionNumber: -1 })
      .lean();
    return res.status(200).json({ success: true, data: { structure, versions } });
  } catch (error) {
    next(error);
  }
}

export async function previewSalaryStructureService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId);
    const defaults = await companySettings(companyObjectId);
    const config = versionConfig(req.body, defaults);
    const { rules, preview } = await normalizeRules({
      company: companyObjectId,
      input: req.body?.rules,
      roundingMode: config.roundingMode,
    });
    return res.status(200).json({ success: true, data: { ...config, rules, preview } });
  } catch (error) {
    next(error);
  }
}

export async function createSalaryStructureService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const identity = validateIdentity(req.body);
    const defaults = await companySettings(companyObjectId);
    const config = versionConfig(req.body, defaults);
    const { rules, preview } = await normalizeRules({ company: companyObjectId, input: req.body?.rules, roundingMode: config.roundingMode });
    let structure: any;
    let version: any;

    await mongoose.connection.transaction(async (session) => {
      [structure] = await SalaryStructure.create([{
        company: companyObjectId,
        ...identity,
        latestVersionNumber: 1,
        createdBy: actorId,
        updatedBy: actorId,
      }], { session });
      [version] = await SalaryStructureVersion.create([{
        company: companyObjectId,
        salaryStructure: structure._id,
        versionNumber: 1,
        status: "draft",
        ...config,
        rules,
        preview,
        changeReason: String(req.body?.changeReason || "Initial salary structure").trim(),
        createdBy: actorId,
      }], { session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "salary_structure",
        entityId: structure._id,
        action: "created",
        actor: actorId,
        details: { code: structure.code, draftVersion: 1 },
      }, session);
    });

    return res.status(201).json({ success: true, data: { structure, version }, message: "Salary structure draft created" });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("Salary structure code already exists or a draft already exists", 409));
    next(error);
  }
}

export async function updateSalaryStructureDraftService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const structure = await getStructure(companyObjectId, req.params.structureId);
    if (structure.status !== "active") throw generateError("Archived salary structures cannot be edited", 409);
    const versionId = validateId(req.params.versionId, "salary structure version id");
    const version = await SalaryStructureVersion.findOne({
      _id: versionId,
      company: companyObjectId,
      salaryStructure: structure._id,
      status: "draft",
    });
    if (!version) throw generateError("Salary structure draft not found", 404);

    const defaults = await companySettings(companyObjectId);
    const config = versionConfig({
      currency: req.body?.currency ?? version.currency,
      currencyMinorUnits: req.body?.currencyMinorUnits ?? version.currencyMinorUnits,
      roundingMode: req.body?.roundingMode ?? version.roundingMode,
    }, defaults);
    const { rules, preview } = await normalizeRules({ company: companyObjectId, input: req.body?.rules, roundingMode: config.roundingMode });
    const nextName = req.body?.name === undefined ? structure.name : String(req.body.name).trim();
    const nextDescription = req.body?.description === undefined ? structure.description || "" : String(req.body.description).trim();
    if (nextName.length < 2 || nextName.length > 100) throw generateError("Structure name must be between 2 and 100 characters", 422);
    if (nextDescription.length > 500) throw generateError("Description cannot exceed 500 characters", 422);

    version.currency = config.currency;
    version.currencyMinorUnits = config.currencyMinorUnits;
    version.payFrequency = config.payFrequency;
    version.roundingMode = config.roundingMode;
    version.rules = rules as any;
    version.preview = preview as any;
    if (req.body?.changeReason !== undefined) version.changeReason = String(req.body.changeReason || "").trim();
    structure.name = nextName;
    structure.description = nextDescription;
    structure.updatedBy = actorId;

    await mongoose.connection.transaction(async (session) => {
      await structure.save({ session });
      await version.save({ session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "salary_structure",
        entityId: structure._id as mongoose.Types.ObjectId,
        action: "draft_updated",
        actor: actorId,
        details: { versionNumber: version.versionNumber, preview },
      }, session);
    });

    return res.status(200).json({ success: true, data: { structure, version }, message: "Salary structure draft updated" });
  } catch (error) {
    next(error);
  }
}

export async function createSalaryStructureVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const structure = await getStructure(companyObjectId, req.params.structureId);
    if (structure.status !== "active") throw generateError("Archived salary structures cannot be versioned", 409);
    const existingDraft = await SalaryStructureVersion.exists({ company: companyObjectId, salaryStructure: structure._id, status: "draft" });
    if (existingDraft) throw generateError("Finish or cancel the existing salary structure draft before creating another version", 409);
    const latestPublished = await SalaryStructureVersion.findOne({ company: companyObjectId, salaryStructure: structure._id, status: "published" })
      .sort({ versionNumber: -1 })
      .lean();
    const latest = latestPublished || await SalaryStructureVersion.findOne({
      company: companyObjectId,
      salaryStructure: structure._id,
      status: "cancelled",
    }).sort({ versionNumber: -1 }).lean();
    if (!latest) throw generateError("No salary structure version is available to copy", 409);
    const defaults = await companySettings(companyObjectId);
    const config = versionConfig(latest, defaults);
    const { rules, preview } = await normalizeRules({ company: companyObjectId, input: latest.rules, roundingMode: config.roundingMode });
    const reason = validateReason(req.body?.changeReason, "Change reason");
    const versionNumber = Number(structure.latestVersionNumber || 0) + 1;
    let version: any;

    await mongoose.connection.transaction(async (session) => {
      [version] = await SalaryStructureVersion.create([{
        company: companyObjectId,
        salaryStructure: structure._id,
        versionNumber,
        status: "draft",
        ...config,
        rules,
        preview,
        changeReason: reason,
        createdBy: actorId,
      }], { session });
      structure.latestVersionNumber = versionNumber;
      structure.updatedBy = actorId;
      await structure.save({ session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "salary_structure",
        entityId: structure._id as mongoose.Types.ObjectId,
        action: "version_created",
        actor: actorId,
        reason,
        details: { versionNumber, basedOnVersion: latest.versionNumber },
      }, session);
    });

    return res.status(201).json({ success: true, data: version, message: "Salary structure version draft created" });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("This salary structure already has a draft version", 409));
    next(error);
  }
}

export async function publishSalaryStructureVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const structure = await getStructure(companyObjectId, req.params.structureId);
    if (structure.status !== "active") throw generateError("Archived salary structures cannot be published", 409);
    const versionId = validateId(req.params.versionId, "salary structure version id");
    const version = await SalaryStructureVersion.findOne({
      _id: versionId,
      company: companyObjectId,
      salaryStructure: structure._id,
      status: "draft",
    });
    if (!version) throw generateError("Salary structure draft not found", 404);
    const effectiveFrom = parseEffectiveDate(req.body?.effectiveFrom);
    const reason = validateReason(req.body?.changeReason || version.changeReason, "Change reason");
    const latestPublished = await SalaryStructureVersion.findOne({
      company: companyObjectId,
      salaryStructure: structure._id,
      status: "published",
    }).sort({ effectiveFrom: -1 });
    if (latestPublished?.effectiveFrom && effectiveFrom.getTime() <= latestPublished.effectiveFrom.getTime()) {
      throw generateError(`Effective-from date must be after version ${latestPublished.versionNumber}`, 409);
    }

    const { rules, preview } = await normalizeRules({
      company: companyObjectId,
      input: version.rules,
      requireActive: true,
      roundingMode: version.roundingMode,
    });
    version.rules = rules as any;
    version.preview = calculateSalaryStructurePreview(rules as any, version.roundingMode) as any;
    version.status = "published";
    version.effectiveFrom = effectiveFrom;
    version.effectiveTo = null;
    version.changeReason = reason;
    version.publishedAt = new Date();
    version.publishedBy = actorId;

    await mongoose.connection.transaction(async (session) => {
      if (latestPublished) {
        latestPublished.effectiveTo = priorDay(effectiveFrom);
        await latestPublished.save({ session });
      }
      await version.save({ session });
      structure.latestPublishedVersion = version._id as mongoose.Types.ObjectId;
      structure.updatedBy = actorId;
      await structure.save({ session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "salary_structure",
        entityId: structure._id as mongoose.Types.ObjectId,
        action: "published",
        actor: actorId,
        reason,
        details: { versionNumber: version.versionNumber, effectiveFrom, preview },
      }, session);
    });

    return res.status(200).json({ success: true, data: version, message: "Salary structure version published" });
  } catch (error) {
    next(error);
  }
}

export async function cancelSalaryStructureDraftService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const structure = await getStructure(companyObjectId, req.params.structureId);
    const versionId = validateId(req.params.versionId, "salary structure version id");
    const version = await SalaryStructureVersion.findOne({
      _id: versionId,
      company: companyObjectId,
      salaryStructure: structure._id,
      status: "draft",
    });
    if (!version) throw generateError("Salary structure draft not found", 404);
    const reason = validateReason(req.body?.reason, "Cancellation reason");
    version.status = "cancelled";
    version.cancelledAt = new Date();
    version.cancelledBy = actorId;
    version.cancelReason = reason;

    await mongoose.connection.transaction(async (session) => {
      await version.save({ session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "salary_structure",
        entityId: structure._id as mongoose.Types.ObjectId,
        action: "draft_cancelled",
        actor: actorId,
        reason,
        details: { versionNumber: version.versionNumber },
      }, session);
    });
    return res.status(200).json({ success: true, data: version, message: "Salary structure draft cancelled" });
  } catch (error) {
    next(error);
  }
}

export async function archiveSalaryStructureService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const structure = await getStructure(companyObjectId, req.params.structureId);
    if (structure.status === "archived") return res.status(200).json({ success: true, data: structure, message: "Salary structure is already archived" });
    if (await SalaryStructureVersion.exists({ company: companyObjectId, salaryStructure: structure._id, status: "draft" })) {
      throw generateError("Cancel the salary structure draft before archiving", 409);
    }
    const reason = validateReason(req.body?.reason, "Archive reason");
    structure.status = "archived";
    structure.archivedAt = new Date();
    structure.archivedBy = actorId;
    structure.archiveReason = reason;
    structure.updatedBy = actorId;
    await mongoose.connection.transaction(async (session) => {
      await structure.save({ session });
      await writePayrollAudit({ company: companyObjectId, entityType: "salary_structure", entityId: structure._id as mongoose.Types.ObjectId, action: "archived", actor: actorId, reason }, session);
    });
    return res.status(200).json({ success: true, data: structure, message: "Salary structure archived" });
  } catch (error) {
    next(error);
  }
}

export async function restoreSalaryStructureService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const structure = await getStructure(companyObjectId, req.params.structureId);
    if (structure.status === "active") return res.status(200).json({ success: true, data: structure, message: "Salary structure is already active" });
    structure.status = "active";
    structure.archivedAt = null;
    structure.archivedBy = null;
    structure.archiveReason = undefined;
    structure.updatedBy = actorId;
    await mongoose.connection.transaction(async (session) => {
      await structure.save({ session });
      await writePayrollAudit({ company: companyObjectId, entityType: "salary_structure", entityId: structure._id as mongoose.Types.ObjectId, action: "restored", actor: actorId }, session);
    });
    return res.status(200).json({ success: true, data: structure, message: "Salary structure restored" });
  } catch (error) {
    next(error);
  }
}
