import Company from "../../schemas/company/Company";

export const PERMISSION_KEYS = {
  VIEW_DASHBOARD: "view_dashboard",
  VIEW_USERS: "view_users",
  CREATE_USERS: "create_users",
  CREATE_MANAGERS: "create_managers",
  CREATE_DEPARTMENT_HEADS: "create_department_heads",
  EDIT_USERS: "edit_users",
  ASSIGN_MANAGERS: "assign_managers",
  VIEW_DEPARTMENTS: "view_departments",
  VIEW_ASSIGNED_COURSES: "view_assigned_courses",
  VIEW_ALL_COURSES: "view_all_courses",
  CREATE_COURSES: "create_courses",
  EDIT_COURSES: "edit_courses",
  DELETE_COURSES: "delete_courses",
  ASSIGN_COURSES: "assign_courses",
  VIEW_BATCHES: "view_batches",
  MANAGE_BATCHES: "manage_batches",
  VIEW_LEARNER_PROGRESS_RESULTS: "view_learner_progress_results",
  MANAGE_PERMISSIONS: "manage_permissions",
  COMPANY_SETTINGS: "company_settings",
  VIEW_PROFILE: "view_profile",
} as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[keyof typeof PERMISSION_KEYS];

type PermissionDefinition = {
  key: PermissionKey;
  label: string;
  description: string;
  category: string;
  systemOnly?: boolean;
};

const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    key: PERMISSION_KEYS.VIEW_DASHBOARD,
    label: "View Dashboard",
    description: "Open the dashboard and see analytics within the role's allowed scope.",
    category: "Navigation",
  },
  {
    key: PERMISSION_KEYS.VIEW_USERS,
    label: "View Users",
    description: "Open the users module and browse users within the allowed scope.",
    category: "Users",
  },
  {
    key: PERMISSION_KEYS.CREATE_USERS,
    label: "Create Users",
    description: "Create employee accounts.",
    category: "Users",
  },
  {
    key: PERMISSION_KEYS.CREATE_MANAGERS,
    label: "Create Managers",
    description: "Create manager accounts within the allowed scope.",
    category: "Users",
  },
  {
    key: PERMISSION_KEYS.CREATE_DEPARTMENT_HEADS,
    label: "Create Department Heads",
    description: "Create department head accounts.",
    category: "Users",
  },
  {
    key: PERMISSION_KEYS.EDIT_USERS,
    label: "Edit Users",
    description: "Edit user profile details and account settings within scope.",
    category: "Users",
  },
  {
    key: PERMISSION_KEYS.ASSIGN_MANAGERS,
    label: "Assign Managers",
    description: "Assign or change manager hierarchy relationships.",
    category: "Users",
  },
  {
    key: PERMISSION_KEYS.VIEW_DEPARTMENTS,
    label: "View Departments",
    description: "Open the departments module.",
    category: "Navigation",
  },
  {
    key: PERMISSION_KEYS.VIEW_ASSIGNED_COURSES,
    label: "View Assigned Courses",
    description: "Open the course workspace and view assigned or in-scope courses.",
    category: "Courses",
  },
  {
    key: PERMISSION_KEYS.VIEW_ALL_COURSES,
    label: "View All Courses",
    description: "View the broader course library allowed for the role.",
    category: "Courses",
  },
  {
    key: PERMISSION_KEYS.CREATE_COURSES,
    label: "Create Courses",
    description: "Create new courses within the allowed scope.",
    category: "Courses",
  },
  {
    key: PERMISSION_KEYS.EDIT_COURSES,
    label: "Edit Courses",
    description: "Edit existing courses within the allowed scope.",
    category: "Courses",
  },
  {
    key: PERMISSION_KEYS.DELETE_COURSES,
    label: "Delete Courses",
    description: "Delete courses within the allowed scope when they are not assigned.",
    category: "Courses",
  },
  {
    key: PERMISSION_KEYS.ASSIGN_COURSES,
    label: "Assign Courses",
    description: "Assign courses to companies, departments, users, or batches within scope.",
    category: "Courses",
  },
  {
    key: PERMISSION_KEYS.VIEW_BATCHES,
    label: "View Batches",
    description: "Open the batches module and browse accessible batches.",
    category: "Batches",
  },
  {
    key: PERMISSION_KEYS.MANAGE_BATCHES,
    label: "Manage Batches",
    description: "Create, update, and delete batches within scope.",
    category: "Batches",
  },
  {
    key: PERMISSION_KEYS.VIEW_LEARNER_PROGRESS_RESULTS,
    label: "View Learner Progress & Results",
    description: "View scoped learner progress, quiz submissions, answers, and scores.",
    category: "Learning Results",
  },
  {
    key: PERMISSION_KEYS.VIEW_PROFILE,
    label: "View Profile",
    description: "Open the profile and settings module.",
    category: "Navigation",
  },
  {
    key: PERMISSION_KEYS.COMPANY_SETTINGS,
    label: "Company Settings",
    description: "Open and manage the company HRMS settings.",
    category: "Company",
  },
  {
    key: PERMISSION_KEYS.MANAGE_PERMISSIONS,
    label: "Manage Permissions",
    description: "Edit role defaults and user-level permission overrides.",
    category: "Permissions",
    systemOnly: true,
  },
];

