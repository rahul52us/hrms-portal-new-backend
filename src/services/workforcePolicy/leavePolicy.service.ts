import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import LeavePolicy from "../../schemas/WorkforcePolicy/LeavePolicy.schema";
import LeavePolicyVersion, {
  LEAVE_ACCRUAL_FREQUENCIES,
  LEAVE_CREDIT_COMPONENT_FREQUENCIES,
  LEAVE_DOCUMENT_SUBMISSION_MODES,
  LEAVE_ENTITLEMENT_MODES,
  LEAVE_PROBATION_RULES,
  LEAVE_UPFRONT_CREDIT_TIMINGS,
  LeaveCreditComponent,
  LeavePolicyRule,
} from "../../schemas/WorkforcePolicy/LeavePolicyVersion.schema";
import LeaveType from "../../schemas/WorkforcePolicy/LeaveType.schema";
import WorkforcePolicyAssignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import { resolveEffectiveApprovalWorkflowReference } from "../approval/approvalWorkflow.service";
import {
  ensurePolicyManager,
  ensurePolicyViewer,
  escapeRegex,
  getPolicyActorId,
  getVersionEffectiveTo,
  normalizeText,
  parseEffectiveDate,
  resolvePolicyCompany,
  validateObjectId,
  writePolicyAudit,
} from "./workforcePolicy.utils";

function normalizeNumber(
  value: unknown,
  fallback: number,
  label: string,
  minimum = 0,
  maximum = Number.POSITIVE_INFINITY
) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw generateError(`${label} must be between ${minimum} and ${maximum}`, 400);
  }
  return Math.round(parsed * 100) / 100;
}

function normalizeOptionalNumber(
  value: unknown,
  fallback: number | null,
  label: string,
  minimum = 0.25
) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  return normalizeNumber(value, fallback || 0, label, minimum);
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function calculateAccrualAmount(
  annualEntitlement: number,
  frequency: LeavePolicyRule["accrualFrequency"]
) {
  const periods = frequency === "monthly" ? 12 : frequency === "quarterly" ? 4 : 1;
  if (frequency === "none" || annualEntitlement <= 0) return 0;
  return Math.round((annualEntitlement / periods) * 10000) / 10000;
}

function normalizeCreditAmount(
  value: unknown,
  fallback: number,
  label: string,
  minimum = 0
) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw generateError(`${label} must be at least ${minimum}`, 400);
  }
  return Math.round((parsed + Number.EPSILON) * 10000) / 10000;
}

function scheduledAnnualCredit(components: LeaveCreditComponent[]) {
  return Math.round(
    (components.reduce((total, component) => {
      const periods = component.frequency === "monthly" ? 12 : component.frequency === "quarterly" ? 4 : 1;
      return total + component.amount * periods;
    }, 0) + Number.EPSILON) * 10000
  ) / 10000;
}

function normalizeCreditComponents(options: {
  value: unknown;
  leaveTypeCode: string;
  balanceTracked: boolean;
  prorateOnJoining: boolean;
  prorateOnExit: boolean;
}) {
  if (!options.balanceTracked) return [];
  if (options.value === undefined || options.value === null) return [];
  if (!Array.isArray(options.value)) {
    throw generateError(`${options.leaveTypeCode} credit components must be an array`, 400);
  }
  if (options.value.length > 20) {
    throw generateError(`${options.leaveTypeCode} cannot have more than 20 credit components`, 400);
  }

  const componentIds = new Set<string>();
  return options.value.map((input: any, index): LeaveCreditComponent => {
    const componentId = String(input?.componentId || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(componentId)) {
      throw generateError(
        `${options.leaveTypeCode} credit component ${index + 1} has an invalid component id`,
        400
      );
    }
    if (componentIds.has(componentId)) {
      throw generateError(`${options.leaveTypeCode} credit component ids must be unique`, 409);
    }
    componentIds.add(componentId);

    const frequency = normalizeText(input?.frequency || "monthly") as LeaveCreditComponent["frequency"];
    if (!LEAVE_CREDIT_COMPONENT_FREQUENCIES.includes(frequency as any)) {
      throw generateError(`${options.leaveTypeCode} credit component ${index + 1} has an invalid frequency`, 400);
    }
    const upfrontTiming = normalizeText(
      input?.upfrontTiming || "leave_year_start"
    ) as LeaveCreditComponent["upfrontTiming"];
    if (!LEAVE_UPFRONT_CREDIT_TIMINGS.includes(upfrontTiming as any)) {
      throw generateError(`${options.leaveTypeCode} credit component ${index + 1} has invalid upfront timing`, 400);
    }

    return {
      componentId,
      frequency,
      amount: normalizeCreditAmount(
        input?.amount,
        0,
        `${options.leaveTypeCode} credit component ${index + 1} amount`
      ),
      upfrontTiming: frequency === "upfront" ? upfrontTiming : "leave_year_start",
      prorateOnJoining: normalizeBoolean(input?.prorateOnJoining, options.prorateOnJoining),
      prorateOnExit: normalizeBoolean(input?.prorateOnExit, options.prorateOnExit),
    };
  });
}

function usesIncrement(value: number, increment: number) {
  const units = value / increment;
  return Math.abs(units - Math.round(units)) < 0.000001;
}

function normalizeColor(value: unknown, fallback = "#3182CE") {
  const color = normalizeText(value || fallback).toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) {
    throw generateError("Leave type color must be a six-digit hex color", 400);
  }
  return color;
}

