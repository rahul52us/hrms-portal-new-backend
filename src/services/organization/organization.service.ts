import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import "../../schemas/OfficeLocation/OfficeLocation.schema";
import { generateError } from "../../config/Error/functions";
import {
  ensurePermission,
  PERMISSION_KEYS,
  resolvePermissionCompany,
} from "../permissions/permission.utils";

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function normalizeRole(value: unknown) {
  const role = normalizeText(value)
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead")
    .replace(/^head[-\s]?hr$/i, "hradmin")
    .replace(/^hr[-\s]?admin$/i, "hradmin")
    .replace(/^hr[-\s]?executive$/i, "hr");

  if (role === "employee" || role === "learner" || /^l\d+[-\s]?manager$/i.test(role)) {
    return "user";
  }

  return role || "user";
}

function normalizeObjectId(value: any) {
  const normalized = normalizeText(value?._id || value);
  return mongoose.Types.ObjectId.isValid(normalized) ? normalized : "";
}

function normalizeStringList(value: any) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();

  return source.reduce<string[]>((output, item) => {
    const normalized = normalizeText(item);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      return output;
    }

    seen.add(key);
    output.push(normalized);
    return output;
  }, []);
}

function normalizeObjectIdList(value: any) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();

  return source.reduce<string[]>((output, item) => {
    const normalized = normalizeObjectId(item);
    if (!normalized || seen.has(normalized)) {
      return output;
    }

    seen.add(normalized);
    output.push(normalized);
    return output;
  }, []);
}

function getHrScope(actor: any) {
  const scope = actor?.hrScope || {};
  return {
    departments: normalizeStringList(scope.departments || scope.departmentNames),
    teams: normalizeStringList(scope.teams || scope.teamNames),
    officeLocationIds: normalizeObjectIdList(
      scope.officeLocationIds ||
        scope.officeLocations ||
        scope.locationIds ||
        scope.locations
    ),
  };
}

function exactListIncludes(values: string[], value: unknown) {
  const normalized = normalizeText(value).toLowerCase();
  return Boolean(normalized) && values.some((item) => item.toLowerCase() === normalized);
}

function getDirectManagerId(user: any) {
  return normalizeObjectId(user?.reportingManager);
}

function isWorkforceAccount(user: any) {
  const role = normalizeRole(user?.role || user?.userType);
  return role !== "superadmin" && role !== "admin";
}

function isPrimaryVisibleUser(user: any, actor: any) {
  const actorRole = normalizeRole(actor?.role || actor?.userType);

  if (["superadmin", "admin", "hradmin"].includes(actorRole)) {
    return true;
  }

  if (actorRole === "departmenthead") {
    const department = normalizeText(actor?.department);
    if (!department) {
      throw generateError("Department head is missing department access", 403);
    }

    return exactListIncludes([department], user?.department);
  }

  if (actorRole === "hr") {
    const scope = getHrScope(actor);
    if (scope.departments.length === 0) {
      throw generateError("HR department scope is not configured", 403);
    }

    if (!exactListIncludes(scope.departments, user?.department)) {
      return false;
    }

    if (scope.teams.length > 0 && !exactListIncludes(scope.teams, user?.team)) {
      return false;
    }

    if (
      scope.officeLocationIds.length > 0 &&
      !scope.officeLocationIds.includes(normalizeObjectId(user?.officeLocation))
    ) {
      return false;
    }

    return true;
  }

  throw generateError("Only company administrators, HR, or department heads can view organization data", 403);
}

function getAccountStatus(user: any) {
  if (user?.is_enabled === false) {
    return "inactive";
  }

  return user?.is_active === true ? "active" : "pending";
}

function serializeLocation(location: any) {
  if (!location || typeof location !== "object") {
    return null;
  }

  return {
    _id: normalizeObjectId(location),
    name: normalizeText(location?.name),
    code: normalizeText(location?.code),
    city: normalizeText(location?.city),
    state: normalizeText(location?.state),
  };
}

function serializePersonReference(user: any, includeContact = true) {
  if (!user) {
    return null;
  }

  return {
    _id: normalizeObjectId(user),
    name: normalizeText(user?.name),
    email: includeContact ? normalizeText(user?.email || user?.username) : "",
    role: normalizeRole(user?.role || user?.userType),
    designation: normalizeText(user?.designation),
    department: normalizeText(user?.department),
  };
}

