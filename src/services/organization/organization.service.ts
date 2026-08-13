import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import Company from "../../schemas/company/Company";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import User from "../../schemas/User/User";
import { generateError } from "../../config/Error/functions";
import {
  ensurePermission,
  PERMISSION_KEYS,
  resolvePermissionCompany,
} from "../permissions/permission.utils";
import {
  getUserAccountStatus,
  isUserAccountActive,
} from "../auth/utils/userAccountStatus";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_HIERARCHY_DEPTH = 50;
const USER_SELECT =
  "name email username code profileId pic role userType designation department team officeLocation " +
  "reportingManager is_enabled password";

type OrganizationScope = {
  mode: "company" | "hr-scope" | "department";
  role: string;
  departments: string[];
  teams: string[];
  officeLocationIds: string[];
};

type OrganizationContext = {
  actor: any;
  company: any;
  companyId: string;
  companyObjectId: mongoose.Types.ObjectId;
  scope: OrganizationScope;
  primaryMatch: any;
  includedMatch: any;
  primaryIds: Set<string> | null;
  contextIds: Set<string>;
};

type PageInfo = {
  limit: number;
  hasNextPage: boolean;
  nextCursor: string;
};

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

function getDirectManagerId(user: any) {
  return normalizeObjectId(user?.reportingManager);
}

