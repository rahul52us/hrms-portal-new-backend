import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import Company from "../../schemas/company/Company";
import PayrollAuditLog from "../../schemas/Payroll/PayrollAuditLog.schema";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";

export function normalizePayrollRole(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^head[-\s]?hr$/i, "hradmin")
    .replace(/^hr[-\s]?admin$/i, "hradmin");
}

export function getPayrollActor(req: any) {
  return req.bodyData || req.user || {};
}

export function getPayrollActorId(req: any) {
  const value = String(getPayrollActor(req)?._id || req.userId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw generateError("Authenticated user id is missing", 401);
  }
  return new mongoose.Types.ObjectId(value);
}

export function ensurePayrollViewer(req: any) {
  const actor = getPayrollActor(req);
  const role = normalizePayrollRole(actor?.role);
  if (!["superadmin", "admin", "hradmin"].includes(role)) {
    throw generateError("Only company administrators and payroll-authorized HR users can view payroll", 403);
  }
  ensurePermission(actor, PERMISSION_KEYS.VIEW_PAYROLL, "You do not have permission to view payroll");
}

export function ensurePayrollConfigurationManager(req: any) {
  const actor = getPayrollActor(req);
  const role = normalizePayrollRole(actor?.role);
  if (!["superadmin", "admin", "hradmin"].includes(role)) {
    throw generateError("Only company administrators and HR Admin can manage payroll configuration", 403);
  }
  ensurePermission(
    actor,
    PERMISSION_KEYS.MANAGE_PAYROLL_CONFIGURATION,
    "You do not have permission to manage payroll configuration"
  );
}

export function ensureEmployeeCompensationManager(req: any) {
  const actor = getPayrollActor(req);
  const role = normalizePayrollRole(actor?.role);
  if (!["superadmin", "admin", "hradmin"].includes(role)) {
    throw generateError("Only company administrators and HR Admin can manage employee compensation", 403);
  }
  ensurePermission(
    actor,
    PERMISSION_KEYS.MANAGE_EMPLOYEE_COMPENSATION,
    "You do not have permission to manage employee compensation"
  );
}

export function ensureEmployeeStatutoryManager(req: any) {
  const actor = getPayrollActor(req);
  const role = normalizePayrollRole(actor?.role);
  if (!["superadmin", "admin", "hradmin"].includes(role)) {
    throw generateError("Only company administrators and HR Admin can manage employee statutory data", 403);
  }
  ensurePermission(
    actor,
    PERMISSION_KEYS.MANAGE_EMPLOYEE_STATUTORY,
    "You do not have permission to manage employee statutory data"
  );
}

export function ensurePayrollRunManager(req: any) {
  const actor = getPayrollActor(req);
  const role = normalizePayrollRole(actor?.role);
  if (!["superadmin", "admin", "hradmin"].includes(role)) {
    throw generateError("Only company administrators and HR Admin can manage payroll runs", 403);
  }
  ensurePermission(
    actor,
    PERMISSION_KEYS.MANAGE_PAYROLL_RUNS,
    "You do not have permission to manage payroll runs"
  );
}

export function ensurePayrollRunApprover(req: any) {
  const actor = getPayrollActor(req);
  const role = normalizePayrollRole(actor?.role);
  if (!['superadmin', 'admin', 'hradmin'].includes(role)) {
    throw generateError('Only company administrators and HR Admin can approve payroll runs', 403);
  }
  ensurePermission(
    actor,
    PERMISSION_KEYS.APPROVE_PAYROLL_RUNS,
    'You do not have permission to approve payroll runs'
  );
}

export function ensurePayrollRunFinalizer(req: any) {
  const actor = getPayrollActor(req);
  const role = normalizePayrollRole(actor?.role);
  if (!["superadmin", "admin", "hradmin"].includes(role)) {
    throw generateError("Only company administrators and HR Admin can finalize payroll runs", 403);
  }
  ensurePermission(
    actor,
    PERMISSION_KEYS.FINALIZE_PAYROLL_RUNS,
    "You do not have permission to finalize payroll runs"
  );
}

export function ensurePayrollRunReopener(req: any) {
  const actor = getPayrollActor(req);
  const role = normalizePayrollRole(actor?.role);
  if (!["superadmin", "admin", "hradmin"].includes(role)) {
    throw generateError("Only company administrators and HR Admin can reopen payroll runs", 403);
  }
  ensurePermission(
    actor,
    PERMISSION_KEYS.REOPEN_PAYROLL_RUNS,
    "You do not have permission to reopen payroll runs"
  );
}

export async function resolvePayrollCompany(
  req: any,
  requestedCompanyInput?: unknown,
  mutation = false,
  actionLabel = "manage payroll configuration for this company"
) {
  const actor = getPayrollActor(req);
  const role = normalizePayrollRole(actor?.role);
  const actorCompanyId = String(actor?.company || actor?.companyId || "").trim();
  const requestedCompanyId = String(requestedCompanyInput || "").trim();
  const companyId = role === "superadmin" ? requestedCompanyId : actorCompanyId;

  if (!companyId) {
    throw generateError("Company context is required", 422);
  }
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    throw generateError("Invalid company id", 400);
  }
  if (role !== "superadmin" && requestedCompanyId && requestedCompanyId !== actorCompanyId) {
    throw generateError("You can only access payroll for your company", 403);
  }

  if (mutation) {
    await ensureCompanyManagementAccess({
      actor,
      requestedCompanyId: companyId,
      actionLabel,
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

export async function writePayrollAudit(options: {
  company: mongoose.Types.ObjectId;
  entityType: "payroll_settings" | "salary_component" | "salary_structure" | "employee_compensation" | "employee_statutory" | "employee_tax_declaration" | "compensation_import" | "payroll_run" | "payroll_input" | "statutory_profile" | "statutory_filing" | "payslip";
  entityId: mongoose.Types.ObjectId;
  action: string;
  actor: mongoose.Types.ObjectId;
  reason?: string;
  details?: Record<string, unknown>;
}, session?: mongoose.ClientSession) {
  if (session) {
    await PayrollAuditLog.create([options], { session });
    return;
  }
  await PayrollAuditLog.create(options);
}
