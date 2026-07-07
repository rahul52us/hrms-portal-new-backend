import Course from "../../schemas/course/Course";
import CourseAccess from "../../schemas/course/CourseAccess";
import User from "../../schemas/User/User";
import {
  getDepartmentScopedUserMatch,
  normalizeRole,
  resolveDepartmentRecord,
  toObjectId,
  isWithinValidityWindow,
} from "../courseAccess/utils/accessControl";
import {
  hasAnyCourseManagementPermission,
  hasPermission,
  PERMISSION_KEYS,
} from "../permissions/permission.utils";

function stringifyId(value: any) {
  return value ? String(value) : "";
}

function uniqueIds(values: Array<string | undefined | null>) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function getActiveAssignedCourseIdsForCompany(companyId: string) {
  const accessDocs = await CourseAccess.find({
    companyId: toObjectId(companyId),
  })
    .select("courseId validFrom validTill")
    .lean();

  return uniqueIds(
    accessDocs
      .filter((accessDoc: any) => isWithinValidityWindow(accessDoc.validFrom, accessDoc.validTill))
      .map((accessDoc: any) => stringifyId(accessDoc.courseId))
  );
}

async function getPublishedSuperadminCourseIds() {
  const superadminIds = await User.find({
    role: "superadmin",
    deletedAt: { $exists: false },
  })
    .select("_id")
    .lean();

  if (!superadminIds.length) {
    return [] as string[];
  }

  const courses = await Course.find({
    status: "published",
    createdBy: { $in: superadminIds.map((user) => user._id) },
  })
    .select("_id")
    .lean();

  return uniqueIds(courses.map((course: any) => stringifyId(course._id)));
}

async function getCompanyCreatedCourseIds(companyId: string) {
  const companyUsers = await User.find({
    company: toObjectId(companyId),
    deletedAt: { $exists: false },
    role: { $in: ["admin", "departmenthead"] },
  })
    .select("_id")
    .lean();

  const companyCreatorIds = companyUsers.map((user) => user._id);
  const courses = await Course.find({
    $or: [
      { company: toObjectId(companyId) },
      ...(companyCreatorIds.length ? [{ createdBy: { $in: companyCreatorIds } }] : []),
    ],
  })
    .select("_id")
    .lean();

  return uniqueIds(courses.map((course: any) => stringifyId(course._id)));
}

async function getSelfCreatedCourseIds(userId: string) {
  const courses = await Course.find({
    createdBy: toObjectId(userId),
  })
    .select("_id")
    .lean();

  return uniqueIds(courses.map((course: any) => stringifyId(course._id)));
}

async function getDepartmentRelevantCourseIds(options: {
  companyId: string;
  departmentName?: string;
}) {
  if (!options.departmentName) {
    return [] as string[];
  }

  const actorDepartment = await resolveDepartmentRecord({
    companyId: options.companyId,
    departmentName: options.departmentName,
  }).catch(() => null);

  if (!actorDepartment) {
    return [] as string[];
  }

  const departmentUsers = await User.find({
    company: toObjectId(options.companyId),
    deletedAt: { $exists: false },
    ...getDepartmentScopedUserMatch(actorDepartment),
  })
    .select("_id")
    .lean();

  const departmentUserIds = departmentUsers.map((user) => user._id);
  const accessDocs = await CourseAccess.find({
    $or: [
      {
        accessLevel: "company",
        companyId: toObjectId(options.companyId),
      },
      {
        accessLevel: "department",
        departmentId: actorDepartment._id,
      },
      ...(departmentUserIds.length
        ? [
            {
              accessLevel: "user",
              userId: { $in: departmentUserIds },
            },
          ]
        : []),
    ],
  })
    .select("courseId validFrom validTill")
    .lean();

  return uniqueIds(
    accessDocs
      .filter((accessDoc: any) => isWithinValidityWindow(accessDoc.validFrom, accessDoc.validTill))
      .map((accessDoc: any) => stringifyId(accessDoc.courseId))
  );
}

export async function getVisibleCourseScopeForUser(user: any) {
  const role = normalizeRole(user?.role || user?.userType);
  const userId = stringifyId(user?._id);
  const companyId = stringifyId(user?.company || user?.companyId);
  const hasManagementAccess = hasAnyCourseManagementPermission(user);
  const canViewAllCourses = hasPermission(user, PERMISSION_KEYS.VIEW_ALL_COURSES);

  if (role === "superadmin") {
    return {
      role,
      isGlobal: true,
      courseIds: [] as string[],
      assignedCourseIds: [] as string[],
      selfCreatedCourseIds: [] as string[],
      companyCreatedCourseIds: [] as string[],
      superadminPublishedCourseIds: [] as string[],
      hasManagementAccess: true,
      canViewAllCourses: true,
    };
  }

  if (!companyId || !userId) {
    return {
      role,
      isGlobal: false,
      courseIds: [] as string[],
      assignedCourseIds: [] as string[],
      selfCreatedCourseIds: [] as string[],
      companyCreatedCourseIds: [] as string[],
      superadminPublishedCourseIds: [] as string[],
      hasManagementAccess,
      canViewAllCourses,
    };
  }

  if (role === "admin") {
    const [assignedCourseIds, companyCreatedCourseIds, superadminPublishedCourseIds] = await Promise.all([
      getActiveAssignedCourseIdsForCompany(companyId),
      hasManagementAccess ? getCompanyCreatedCourseIds(companyId) : Promise.resolve([] as string[]),
      canViewAllCourses ? getPublishedSuperadminCourseIds() : Promise.resolve([] as string[]),
    ]);

    return {
      role,
      isGlobal: false,
      courseIds: uniqueIds([
        ...assignedCourseIds,
        ...companyCreatedCourseIds,
        ...superadminPublishedCourseIds,
      ]),
      assignedCourseIds,
      selfCreatedCourseIds: [],
      companyCreatedCourseIds,
      superadminPublishedCourseIds,
      hasManagementAccess,
      canViewAllCourses,
    };
  }

  if (role === "departmenthead") {
    const [assignedCourseIds, selfCreatedCourseIds] = await Promise.all([
      getDepartmentRelevantCourseIds({
        companyId,
        departmentName: String(user?.department || "").trim(),
      }),
      hasManagementAccess ? getSelfCreatedCourseIds(userId) : Promise.resolve([] as string[]),
    ]);

    return {
      role,
      isGlobal: false,
      courseIds: uniqueIds([...assignedCourseIds, ...selfCreatedCourseIds]),
      assignedCourseIds,
      selfCreatedCourseIds,
      companyCreatedCourseIds: [],
      superadminPublishedCourseIds: [],
      hasManagementAccess,
      canViewAllCourses: false,
    };
  }

  const selfCreatedCourseIds = hasManagementAccess ? await getSelfCreatedCourseIds(userId) : [];

  return {
    role,
    isGlobal: false,
    courseIds: selfCreatedCourseIds,
    assignedCourseIds: [],
    selfCreatedCourseIds,
    companyCreatedCourseIds: [],
    superadminPublishedCourseIds: [],
    hasManagementAccess,
    canViewAllCourses: false,
  };
}