function getAccountStatus(user: any) {
  return getUserAccountStatus(user).toLowerCase();
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

function resolveScope(actor: any): OrganizationScope {
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

function combineMatch(...matches: any[]) {
  const activeMatches = matches.filter(
    (match) => match && typeof match === "object" && Object.keys(match).length > 0
  );

  if (activeMatches.length === 0) {
    return {};
  }
  if (activeMatches.length === 1) {
    return activeMatches[0];
  }
  return { $and: activeMatches };
}

function buildWorkforceMatch(companyObjectId: mongoose.Types.ObjectId) {
  return {
    company: companyObjectId,
    deletedAt: { $exists: false },
    role: { $nin: ["admin", "superadmin"] },
    userType: { $nin: ["admin", "superadmin"] },
  };
}

function buildScopeMatch(scope: OrganizationScope) {
  if (scope.mode === "company") {
    return {};
  }

  if (scope.departments.length === 0) {
    throw generateError(
      scope.mode === "department"
        ? "Department head is missing department access"
        : "HR department scope is not configured",
      403
    );
  }

  const match: any = { department: { $in: scope.departments } };
  if (scope.teams.length > 0) {
    match.team = { $in: scope.teams };
  }
  if (scope.officeLocationIds.length > 0) {
    match.officeLocation = {
      $in: scope.officeLocationIds.map((id) => new mongoose.Types.ObjectId(id)),
    };
  }

  return match;
}

async function buildOrganizationContext(req: any): Promise<OrganizationContext> {
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

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const scope = resolveScope(actor);
  const workforceMatch = buildWorkforceMatch(companyObjectId);
  const scopeMatch = buildScopeMatch(scope);
  const primaryMatch = combineMatch(workforceMatch, scopeMatch);

  if (scope.mode === "company") {
    return {
      actor,
      company,
      companyId,
      companyObjectId,
      scope,
      primaryMatch,
      includedMatch: workforceMatch,
      primaryIds: null,
      contextIds: new Set<string>(),
    };
  }

  const primaryUsers = await User.find(primaryMatch).select("_id reportingManager").lean();
  const primaryIds = new Set(
    primaryUsers.map((user: any) => normalizeObjectId(user)).filter(Boolean)
  );
  const contextIds = new Set<string>();
  let pendingManagerIds = Array.from(
    new Set(
      primaryUsers
        .map((user: any) => getDirectManagerId(user))
        .filter((id) => id && !primaryIds.has(id))
    )
  );

  for (let depth = 0; depth < MAX_HIERARCHY_DEPTH && pendingManagerIds.length > 0; depth += 1) {
    const managers = await User.find(
      combineMatch(workforceMatch, {
        _id: { $in: pendingManagerIds.map((id) => new mongoose.Types.ObjectId(id)) },
      })
    )
      .select("_id reportingManager")
      .lean();
    const nextIds = new Set<string>();

    managers.forEach((manager: any) => {
      const managerId = normalizeObjectId(manager);
      if (!managerId || primaryIds.has(managerId) || contextIds.has(managerId)) {
        return;
      }

      contextIds.add(managerId);
      const parentId = getDirectManagerId(manager);
      if (parentId && !primaryIds.has(parentId) && !contextIds.has(parentId)) {
        nextIds.add(parentId);
      }
    });

    pendingManagerIds = Array.from(nextIds);
  }

  const includedMatch = contextIds.size
    ? combineMatch(workforceMatch, {
        $or: [
          scopeMatch,
          {
            _id: {
              $in: Array.from(contextIds).map((id) => new mongoose.Types.ObjectId(id)),
            },
          },
        ],
      })
    : primaryMatch;

  return {
    actor,
    company,
    companyId,
    companyObjectId,
    scope,
    primaryMatch,
    includedMatch,
    primaryIds,
    contextIds,
  };
}

function isContextOnly(context: OrganizationContext, userId: string) {
  return Boolean(context.primaryIds && !context.primaryIds.has(userId));
}

function getPageLimit(value: unknown) {
  const parsed = Number(value || DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), MAX_PAGE_SIZE);
}

function encodeCursor(user: any) {
  return Buffer.from(
    JSON.stringify({ name: String(user?.name || ""), id: normalizeObjectId(user) }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(value: unknown) {
  const cursor = normalizeText(value);
  if (!cursor) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!mongoose.Types.ObjectId.isValid(decoded?.id) || typeof decoded?.name !== "string") {
      throw new Error("Invalid cursor");
    }
    return { name: decoded.name, id: new mongoose.Types.ObjectId(decoded.id) };
  } catch {
    throw generateError("Invalid organization pagination cursor", 400);
  }
}

function withCursor(match: any, cursor: ReturnType<typeof decodeCursor>) {
  if (!cursor) {
    return match;
  }

  return combineMatch(match, {
    $or: [
      { name: { $gt: cursor.name } },
      { name: cursor.name, _id: { $gt: cursor.id } },
    ],
  });
}

async function fetchUserPage(options: {
  match: any;
  cursor?: unknown;
  limit?: unknown;
}) {
  const limit = getPageLimit(options.limit);
  const cursor = decodeCursor(options.cursor);
  const users = await User.find(withCursor(options.match, cursor))
    .select(USER_SELECT)
    .populate("officeLocation", "name code city state")
    .sort({ name: 1, _id: 1 })
    .limit(limit + 1)
    .lean();
  const hasNextPage = users.length > limit;
  const pageUsers = hasNextPage ? users.slice(0, limit) : users;
  const lastUser = pageUsers[pageUsers.length - 1];

  return {
    users: pageUsers,
    pageInfo: {
      limit,
      hasNextPage,
      nextCursor: hasNextPage && lastUser ? encodeCursor(lastUser) : "",
    } as PageInfo,
  };
}

async function getDirectReportCounts(context: OrganizationContext, userIds: string[]) {
  if (userIds.length === 0) {
    return new Map<string, number>();
  }

  const results = await User.aggregate([
    {
      $match: combineMatch(context.includedMatch, {
        reportingManager: {
          $in: userIds.map((id) => new mongoose.Types.ObjectId(id)),
        },
      }),
    },
    { $group: { _id: "$reportingManager", count: { $sum: 1 } } },
  ]);

  return new Map(
    results.map((entry: any) => [normalizeObjectId(entry?._id), Number(entry?.count || 0)])
  );
}

async function hydrateOrganizationNodes(users: any[], context: OrganizationContext) {
  const userIds = users.map((user) => normalizeObjectId(user)).filter(Boolean);
  const managerIds = Array.from(
    new Set(users.map((user) => getDirectManagerId(user)).filter(Boolean))
  );
  const [directReportCounts, managers] = await Promise.all([
    getDirectReportCounts(context, userIds),
    managerIds.length
      ? User.find(
          combineMatch(context.includedMatch, {
            _id: { $in: managerIds.map((id) => new mongoose.Types.ObjectId(id)) },
          })
        )
          .select("name email username role userType designation department reportingManager")
          .lean()
      : Promise.resolve([]),
  ]);
  const managerById = new Map(
    managers.map((manager: any) => [normalizeObjectId(manager), manager] as const)
  );

  return users.map((user) => {
    const userId = normalizeObjectId(user);
    const managerId = getDirectManagerId(user);
    const manager = managerId ? managerById.get(managerId) : null;
    const contextOnly = isContextOnly(context, userId);
    const directReportCount = directReportCounts.get(userId) || 0;

    return {
      _id: userId,
      code: contextOnly ? "" : normalizeText(user?.code),
      profileId: contextOnly ? "" : normalizeText(user?.profileId),
      name: normalizeText(user?.name || user?.email || user?.username) || "Unnamed employee",
      email: contextOnly ? "" : normalizeText(user?.email || user?.username),
      role: normalizeRole(user?.role || user?.userType),
      designation: normalizeText(user?.designation),
      department: normalizeText(user?.department),
      team: contextOnly ? "" : normalizeText(user?.team),
      officeLocation: contextOnly ? null : serializeLocation(user?.officeLocation),
      pic: user?.pic?.url ? { url: user.pic.url } : null,
      status: getAccountStatus(user),
      isActive: isUserAccountActive(user),
      isEnabled: user?.is_enabled !== false,
      reportingManagerId: managerId || "",
      reportingManager: serializePersonReference(
        manager,
        Boolean(managerId && !isContextOnly(context, managerId))
      ),
      managerChain: [],
      directReportIds: [],
      directReportCount,
      totalReportCount: null,
      depth: 0,
      isManager: directReportCount > 0,
      isUnassigned: !managerId || !manager,
      isContextOnly: contextOnly,
      hasHierarchyIssue: Boolean(managerId && !manager) || managerId === userId,
    };
  });
}

async function buildFilteredMatch(
  context: OrganizationContext,
  query: any,
  includeContext = false
) {
  const baseMatch = includeContext ? context.includedMatch : context.primaryMatch;
  const filters: any[] = [];
  const department = normalizeText(query?.department);
  const team = normalizeText(query?.team);
  const locationId = normalizeObjectId(query?.locationId || query?.officeLocationId);

  if (department) {
    filters.push({ department });
  }
  if (team) {
    filters.push({ team });
  }
  if (query?.locationId || query?.officeLocationId) {
    if (!locationId) {
      throw generateError("Invalid office location filter", 400);
    }
    filters.push({ officeLocation: new mongoose.Types.ObjectId(locationId) });
  }

  const search = normalizeText(query?.search || query?.q).slice(0, 100);
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    const matchingLocations = await OfficeLocation.find({
      company: context.companyObjectId,
      deletedAt: null,
      $or: [
        { name: regex },
        { code: regex },
        { city: regex },
        { state: regex },
      ],
    })
      .select("_id")
      .limit(MAX_PAGE_SIZE)
      .lean();
    const searchConditions: any[] = [
      { name: regex },
      { code: regex },
      { profileId: regex },
      { designation: regex },
      { department: regex },
      { team: regex },
    ];

    if (!includeContext) {
      searchConditions.push({ email: regex }, { username: regex });
    }
    if (matchingLocations.length > 0) {
      searchConditions.push({
        officeLocation: { $in: matchingLocations.map((location) => location._id) },
      });
    }
    filters.push({ $or: searchConditions });
  }

  return combineMatch(baseMatch, ...filters);
}

async function fetchRootPage(context: OrganizationContext, query: any) {
  const rootMatch = combineMatch(context.includedMatch, {
    $or: [
      { reportingManager: null },
      { reportingManager: { $exists: false } },
    ],
  });
  const page = await fetchUserPage({
    match: rootMatch,
    cursor: query?.cursor,
    limit: query?.limit,
  });
  const nodes = await hydrateOrganizationNodes(page.users, context);
  return { nodes, roots: nodes.map((node) => node._id), pageInfo: page.pageInfo };
}

async function getHierarchyIssueCount(context: OrganizationContext) {
  const result = await User.aggregate([
    { $match: context.primaryMatch },
    {
      $lookup: {
        from: User.collection.name,
        let: { managerId: "$reportingManager" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$_id", "$$managerId"] },
              company: context.companyObjectId,
              deletedAt: { $exists: false },
            },
          },
          { $project: { _id: 1 } },
        ],
        as: "resolvedManager",
      },
    },
    {
      $match: {
        $or: [
          { $expr: { $eq: ["$_id", "$reportingManager"] } },
          {
            $and: [
              { reportingManager: { $ne: null } },
              { "resolvedManager.0": { $exists: false } },
            ],
          },
        ],
      },
    },
    { $count: "count" },
  ]);

  return Number(result[0]?.count || 0);
}