export const PERMISSION_CATALOG = PERMISSION_DEFINITIONS.filter((permission) => !permission.systemOnly);
export const ALL_PERMISSION_KEYS = Object.values(PERMISSION_KEYS);

export const CONFIGURABLE_PERMISSION_ROLES = ["admin", "departmenthead"] as const;

const PERMISSION_METADATA_BY_KEY = PERMISSION_DEFINITIONS.reduce<Record<string, PermissionDefinition>>(
  (acc, permission) => {
    acc[permission.key] = permission;
    return acc;
  },
  {}
);

const ADMIN_ALLOWED_PERMISSION_KEYS: PermissionKey[] = [
  PERMISSION_KEYS.VIEW_DASHBOARD,
  PERMISSION_KEYS.VIEW_USERS,
  PERMISSION_KEYS.CREATE_USERS,
  PERMISSION_KEYS.CREATE_MANAGERS,
  PERMISSION_KEYS.CREATE_DEPARTMENT_HEADS,
  PERMISSION_KEYS.EDIT_USERS,
  PERMISSION_KEYS.ASSIGN_MANAGERS,
  PERMISSION_KEYS.VIEW_DEPARTMENTS,
  PERMISSION_KEYS.VIEW_ASSIGNED_COURSES,
  PERMISSION_KEYS.VIEW_ALL_COURSES,
  PERMISSION_KEYS.CREATE_COURSES,
  PERMISSION_KEYS.EDIT_COURSES,
  PERMISSION_KEYS.DELETE_COURSES,
  PERMISSION_KEYS.ASSIGN_COURSES,
  PERMISSION_KEYS.VIEW_BATCHES,
  PERMISSION_KEYS.MANAGE_BATCHES,
  PERMISSION_KEYS.VIEW_LEARNER_PROGRESS_RESULTS,
  PERMISSION_KEYS.COMPANY_SETTINGS,
  PERMISSION_KEYS.VIEW_PROFILE,
];

const DEPARTMENT_HEAD_ALLOWED_PERMISSION_KEYS: PermissionKey[] = [
  PERMISSION_KEYS.VIEW_DASHBOARD,
  PERMISSION_KEYS.VIEW_USERS,
  PERMISSION_KEYS.CREATE_USERS,
  PERMISSION_KEYS.CREATE_MANAGERS,
  PERMISSION_KEYS.EDIT_USERS,
  PERMISSION_KEYS.ASSIGN_MANAGERS,
  PERMISSION_KEYS.VIEW_DEPARTMENTS,
  PERMISSION_KEYS.VIEW_ASSIGNED_COURSES,
  PERMISSION_KEYS.CREATE_COURSES,
  PERMISSION_KEYS.EDIT_COURSES,
  PERMISSION_KEYS.DELETE_COURSES,
  PERMISSION_KEYS.ASSIGN_COURSES,
  PERMISSION_KEYS.VIEW_BATCHES,
  PERMISSION_KEYS.MANAGE_BATCHES,
  PERMISSION_KEYS.VIEW_LEARNER_PROGRESS_RESULTS,
  PERMISSION_KEYS.VIEW_PROFILE,
];