function normalizeLeaveYear(input: any = {}, current?: any) {
  const startMonth = normalizeNumber(
    input.leaveYearStartMonth,
    Number(current?.leaveYearStartMonth || 1),
    "Leave year start month",
    1,
    12
  );
  const startDay = normalizeNumber(
    input.leaveYearStartDay,
    Number(current?.leaveYearStartDay || 1),
    "Leave year start day",
    1,
    31
  );
  const referenceDate = new Date(Date.UTC(2024, startMonth - 1, startDay));
  if (referenceDate.getUTCMonth() !== startMonth - 1 || referenceDate.getUTCDate() !== startDay) {
    throw generateError("Leave year start day is not valid for the selected month", 400);
  }
  return { leaveYearStartMonth: startMonth, leaveYearStartDay: startDay };
}

function currentRuleToObject(rule: any) {
  return rule?.toObject ? rule.toObject() : { ...(rule || {}) };
}

function normalizeOptionalReference(value: unknown, current: unknown, label: string) {
  const source = value === undefined ? current : value;
  const normalized = normalizeText((source as any)?._id || source);
  if (!normalized) return null;
  return new mongoose.Types.ObjectId(validateObjectId(normalized, label));
}

async function normalizeLeaveRules(options: {
  company: mongoose.Types.ObjectId;
  input: unknown;
  current?: any[];
}) {
  const source = Array.isArray(options.input)
    ? options.input
    : Array.isArray(options.current)
      ? options.current.map(currentRuleToObject)
      : [];
  const ids = source.map((rule: any) =>
    validateObjectId(rule?.leaveType || rule?.leaveTypeId, "leave type id")
  );
  if (ids.length !== new Set(ids).size) {
    throw generateError("A leave type can appear only once in a policy", 409);
  }
  if (!ids.length) return [];

  const leaveTypes = await LeaveType.find({
    _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
    company: options.company,
  }).lean();
  const leaveTypeById = new Map(leaveTypes.map((item) => [String(item._id), item]));
  if (leaveTypes.length !== ids.length) {
    throw generateError("One or more leave types do not belong to this company", 400);
  }

  const currentByLeaveType = new Map(
    (options.current || []).map((rule: any) => [String(rule.leaveType), currentRuleToObject(rule)])
  );
  return source.map((inputRule: any, index: number): LeavePolicyRule => {
    const leaveTypeId = ids[index];
    const leaveType = leaveTypeById.get(leaveTypeId)!;
    if (leaveType.status !== "active") {
      throw generateError(`${leaveType.name} is archived and cannot be used in a new policy version`, 409);
    }
    const current = currentByLeaveType.get(leaveTypeId) || {};
    const entitlementMode = normalizeText(
      inputRule.entitlementMode ||
        current.entitlementMode ||
        (leaveType.balanceTracked ? "fixed" : "untracked")
    ) as LeavePolicyRule["entitlementMode"];
    if (!LEAVE_ENTITLEMENT_MODES.includes(entitlementMode as any)) {
      throw generateError(`Invalid entitlement mode for ${leaveType.code}`, 400);
    }
    if (!leaveType.balanceTracked && entitlementMode !== "untracked") {
      throw generateError(`${leaveType.code} must track balances to use ${entitlementMode} entitlement`, 422);
    }
    if (entitlementMode === "earned" && leaveType.unit !== "days") {
      throw generateError(`${leaveType.code} earned comp-off entitlement must use days`, 422);
    }
    const manualAnnualEntitlement = leaveType.balanceTracked
      ? normalizeNumber(
          inputRule.annualEntitlement,
          Number(current.annualEntitlement || 0),
          `${leaveType.code} annual entitlement`
        )
      : 0;
    const requestedAccrualFrequency = normalizeText(
      inputRule.accrualFrequency || current.accrualFrequency || "upfront"
    );
    const legacyAccrualFrequency = (leaveType.balanceTracked
      ? requestedAccrualFrequency
      : "none") as LeavePolicyRule["accrualFrequency"];
    if (!LEAVE_ACCRUAL_FREQUENCIES.includes(legacyAccrualFrequency as any)) {
      throw generateError(`Invalid accrual frequency for ${leaveType.code}`, 400);
    }
    const prorateOnJoining = normalizeBoolean(
      inputRule.prorateOnJoining,
      current.prorateOnJoining ?? true
    );
    const prorateOnExit = normalizeBoolean(
      inputRule.prorateOnExit,
      current.prorateOnExit ?? true
    );
    const hasInputComponents = Object.prototype.hasOwnProperty.call(inputRule, "creditComponents");
    const creditComponents = entitlementMode === "fixed" ? normalizeCreditComponents({
      value: hasInputComponents ? inputRule.creditComponents : current.creditComponents,
      leaveTypeCode: leaveType.code,
      balanceTracked: leaveType.balanceTracked,
      prorateOnJoining,
      prorateOnExit,
    }) : [];
    const annualEntitlement = entitlementMode === "fixed"
      ? creditComponents.length
        ? scheduledAnnualCredit(creditComponents)
        : manualAnnualEntitlement
      : entitlementMode === "manual"
        ? manualAnnualEntitlement
        : 0;
    const accrualFrequency = entitlementMode !== "fixed"
      ? "none"
      : creditComponents.length === 1
      ? creditComponents[0].frequency
      : creditComponents.length > 1
        ? "none"
        : legacyAccrualFrequency;
    const accrualAmount = entitlementMode !== "fixed"
      ? 0
      : creditComponents.length === 1
      ? creditComponents[0].amount
      : creditComponents.length > 1
        ? 0
        : calculateAccrualAmount(annualEntitlement, accrualFrequency);
    const minimumRequestDays = normalizeNumber(
      inputRule.minimumRequestDays,
      Number(current.minimumRequestDays || 1),
      `${leaveType.code} minimum request`,
      0.25
    );
    const maximumRequestDays = normalizeOptionalNumber(
      inputRule.maximumRequestDays,
      current.maximumRequestDays ?? null,
      `${leaveType.code} maximum request`
    );
    if (maximumRequestDays !== null && maximumRequestDays < minimumRequestDays) {
      throw generateError(`${leaveType.code} maximum request must be at least the minimum request`, 400);
    }
    const carryForwardEnabled =
      entitlementMode === "fixed" && leaveType.balanceTracked &&
      normalizeBoolean(inputRule.carryForwardEnabled, Boolean(current.carryForwardEnabled));
    const encashmentEnabled =
      entitlementMode === "fixed" && leaveType.balanceTracked &&
      leaveType.paid &&
      normalizeBoolean(inputRule.encashmentEnabled, Boolean(current.encashmentEnabled));
    const negativeBalanceAllowed =
      entitlementMode === "fixed" && leaveType.balanceTracked &&
      normalizeBoolean(inputRule.negativeBalanceAllowed, Boolean(current.negativeBalanceAllowed));
    const probationEligibility = normalizeText(
      inputRule.probationEligibility || current.probationEligibility || "allowed"
    ) as LeavePolicyRule["probationEligibility"];
    if (!LEAVE_PROBATION_RULES.includes(probationEligibility as any)) {
      throw generateError(`Invalid probation rule for ${leaveType.code}`, 400);
    }
    const compOffValidityDays = entitlementMode === "earned"
      ? normalizeNumber(
          inputRule.compOffValidityDays,
          Number(current.compOffValidityDays || 90),
          `${leaveType.code} comp-off validity`,
          1,
          730
        )
      : 90;
    const compOffFullDayMinutes = entitlementMode === "earned"
      ? normalizeNumber(
          inputRule.compOffFullDayMinutes,
          Number(current.compOffFullDayMinutes || 480),
          `${leaveType.code} full-day earning threshold`,
          1,
          1440
        )
      : 480;
    const compOffHalfDayMinutes = entitlementMode === "earned"
      ? normalizeNumber(
          inputRule.compOffHalfDayMinutes,
          Number(current.compOffHalfDayMinutes || 240),
          `${leaveType.code} half-day earning threshold`,
          1,
          1440
        )
      : 240;
    if (compOffHalfDayMinutes > compOffFullDayMinutes) {
      throw generateError(
        `${leaveType.code} half-day earning threshold cannot exceed the full-day threshold`,
        422
      );
    }
    const hasDocumentThreshold = Object.prototype.hasOwnProperty.call(
      inputRule,
      "documentRequiredFromUnits"
    );
    const hasLegacyDocumentThreshold = Object.prototype.hasOwnProperty.call(
      inputRule,
      "documentRequiredAfterDays"
    );
    const documentRequiredFromUnits = normalizeOptionalNumber(
      hasDocumentThreshold
        ? inputRule.documentRequiredFromUnits
        : hasLegacyDocumentThreshold
          ? inputRule.documentRequiredAfterDays
          : undefined,
      current.documentRequiredFromUnits ?? current.documentRequiredAfterDays ?? null,
      `${leaveType.code} document threshold`
    );
    const documentSubmissionMode = normalizeText(
      inputRule.documentSubmissionMode || current.documentSubmissionMode || "allow_later"
    ) as LeavePolicyRule["documentSubmissionMode"];
    if (!LEAVE_DOCUMENT_SUBMISSION_MODES.includes(documentSubmissionMode as any)) {
      throw generateError(`Invalid document submission mode for ${leaveType.code}`, 400);
    }
    const documentDueDaysAfterLeaveEnd = normalizeNumber(
      inputRule.documentDueDaysAfterLeaveEnd,
      Number(current.documentDueDaysAfterLeaveEnd ?? 2),
      `${leaveType.code} document due period`,
      0,
      365
    );

    return {
      leaveType: new mongoose.Types.ObjectId(leaveTypeId),
      leaveTypeCodeSnapshot: leaveType.code,
      leaveTypeNameSnapshot: leaveType.name,
      paid: leaveType.paid,
      balanceTracked: leaveType.balanceTracked,
      entitlementMode,
      annualEntitlement,
      accrualFrequency,
      accrualAmount,
      creditComponents,
      prorateOnJoining,
      prorateOnExit,
      carryForwardEnabled,
      maxCarryForward: carryForwardEnabled
        ? normalizeNumber(inputRule.maxCarryForward, Number(current.maxCarryForward || 0), `${leaveType.code} carry-forward limit`)
        : 0,
      carryForwardExpiryMonths: carryForwardEnabled
        ? normalizeNumber(
            inputRule.carryForwardExpiryMonths,
            Number(current.carryForwardExpiryMonths || 0),
            `${leaveType.code} carry-forward expiry`,
            0,
            120
          )
        : 0,
      encashmentEnabled,
      maxEncashmentPerYear: encashmentEnabled
        ? normalizeNumber(
            inputRule.maxEncashmentPerYear,
            Number(current.maxEncashmentPerYear || 0),
            `${leaveType.code} encashment limit`
          )
        : 0,
      negativeBalanceAllowed,
      maxNegativeBalance: negativeBalanceAllowed
        ? normalizeNumber(
            inputRule.maxNegativeBalance,
            Number(current.maxNegativeBalance || 0),
            `${leaveType.code} negative balance limit`
          )
        : 0,
      allowHalfDay:
        leaveType.unit === "days" &&
        leaveType.allowHalfDay &&
        normalizeBoolean(inputRule.allowHalfDay, current.allowHalfDay ?? leaveType.allowHalfDay),
      minimumRequestDays,
      maximumRequestDays,
      minimumNoticeDays: normalizeNumber(
        inputRule.minimumNoticeDays,
        Number(current.minimumNoticeDays || 0),
        `${leaveType.code} notice days`
      ),
      documentRequiredFromUnits,
      documentSubmissionMode,
      documentDueDaysAfterLeaveEnd,
      documentRequiredAfterDays: null,
      probationEligibility,
      sandwichRuleEnabled: normalizeBoolean(
        inputRule.sandwichRuleEnabled,
        Boolean(current.sandwichRuleEnabled)
      ),
      compOffValidityDays,
      compOffFullDayMinutes,
      compOffHalfDayMinutes,
      requestApprovalWorkflow: normalizeOptionalReference(
        inputRule.requestApprovalWorkflow,
        current.requestApprovalWorkflow,
        `${leaveType.code} request approval workflow`
      ),
      requestApprovalWorkflowVersion: normalizeOptionalReference(
        inputRule.requestApprovalWorkflowVersion,
        current.requestApprovalWorkflowVersion,
        `${leaveType.code} request approval workflow version`
      ),
      requestApprovalWorkflowVersionNumber:
        Number(inputRule.requestApprovalWorkflowVersionNumber || current.requestApprovalWorkflowVersionNumber || 0) || null,
      compOffClaimApprovalWorkflow: entitlementMode === "earned"
        ? normalizeOptionalReference(
            inputRule.compOffClaimApprovalWorkflow,
            current.compOffClaimApprovalWorkflow,
            `${leaveType.code} comp-off claim approval workflow`
          )
        : null,
      compOffClaimApprovalWorkflowVersion: entitlementMode === "earned"
        ? normalizeOptionalReference(
            inputRule.compOffClaimApprovalWorkflowVersion,
            current.compOffClaimApprovalWorkflowVersion,
            `${leaveType.code} comp-off claim approval workflow version`
          )
        : null,
      compOffClaimApprovalWorkflowVersionNumber: entitlementMode === "earned"
        ? Number(inputRule.compOffClaimApprovalWorkflowVersionNumber || current.compOffClaimApprovalWorkflowVersionNumber || 0) || null
        : null,
    };
  });
}

