import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import Company from "../../schemas/company/Company";
import WorkforcePolicyAuditLog from "../../schemas/WorkforcePolicy/WorkforcePolicyAuditLog.schema";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";

export const POLICY_SCOPE_PRIORITY: Record<string, number> = {
  company: 100,
  location: 200,
  department: 300,
  team: 400,
  employee: 500,
};

export function normalizeText(value: unknown) {
  return String(value || "").trim();
}

export function normalizeRole(value: unknown) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead")
    .replace(/^head[-\s]?hr$/i, "hradmin")
    .replace(/^hr[-\s]?admin$/i, "hradmin")
    .replace(/^hr[-\s]?executive$/i, "hr");
}

export function getPolicyActor(req: any) {
  return req.bodyData || req.user || {};
}

export function getPolicyActorId(req: any) {
  const id = normalizeText(getPolicyActor(req)?._id || req.userId);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw generateError("Authenticated user id is missing", 401);
  }

  return new mongoose.Types.ObjectId(id);
}

export function validateObjectId(value: unknown, label: string) {
  const id = normalizeText(value);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw generateError(`Invalid ${label}`, 400);
  }

  return id;
}

export function parseEffectiveDate(value: unknown, label: string, required = true) {
  const raw = normalizeText(value);
  if (!raw) {
    if (required) {
      throw generateError(`${label} is required`, 422);
    }
    return null;
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw generateError(`Invalid ${label}`, 400);
  }

  return date;
}

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function ensurePolicyViewer(req: any) {
  const actor = getPolicyActor(req);
  const role = normalizeRole(actor?.role);
  if (!["superadmin", "admin", "hradmin", "hr", "departmenthead"].includes(role)) {
    throw generateError("Only company administrators and HR roles can view workforce policies", 403);
  }

  ensurePermission(
    actor,
    PERMISSION_KEYS.VIEW_WORKFORCE_POLICIES,
    "You do not have permission to view workforce policies"
  );
}

export function ensurePolicyManager(req: any) {
  const actor = getPolicyActor(req);
  const role = normalizeRole(actor?.role);
  if (!["superadmin", "admin", "hradmin"].includes(role)) {
    throw generateError("Only superadmin, company admin, or HR Admin can manage workforce policies", 403);
  }

  ensurePermission(
    actor,
    PERMISSION_KEYS.MANAGE_WORKFORCE_POLICIES,
    "You do not have permission to manage workforce policies"
  );
}

export async function resolvePolicyCompany(req: any, requestedCompanyInput?: unknown, mutation = false) {
  const actor = getPolicyActor(req);
  const role = normalizeRole(actor?.role);
  const actorCompanyId = normalizeText(actor?.company || actor?.companyId);
  const requestedCompanyId = normalizeText(requestedCompanyInput);
  const companyId = role === "superadmin" ? requestedCompanyId : actorCompanyId;

  if (!companyId) {
    throw generateError("Company context is required", 422);
  }

  validateObjectId(companyId, "company id");

  if (role !== "superadmin" && requestedCompanyId && requestedCompanyId !== actorCompanyId) {
    throw generateError("You can only access policies from your company", 403);
  }

  if (mutation) {
    await ensureCompanyManagementAccess({
      actor,
      requestedCompanyId: companyId,
      actionLabel: "manage workforce policies for this company",
      allowSuperadminWithoutCompany: false,
    });
  }

  const company = await Company.findOne({
    _id: new mongoose.Types.ObjectId(companyId),
    deletedAt: { $exists: false },
  })
    .select("_id company_name companyCode is_active")
    .lean();

  if (!company) {
    throw generateError("Company not found", 404);
  }

  return { company, companyId, companyObjectId: new mongoose.Types.ObjectId(companyId) };
}

export async function writePolicyAudit(options: {
  company: mongoose.Types.ObjectId;
  entityType:
    | "attendance_policy"
    | "attendance_version"
    | "work_schedule"
    | "work_schedule_version"
    | "holiday_calendar"
    | "holiday_version"
    | "leave_type"
    | "leave_policy"
    | "leave_version"
    | "assignment";
  entityId: mongoose.Types.ObjectId;
  action: string;
  actor: mongoose.Types.ObjectId;
  details?: any;
}) {
  await WorkforcePolicyAuditLog.create(options);
}

export function getVersionEffectiveTo<T extends { status?: string; effectiveFrom?: any }>(
  version: T,
  publishedVersions: T[]
) {
  if (version.status !== "published" || !version.effectiveFrom) {
    return null;
  }

  const currentTime = new Date(version.effectiveFrom).getTime();
  const nextVersion = publishedVersions
    .filter((candidate) => candidate.effectiveFrom && new Date(candidate.effectiveFrom).getTime() > currentTime)
    .sort(
      (left, right) =>
        new Date(left.effectiveFrom).getTime() - new Date(right.effectiveFrom).getTime()
    )[0];

  return nextVersion?.effectiveFrom || null;
}

export function isDateRangeOverlapping(options: {
  existingStart: Date;
  existingEnd?: Date | null;
  requestedStart: Date;
  requestedEnd?: Date | null;
}) {
  const existingStart = options.existingStart.getTime();
  const existingEnd = options.existingEnd ? options.existingEnd.getTime() : Number.POSITIVE_INFINITY;
  const requestedStart = options.requestedStart.getTime();
  const requestedEnd = options.requestedEnd ? options.requestedEnd.getTime() : Number.POSITIVE_INFINITY;
  return existingStart < requestedEnd && requestedStart < existingEnd;
}