function resolveScope(actor: any) {
  const role = normalizeRole(actor?.role || actor?.userType);
  const hrScope = getHrScope(actor);

  if (role === "hr") {
    return {
      mode: "hr-scope",
      role,
      departments: hrScope.departments,
      teams: hrScope.teams,
      officeLocationIds: hrScope.officeLocationIds,
    };
  }

  if (role === "departmenthead") {
    return {
      mode: "department",
      role,
      departments: normalizeText(actor?.department) ? [normalizeText(actor.department)] : [],
      teams: [],
      officeLocationIds: [],
    };
  }

  return {
    mode: "company",
    role,
    departments: [],
    teams: [],
    officeLocationIds: [],
  };
}

function buildOrganizationData(users: any[], actor: any) {
  const workforceUsers = users.filter(isWorkforceAccount);
  const userById = new Map(
    workforceUsers
      .map((user) => [normalizeObjectId(user), user] as const)
      .filter(([id]) => Boolean(id))
  );
  const primaryUsers = workforceUsers.filter((user) => isPrimaryVisibleUser(user, actor));
  const primaryIds = new Set(primaryUsers.map((user) => normalizeObjectId(user)).filter(Boolean));
  const includedIds = new Set(primaryIds);

  primaryUsers.forEach((user) => {
    const visited = new Set<string>();
    let managerId = getDirectManagerId(user);

    while (managerId && !visited.has(managerId)) {
      visited.add(managerId);
      const manager = userById.get(managerId);
      if (!manager) {
        break;
      }

      includedIds.add(managerId);
      managerId = getDirectManagerId(manager);
    }
  });

  const includedUsers = Array.from(includedIds)
    .map((id) => userById.get(id))
    .filter(Boolean);
  const includedUserById = new Map(
    includedUsers.map((user) => [normalizeObjectId(user), user] as const)
  );
  const directReportIdsByManager = new Map<string, string[]>();

  includedUsers.forEach((user) => {
    const userId = normalizeObjectId(user);
    const managerId = getDirectManagerId(user);
    if (!userId || !managerId || !includedIds.has(managerId) || managerId === userId) {
      return;
    }

    const reports = directReportIdsByManager.get(managerId) || [];
    reports.push(userId);
    directReportIdsByManager.set(managerId, reports);
  });

  directReportIdsByManager.forEach((ids) => {
    ids.sort((left, right) => {
      const leftUser = includedUserById.get(left);
      const rightUser = includedUserById.get(right);
      return normalizeText(leftUser?.name || leftUser?.email).localeCompare(
        normalizeText(rightUser?.name || rightUser?.email)
      );
    });
  });

  const cycleNodeIds = new Set<string>();
  const descendantCountCache = new Map<string, number>();

  const countDescendants = (userId: string, path = new Set<string>()): number => {
    if (descendantCountCache.has(userId)) {
      return descendantCountCache.get(userId) || 0;
    }

    if (path.has(userId)) {
      cycleNodeIds.add(userId);
      return 0;
    }

    const nextPath = new Set(path);
    nextPath.add(userId);
    let total = 0;

    (directReportIdsByManager.get(userId) || []).forEach((reportId) => {
      if (nextPath.has(reportId)) {
        cycleNodeIds.add(userId);
        cycleNodeIds.add(reportId);
        return;
      }

      total += 1 + countDescendants(reportId, nextPath);
    });

    descendantCountCache.set(userId, total);
    return total;
  };

  includedIds.forEach((userId) => countDescendants(userId));

  const roots = Array.from(includedIds).filter((userId) => {
    const user = includedUserById.get(userId);
    const managerId = getDirectManagerId(user);
    return !managerId || !includedIds.has(managerId) || managerId === userId;
  });
  const depthById = new Map<string, number>();
  const queue = roots.map((id) => ({ id, depth: 0 }));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || depthById.has(current.id)) {
      continue;
    }

    depthById.set(current.id, current.depth);
    (directReportIdsByManager.get(current.id) || []).forEach((reportId) => {
      queue.push({ id: reportId, depth: current.depth + 1 });
    });
  }

  Array.from(includedIds).forEach((userId) => {
    if (!depthById.has(userId)) {
      roots.push(userId);
      depthById.set(userId, 0);
      cycleNodeIds.add(userId);
    }
  });

  const uniqueRoots = Array.from(new Set(roots));
  const nodes = includedUsers
    .map((user) => {
      const userId = normalizeObjectId(user);
      const managerId = getDirectManagerId(user);
      const manager = managerId ? includedUserById.get(managerId) : null;
      const managerIsContextOnly = Boolean(managerId && !primaryIds.has(managerId));
      const directReportIds = directReportIdsByManager.get(userId) || [];
      const isContextOnly = !primaryIds.has(userId);
      const location = serializeLocation(user?.officeLocation);
      const managerChain: any[] = [];
      const visitedManagers = new Set<string>();
      let chainManagerId = managerId;

      while (chainManagerId && !visitedManagers.has(chainManagerId)) {
        visitedManagers.add(chainManagerId);
        const chainManager = includedUserById.get(chainManagerId);
        if (!chainManager) {
          break;
        }

        managerChain.push({
          ...serializePersonReference(chainManager, primaryIds.has(chainManagerId)),
          level: managerChain.length + 1,
        });
        chainManagerId = getDirectManagerId(chainManager);
      }

      return {
        _id: userId,
        code: isContextOnly ? "" : normalizeText(user?.code),
        profileId: isContextOnly ? "" : normalizeText(user?.profileId),
        name: normalizeText(user?.name || user?.email || user?.username) || "Unnamed employee",
        email: isContextOnly ? "" : normalizeText(user?.email || user?.username),
        role: normalizeRole(user?.role || user?.userType),
        designation: normalizeText(user?.designation),
        department: normalizeText(user?.department),
        team: isContextOnly ? "" : normalizeText(user?.team),
        officeLocation: isContextOnly ? null : location,
        pic: user?.pic?.url ? { url: user.pic.url } : null,
        status: getAccountStatus(user),
        isActive: user?.is_active === true,
        isEnabled: user?.is_enabled !== false,
        reportingManagerId: managerId || "",
        reportingManager: serializePersonReference(manager, !managerIsContextOnly),
        managerChain,
        directReportIds,
        directReportCount: directReportIds.length,
        totalReportCount: countDescendants(userId),
        depth: depthById.get(userId) || 0,
        isManager: directReportIds.length > 0,
        isUnassigned: !managerId || !userById.has(managerId) || managerId === userId,
        isContextOnly,
        hasHierarchyIssue:
          cycleNodeIds.has(userId) ||
          Boolean(managerId && !userById.has(managerId)) ||
          managerId === userId,
      };
    })
    .sort((left, right) => {
      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }

      return left.name.localeCompare(right.name);
    });

  const primaryNodes = nodes.filter((node) => !node.isContextOnly);
  const managers = nodes.filter((node) => node.isManager);
  const unassigned = primaryNodes.filter((node) => node.isUnassigned);
  const filterLocations = new Map<string, any>();

  primaryNodes.forEach((node) => {
    const locationId = normalizeObjectId(node.officeLocation);
    if (locationId && node.officeLocation) {
      filterLocations.set(locationId, node.officeLocation);
    }
  });

  return {
    nodes,
    roots: uniqueRoots,
    summary: {
      totalPeople: primaryNodes.length,
      managerCount: managers.length,
      unassignedCount: unassigned.length,
      contextPeopleCount: nodes.length - primaryNodes.length,
      maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
      hierarchyIssueCount: nodes.filter((node) => node.hasHierarchyIssue).length,
    },
    filters: {
      departments: Array.from(
        new Set(primaryNodes.map((node) => node.department).filter(Boolean))
      ).sort((left, right) => left.localeCompare(right)),
      teams: Array.from(
        new Set(primaryNodes.map((node) => node.team).filter(Boolean))
      ).sort((left, right) => left.localeCompare(right)),
      locations: Array.from(filterLocations.values()).sort((left, right) =>
        normalizeText(left?.name).localeCompare(normalizeText(right?.name))
      ),
    },
  };
}