const ROLE_ALLOWED_PERMISSION_KEYS: Record<string, PermissionKey[]> = {
  superadmin: ALL_PERMISSION_KEYS,
  admin: ADMIN_ALLOWED_PERMISSION_KEYS,
  departmenthead: DEPARTMENT_HEAD_ALLOWED_PERMISSION_KEYS,
  default: [PERMISSION_KEYS.VIEW_PROFILE],
};

const PERMISSION_DEPENDENCIES: Partial<Record<PermissionKey, PermissionKey[]>> = {
  [PERMISSION_KEYS.CREATE_USERS]: [PERMISSION_KEYS.VIEW_USERS],
  [PERMISSION_KEYS.CREATE_MANAGERS]: [PERMISSION_KEYS.VIEW_USERS],
  [PERMISSION_KEYS.CREATE_DEPARTMENT_HEADS]: [PERMISSION_KEYS.VIEW_USERS],
  [PERMISSION_KEYS.EDIT_USERS]: [PERMISSION_KEYS.VIEW_USERS],
  [PERMISSION_KEYS.ASSIGN_MANAGERS]: [PERMISSION_KEYS.VIEW_USERS],
  [PERMISSION_KEYS.VIEW_ALL_COURSES]: [PERMISSION_KEYS.VIEW_ASSIGNED_COURSES],
  [PERMISSION_KEYS.CREATE_COURSES]: [PERMISSION_KEYS.VIEW_ASSIGNED_COURSES],
  [PERMISSION_KEYS.EDIT_COURSES]: [PERMISSION_KEYS.VIEW_ASSIGNED_COURSES],
  [PERMISSION_KEYS.DELETE_COURSES]: [PERMISSION_KEYS.VIEW_ASSIGNED_COURSES],
  [PERMISSION_KEYS.ASSIGN_COURSES]: [PERMISSION_KEYS.VIEW_ASSIGNED_COURSES],
  [PERMISSION_KEYS.MANAGE_BATCHES]: [PERMISSION_KEYS.VIEW_BATCHES],
};

const LEGACY_PERMISSION_ALIASES: Record<string, PermissionKey[]> = {
  view_courses: [PERMISSION_KEYS.VIEW_ASSIGNED_COURSES, PERMISSION_KEYS.VIEW_ALL_COURSES],
  manage_courses: [
    PERMISSION_KEYS.CREATE_COURSES,
    PERMISSION_KEYS.EDIT_COURSES,
    PERMISSION_KEYS.DELETE_COURSES,
    PERMISSION_KEYS.VIEW_ASSIGNED_COURSES,
  ],
  view_companies: [],
};

function normalizeRole(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead");
}

function buildEmptyPermissionRecord() {
  return ALL_PERMISSION_KEYS.reduce<Record<string, boolean>>((acc, key) => {
    acc[key] = false;
    return acc;
  }, {});
}

export function buildCompletePermissionRecord(value: any) {
  return {
    ...buildEmptyPermissionRecord(),
    ...normalizePermissionRecord(value),
  };
}

function getRoleLabel(roleInput: unknown) {
  const role = normalizeRole(roleInput);
  if (role === "departmenthead") {
    return "Department Head";
  }

  if (role === "superadmin") {
    return "Super Admin";
  }

  return role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : "Role";
}

export function getAllowedPermissionKeysForRole(roleInput: unknown) {
  const role = normalizeRole(roleInput);
  return ROLE_ALLOWED_PERMISSION_KEYS[role] || ROLE_ALLOWED_PERMISSION_KEYS.default;
}