async function buildSummaryAndFilters(context: OrganizationContext) {
  const managerSourceMatch = combineMatch(context.includedMatch, {
    reportingManager: { $ne: null },
  });
  const [
    totalPeople,
    unassignedCount,
    managerIds,
    hierarchyIssueCount,
    departments,
    teams,
    locationIds,
  ] = await Promise.all([
    User.countDocuments(context.primaryMatch),
    User.countDocuments(
      combineMatch(context.primaryMatch, {
        $or: [
          { reportingManager: null },
          { reportingManager: { $exists: false } },
        ],
      })
    ),
    User.distinct("reportingManager", managerSourceMatch),
    getHierarchyIssueCount(context),
    User.distinct("department", context.primaryMatch),
    User.distinct("team", context.primaryMatch),
    User.distinct("officeLocation", context.primaryMatch),
  ]);
  const validLocationIds = locationIds
    .map((id: any) => normalizeObjectId(id))
    .filter(Boolean)
    .map((id: string) => new mongoose.Types.ObjectId(id));
  const locations = validLocationIds.length
    ? await OfficeLocation.find({
        _id: { $in: validLocationIds },
        company: context.companyObjectId,
        deletedAt: null,
      })
        .select("name code city state")
        .sort({ name: 1 })
        .lean()
    : [];

  return {
    summary: {
      totalPeople,
      managerCount: managerIds.map((id: any) => normalizeObjectId(id)).filter(Boolean).length,
      unassignedCount,
      contextPeopleCount: context.contextIds.size,
      maxDepth: 0,
      hierarchyIssueCount,
    },
    filters: {
      departments: departments.map(normalizeText).filter(Boolean).sort((a, b) => a.localeCompare(b)),
      teams: teams.map(normalizeText).filter(Boolean).sort((a, b) => a.localeCompare(b)),
      locations: locations.map(serializeLocation),
    },
  };
}

