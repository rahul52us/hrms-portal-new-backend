import mongoose from "mongoose";
import { Response, NextFunction } from "express";
import Company from "../../schemas/company/Company";
import Department from "../../schemas/Department/Department.schema";
import User from "../../schemas/User/User";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import { generateError } from "../../config/Error/functions";
import {
  archive_department_repo,
  create_department_repo,
  get_departments_repo,
  update_department_repo,
} from "../../repository/department/department.respository";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import {
  buildEmployeeAssignmentSnapshot,
  ensureCurrentEmployeeAssignment,
  recordEmployeeAssignmentChange,
} from "../employeeAssignment/employeeAssignment.service";

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
    .replace(/^department[-\s]?head$/i, "departmenthead")
    .replace(/^head[-\s]?hr$/i, "hradmin")
    .replace(/^hr[-\s]?admin$/i, "hradmin")
    .replace(/^hr[-\s]?executive$/i, "hr");

const ensureDepartmentMutationAllowed = (req: any) => {
  const role = getRequesterRole(req);
  if (!["superadmin", "admin"].includes(role)) {
    throw generateError("Only superadmin or admin can manage departments", 403);
  }
};

const normalizeText = (value: unknown) => String(value || "").trim();

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const getRequesterId = (req: any) =>
  normalizeText(req.userId || req.user?._id || req.bodyData?._id);

const normalizeRole = (value: unknown) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead")
    .replace(/^head[-\s]?hr$/i, "hradmin")
    .replace(/^hr[-\s]?admin$/i, "hradmin")
    .replace(/^hr[-\s]?executive$/i, "hr");

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

const serializeDepartmentTeams = (teams: any[] = []) =>
  (Array.isArray(teams) ? teams : []).map((team: any) => ({
    _id: team?._id,
    name: team?.name || "",
    code: team?.code || "",
    description: team?.description || "",
    isActive: team?.isActive !== false,
    createdAt: team?.createdAt || null,
    updatedAt: team?.updatedAt || null,
  }));