function createPermissionRecord(enabledKeys: string[]) {
  const base = buildEmptyPermissionRecord();
  enabledKeys.forEach((key) => {
    if (ALL_PERMISSION_KEYS.includes(key as PermissionKey)) {
      base[key] = true;
    }
  });
  return base;
}

export function getDefaultPermissionsForRole(roleInput: unknown) {
  const role = normalizeRole(roleInput);

  if (role === "superadmin") {
    return createPermissionRecord(ALL_PERMISSION_KEYS);
  }

  if (role === "admin") {
    return createPermissionRecord([
      PERMISSION_KEYS.VIEW_DASHBOARD,
      PERMISSION_KEYS.VIEW_USERS,
      PERMISSION_KEYS.CREATE_USERS,
      PERMISSION_KEYS.CREATE_MANAGERS,
      PERMISSION_KEYS.CREATE_DEPARTMENT_HEADS,
      PERMISSION_KEYS.EDIT_USERS,
      PERMISSION_KEYS.ASSIGN_MANAGERS,
      PERMISSION_KEYS.VIEW_DEPARTMENTS,
      PERMISSION_KEYS.VIEW_ASSIGNED_COURSES,
      PERMISSION_KEYS.VIEW_ALL_COURSES,
      PERMISSION_KEYS.CREATE_COURSES,
      PERMISSION_KEYS.EDIT_COURSES,
      PERMISSION_KEYS.DELETE_COURSES,
      PERMISSION_KEYS.ASSIGN_COURSES,
      PERMISSION_KEYS.VIEW_BATCHES,
      PERMISSION_KEYS.MANAGE_BATCHES,
      PERMISSION_KEYS.VIEW_LEARNER_PROGRESS_RESULTS,
      PERMISSION_KEYS.COMPANY_SETTINGS,
      PERMISSION_KEYS.VIEW_PROFILE,
    ]);
  }

  if (role === "departmenthead") {
    return createPermissionRecord([
      PERMISSION_KEYS.VIEW_DASHBOARD,
      PERMISSION_KEYS.VIEW_USERS,
      PERMISSION_KEYS.CREATE_USERS,
      PERMISSION_KEYS.CREATE_MANAGERS,
      PERMISSION_KEYS.EDIT_USERS,
      PERMISSION_KEYS.ASSIGN_MANAGERS,
      PERMISSION_KEYS.VIEW_DEPARTMENTS,
      PERMISSION_KEYS.VIEW_ASSIGNED_COURSES,
      PERMISSION_KEYS.CREATE_COURSES,
      PERMISSION_KEYS.EDIT_COURSES,
      PERMISSION_KEYS.DELETE_COURSES,
      PERMISSION_KEYS.ASSIGN_COURSES,
      PERMISSION_KEYS.VIEW_BATCHES,
      PERMISSION_KEYS.MANAGE_BATCHES,
      PERMISSION_KEYS.VIEW_LEARNER_PROGRESS_RESULTS,
      PERMISSION_KEYS.VIEW_PROFILE,
    ]);
  }

  return createPermissionRecord([PERMISSION_KEYS.VIEW_PROFILE]);
}

export function normalizePermissionRecord(value: any) {
  const normalized: Record<string, boolean> = {};

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return normalized;
  }

  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "boolean") {
      continue;
    }

    if (ALL_PERMISSION_KEYS.includes(rawKey as PermissionKey)) {
      normalized[rawKey] = rawValue;
      continue;
    }

    const aliasTargets = LEGACY_PERMISSION_ALIASES[rawKey];
    if (!aliasTargets?.length) {
      continue;
    }

    aliasTargets.forEach((aliasKey) => {
      normalized[aliasKey] = rawValue;
    });
  }

  return normalized;
}

function applyPermissionDependencies(value: Record<string, boolean>) {
  const next = { ...buildEmptyPermissionRecord(), ...value };
  let changed = true;

  while (changed) {
    changed = false;

    for (const [permissionKey, dependencies] of Object.entries(PERMISSION_DEPENDENCIES)) {
      if (!next[permissionKey]) {
        continue;
      }

      if ((dependencies || []).some((dependencyKey) => !next[dependencyKey])) {
        next[permissionKey] = false;
        changed = true;
      }
    }
  }

  return next;
}

