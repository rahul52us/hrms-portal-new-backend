import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import Company from "../../schemas/company/Company";
import Department from "../../schemas/Department/Department.schema";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import User from "../../schemas/User/User";
import { generateError } from "../../config/Error/functions";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import {
  getUserAccountStatus,
  isUserAccountActive,
} from "../auth/utils/userAccountStatus";

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function normalizeRole(value: unknown) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead")
    .replace(/^head[-\s]?hr$/i, "hradmin")
    .replace(/^hr[-\s]?admin$/i, "hradmin")
    .replace(/^hr[-\s]?executive$/i, "hr");
}

function normalizeObjectId(value: any) {
  return normalizeText(value?._id || value);
}

function normalizeStringList(value: any) {
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
}

function normalizeObjectIdList(value: any) {
  const source = Array.isArray(value)
    ? value
    : value
      ? [value]
      : [];
  const seen = new Set<string>();
  const output: string[] = [];

  source.forEach((item: any) => {
    const normalized = normalizeObjectId(item);
    if (!normalized || seen.has(normalized) || !mongoose.Types.ObjectId.isValid(normalized)) {
      return;
    }

    seen.add(normalized);
    output.push(normalized);
  });

  return output;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactRegex(value: string) {
  return new RegExp(`^${escapeRegex(value)}$`, "i");
}

function getHrScope(actor: any) {
  const scope = actor?.hrScope || {};
  return {
    departments: normalizeStringList(scope.departments || scope.departmentNames),
    teams: normalizeStringList(scope.teams || scope.teamNames),
    officeLocationIds: normalizeObjectIdList(
      scope.officeLocationIds || scope.officeLocations || scope.locationIds || scope.locations
    ),
  };
}

function getUserRole(user: any) {
  return normalizeRole(user?.role || user?.userType || "user") || "user";
}

function isManagerRole(role: string) {
  return role === "manager" || /^l\d+[-\s]?manager$/i.test(role);
}

function isWorkforceRole(role: string) {
  return role === "user" || role === "departmenthead" || isManagerRole(role);
}

function isAccountActive(user: any) {
  return isUserAccountActive(user);
}

function getStatus(user: any) {
  return getUserAccountStatus(user).toLowerCase();
}

function getMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { now, start, end };
}