const enrichDepartmentsWithStats = async (companyId: string, departments: any[]) => {
  const plainDepartments = departments.filter(Boolean).map(toPlainDepartment);
  const departmentNames = plainDepartments
    .map((department) => normalizeText(department.departmentName))
    .filter(Boolean);

  if (!companyId || !departmentNames.length || !mongoose.Types.ObjectId.isValid(companyId)) {
    return plainDepartments.map((department) => ({
      ...department,
      departmentHead: serializeDepartmentHead(department.departmentHead),
      teams: serializeDepartmentTeams(department.teams),
      teamCount: serializeDepartmentTeams(department.teams).length,
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
    const teams = serializeDepartmentTeams(department.teams);
    return {
      ...department,
      departmentHead: serializeDepartmentHead(department.departmentHead),
      teams,
      teamCount: teams.length,
      employeeCount: stats.employeeCount || 0,
      activeEmployeeCount: stats.activeEmployeeCount || 0,
      managerCount: stats.managerCount || 0,
    };
  });
};

const findDepartmentForMutation = async (req: any, id: string) => {
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

  return department;
};

const getDepartmentTeams = (department: any) =>
  Array.isArray(department?.teams) ? department.teams : [];

const normalizeScopeList = (value: any) => {
  const source = Array.isArray(value)
    ? value
    : value
      ? [value]
      : [];
  const seen = new Set<string>();
  const output: string[] = [];

  source.forEach((item: any) => {
    const normalized = normalizeText(item);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(normalized);
  });

  return output;
};

const getHrScopeDepartments = (req: any) =>
  normalizeScopeList((req.bodyData || req.user)?.hrScope?.departments);

const findTeamById = (department: any, teamId: string) =>
  getDepartmentTeams(department).find((team: any) => String(team?._id || "") === String(teamId || ""));

const findDuplicateTeam = (
  department: any,
  name: string,
  excludeTeamId?: string
) => {
  const normalizedName = normalizeText(name).toLowerCase();
  return getDepartmentTeams(department).find((team: any) => {
    if (excludeTeamId && String(team?._id || "") === String(excludeTeamId)) {
      return false;
    }

    return normalizeText(team?.name).toLowerCase() === normalizedName;
  });
};

const getPopulatedDepartment = (id: string) =>
  Department.findById(id).populate("departmentHead", "name email username role userType department");

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

const getDepartmentArchiveImpact = async (department: any) => {
  const departmentName = normalizeText(department?.departmentName);
  const exactDepartmentName = new RegExp(`^${escapeRegex(departmentName)}$`, "i");

  const [assignedEmployees, scopedHrUsers] = await Promise.all([
    User.countDocuments({
      company: department.company,
      department: exactDepartmentName,
      deletedAt: null,
    }),
    User.countDocuments({
      company: department.company,
      "hrScope.departments": exactDepartmentName,
      deletedAt: null,
    }),
  ]);

  const teams = getDepartmentTeams(department);
  const activeTeams = teams.filter((team: any) => team?.isActive !== false).length;
  const hasDepartmentHead = Boolean(department?.departmentHead);
  const blockers = [
    assignedEmployees > 0
      ? {
          key: "employees",
          count: assignedEmployees,
          label: "Assigned employees",
          resolution: "Transfer every employee to another department.",
        }
      : null,
    hasDepartmentHead
      ? {
          key: "departmentHead",
          count: 1,
          label: "Department head",
          resolution: "Remove or reassign the department head.",
        }
      : null,
    scopedHrUsers > 0
      ? {
          key: "hrScopes",
          count: scopedHrUsers,
          label: "HR scope assignments",
          resolution: "Remove or replace this department in each HR scope.",
        }
      : null,
  ].filter(Boolean);

  return {
    department: {
      _id: department._id,
      departmentName,
      code: normalizeText(department?.code),
    },
    counts: {
      assignedEmployees,
      departmentHead: hasDepartmentHead ? 1 : 0,
      teams: teams.length,
      activeTeams,
      hrScopes: scopedHrUsers,
    },
    blockers,
    canArchive: blockers.length === 0,
    effects: {
      teamsArchivedWithDepartment: teams.length,
      reportingManagersChanged: 0,
      historicalRecordsPreserved: true,
    },
  };
};

const getDepartmentTransferPreview = async (department: any) => {
  const departmentName = normalizeText(department?.departmentName);
  const exactDepartmentName = new RegExp(
    `^${escapeRegex(departmentName)}$`,
    "i"
  );

  const [employees, destinations] = await Promise.all([
    User.find({
      company: department.company,
      department: exactDepartmentName,
      deletedAt: null,
    })
      .select(
        "name email username code role userType team designation officeLocation reportingManager is_active is_enabled"
      )
      .populate("officeLocation", "name code city state")
      .populate("reportingManager", "name email username")
      .sort({ name: 1 })
      .lean(),
    Department.find({
      company: department.company,
      _id: { $ne: department._id },
      deletedAt: null,
    })
      .sort({ departmentName: 1 })
      .lean(),
  ]);

  return {
    sourceDepartment: {
      _id: department._id,
      departmentName,
      code: normalizeText(department?.code),
      teams: serializeDepartmentTeams(getDepartmentTeams(department)),
      departmentHeadId: normalizeText(department?.departmentHead),
    },
    employees: employees.map((employee: any) => ({
      _id: employee._id,
      name: employee.name || "",
      email: employee.email || employee.username || "",
      code: employee.code || "",
      role: employee.role || employee.userType || "user",
      team: employee.team || "",
      designation: employee.designation || "",
      officeLocation: employee.officeLocation || null,
      reportingManager: employee.reportingManager || null,
      isActive: Boolean(employee.is_active) && employee.is_enabled !== false,
      isDepartmentHead:
        String(employee._id) === String(department?.departmentHead || ""),
    })),
    destinations: destinations.map((destination: any) => ({
      _id: destination._id,
      departmentName: destination.departmentName || "",
      code: destination.code || "",
      teams: serializeDepartmentTeams(destination.teams).filter(
        (team: any) => team.isActive !== false
      ),
    })),
  };
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

// ================= ARCHIVE =================
export const getDepartmentArchiveImpactService = async (
  req: any,
  res: Response,
  next: NextFunction,
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    const { id } = req.params;
    const department = await findDepartmentForMutation(req, id);
    const impact = await getDepartmentArchiveImpact(department);

    return res.status(200).send({
      status: "success",
      data: impact,
      message: impact.canArchive
        ? "Department can be archived"
        : "Resolve department dependencies before archiving",
    });
  } catch (err) {
    next(err);
  }
};

export const archiveDepartmentService = async (
  req: any,
  res: Response,
  next: NextFunction,
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    const { id } = req.params;
    const reason = normalizeText(req.body?.reason);
    const requesterId = getRequesterId(req);

    if (reason.length < 3) {
      throw generateError("Archive reason must be at least 3 characters", 422);
    }

    if (!requesterId || !mongoose.Types.ObjectId.isValid(requesterId)) {
      throw generateError("Unable to identify the user archiving this department", 401);
    }

    const department = await findDepartmentForMutation(req, id);
    const impact = await getDepartmentArchiveImpact(department);

    if (!impact.canArchive) {
      return res.status(409).send({
        status: "error",
        data: impact,
        message: "Resolve department dependencies before archiving",
      });
    }

    const archivedAt = new Date();
    const archived = await archive_department_repo(id, {
      deletedAt: archivedAt,
      archivedBy: requesterId,
      archiveReason: reason,
    });

    if (!archived) {
      throw generateError("Department not found or already archived", 404);
    }

    await syncCompanyDepartmentNames(String(department.company), {
      remove: String(department.departmentName || ""),
    });

    return res.status(200).send({
      status: "success",
      data: {
        _id: archived._id,
        departmentName: archived.departmentName,
        archivedAt: archived.deletedAt,
        archivedBy: archived.archivedBy,
        archiveReason: archived.archiveReason,
      },
      message: "Department archived successfully",
    });
  } catch (err) {
    next(err);
  }
};

export const getDepartmentTransferPreviewService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    ensurePermission(
      req.bodyData || req.user,
      PERMISSION_KEYS.VIEW_USERS,
      "You do not have permission to view employees"
    );

    const department = await findDepartmentForMutation(req, req.params.id);
    const preview = await getDepartmentTransferPreview(department);

    return res.status(200).send({
      status: "success",
      data: preview,
      message: "Department transfer preview retrieved successfully",
    });
  } catch (err) {
    next(err);
  }
};

