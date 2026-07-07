import mongoose from "mongoose";
import { generateError } from "../../../config/Error/functions";
import Company from "../../../schemas/company/Company";

function normalizeRole(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead");
}

function normalizeId(value: unknown) {
  return String(value || "").trim();
}

export function buildInactiveCompanyMessage(actionLabel: string, companyName?: string) {
  const prefix = companyName ? `${companyName} is inactive.` : "This company is inactive.";
  return `${prefix} You cannot ${actionLabel} until the company is reactivated. User login access depends on each account's status.`;
}

export function ensureUserAccountEnabled(user: any) {
  if (user && user.is_enabled === false) {
    throw generateError(
      "Your account has been deactivated. Please contact your administrator.",
      403
    );
  }
}

export function assertCompanyIsActiveForManagement(company: any, actionLabel: string) {
  if (company && company.is_active === false) {
    throw generateError(buildInactiveCompanyMessage(actionLabel, company.company_name), 403);
  }
}

export async function ensureCompanyManagementAccess(options: {
  actor?: any;
  requestedCompanyId?: string | null;
  actionLabel: string;
  allowSuperadminWithoutCompany?: boolean;
}): Promise<any> {
  const role = normalizeRole(options.actor?.role || options.actor?.userType);
  const actorCompanyId = normalizeId(options.actor?.companyId || options.actor?.company);
  const requestedCompanyId = normalizeId(options.requestedCompanyId);
  const companyId = requestedCompanyId || (role === "superadmin" ? "" : actorCompanyId);

  if (!companyId) {
    if (role === "superadmin" && options.allowSuperadminWithoutCompany) {
      return null;
    }

    throw generateError("Company context is required", 422);
  }

  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    throw generateError("Invalid company id", 400);
  }

  const company = await Company.findOne({
    _id: new mongoose.Types.ObjectId(companyId),
    deletedAt: { $exists: false },
  }).lean();

  if (!company) {
    throw generateError("Company not found", 404);
  }

  assertCompanyIsActiveForManagement(company, options.actionLabel);
  return company;
}