export const getOrganizationHierarchyService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const actor = req.bodyData || req.user;
    ensurePermission(
      actor,
      PERMISSION_KEYS.VIEW_USERS,
      "You do not have permission to view organization data"
    );

    const actorRole = normalizeRole(actor?.role || actor?.userType);
    if (!["superadmin", "admin", "hradmin", "hr", "departmenthead"].includes(actorRole)) {
      throw generateError("This account cannot view organization data", 403);
    }

    const company = await resolvePermissionCompany({
      actor,
      requestedCompanyId: normalizeText(req.query?.companyId || req.query?.company),
    });

    if (!company) {
      throw generateError("Company context is required", 422);
    }

    if (company?.deletedAt || company?.type === "user") {
      throw generateError("Company not found", 404);
    }

    const companyId = normalizeObjectId(company);
    if (!companyId) {
      throw generateError("Invalid company context", 400);
    }

    const users = await User.find({
      company: new mongoose.Types.ObjectId(companyId),
      deletedAt: { $exists: false },
    })
      .select(
        "name email username code profileId pic role userType designation department team officeLocation " +
          "reportingManager is_active is_enabled"
      )
      .populate("officeLocation", "name code city state")
      .lean();
    const organization = buildOrganizationData(users, actor);

    return res.status(200).json({
      success: true,
      data: {
        company: {
          _id: companyId,
          name: normalizeText(company?.company_name),
        },
        scope: resolveScope(actor),
        ...organization,
      },
    });
  } catch (error) {
    next(error);
  }
};