export function sanitizePermissionRecordForRole(roleInput: unknown, value: any) {
  const role = normalizeRole(roleInput);
  const allowedKeys = new Set(getAllowedPermissionKeysForRole(role));
  const requestedPermissions = buildCompletePermissionRecord(value);

  if (role === "superadmin") {
    return createPermissionRecord(ALL_PERMISSION_KEYS);
  }

  const next = buildEmptyPermissionRecord();
  for (const permissionKey of ALL_PERMISSION_KEYS) {
    next[permissionKey] = allowedKeys.has(permissionKey) ? requestedPermissions[permissionKey] : false;
  }

  return applyPermissionDependencies(next);
}

export function validatePermissionRecordForRole(options: {
  role: unknown;
  permissions: any;
}) {
  const role = normalizeRole(options.role);
  const errors: string[] = [];
  const requestedPermissions = buildCompletePermissionRecord(options.permissions);
  const allowedKeys = new Set(getAllowedPermissionKeysForRole(role));

  if (!CONFIGURABLE_PERMISSION_ROLES.includes(role as (typeof CONFIGURABLE_PERMISSION_ROLES)[number])) {
    errors.push(`${getRoleLabel(role)} permissions cannot be configured here.`);
  }

  for (const permissionKey of ALL_PERMISSION_KEYS) {
    if (!requestedPermissions[permissionKey]) {
      continue;
    }

    if (!allowedKeys.has(permissionKey)) {
      const label = PERMISSION_METADATA_BY_KEY[permissionKey]?.label || permissionKey;
      errors.push(`${label} is not allowed for ${getRoleLabel(role)}.`);
    }
  }

  for (const [permissionKey, dependencies] of Object.entries(PERMISSION_DEPENDENCIES)) {
    if (!requestedPermissions[permissionKey]) {
      continue;
    }

    const missingDependencies = (dependencies || []).filter((dependencyKey) => !requestedPermissions[dependencyKey]);
    if (!missingDependencies.length) {
      continue;
    }

    const missingLabels = missingDependencies.map(
      (dependencyKey) => PERMISSION_METADATA_BY_KEY[dependencyKey]?.label || dependencyKey
    );
    const permissionLabel = PERMISSION_METADATA_BY_KEY[permissionKey]?.label || permissionKey;
    errors.push(`${permissionLabel} requires ${missingLabels.join(", ")}.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedPermissions: sanitizePermissionRecordForRole(role, requestedPermissions),
  };
}

export function normalizeRolePermissionMap(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, Record<string, boolean>>;
  }

  return Object.entries(value).reduce<Record<string, Record<string, boolean>>>((acc, [roleKey, permissions]) => {
    const role = normalizeRole(roleKey);
    acc[role] = sanitizePermissionRecordForRole(role, {
      ...getDefaultPermissionsForRole(role),
      ...normalizePermissionRecord(permissions),
    });
    return acc;
  }, {});
}

export function computeEffectivePermissions(options: {
  role: unknown;
  rolePermissionOverrides?: any;
  userOverrides?: any;
}) {
  const role = normalizeRole(options.role);

  if (role === "superadmin") {
    return createPermissionRecord(ALL_PERMISSION_KEYS);
  }

  const defaults = getDefaultPermissionsForRole(role);
  const mergedPermissions = { ...defaults };

  if (options.rolePermissionOverrides && typeof options.rolePermissionOverrides === "object") {
    Object.assign(
      mergedPermissions,
      sanitizePermissionRecordForRole(role, {
        ...mergedPermissions,
        ...options.rolePermissionOverrides,
      })
    );
  }

  if (options.userOverrides && typeof options.userOverrides === "object") {
    const allowedKeys = new Set(getAllowedPermissionKeysForRole(role));
    const normalizedUserOverrides = normalizePermissionRecord(options.userOverrides);

    for (const [permissionKey, permissionValue] of Object.entries(normalizedUserOverrides)) {
      if (allowedKeys.has(permissionKey as PermissionKey)) {
        mergedPermissions[permissionKey] = permissionValue;
      }
    }
  }

  return sanitizePermissionRecordForRole(role, mergedPermissions);
}

export function attachEffectivePermissions(options: {
  user: any;
  company?: any;
}) {
  const user = options.user || {};
  const normalizedRolePermissions = normalizeRolePermissionMap(options.company?.rolePermissions);
  const role = normalizeRole(user?.role || user?.userType);
  const rolePermissionDefaults = computeEffectivePermissions({
    role,
    rolePermissionOverrides: normalizedRolePermissions[role],
  });
  const permissionOverrides = normalizePermissionRecord(user?.permissions);
  const effectivePermissions =
    role === "superadmin"
      ? createPermissionRecord(ALL_PERMISSION_KEYS)
      : computeEffectivePermissions({
          role,
          rolePermissionOverrides: normalizedRolePermissions[role],
          userOverrides: permissionOverrides,
        });

  return {
    ...user,
    permissions: permissionOverrides,
    permissionOverrides,
    rolePermissionDefaults,
    effectivePermissions,
  };
}

export function hasPermission(user: any, permissionKey: string) {
  const role = normalizeRole(user?.role || user?.userType);
  if (role === "superadmin") {
    return true;
  }

  if (!ALL_PERMISSION_KEYS.includes(permissionKey as PermissionKey)) {
    return false;
  }

  if (typeof user?.effectivePermissions?.[permissionKey] === "boolean") {
    return user.effectivePermissions[permissionKey];
  }

  return computeEffectivePermissions({
    role,
    userOverrides: user?.permissions,
  })[permissionKey];
}

export function hasAnyCourseViewPermission(user: any) {
  return (
    hasPermission(user, PERMISSION_KEYS.VIEW_ASSIGNED_COURSES) ||
    hasPermission(user, PERMISSION_KEYS.VIEW_ALL_COURSES) ||
    hasPermission(user, PERMISSION_KEYS.CREATE_COURSES) ||
    hasPermission(user, PERMISSION_KEYS.EDIT_COURSES) ||
    hasPermission(user, PERMISSION_KEYS.DELETE_COURSES) ||
    hasPermission(user, PERMISSION_KEYS.ASSIGN_COURSES)
  );
}

export function hasAnyCourseManagementPermission(user: any) {
  return (
    hasPermission(user, PERMISSION_KEYS.CREATE_COURSES) ||
    hasPermission(user, PERMISSION_KEYS.EDIT_COURSES) ||
    hasPermission(user, PERMISSION_KEYS.DELETE_COURSES)
  );
}

export function ensureCourseViewPermission(user: any, message?: string) {
  if (!hasAnyCourseViewPermission(user)) {
    const error: any = new Error(message || "You do not have permission to view courses");
    error.statusCode = 403;
    throw error;
  }
}

export function ensurePermission(user: any, permissionKey: string, message?: string) {
  if (!hasPermission(user, permissionKey)) {
    const error: any = new Error(message || "You do not have permission to perform this action");
    error.statusCode = 403;
    throw error;
  }
}

export function getPermissionRoleOptions() {
  return [
    { value: "admin", label: "Admin" },
    { value: "departmenthead", label: "Department Head" },
  ];
}

export async function resolvePermissionCompany(options: {
  actor: any;
  requestedCompanyId?: string;
}) {
  if (normalizeRole(options.actor?.role) !== "superadmin") {
    return options.actor?.company
      ? await Company.findById(options.actor.company)
      : options.actor?.companyId
        ? await Company.findById(options.actor.companyId)
        : null;
  }

  const companyId = String(options.requestedCompanyId || options.actor?.company || options.actor?.companyId || "").trim();
  if (!companyId) {
    return null;
  }

  return Company.findById(companyId);
}
