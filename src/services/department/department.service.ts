import mongoose from "mongoose";
import { Response, NextFunction } from "express";
import Company from "../../schemas/company/Company";
import Department from "../../schemas/Department/Department.schema";
import User from "../../schemas/User/User";
import { generateError } from "../../config/Error/functions";
import {
  create_department_repo,
  delete_department_repo,
  get_departments_repo,
  update_department_repo,
} from "../../repository/department/department.respository";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";

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

const normalizeText = (value: unknown) => String(value || "").trim();

const normalizeRole = (value: unknown) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead");

const isManagerRole = (role: unknown) => /^l\d+[-\s]?manager$/i.test(normalizeRole(role));

const toPlainDepartment = (department: any) =>
  typeof department?.toObject === "function" ? department.toObject() : department;

const serializeDepartmentHead = (head: any) => {
  if (!head || typeof head !== "object" || !("_id" in head)) {
    return null;
  }

  return {
    _id: head._id,
    name: head.name || "",
    email: head.email || head.username || "",
    username: head.username || head.email || "",
    role: head.role || head.userType || "",
    department: head.department || "",
  };
};

const enrichDepartmentsWithStats = async (companyId: string, departments: any[]) => {
  const plainDepartments = departments.filter(Boolean).map(toPlainDepartment);
  const departmentNames = plainDepartments
    .map((department) => normalizeText(department.departmentName))
    .filter(Boolean);

  if (!companyId || !departmentNames.length || !mongoose.Types.ObjectId.isValid(companyId)) {
    return plainDepartments.map((department) => ({
      ...department,
      departmentHead: serializeDepartmentHead(department.departmentHead),
      employeeCount: 0,
      activeEmployeeCount: 0,
      managerCount: 0,
    }));
  }

  const users = await User.find({
    company: new mongoose.Types.ObjectId(companyId),
    department: { $in: departmentNames },
    deletedAt: { $exists: false },
  })
    .select("department role userType is_active is_enabled")
    .lean();

  const statsByDepartment = users.reduce<Record<string, any>>((acc, user: any) => {
    const key = normalizeText(user.department);
    if (!acc[key]) {
      acc[key] = {
        employeeCount: 0,
        activeEmployeeCount: 0,
        managerCount: 0,
      };
    }

    acc[key].employeeCount += 1;
    if (user.is_active && user.is_enabled !== false) {
      acc[key].activeEmployeeCount += 1;
    }
    if (isManagerRole(user.role || user.userType)) {
      acc[key].managerCount += 1;
    }

    return acc;
  }, {});

  return plainDepartments.map((department) => {
    const stats = statsByDepartment[normalizeText(department.departmentName)] || {};
    return {
      ...department,
      departmentHead: serializeDepartmentHead(department.departmentHead),
      employeeCount: stats.employeeCount || 0,
      activeEmployeeCount: stats.activeEmployeeCount || 0,
      managerCount: stats.managerCount || 0,
    };
  });
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
      data: (await enrichDepartmentsWithStats(company, [department]))[0],
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

      await User.updateMany(
        {
          company: updated.company,
          department: String(existingDepartment.departmentName || ""),
          deletedAt: { $exists: false },
        },
        {
          department: nextDepartmentName,
          updatedAt: new Date(),
        }
      );
    }

    return res.status(200).send({
      status: "success",
      data: (await enrichDepartmentsWithStats(String(updated.company), [updated]))[0],
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

    const assignedUsers = await User.countDocuments({
      company: existingDepartment.company,
      department: String(existingDepartment.departmentName || ""),
      deletedAt: { $exists: false },
    });

    if (assignedUsers > 0) {
      throw generateError("This department has assigned employees. Move employees before deleting it.", 400);
    }

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

// ================= ASSIGN HEAD =================
export const assignDepartmentHeadService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    ensurePermission(
      req.bodyData || req.user,
      PERMISSION_KEYS.CREATE_DEPARTMENT_HEADS,
      "You do not have permission to assign department heads"
    );

    const { id } = req.params;
    const departmentHeadId = normalizeText(req.body?.departmentHeadId || req.body?.userId);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw generateError("Invalid department id", 400);
    }

    const department = await Department.findOne({
      _id: id,
      deletedAt: null,
    });

    if (!department) {
      throw generateError("Department not found", 404);
    }

    await ensureCompanyManagementAccess({
      actor: req.bodyData || req.user,
      requestedCompanyId: String(department.company || ""),
      actionLabel: "manage departments for this company",
      allowSuperadminWithoutCompany: false,
    });

    if (!departmentHeadId) {
      department.departmentHead = undefined;
      await department.save();
      const updated = await Department.findById(id).populate("departmentHead", "name email username role userType department");

      return res.status(200).send({
        status: "success",
        data: (await enrichDepartmentsWithStats(String(department.company), [updated]))[0],
        message: "Department head removed successfully",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(departmentHeadId)) {
      throw generateError("Invalid departmentHeadId", 400);
    }

    const user = await User.findOne({
      _id: new mongoose.Types.ObjectId(departmentHeadId),
      company: department.company,
      deletedAt: { $exists: false },
    });

    if (!user) {
      throw generateError("User not found in this company", 404);
    }

    const targetRole = normalizeRole(user.role || user.userType);
    if (["admin", "superadmin"].includes(targetRole)) {
      throw generateError("Choose an employee or manager, not an admin account", 400);
    }

    user.department = normalizeText(department.departmentName);
    user.role = "departmenthead";
    user.userType = "departmenthead";
    user.updatedAt = new Date();
    await user.save();

    department.departmentHead = user._id;
    await department.save();

    const updated = await Department.findById(id).populate("departmentHead", "name email username role userType department");

    return res.status(200).send({
      status: "success",
      data: (await enrichDepartmentsWithStats(String(department.company), [updated]))[0],
      message: "Department head assigned successfully",
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
        .populate("departmentHead", "name email username role userType department")
        .limit(limit)
        .skip((page - 1) * limit)
        .sort({ createdAt: -1 });
      const enrichedData = await enrichDepartmentsWithStats(company, data);

      return res.status(200).send({
        status: "success",
        data: enrichedData,
        pagination: {
          total: enrichedData.length,
          page,
          limit,
          totalPages: enrichedData.length ? 1 : 0,
        },
      });
    }

    const data = await get_departments_repo(company, page, limit);
    const enrichedData = await enrichDepartmentsWithStats(company, data.data || []);

    return res.status(200).send({
      status: "success",
      data: enrichedData,
      pagination: data.pagination,
    });
  } catch (err) {
    next(err);
  }
};