async function countVisibleDescendants(context: OrganizationContext, userId: string) {
  const visited = new Set<string>([userId]);
  let frontier = [new mongoose.Types.ObjectId(userId)];
  let total = 0;

  for (let depth = 0; depth < MAX_HIERARCHY_DEPTH && frontier.length > 0; depth += 1) {
    const children = await User.find(
      combineMatch(context.includedMatch, { reportingManager: { $in: frontier } })
    )
      .select("_id")
      .lean();
    const nextFrontier: mongoose.Types.ObjectId[] = [];

    children.forEach((child: any) => {
      const childId = normalizeObjectId(child);
      if (!childId || visited.has(childId)) {
        return;
      }
      visited.add(childId);
      total += 1;
      nextFrontier.push(new mongoose.Types.ObjectId(childId));
    });
    frontier = nextFrontier;
  }

  return total;
}

async function loadManagerChain(context: OrganizationContext, user: any) {
  const managerChain: any[] = [];
  const visited = new Set<string>();
  let managerId = getDirectManagerId(user);

  while (managerId && !visited.has(managerId) && managerChain.length < MAX_HIERARCHY_DEPTH) {
    visited.add(managerId);
    const manager = await User.findOne(
      combineMatch(context.includedMatch, {
        _id: new mongoose.Types.ObjectId(managerId),
      })
    )
      .select("name email username role userType designation department reportingManager")
      .lean();
    if (!manager) {
      break;
    }

    managerChain.push({
      ...serializePersonReference(manager, !isContextOnly(context, managerId)),
      level: managerChain.length + 1,
    });
    managerId = getDirectManagerId(manager);
  }

  return managerChain;
}

async function sendOrganizationPage(
  res: Response,
  context: OrganizationContext,
  match: any,
  query: any,
  extra: Record<string, any> = {}
) {
  const page = await fetchUserPage({ match, cursor: query?.cursor, limit: query?.limit });
  const nodes = await hydrateOrganizationNodes(page.users, context);
  return res.status(200).json({
    success: true,
    data: { ...extra, nodes, pageInfo: page.pageInfo },
  });
}