export const transferDepartmentEmployeesService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    ensurePermission(
      req.bodyData || req.user,
      PERMISSION_KEYS.EDIT_USERS,
      "You do not have permission to transfer employees"
    );

    const department = await findDepartmentForMutation(req, req.params.id);
    const reason = normalizeText(req.body?.reason);
    const defaultTargetDepartmentId = normalizeText(
      req.body?.targetDepartmentId
    );
    const teamMappings = Array.isArray(req.body?.teamMappings)
      ? req.body.teamMappings
      : [];
    const employeeOverrides = Array.isArray(req.body?.employeeOverrides)
      ? req.body.employeeOverrides
      : [];

    if (reason.length < 3) {
      throw generateError("Transfer reason must be at least 3 characters", 422);
    }

    if (
      !defaultTargetDepartmentId ||
      !mongoose.Types.ObjectId.isValid(defaultTargetDepartmentId) ||
      defaultTargetDepartmentId === String(department._id)
    ) {
      throw generateError("Select a valid destination department", 400);
    }

    const exactDepartmentName = new RegExp(
      `^${escapeRegex(normalizeText(department.departmentName))}$`,
      "i"
    );
    const employees = await User.find({
      company: department.company,
      department: exactDepartmentName,
      deletedAt: null,
    });

    if (employees.length === 0) {
      throw generateError("This department has no employees to transfer", 400);
    }

    const employeeById = new Map(
      employees.map((employee: any) => [String(employee._id), employee])
    );
    const overrideByEmployeeId = new Map<string, any>();
    const requestedDepartmentIds = new Set<string>([
      defaultTargetDepartmentId,
    ]);

    for (const override of employeeOverrides) {
      const employeeId = normalizeText(override?.employeeId);
      if (!employeeById.has(employeeId)) {
        throw generateError(
          "One or more employee overrides are outside this department",
          400
        );
      }

      const targetDepartmentId = normalizeText(
        override?.targetDepartmentId || defaultTargetDepartmentId
      );
      if (
        !mongoose.Types.ObjectId.isValid(targetDepartmentId) ||
        targetDepartmentId === String(department._id)
      ) {
        throw generateError(
          "One or more employee destination departments are invalid",
          400
        );
      }

      requestedDepartmentIds.add(targetDepartmentId);
      overrideByEmployeeId.set(employeeId, {
        ...override,
        targetDepartmentId,
      });
    }

    const targetDepartments = await Department.find({
      _id: {
        $in: Array.from(requestedDepartmentIds).map(
          (id) => new mongoose.Types.ObjectId(id)
        ),
      },
      company: department.company,
      deletedAt: null,
    });

    if (targetDepartments.length !== requestedDepartmentIds.size) {
      throw generateError(
        "One or more destination departments are unavailable",
        400
      );
    }

    const targetDepartmentById = new Map(
      targetDepartments.map((target: any) => [String(target._id), target])
    );
    const sourceTeams = getDepartmentTeams(department);
    const sourceTeamByName = new Map<string, any>(
      sourceTeams.map((team: any) => [
        normalizeText(team?.name).toLowerCase(),
        team,
      ])
    );
    const mappingBySourceTeamId = new Map<string, any>();
    const mappingBySourceTeamName = new Map<string, any>();

    teamMappings.forEach((mapping: any) => {
      const sourceTeamId = normalizeText(mapping?.sourceTeamId);
      const sourceTeamName = normalizeText(mapping?.sourceTeamName).toLowerCase();
      if (sourceTeamId) mappingBySourceTeamId.set(sourceTeamId, mapping);
      if (sourceTeamName) mappingBySourceTeamName.set(sourceTeamName, mapping);
    });

    const resolveTargetTeam = ({
      targetDepartment,
      targetTeamId,
    }: {
      targetDepartment: any;
      targetTeamId: string;
    }) => {
      if (!targetTeamId) return null;
      const team = getDepartmentTeams(targetDepartment).find(
        (candidate: any) =>
          String(candidate?._id || "") === targetTeamId &&
          candidate?.isActive !== false
      );
      if (!team) {
        throw generateError(
          `Select a valid team in ${targetDepartment.departmentName}`,
          400
        );
      }
      return team;
    };

    const officeLocationIds = employees
      .map((employee: any) => normalizeText(employee.officeLocation))
      .filter((id: string) => mongoose.Types.ObjectId.isValid(id));
    const managerIds = employees
      .map((employee: any) => normalizeText(employee.reportingManager))
      .filter((id: string) => mongoose.Types.ObjectId.isValid(id));

    const [officeLocations, reportingManagers] = await Promise.all([
      OfficeLocation.find({ _id: { $in: officeLocationIds } })
        .select("name code")
        .lean(),
      User.find({ _id: { $in: managerIds } })
        .select("name email username")
        .lean(),
    ]);

    const officeLocationById = new Map(
      officeLocations.map((location: any) => [String(location._id), location])
    );
    const reportingManagerById = new Map(
      reportingManagers.map((manager: any) => [String(manager._id), manager])
    );
    const otherDepartmentHeadCount = department.departmentHead
      ? await Department.countDocuments({
          _id: { $ne: department._id },
          company: department.company,
          departmentHead: department.departmentHead,
          deletedAt: null,
        })
      : 0;
    const plans: any[] = [];

    for (const employee of employees) {
      const employeeId = String(employee._id);
      const override = overrideByEmployeeId.get(employeeId);
      const targetDepartmentId =
        override?.targetDepartmentId || defaultTargetDepartmentId;
      const targetDepartment = targetDepartmentById.get(targetDepartmentId);

      if (!targetDepartment) {
        throw generateError("Destination department not found", 400);
      }

      const sourceTeam = sourceTeamByName.get(
        normalizeText(employee.team).toLowerCase()
      );
      const mapping =
        (sourceTeam &&
          mappingBySourceTeamId.get(String(sourceTeam?._id || ""))) ||
        mappingBySourceTeamName.get(
          normalizeText(employee.team).toLowerCase()
        );
      const hasOverrideTeam = override &&
        Object.prototype.hasOwnProperty.call(override, "targetTeamId");
      const targetTeamId = normalizeText(
        hasOverrideTeam ? override?.targetTeamId : mapping?.targetTeamId
      );
      const targetTeam = resolveTargetTeam({
        targetDepartment,
        targetTeamId,
      });
      const previousUser = employee.toObject({ depopulate: true });
      const isSourceDepartmentHead =
        String(department.departmentHead || "") === employeeId;
      const nextRole =
        isSourceDepartmentHead &&
        otherDepartmentHeadCount === 0 &&
        normalizeRole(employee.role || employee.userType) === "departmenthead"
          ? "user"
          : normalizeRole(employee.role || employee.userType);
      const nextUser = {
        ...previousUser,
        department: normalizeText(targetDepartment.departmentName),
        team: normalizeText(targetTeam?.name),
        role: nextRole,
        userType: nextRole,
      };
      const snapshotContext = {
        officeLocation:
          officeLocationById.get(normalizeText(employee.officeLocation)) || null,
        reportingManager:
          reportingManagerById.get(normalizeText(employee.reportingManager)) ||
          null,
      };
      const previousSnapshot = await buildEmployeeAssignmentSnapshot(
        previousUser,
        {
          context: {
            department,
            team: sourceTeam || null,
            ...snapshotContext,
          },
        }
      );
      const nextSnapshot = await buildEmployeeAssignmentSnapshot(nextUser, {
        context: {
          department: targetDepartment,
          team: targetTeam,
          ...snapshotContext,
        },
      });

      plans.push({
        employee,
        nextRole,
        targetDepartment,
        targetTeam,
        previousSnapshot,
        nextSnapshot,
      });
    }

    const effectiveAt = new Date();
    const changeBatchId = new mongoose.Types.ObjectId().toString();
    const requesterId = getRequesterId(req);

    await mongoose.connection.transaction(async (session) => {
      for (const plan of plans) {
        await ensureCurrentEmployeeAssignment({
          user: plan.employee,
          changedBy: requesterId,
          source: "department_closure_backfill",
          session,
        });

        plan.employee.department = normalizeText(
          plan.targetDepartment.departmentName
        );
        plan.employee.team = normalizeText(plan.targetTeam?.name);
        plan.employee.role = plan.nextRole;
        plan.employee.userType = plan.nextRole;
        plan.employee.updatedAt = effectiveAt;
        await plan.employee.save({ session });

        await recordEmployeeAssignmentChange({
          user: plan.employee,
          previousSnapshot: plan.previousSnapshot,
          nextSnapshot: plan.nextSnapshot,
          changedBy: requesterId,
          changeReason: reason,
          changeType: "department_transfer",
          changeBatchId,
          source: "department_closure",
          effectiveAt,
          session,
        });
      }

      if (department.departmentHead) {
        department.departmentHead = undefined;
        await department.save({ session });
      }
    });

    const refreshedDepartment = await Department.findById(
      department._id
    ).populate(
      "departmentHead",
      "name email username role userType department"
    );
    const impact = await getDepartmentArchiveImpact(refreshedDepartment);

    return res.status(200).send({
      status: "success",
      data: {
        changeBatchId,
        transferredEmployees: plans.length,
        impact,
      },
      message: `${plans.length} employees transferred successfully`,
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

    const previousDepartmentHeadId = normalizeText(
      department.departmentHead
    );
    const requesterId = getRequesterId(req);

    if (!departmentHeadId) {
      await mongoose.connection.transaction(async (session) => {
        if (previousDepartmentHeadId) {
          const previousHead = await User.findById(
            previousDepartmentHeadId
          ).session(session);

          if (previousHead) {
            const previousUser = previousHead.toObject({ depopulate: true });
            const otherHeadAssignments = await Department.countDocuments({
              _id: { $ne: department._id },
              company: department.company,
              departmentHead: previousHead._id,
              deletedAt: null,
            }).session(session);

            if (
              otherHeadAssignments === 0 &&
              normalizeRole(previousHead.role || previousHead.userType) ===
                "departmenthead"
            ) {
              previousHead.role = "user";
              previousHead.userType = "user";
              previousHead.updatedAt = new Date();
              await previousHead.save({ session });
              await recordEmployeeAssignmentChange({
                user: previousHead,
                previousUser,
                changedBy: requesterId,
                changeType: "department_head_removed",
                changeReason:
                  normalizeText(req.body?.reason) ||
                  `Removed as head of ${department.departmentName}`,
                source: "department_head_assignment",
                session,
              });
            }
          }
        }

        department.departmentHead = undefined;
        await department.save({ session });
      });
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

    const selectedUserBefore = user.toObject({ depopulate: true });
    await mongoose.connection.transaction(async (session) => {
      if (
        previousDepartmentHeadId &&
        previousDepartmentHeadId !== String(user._id)
      ) {
        const previousHead = await User.findById(
          previousDepartmentHeadId
        ).session(session);

        if (previousHead) {
          const previousUser = previousHead.toObject({ depopulate: true });
          const otherHeadAssignments = await Department.countDocuments({
            _id: { $ne: department._id },
            company: department.company,
            departmentHead: previousHead._id,
            deletedAt: null,
          }).session(session);

          if (
            otherHeadAssignments === 0 &&
            normalizeRole(previousHead.role || previousHead.userType) ===
              "departmenthead"
          ) {
            previousHead.role = "user";
            previousHead.userType = "user";
            previousHead.updatedAt = new Date();
            await previousHead.save({ session });
            await recordEmployeeAssignmentChange({
              user: previousHead,
              previousUser,
              changedBy: requesterId,
              changeType: "department_head_replaced",
              changeReason:
                normalizeText(req.body?.reason) ||
                `Replaced as head of ${department.departmentName}`,
              source: "department_head_assignment",
              session,
            });
          }
        }
      }

      user.department = normalizeText(department.departmentName);
      user.role = "departmenthead";
      user.userType = "departmenthead";
      user.updatedAt = new Date();
      await user.save({ session });
      await recordEmployeeAssignmentChange({
        user,
        previousUser: selectedUserBefore,
        changedBy: requesterId,
        changeType: "department_head_assigned",
        changeReason:
          normalizeText(req.body?.reason) ||
          `Assigned as head of ${department.departmentName}`,
        source: "department_head_assignment",
        session,
      });

      department.departmentHead = user._id;
      await department.save({ session });
    });

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

// ================= ADD TEAM =================
export const addDepartmentTeamService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    const { id } = req.params;
    const name = normalizeText(req.body?.name || req.body?.teamName);
    const code = normalizeText(req.body?.code);
    const description = normalizeText(req.body?.description);

    if (!name) {
      throw generateError("Team name is required", 400);
    }

    const department = await findDepartmentForMutation(req, id);
    if (findDuplicateTeam(department, name)) {
      throw generateError("Team already exists in this department", 400);
    }

    (department as any).teams = [
      ...getDepartmentTeams(department),
      {
        name,
        code,
        description,
        isActive: req.body?.isActive !== false,
        createdAt: new Date(),
      },
    ];
    await department.save();

    const updated = await getPopulatedDepartment(id);

    return res.status(201).send({
      status: "success",
      data: (await enrichDepartmentsWithStats(String(department.company), [updated]))[0],
      message: "Team added successfully",
    });
  } catch (err) {
    next(err);
  }
};

// ================= UPDATE TEAM =================
export const updateDepartmentTeamService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    const { id, teamId } = req.params;
    const department = await findDepartmentForMutation(req, id);
    const team = findTeamById(department, teamId);

    if (!team) {
      throw generateError("Team not found", 404);
    }

    const oldName = normalizeText(team.name);
    const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, "name") ||
      Object.prototype.hasOwnProperty.call(req.body || {}, "teamName");
    const nextName = hasName ? normalizeText(req.body?.name || req.body?.teamName) : oldName;

    if (!nextName) {
      throw generateError("Team name is required", 400);
    }

    if (
      nextName.toLowerCase() !== oldName.toLowerCase() &&
      findDuplicateTeam(department, nextName, teamId)
    ) {
      throw generateError("Team already exists in this department", 400);
    }

    team.name = nextName;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "code")) {
      team.code = normalizeText(req.body?.code);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "description")) {
      team.description = normalizeText(req.body?.description);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "isActive")) {
      team.isActive = req.body?.isActive !== false;
    }
    team.updatedAt = new Date();

    await department.save();

    if (oldName && nextName && oldName !== nextName) {
      await User.updateMany(
        {
          company: department.company,
          department: String(department.departmentName || ""),
          team: oldName,
          deletedAt: { $exists: false },
        },
        {
          team: nextName,
          updatedAt: new Date(),
        }
      );
    }

    const updated = await getPopulatedDepartment(id);

    return res.status(200).send({
      status: "success",
      data: (await enrichDepartmentsWithStats(String(department.company), [updated]))[0],
      message: "Team updated successfully",
    });
  } catch (err) {
    next(err);
  }
};