function serializeVersions(versions: any[]) {
  const published = versions.filter((version) => version.status === "published");
  return versions.map((version) => ({
    ...version,
    effectiveTo: getVersionEffectiveTo(version, published),
  }));
}

async function findLeaveType(company: mongoose.Types.ObjectId, leaveTypeIdInput: unknown) {
  const leaveTypeId = validateObjectId(leaveTypeIdInput, "leave type id");
  const leaveType = await LeaveType.findOne({
    _id: new mongoose.Types.ObjectId(leaveTypeId),
    company,
  });
  if (!leaveType) throw generateError("Leave type not found", 404);
  return leaveType;
}

async function findLeavePolicy(company: mongoose.Types.ObjectId, policyIdInput: unknown) {
  const policyId = validateObjectId(policyIdInput, "leave policy id");
  const policy = await LeavePolicy.findOne({
    _id: new mongoose.Types.ObjectId(policyId),
    company,
  });
  if (!policy) throw generateError("Leave policy not found", 404);
  return policy;
}

export async function listLeaveTypesService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyId, companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const status = normalizeText(req.query.status);
    const search = normalizeText(req.query.search);
    const match: any = { company: companyObjectId };
    if (["active", "archived"].includes(status)) match.status = status;
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$or = [{ name: regex }, { code: regex }, { description: regex }];
    }
    const [data, total] = await Promise.all([
      LeaveType.find(match)
        .sort({ status: 1, displayOrder: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      LeaveType.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      companyId,
    });
  } catch (error) {
    next(error);
  }
}