export const getOrganizationHierarchyService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const context = await buildOrganizationContext(req);
    const [rootPage, metadata] = await Promise.all([
      fetchRootPage(context, req.query),
      buildSummaryAndFilters(context),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        company: {
          _id: context.companyId,
          name: normalizeText(context.company?.company_name),
        },
        scope: context.scope,
        nodes: rootPage.nodes,
        roots: rootPage.roots,
        rootPageInfo: rootPage.pageInfo,
        ...metadata,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getOrganizationRootsService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const context = await buildOrganizationContext(req);
    const rootPage = await fetchRootPage(context, req.query);
    return res.status(200).json({ success: true, data: rootPage });
  } catch (error) {
    next(error);
  }
};

export const getOrganizationChildrenService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const context = await buildOrganizationContext(req);
    const managerId = normalizeObjectId(req.query?.managerId || req.query?.parentId);
    if (!managerId) {
      throw generateError("Valid managerId is required", 422);
    }

    const manager = await User.exists(
      combineMatch(context.includedMatch, { _id: new mongoose.Types.ObjectId(managerId) })
    );
    if (!manager) {
      throw generateError("Manager is outside the permitted organization scope", 404);
    }

    return sendOrganizationPage(
      res,
      context,
      combineMatch(context.includedMatch, {
        reportingManager: new mongoose.Types.ObjectId(managerId),
      }),
      req.query,
      { parentId: managerId }
    );
  } catch (error) {
    next(error);
  }
};

export const listOrganizationPeopleService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const context = await buildOrganizationContext(req);
    const view = normalizeText(req.query?.view || "search").toLowerCase();
    if (!["search", "managers", "unassigned"].includes(view)) {
      throw generateError("Organization view must be search, managers, or unassigned", 400);
    }

    if (view === "managers") {
      const managerIds = (await User.distinct(
        "reportingManager",
        combineMatch(context.includedMatch, { reportingManager: { $ne: null } })
      ))
        .map((id: any) => normalizeObjectId(id))
        .filter(Boolean);
      const managerMatch = await buildFilteredMatch(context, req.query, true);
      return sendOrganizationPage(
        res,
        context,
        combineMatch(managerMatch, {
          _id: {
            $in: managerIds.map((id: string) => new mongoose.Types.ObjectId(id)),
          },
        }),
        req.query,
        { view }
      );
    }

    const filteredMatch = await buildFilteredMatch(context, req.query, false);
    const match =
      view === "unassigned"
        ? combineMatch(filteredMatch, {
            $or: [
              { reportingManager: null },
              { reportingManager: { $exists: false } },
            ],
          })
        : filteredMatch;
    return sendOrganizationPage(res, context, match, req.query, { view });
  } catch (error) {
    next(error);
  }
};

export const getOrganizationPersonService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const context = await buildOrganizationContext(req);
    const userId = normalizeObjectId(req.params?.userId);
    if (!userId) {
      throw generateError("Valid employee id is required", 422);
    }

    const user = await User.findOne(
      combineMatch(context.includedMatch, { _id: new mongoose.Types.ObjectId(userId) })
    )
      .select(USER_SELECT)
      .populate("officeLocation", "name code city state")
      .lean();
    if (!user) {
      throw generateError("Employee is outside the permitted organization scope", 404);
    }

    const [nodes, managerChain, totalReportCount, directReportPage] = await Promise.all([
      hydrateOrganizationNodes([user], context),
      loadManagerChain(context, user),
      countVisibleDescendants(context, userId),
      fetchUserPage({
        match: combineMatch(context.includedMatch, {
          reportingManager: new mongoose.Types.ObjectId(userId),
        }),
        limit: 20,
      }),
    ]);
    const directReports = await hydrateOrganizationNodes(directReportPage.users, context);
    const node = {
      ...nodes[0],
      managerChain,
      totalReportCount,
      depth: managerChain.length,
      directReportIds: directReports.map((report) => report._id),
    };

    return res.status(200).json({
      success: true,
      data: {
        node,
        directReports,
        directReportsPageInfo: directReportPage.pageInfo,
      },
    });
  } catch (error) {
    next(error);
  }
};