// ================= DELETE TEAM =================
export const deleteDepartmentTeamService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureDepartmentMutationAllowed(req);
    const { id, teamId } = req.params;
    const department = await findDepartmentForMutation(req, id);
    const team = findTeamById(department, teamId);

    if (!team) {
      throw generateError("Team not found", 404);
    }

    const assignedUsers = await User.countDocuments({
      company: department.company,
      department: String(department.departmentName || ""),
      team: normalizeText(team.name),
      deletedAt: { $exists: false },
    });

    if (assignedUsers > 0) {
      throw generateError("This team has assigned employees. Move employees before deleting it.", 400);
    }

    (department as any).teams = getDepartmentTeams(department).filter(
      (item: any) => String(item?._id || "") !== String(teamId)
    );
    await department.save();

    const updated = await getPopulatedDepartment(id);

    return res.status(200).send({
      status: "success",
      data: (await enrichDepartmentsWithStats(String(department.company), [updated]))[0],
      message: "Team deleted successfully",
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

    ensurePermission(
      req.bodyData || req.user,
      PERMISSION_KEYS.VIEW_DEPARTMENTS,
      "You do not have permission to view departments"
    );

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
          { departmentName: { $regex: `^${escapeRegex(actorDepartment)}$`, $options: "i" } },
          { code: { $regex: `^${escapeRegex(actorDepartment)}$`, $options: "i" } },
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

    if (role === "hr") {
      const scopedDepartments = getHrScopeDepartments(req);

      if (scopedDepartments.length === 0) {
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

      const scopedDepartmentRegexes = scopedDepartments.map(
        (department) => new RegExp(`^${escapeRegex(department)}$`, "i")
      );
      const match = {
        company,
        deletedAt: null,
        departmentName: { $in: scopedDepartmentRegexes },
      };
      const [data, total] = await Promise.all([
        Department.find(match)
          .populate("departmentHead", "name email username role userType department")
          .skip((page - 1) * limit)
          .limit(limit)
          .sort({ createdAt: -1 }),
        Department.countDocuments(match),
      ]);
      const enrichedData = await enrichDepartmentsWithStats(company, data);

      return res.status(200).send({
        status: "success",
        data: enrichedData,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
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