export async function createLeaveTypeService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.body.company,
      true
    );
    const name = normalizeText(req.body.name);
    const code = normalizeText(req.body.code).toUpperCase();
    if (!name || !code) throw generateError("Leave type name and code are required", 422);
    const actorId = getPolicyActorId(req);
    const leaveType = await LeaveType.create({
      company: companyObjectId,
      name,
      code,
      description: normalizeText(req.body.description),
      paid: normalizeBoolean(req.body.paid, true),
      balanceTracked: normalizeBoolean(req.body.balanceTracked, true),
      unit: ["days", "hours"].includes(normalizeText(req.body.unit))
        ? normalizeText(req.body.unit)
        : "days",
      allowHalfDay: normalizeBoolean(req.body.allowHalfDay, true),
      color: normalizeColor(req.body.color),
      displayOrder: normalizeNumber(req.body.displayOrder, 0, "Display order"),
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_type",
      entityId: leaveType._id as mongoose.Types.ObjectId,
      action: "created",
      actor: actorId,
      details: { code, paid: leaveType.paid, balanceTracked: leaveType.balanceTracked },
    });
    return res.status(201).json({ success: true, message: "Leave type created", data: leaveType });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("A leave type with this code already exists", 409));
    }
    next(error);
  }
}

export async function updateLeaveTypeService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const leaveType = await findLeaveType(companyObjectId, req.params.leaveTypeId);
    if (leaveType.status === "archived") throw generateError("Archived leave types cannot be edited", 409);
    const actorId = getPolicyActorId(req);
    if (req.body.code !== undefined) {
      const code = normalizeText(req.body.code).toUpperCase();
      if (!code) throw generateError("Leave type code is required", 422);
      if (code !== leaveType.code) {
        const used = await LeavePolicyVersion.exists({ company: companyObjectId, "rules.leaveType": leaveType._id });
        if (used) throw generateError("Leave type code cannot change after it is used in a policy version", 409);
      }
      leaveType.code = code;
    }
    if (req.body.name !== undefined) {
      const name = normalizeText(req.body.name);
      if (!name) throw generateError("Leave type name is required", 422);
      leaveType.name = name;
    }
    if (req.body.description !== undefined) leaveType.description = normalizeText(req.body.description);
    if (req.body.paid !== undefined) leaveType.paid = normalizeBoolean(req.body.paid, leaveType.paid);
    if (req.body.balanceTracked !== undefined) {
      leaveType.balanceTracked = normalizeBoolean(req.body.balanceTracked, leaveType.balanceTracked);
    }
    if (req.body.unit !== undefined) {
      const unit = normalizeText(req.body.unit);
      if (!["days", "hours"].includes(unit)) throw generateError("Invalid leave unit", 400);
      leaveType.unit = unit as "days" | "hours";
    }
    if (req.body.allowHalfDay !== undefined) {
      leaveType.allowHalfDay = normalizeBoolean(req.body.allowHalfDay, leaveType.allowHalfDay);
    }
    if (req.body.color !== undefined) leaveType.color = normalizeColor(req.body.color, leaveType.color);
    if (req.body.displayOrder !== undefined) {
      leaveType.displayOrder = normalizeNumber(req.body.displayOrder, leaveType.displayOrder, "Display order");
    }
    await leaveType.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_type",
      entityId: leaveType._id as mongoose.Types.ObjectId,
      action: "updated",
      actor: actorId,
      details: { code: leaveType.code, name: leaveType.name },
    });
    return res.status(200).json({ success: true, message: "Leave type updated", data: leaveType });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("A leave type with this code already exists", 409));
    }
    next(error);
  }
}

