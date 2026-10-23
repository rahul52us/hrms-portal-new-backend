import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import Department from "../../schemas/Department/Department.schema";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import Project from "../../schemas/project/Project.schema";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { getHrDashboardSummaryService } from "./hrDashboard.service";

export async function getPlatformDashboardSummaryService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = req.user || req.bodyData;
    ensurePermission(actor, PERMISSION_KEYS.VIEW_DASHBOARD, "You do not have permission to view the dashboard");
    if (String(actor.role).toLowerCase() !== "superadmin") return getHrDashboardSummaryService(req, res, next);
    const companyId = String(req.query.companyId || "").trim();
    if (companyId && !/^[a-f\d]{24}$/i.test(companyId)) throw generateError("Invalid company id", 400);
    const companyMatch: any = { deletedAt: null, type: { $ne: "user" }, companyType: { $ne: "organisation" }, ...(companyId ? { _id: new mongoose.Types.ObjectId(companyId) } : {}) };
    if (companyId && !await Company.exists(companyMatch)) throw generateError("Company not found", 404);
    const scope = companyId ? { company: new mongoose.Types.ObjectId(companyId) } : { company: { $ne: null } };
    const people = { ...scope, role: { $ne: "superadmin" }, deletedAt: null };
    const hasPassword = { $exists: true, $nin: [null, ""] };
    const [totalCompanies, activeCompanies, totalEmployees, activeEmployees, pendingEmployees, departments, locations, activeProjects, recentCompanies] = await Promise.all([
      Company.countDocuments(companyMatch), Company.countDocuments({ ...companyMatch, is_active: { $ne: false } }),
      User.countDocuments(people), User.countDocuments({ ...people, is_enabled: { $ne: false }, password: hasPassword }),
      User.countDocuments({ ...people, is_enabled: { $ne: false }, $or: [{ password: null }, { password: "" }] }),
      Department.countDocuments({ ...scope, deletedAt: null }), OfficeLocation.countDocuments({ ...scope, deletedAt: null }),
      Project.countDocuments({ ...scope, status: "active" }),
      Company.find(companyMatch).select("_id company_name companyCode is_active createdAt").sort({ createdAt: -1, _id: -1 }).limit(5).lean(),
    ]);
    return res.status(200).json({ success: true, data: {
      role: "superadmin", scope: { mode: "platform", companyId: companyId || null },
      stats: { totalCompanies, activeCompanies, inactiveCompanies: totalCompanies - activeCompanies,
        totalEmployees, activeEmployees, pendingEmployees, inactiveEmployees: totalEmployees - activeEmployees - pendingEmployees,
        departments, locations, activeProjects },
      recentCompanies,
    } });
  } catch (error) { next(error); }
}