function isDateInCurrentMonth(value: any) {
  if (!value) {
    return false;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const { now } = getMonthRange();
  return date.getMonth() === now.getMonth();
}

function isDateInCurrentMonthAndYear(value: any) {
  if (!value) {
    return false;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const { now } = getMonthRange();
  return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
}

function buildBreakdown(users: any[], keyGetter: (user: any) => string) {
  const map = new Map<string, number>();
  users.forEach((user) => {
    const key = normalizeText(keyGetter(user)) || "Unassigned";
    map.set(key, (map.get(key) || 0) + 1);
  });

  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
}

function serializeUserLite(user: any) {
  const role = getUserRole(user);
  const location = user?.officeLocation && typeof user.officeLocation === "object"
    ? user.officeLocation
    : null;

  return {
    _id: user?._id,
    name: user?.name || "",
    email: user?.email || user?.username || "",
    role,
    department: user?.department || "",
    team: user?.team || "",
    designation: user?.designation || "",
    officeLocationName: location?.name || "",
    status: getStatus(user),
    pic: user?.pic || null,
    createdAt: user?.createdAt || null,
    joiningDate: user?.joiningDate || null,
    dateOfBirth: user?.dateOfBirth || null,
  };
}

async function resolveCompany(actor: any, query: any) {
  const role = normalizeRole(actor?.role || actor?.userType);
  const requestedCompanyId = normalizeText(query?.companyId || query?.company);
  const companyId = role === "superadmin"
    ? requestedCompanyId
    : normalizeObjectId(actor?.company || actor?.companyId);

  if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
    throw generateError("Company context is required for HR dashboard", 422);
  }

  const company = await Company.findOne({
    _id: new mongoose.Types.ObjectId(companyId),
    deletedAt: { $exists: false },
    type: { $ne: "user" },
  })
    .select("_id company_name departments managerLevels")
    .lean();

  if (!company) {
    throw generateError("Company not found", 404);
  }

  return { company, companyId };
}

function buildVisibleUserMatch(actor: any, companyId: string) {
  const role = normalizeRole(actor?.role || actor?.userType);
  const matchClauses: any[] = [
    {
      company: new mongoose.Types.ObjectId(companyId),
      deletedAt: { $exists: false },
    },
  ];

  if (role === "hr") {
    const scope = getHrScope(actor);
    if (scope.departments.length === 0) {
      throw generateError("HR department scope is not configured", 403);
    }

    matchClauses.push({ role: { $nin: ["admin", "superadmin", "departmenthead", "hradmin", "hr"] } });
    matchClauses.push({ department: { $in: scope.departments.map(exactRegex) } });

    if (scope.teams.length > 0) {
      matchClauses.push({ team: { $in: scope.teams.map(exactRegex) } });
    }

    if (scope.officeLocationIds.length > 0) {
      matchClauses.push({
        officeLocation: {
          $in: scope.officeLocationIds.map((locationId) => new mongoose.Types.ObjectId(locationId)),
        },
      });
    }
  } else if (role === "admin" || role === "hradmin") {
    matchClauses.push({ role: { $nin: ["admin", "superadmin"] } });
  } else if (role === "superadmin") {
    matchClauses.push({ role: { $ne: "superadmin" } });
  } else {
    throw generateError("Only admin, HR Admin, scoped HR, or superadmin can view HR dashboard", 403);
  }

  return matchClauses.length === 1 ? matchClauses[0] : { $and: matchClauses };
}

async function buildScopePanel(actor: any, company: any, companyId: string) {
  const role = normalizeRole(actor?.role || actor?.userType);
  const scope = getHrScope(actor);
  const locationDocs = scope.officeLocationIds.length
    ? await OfficeLocation.find({
        _id: { $in: scope.officeLocationIds.map((id) => new mongoose.Types.ObjectId(id)) },
        company: new mongoose.Types.ObjectId(companyId),
        deletedAt: null,
      })
        .select("_id name code city state")
        .lean()
    : [];

  return {
    role,
    mode: role === "hr" ? "scoped" : "company",
    companyId,
    companyName: company?.company_name || "",
    departments: role === "hr" ? scope.departments : [],
    teams: role === "hr" ? scope.teams : [],
    officeLocations: locationDocs.map((location: any) => ({
      _id: location._id,
      name: location.name || "",
      code: location.code || "",
      city: location.city || "",
      state: location.state || "",
    })),
  };
}

export const getHrDashboardSummaryService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const actor = req.bodyData || req.user;
    const actorRole = normalizeRole(actor?.role || actor?.userType);

    ensurePermission(actor, PERMISSION_KEYS.VIEW_DASHBOARD, "You do not have permission to view HR dashboard");

    if (!["superadmin", "admin", "hradmin", "hr"].includes(actorRole)) {
      throw generateError("Only admin, HR Admin, or scoped HR can view HR dashboard", 403);
    }

    const { company, companyId } = await resolveCompany(actor, req.query);
    const visibleMatch = buildVisibleUserMatch(actor, companyId);

    const [visibleUsers, departments, allLocations, scopedLocations] = await Promise.all([
      User.find(visibleMatch)
        .select("name email username role userType department team officeLocation designation joiningDate dateOfBirth reportingManager is_enabled password setupToken createdAt pic")
        .populate("officeLocation", "name code city state")
        .sort({ createdAt: -1 })
        .lean(),
      Department.find({
        company: new mongoose.Types.ObjectId(companyId),
        deletedAt: null,
      })
        .select("departmentName teams")
        .lean(),
      OfficeLocation.find({
        company: new mongoose.Types.ObjectId(companyId),
        deletedAt: null,
      })
        .select("_id name code city state")
        .lean(),
      buildScopePanel(actor, company, companyId),
    ]);

    const hrScope = getHrScope(actor);
    const visibleDepartments = actorRole === "hr"
      ? departments.filter((department: any) =>
          hrScope.departments.some(
            (departmentName) =>
              departmentName.toLowerCase() === normalizeText(department.departmentName).toLowerCase()
          )
        )
      : departments;
    const workforceUsers = visibleUsers.filter((user) => isWorkforceRole(getUserRole(user)));
    const reportingManagerIds = new Set(
      workforceUsers
        .map((user: any) => normalizeObjectId(user?.reportingManager))
        .filter(Boolean)
    );
    const managerUsers = visibleUsers.filter((user) =>
      reportingManagerIds.has(normalizeObjectId(user?._id)) || isManagerRole(getUserRole(user))
    );
    const departmentHeadUsers = visibleUsers.filter((user) => getUserRole(user) === "departmenthead");
    const hrAdminUsers = visibleUsers.filter((user) => getUserRole(user) === "hradmin");
    const scopedHrUsers = visibleUsers.filter((user) => getUserRole(user) === "hr");
    const activeUsers = workforceUsers.filter((user) => getStatus(user) === "active");
    const inactiveUsers = workforceUsers.filter((user) => getStatus(user) === "inactive");
    const pendingUsers = workforceUsers.filter((user) => getStatus(user) === "pending");
    const pendingSetupUsers = workforceUsers.filter((user: any) => !user?.password || user?.setupToken);
    const missingDepartmentUsers = workforceUsers.filter((user) => !normalizeText(user?.department));
    const missingManagerUsers = workforceUsers.filter((user) => {
      if (getUserRole(user) === "departmenthead") {
        return false;
      }

      return !normalizeObjectId(user?.reportingManager);
    });
    const missingLocationUsers = workforceUsers.filter((user) => !user?.officeLocation);
    const incompleteProfileUsers = workforceUsers.filter(
      (user) =>
        !normalizeText(user?.designation) ||
        !user?.joiningDate ||
        !normalizeText(user?.department) ||
        !user?.officeLocation
    );

    const teamCount = visibleDepartments.reduce((count, department: any) => {
      const teams = Array.isArray(department?.teams) ? department.teams : [];
      return count + teams.filter((team: any) => team?.isActive !== false).length;
    }, 0);

    const birthdaysThisMonth = workforceUsers
      .filter((user) => isDateInCurrentMonth(user?.dateOfBirth))
      .slice(0, 8)
      .map(serializeUserLite);
    const workAnniversaries = workforceUsers
      .filter((user) => {
        if (!isDateInCurrentMonth(user?.joiningDate)) {
          return false;
        }

        const joiningDate = new Date(String(user?.joiningDate));
        return !Number.isNaN(joiningDate.getTime()) && joiningDate.getFullYear() < new Date().getFullYear();
      })
      .slice(0, 8)
      .map(serializeUserLite);
    const newJoinersThisMonth = workforceUsers
      .filter((user) => isDateInCurrentMonthAndYear(user?.joiningDate))
      .slice(0, 8)
      .map(serializeUserLite);

    return res.status(200).json({
      success: true,
      data: {
        scope: {
          ...scopedLocations,
          availableDepartments: visibleDepartments.map((department: any) => department.departmentName).filter(Boolean),
          availableLocations: (actorRole === "hr" && hrScope.officeLocationIds.length
            ? allLocations.filter((location: any) => hrScope.officeLocationIds.includes(String(location._id || "")))
            : allLocations
          ).map((location: any) => ({
            _id: location._id,
            name: location.name || "",
            code: location.code || "",
            city: location.city || "",
            state: location.state || "",
          })),
        },
        summary: {
          totalEmployees: workforceUsers.length,
          activeEmployees: activeUsers.length,
          inactiveEmployees: inactiveUsers.length,
          pendingEmployees: pendingUsers.length,
          pendingSetup: pendingSetupUsers.length,
          managers: managerUsers.length,
          departmentHeads: departmentHeadUsers.length,
          hrAdmins: hrAdminUsers.length,
          scopedHrs: scopedHrUsers.length,
          departments: visibleDepartments.length,
          teams: teamCount,
          locations: actorRole === "hr" && hrScope.officeLocationIds.length
            ? hrScope.officeLocationIds.length
            : allLocations.length,
          missingDepartment: missingDepartmentUsers.length,
          missingManager: missingManagerUsers.length,
          missingOfficeLocation: missingLocationUsers.length,
          incompleteProfiles: incompleteProfileUsers.length,
          newJoinersThisMonth: newJoinersThisMonth.length,
          birthdaysThisMonth: birthdaysThisMonth.length,
          workAnniversariesThisMonth: workAnniversaries.length,
        },
        pendingWork: [
          {
            key: "missing_department",
            label: "Employees without department",
            count: missingDepartmentUsers.length,
            href: "/dashboard/users?issue=missing_department",
          },
          {
            key: "missing_manager",
            label: "Employees without manager hierarchy",
            count: missingManagerUsers.length,
            href: "/dashboard/users?issue=missing_manager",
          },
          {
            key: "missing_location",
            label: "Employees without office location",
            count: missingLocationUsers.length,
            href: "/dashboard/users?issue=missing_location",
          },
          {
            key: "pending_setup",
            label: "Password setup pending",
            count: pendingSetupUsers.length,
            href: "/dashboard/users?issue=pending_setup",
          },
          {
            key: "incomplete_profiles",
            label: "Incomplete employee profiles",
            count: incompleteProfileUsers.length,
            href: "/dashboard/users?issue=incomplete_profiles",
          },
        ],
        breakdowns: {
          departments: buildBreakdown(workforceUsers, (user) => user.department),
          teams: buildBreakdown(workforceUsers, (user) => user.team),
          locations: buildBreakdown(workforceUsers, (user) => {
            const location = user?.officeLocation && typeof user.officeLocation === "object"
              ? user.officeLocation
              : null;
            return location?.name || "Unassigned";
          }),
          managerLevels: buildBreakdown(managerUsers, (user) =>
            isManagerRole(getUserRole(user)) ? getUserRole(user).replace("-", " ") : "Direct manager"
          ),
          statuses: buildBreakdown(workforceUsers, getStatus),
        },
        recentEmployees: workforceUsers.slice(0, 8).map(serializeUserLite),
        upcoming: {
          newJoiners: newJoinersThisMonth,
          birthdays: birthdaysThisMonth,
          anniversaries: workAnniversaries,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};