export async function archiveLeaveTypeService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const leaveType = await findLeaveType(companyObjectId, req.params.leaveTypeId);
    if (leaveType.status === "archived") {
      return res.status(200).json({ success: true, message: "Leave type is already archived", data: leaveType });
    }
    const reason = normalizeText(req.body.reason || req.body.archiveReason);
    if (reason.length < 3) throw generateError("Archive reason must be at least 3 characters", 422);
    const actorId = getPolicyActorId(req);
    leaveType.status = "archived";
    leaveType.archivedAt = new Date();
    leaveType.archivedBy = actorId;
    leaveType.archiveReason = reason;
    await leaveType.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_type",
      entityId: leaveType._id as mongoose.Types.ObjectId,
      action: "archived",
      actor: actorId,
      details: { reason },
    });
    return res.status(200).json({ success: true, message: "Leave type archived", data: leaveType });
  } catch (error) {
    next(error);
  }
}

export async function listLeavePoliciesService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyId, companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const status = normalizeText(req.query.status);
    const search = normalizeText(req.query.search);
    const match: any = { company: companyObjectId };
    if (["active", "archived"].includes(status)) match.status = status;
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$or = [{ name: regex }, { code: regex }, { description: regex }];
    }
    const [policies, total] = await Promise.all([
      LeavePolicy.find(match)
        .sort({ status: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      LeavePolicy.countDocuments(match),
    ]);
    const policyIds = policies.map((policy) => policy._id);
    const [versions, assignments] = policyIds.length
      ? await Promise.all([
          LeavePolicyVersion.find({ company: companyObjectId, policy: { $in: policyIds } })
            .sort({ versionNumber: -1 })
            .lean(),
          WorkforcePolicyAssignment.aggregate([
            {
              $match: {
                company: companyObjectId,
                resourceType: "leave_policy",
                resource: { $in: policyIds },
                $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
              },
            },
            { $group: { _id: "$resource", count: { $sum: 1 } } },
          ]),
        ])
      : [[], []];
    const versionsByPolicy = (versions as any[]).reduce<Map<string, any[]>>((map, version) => {
      const key = String(version.policy);
      map.set(key, [...(map.get(key) || []), version]);
      return map;
    }, new Map());
    const assignmentCountByPolicy = new Map(
      (assignments as any[]).map((item: any) => [String(item._id), item.count])
    );
    const data = policies.map((policy: any) => {
      const policyVersions = versionsByPolicy.get(String(policy._id)) || [];
      return {
        ...policy,
        draftVersion: policyVersions.find((version) => version.status === "draft") || null,
        latestPublishedVersion:
          policyVersions
            .filter((version) => version.status === "published")
            .sort((left, right) => right.versionNumber - left.versionNumber)[0] || null,
        assignmentCount: assignmentCountByPolicy.get(String(policy._id)) || 0,
      };
    });
    return res.status(200).json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      companyId,
    });
  } catch (error) {
    next(error);
  }
}

export async function getLeavePolicyService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyViewer(req);
    const { companyObjectId } = await resolvePolicyCompany(req, req.query.companyId);
    const policy = await findLeavePolicy(companyObjectId, req.params.policyId);
    const versions = await LeavePolicyVersion.find({ company: companyObjectId, policy: policy._id })
      .sort({ versionNumber: -1 })
      .lean();
    return res.status(200).json({
      success: true,
      data: { policy: policy.toObject(), versions: serializeVersions(versions) },
    });
  } catch (error) {
    next(error);
  }
}

