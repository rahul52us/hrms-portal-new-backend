import mongoose from "mongoose";
import { Response, NextFunction } from "express";
import Company from "../../schemas/company/Company";
import Department from "../../schemas/Department/Department.schema";
import { generateError } from "../../config/Error/functions";
import {
  create_department_repo,
  delete_department_repo,
  get_departments_repo,
  update_department_repo,
} from "../../repository/department/department.respository";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";

const getScopedCompanyId = (req: any) => {
  const role = String(
    req.bodyData?.role ||
      req.bodyData?.userType ||
      req.user?.role ||
      req.user?.userType ||
      ""
  ).toLowerCase();

  if (role === "superadmin") {
    return String(
      req.body?.companyId || req.body?.company || req.query?.companyId || ""
    ).trim();
  }

  return String(req.bodyData?.company || req.user?.company || "").trim();
};

const getRequesterRole = (req: any) =>
  String(
    req.bodyData?.role ||
      req.bodyData?.userType ||
      req.user?.role ||
      req.user?.userType ||
      ""
  )
    .trim()
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead");

const ensureDepartmentMutationAllowed = (req: any) => {
  const role = getRequesterRole(req);
  if (!["superadmin", "admin"].includes(role)) {
    throw generateError("Only superadmin or admin can manage departments", 403);
  }
};

const syncCompanyDepartmentNames = async (
  companyId: string,
  options: { add?: string; remove?: string }
) => {
  if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
    return;
  }

  const addName = String(options.add || "").trim();
  const removeName = String(options.remove || "").trim();

  if (removeName && removeName !== addName) {
    const remainingDepartment = await Department.findOne({
      company: new mongoose.Types.ObjectId(companyId),
      departmentName: removeName,
      deletedAt: null,
    }).lean();

    if (!remainingDepartment) {
      await Company.findByIdAndUpdate(companyId, {
        $pull: { departments: removeName },
      });
    }
  }

  if (addName) {
    await Company.findByIdAndUpdate(companyId, {
      $addToSet: { departments: addName },
    });
  }
};

// ================= CREATE =================
export const createDepartmentService = async (
  req: any,
  res: Response,
  next: NextFunction,
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    const company = getScopedCompanyId(req);
    const departmentName = String(req.body.departmentName || "").trim();
    const code = String(req.body.code || "").trim();

    if (!company) {
      return res.status(422).send({
        status: "error",
        data: null,
        message: "companyId is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(company)) {
      return res.status(400).send({
        status: "error",
        data: null,
        message: "Invalid companyId",
      });
    }

    await ensureCompanyManagementAccess({
      actor: req.bodyData || req.user,
      requestedCompanyId: company,
      actionLabel: "manage departments for this company",
      allowSuperadminWithoutCompany: false,
    });

    const department = await create_department_repo({
      company,
      departmentName,
      code,
    });

    await syncCompanyDepartmentNames(company, { add: departmentName });

    return res.status(201).send({
      status: "success",
      data: department,
      message: "Created successfully",
    });
  } catch (err) {
    next(err);
  }
};

// ================= UPDATE =================
export const updateDepartmentService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    const { id } = req.params;
    const existingDepartment = await Department.findOne({
      _id: id,
      deletedAt: null,
    });

    if (!existingDepartment) {
      return res.status(404).send({
        status: "error",
        data: null,
        message: "Department not found",
      });
    }

    const nextDepartmentName = req.body.departmentName
      ? String(req.body.departmentName).trim()
      : undefined;
    const nextCode = req.body.code ? String(req.body.code).trim() : undefined;

    await ensureCompanyManagementAccess({
      actor: req.bodyData || req.user,
      requestedCompanyId: String(existingDepartment.company || ""),
      actionLabel: "manage departments for this company",
      allowSuperadminWithoutCompany: false,
    });

    const updated = await update_department_repo(id, {
      ...req.body,
      ...(typeof nextDepartmentName === "string"
        ? { departmentName: nextDepartmentName }
        : {}),
      ...(typeof nextCode === "string" ? { code: nextCode } : {}),
    });

    if (!updated) {
      return res.status(404).send({
        status: "error",
        data: null,
        message: "Department not found",
      });
    }

    if (
      nextDepartmentName &&
      nextDepartmentName !== String(existingDepartment.departmentName || "")
    ) {
      await syncCompanyDepartmentNames(String(updated.company), {
        remove: String(existingDepartment.departmentName || ""),
        add: nextDepartmentName,
      });
    }

    return res.status(200).send({
      status: "success",
      data: updated,
      message: "Updated successfully",
    });
  } catch (err) {
    next(err);
  }
};

// ================= DELETE =================
export const deleteDepartmentService = async (
  req: any,
  res: Response,
  next: NextFunction,
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    const { id } = req.params;
    const existingDepartment = await Department.findOne({
      _id: id,
      deletedAt: null,
    });

    if (!existingDepartment) {
      return res.status(404).send({
        status: "error",
        data: null,
        message: "Department not found",
      });
    }

    await ensureCompanyManagementAccess({
      actor: req.bodyData || req.user,
      requestedCompanyId: String(existingDepartment.company || ""),
      actionLabel: "manage departments for this company",
      allowSuperadminWithoutCompany: false,
    });

    await delete_department_repo(id);
    await syncCompanyDepartmentNames(String(existingDepartment.company), {
      remove: String(existingDepartment.departmentName || ""),
    });

    return res.status(200).send({
      status: "success",
      message: "Deleted successfully",
    });
  } catch (err) {
    next(err);
  }
};

// ================= GET ALL =================
export const getDepartmentsService = async (
  req: any,
  res: Response,
  next: NextFunction,
) => {
  try {
    const role = getRequesterRole(req);
    const company = getScopedCompanyId(req);
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;

    if (!company) {
      return res.status(200).send({
        status: "success",
        data: [],
        pagination: {
          total: 0,
          page,
          limit,
          totalPages: 0,
        },
      });
    }

    if (!mongoose.Types.ObjectId.isValid(company)) {
      return res.status(400).send({
        status: "error",
        data: null,
        message: "Invalid companyId",
      });
    }

    if (role === "departmenthead") {
      const actorDepartment = String(req.bodyData?.department || req.user?.department || "").trim();
      if (!actorDepartment) {
        throw generateError("Department head is missing department scope", 403);
      }

      const normalizedDepartment = actorDepartment.toLowerCase();
      const data = await Department.find({
        company,
        deletedAt: null,
        $or: [
          { departmentName: { $regex: `^${actorDepartment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } },
          { code: { $regex: `^${actorDepartment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } },
        ],
      })
        .limit(limit)
        .skip((page - 1) * limit)
        .sort({ createdAt: -1 });

      return res.status(200).send({
        status: "success",
        data,
        pagination: {
          total: data.length,
          page,
          limit,
          totalPages: data.length ? 1 : 0,
        },
      });
    }

    const data = await get_departments_repo(company, page, limit);

    return res.status(200).send({
      status: "success",
      ...data,
    });
  } catch (err) {
    next(err);
  }
};
