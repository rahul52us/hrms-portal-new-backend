import Event from "../../schemas/Storage/UploadSecurityEvent.schema";
import { generateError } from "../../config/Error/functions";
import { getEmployeeRequestActor, resolveEmployeeRequestCompanyId } from "../leave/leaveAccess.utils";
import { canManageOnboardingAutomation } from "./onboardingAutomation.service";
import { checkMalwareScanner, malwareScannerSummary } from "../storage/malwareScanner";
import { pagination } from "./onboardingTemplate.utils";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";

/** Only company-wide HR/Admin operators can inspect scanner configuration or company failure metadata. */
function context(req: any) {
  const actor = getEmployeeRequestActor(req);
  if (!canManageOnboardingAutomation(actor)) throw generateError("Company Admin or HR Admin with onboarding management permission is required", 403);
  return { actor, company: resolveEmployeeRequestCompanyId(actor, req.query?.companyId || req.body?.companyId, "document security") };
}
export const getOnboardingDocumentSecurity = async (req: any, res: any, next: any) => {
  try {
    context(req);
    res.json({ success: true, data: { scanner: malwareScannerSummary() } });
  } catch (error) { next(error); }
};
export const checkOnboardingDocumentScanner = async (req: any, res: any, next: any) => {
  try {
    const { actor, company } = context(req);
    await ensureCompanyManagementAccess({ actor, requestedCompanyId: String(company), actionLabel: "check the document scanner" });
    res.json({ success: true, data: await checkMalwareScanner() });
  } catch (error) { next(error); }
};
export const listUploadSecurityEvents = async (req: any, res: any, next: any) => {
  try {
    const { company } = context(req), { page, limit, skip } = pagination(req.query);
    const [data, total] = await Promise.all([Event.find({ company }).select("uploadedBy purpose provider outcome createdAt").populate("uploadedBy", "name code").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), Event.countDocuments({ company })]);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};