export async function createLeavePolicyService(req: any, res: Response, next: NextFunction) {
  let createdPolicyId: mongoose.Types.ObjectId | null = null;
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.body.company,
      true
    );
    const name = normalizeText(req.body.name);
    const code = normalizeText(req.body.code).toUpperCase();
    if (!name || !code) throw generateError("Leave policy name and code are required", 422);
    const actorId = getPolicyActorId(req);
    const leaveYear = normalizeLeaveYear(req.body);
    const rules = await normalizeLeaveRules({ company: companyObjectId, input: req.body.rules });
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    const policy = await LeavePolicy.create({
      company: companyObjectId,
      name,
      code,
      description: normalizeText(req.body.description),
      latestVersionNumber: 1,
      createdBy: actorId,
    });
    createdPolicyId = policy._id as mongoose.Types.ObjectId;
    const version = await LeavePolicyVersion.create({
      company: companyObjectId,
      policy: policy._id,
      versionNumber: 1,
      status: "draft",
      effectiveFrom,
      ...leaveYear,
      rules,
      changeReason: normalizeText(req.body.changeReason) || "Initial leave policy configuration",
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_policy",
      entityId: policy._id as mongoose.Types.ObjectId,
      action: "created",
      actor: actorId,
      details: { code, initialVersionId: version._id, effectiveFrom, ruleCount: rules.length },
    });
    return res.status(201).json({
      success: true,
      message: "Leave policy draft created",
      data: { policy, version },
    });
  } catch (error: any) {
    if (createdPolicyId) await LeavePolicy.deleteOne({ _id: createdPolicyId }).catch(() => undefined);
    if (error?.code === 11000) {
      return next(generateError("A leave policy with this code already exists", 409));
    }
    next(error);
  }
}

export async function updateLeavePolicyService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const policy = await findLeavePolicy(companyObjectId, req.params.policyId);
    if (policy.status === "archived") throw generateError("Archived leave policies cannot be edited", 409);
    const actorId = getPolicyActorId(req);
    if (req.body.name !== undefined) {
      const name = normalizeText(req.body.name);
      if (!name) throw generateError("Leave policy name is required", 422);
      policy.name = name;
    }
    if (req.body.code !== undefined) {
      const code = normalizeText(req.body.code).toUpperCase();
      if (!code) throw generateError("Leave policy code is required", 422);
      policy.code = code;
    }
    if (req.body.description !== undefined) policy.description = normalizeText(req.body.description);
    await policy.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_policy",
      entityId: policy._id as mongoose.Types.ObjectId,
      action: "metadata_updated",
      actor: actorId,
      details: { name: policy.name, code: policy.code },
    });
    return res.status(200).json({ success: true, message: "Leave policy updated", data: policy });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("A leave policy with this code already exists", 409));
    }
    next(error);
  }
}

export async function createLeavePolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const policy = await findLeavePolicy(companyObjectId, req.params.policyId);
    if (policy.status === "archived") {
      throw generateError("Archived leave policies cannot receive new versions", 409);
    }
    const existingDraft = await LeavePolicyVersion.findOne({
      company: companyObjectId,
      policy: policy._id,
      status: "draft",
    });
    if (existingDraft) {
      throw generateError("Finish or cancel the existing draft before creating another version", 409);
    }
    const sourceVersion = await LeavePolicyVersion.findOne({
      company: companyObjectId,
      policy: policy._id,
      status: "published",
    }).sort({ effectiveFrom: -1, versionNumber: -1 });
    const leaveYear = normalizeLeaveYear(req.body, sourceVersion);
    const rules = await normalizeLeaveRules({
      company: companyObjectId,
      input: req.body.rules,
      current: sourceVersion?.rules as any,
    });
    const effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    const actorId = getPolicyActorId(req);
    const updatedPolicy = await LeavePolicy.findOneAndUpdate(
      { _id: policy._id, company: companyObjectId, status: "active" },
      { $inc: { latestVersionNumber: 1 } },
      { new: true }
    );
    if (!updatedPolicy) throw generateError("Leave policy is no longer active", 409);
    const version = await LeavePolicyVersion.create({
      company: companyObjectId,
      policy: policy._id,
      versionNumber: updatedPolicy.latestVersionNumber,
      status: "draft",
      effectiveFrom,
      ...leaveYear,
      rules,
      changeReason: normalizeText(req.body.changeReason),
      createdBy: actorId,
    });
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "draft_created",
      actor: actorId,
      details: { policyId: policy._id, versionNumber: version.versionNumber, effectiveFrom },
    });
    return res.status(201).json({
      success: true,
      message: "Leave policy version draft created",
      data: version,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateLeavePolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const policy = await findLeavePolicy(companyObjectId, req.params.policyId);
    const versionId = validateObjectId(req.params.versionId, "leave policy version id");
    const version = await LeavePolicyVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      policy: policy._id,
    });
    if (!version) throw generateError("Leave policy version not found", 404);
    if (version.status !== "draft") throw generateError("Published leave policy versions are immutable", 409);
    const leaveYear = normalizeLeaveYear(req.body, version);
    version.leaveYearStartMonth = leaveYear.leaveYearStartMonth;
    version.leaveYearStartDay = leaveYear.leaveYearStartDay;
    version.rules = (await normalizeLeaveRules({
      company: companyObjectId,
      input: req.body.rules,
      current: version.rules as any,
    })) as any;
    if (req.body.effectiveFrom !== undefined) {
      version.effectiveFrom = parseEffectiveDate(req.body.effectiveFrom, "effective from date", false);
    }
    if (req.body.changeReason !== undefined) version.changeReason = normalizeText(req.body.changeReason);
    await version.save();
    const actorId = getPolicyActorId(req);
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "draft_updated",
      actor: actorId,
      details: { policyId: policy._id, versionNumber: version.versionNumber },
    });
    return res.status(200).json({ success: true, message: "Leave policy draft updated", data: version });
  } catch (error) {
    next(error);
  }
}

export async function publishLeavePolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const policy = await findLeavePolicy(companyObjectId, req.params.policyId);
    if (policy.status !== "active") throw generateError("Archived leave policies cannot be published", 409);
    const versionId = validateObjectId(req.params.versionId, "leave policy version id");
    const version = await LeavePolicyVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      policy: policy._id,
    });
    if (!version) throw generateError("Leave policy version not found", 404);
    if (version.status !== "draft") throw generateError("Only draft leave policy versions can be published", 409);
    const effectiveFrom = parseEffectiveDate(
      req.body.effectiveFrom || version.effectiveFrom,
      "effective from date"
    ) as Date;
    const changeReason = normalizeText(req.body.changeReason || version.changeReason);
    if (version.versionNumber > 1 && changeReason.length < 3) {
      throw generateError("A change reason is required when publishing a new version", 422);
    }
    const rules = await normalizeLeaveRules({
      company: companyObjectId,
      input: version.rules,
      current: version.rules as any,
    });
    if (!rules.length) throw generateError("Add at least one leave type rule before publishing", 422);
    for (const rule of rules) {
      const requestReference = await resolveEffectiveApprovalWorkflowReference({
        company: companyObjectId,
        workflowId: rule.requestApprovalWorkflow,
        requestType: "leave_request",
        at: effectiveFrom,
        setupLabel: `${rule.leaveTypeCodeSnapshot} leave requests`,
      });
      rule.requestApprovalWorkflow = requestReference.workflow;
      rule.requestApprovalWorkflowVersion = requestReference.version;
      rule.requestApprovalWorkflowVersionNumber = requestReference.versionNumber;

      if (rule.entitlementMode === "earned") {
        const claimReference = await resolveEffectiveApprovalWorkflowReference({
          company: companyObjectId,
          workflowId: rule.compOffClaimApprovalWorkflow,
          requestType: "comp_off_claim",
          at: effectiveFrom,
          setupLabel: `${rule.leaveTypeCodeSnapshot} comp-off claims`,
        });
        rule.compOffClaimApprovalWorkflow = claimReference.workflow;
        rule.compOffClaimApprovalWorkflowVersion = claimReference.version;
        rule.compOffClaimApprovalWorkflowVersionNumber = claimReference.versionNumber;
      }
    }
    const emptyEntitlementRule = rules.find(
      (rule) =>
        rule.balanceTracked &&
        rule.entitlementMode === "fixed" &&
        rule.annualEntitlement <= 0
    );
    if (emptyEntitlementRule) {
      throw generateError(
        `${emptyEntitlementRule.leaveTypeCodeSnapshot} annual entitlement must be greater than zero before publishing`,
        422
      );
    }
    const invalidCreditComponentRule = rules.find((rule) =>
      rule.creditComponents.some((component) => component.amount <= 0)
    );
    if (invalidCreditComponentRule) {
      throw generateError(
        `${invalidCreditComponentRule.leaveTypeCodeSnapshot} automatic credit amounts must be greater than zero before publishing`,
        422
      );
    }
    const invalidCarryForwardRule = rules.find(
      (rule) => rule.carryForwardEnabled && rule.maxCarryForward <= 0
    );
    if (invalidCarryForwardRule) {
      throw generateError(
        `${invalidCarryForwardRule.leaveTypeCodeSnapshot} maximum carry-forward must be greater than zero before publishing`,
        422
      );
    }
    const invalidEncashmentRule = rules.find(
      (rule) => rule.encashmentEnabled && rule.maxEncashmentPerYear <= 0
    );
    if (invalidEncashmentRule) {
      throw generateError(
        `${invalidEncashmentRule.leaveTypeCodeSnapshot} annual encashment limit must be greater than zero before publishing`,
        422
      );
    }
    const invalidNegativeBalanceRule = rules.find(
      (rule) => rule.negativeBalanceAllowed && rule.maxNegativeBalance <= 0
    );
    if (invalidNegativeBalanceRule) {
      throw generateError(
        `${invalidNegativeBalanceRule.leaveTypeCodeSnapshot} maximum negative balance must be greater than zero before publishing`,
        422
      );
    }
    const leaveTypes = await LeaveType.find({
      _id: { $in: rules.map((rule) => rule.leaveType) },
      company: companyObjectId,
    })
      .select("_id unit")
      .lean();
    const leaveTypeUnitById = new Map(
      leaveTypes.map((leaveType) => [String(leaveType._id), leaveType.unit])
    );
    for (const rule of rules) {
      const unit = leaveTypeUnitById.get(String(rule.leaveType)) || "days";
      if (rule.documentRequiredFromUnits !== null && rule.documentRequiredFromUnits !== undefined) {
        const documentIncrement = unit === "hours" ? 0.25 : rule.allowHalfDay ? 0.5 : 1;
        if (!usesIncrement(rule.documentRequiredFromUnits, documentIncrement)) {
          throw generateError(
            `${rule.leaveTypeCodeSnapshot} document threshold must use valid ${unit} increments`,
            422
          );
        }
        if (
          rule.documentSubmissionMode === "allow_later" &&
          !Number.isInteger(rule.documentDueDaysAfterLeaveEnd)
        ) {
          throw generateError(
            `${rule.leaveTypeCodeSnapshot} document due period must use whole calendar days`,
            422
          );
        }
      }
      if (unit === "hours") {
        if (!usesIncrement(rule.minimumRequestDays, 0.25)) {
          throw generateError(
            `${rule.leaveTypeCodeSnapshot} minimum request must use 15-minute increments`,
            422
          );
        }
        if (
          rule.maximumRequestDays !== null &&
          rule.maximumRequestDays !== undefined &&
          !usesIncrement(rule.maximumRequestDays, 0.25)
        ) {
          throw generateError(
            `${rule.leaveTypeCodeSnapshot} maximum request must use 15-minute increments`,
            422
          );
        }
      } else if (rule.allowHalfDay) {
        if (Math.abs(rule.minimumRequestDays - 0.5) > 0.000001) {
          throw generateError(
            `${rule.leaveTypeCodeSnapshot} minimum request must be 0.5 day when half-day leave is allowed`,
            422
          );
        }
        if (
          rule.maximumRequestDays !== null &&
          rule.maximumRequestDays !== undefined &&
          !usesIncrement(rule.maximumRequestDays, 0.5)
        ) {
          throw generateError(
            `${rule.leaveTypeCodeSnapshot} maximum request must use half-day increments`,
            422
          );
        }
      } else {
        if (rule.minimumRequestDays < 1 || !usesIncrement(rule.minimumRequestDays, 1)) {
          throw generateError(
            `${rule.leaveTypeCodeSnapshot} minimum request must be a whole day when half-day leave is disabled`,
            422
          );
        }
        if (
          rule.maximumRequestDays !== null &&
          rule.maximumRequestDays !== undefined &&
          !usesIncrement(rule.maximumRequestDays, 1)
        ) {
          throw generateError(
            `${rule.leaveTypeCodeSnapshot} maximum request must be a whole day when half-day leave is disabled`,
            422
          );
        }
      }
    }
    const duplicateEffectiveDate = await LeavePolicyVersion.findOne({
      company: companyObjectId,
      policy: policy._id,
      status: "published",
      effectiveFrom,
      _id: { $ne: version._id },
    }).lean();
    if (duplicateEffectiveDate) {
      throw generateError("Another published version already starts on this date", 409);
    }
    version.rules = rules as any;
    version.effectiveFrom = effectiveFrom;
    version.changeReason = changeReason || "Initial leave policy publication";
    version.status = "published";
    version.publishedAt = new Date();
    version.publishedBy = getPolicyActorId(req);
    await version.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "published",
      actor: version.publishedBy as mongoose.Types.ObjectId,
      details: {
        policyId: policy._id,
        versionNumber: version.versionNumber,
        effectiveFrom,
        changeReason: version.changeReason,
        ruleCount: rules.length,
      },
    });
    return res.status(200).json({
      success: true,
      message: "Leave policy version published",
      data: version,
      meta: { historicalRecalculationRequired: effectiveFrom.getTime() < Date.now() },
    });
  } catch (error) {
    next(error);
  }
}

export async function cancelLeavePolicyVersionService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const policy = await findLeavePolicy(companyObjectId, req.params.policyId);
    const versionId = validateObjectId(req.params.versionId, "leave policy version id");
    const version = await LeavePolicyVersion.findOne({
      _id: new mongoose.Types.ObjectId(versionId),
      company: companyObjectId,
      policy: policy._id,
    });
    if (!version) throw generateError("Leave policy version not found", 404);
    if (version.status === "cancelled") {
      return res.status(200).json({
        success: true,
        message: "Leave policy draft is already cancelled",
        data: version,
      });
    }
    if (version.status !== "draft") {
      throw generateError("Only draft leave policy versions can be cancelled", 409);
    }
    const reason = normalizeText(req.body.reason || req.body.cancellationReason);
    if (reason.length < 3) throw generateError("Cancellation reason must be at least 3 characters", 422);
    const actorId = getPolicyActorId(req);
    version.status = "cancelled";
    version.cancelledAt = new Date();
    version.cancelledBy = actorId;
    version.cancellationReason = reason;
    await version.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_version",
      entityId: version._id as mongoose.Types.ObjectId,
      action: "draft_cancelled",
      actor: actorId,
      details: { policyId: policy._id, versionNumber: version.versionNumber, reason },
    });
    return res.status(200).json({
      success: true,
      message: "Leave policy draft cancelled",
      data: version,
    });
  } catch (error) {
    next(error);
  }
}

export async function archiveLeavePolicyService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePolicyManager(req);
    const { companyObjectId } = await resolvePolicyCompany(
      req,
      req.body.companyId || req.query.companyId,
      true
    );
    const policy = await findLeavePolicy(companyObjectId, req.params.policyId);
    if (policy.status === "archived") {
      return res.status(200).json({ success: true, message: "Leave policy is already archived", data: policy });
    }
    const reason = normalizeText(req.body.reason || req.body.archiveReason);
    if (reason.length < 3) throw generateError("Archive reason must be at least 3 characters", 422);
    const activeAssignments = await WorkforcePolicyAssignment.countDocuments({
      company: companyObjectId,
      resourceType: "leave_policy",
      resource: policy._id,
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
    });
    if (activeAssignments > 0) {
      throw generateError(
        `End ${activeAssignments} active or scheduled assignment${activeAssignments === 1 ? "" : "s"} before archiving this policy`,
        409
      );
    }
    const actorId = getPolicyActorId(req);
    policy.status = "archived";
    policy.archivedAt = new Date();
    policy.archivedBy = actorId;
    policy.archiveReason = reason;
    await policy.save();
    await writePolicyAudit({
      company: companyObjectId,
      entityType: "leave_policy",
      entityId: policy._id as mongoose.Types.ObjectId,
      action: "archived",
      actor: actorId,
      details: { reason },
    });
    return res.status(200).json({ success: true, message: "Leave policy archived", data: policy });
  } catch (error) {
    next(error);
  }
}
