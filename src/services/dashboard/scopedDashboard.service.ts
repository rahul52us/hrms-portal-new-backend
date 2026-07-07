import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import Company from "../../schemas/company/Company";
import Department from "../../schemas/Department/Department.schema";
import User from "../../schemas/User/User";
import Course from "../../schemas/course/Course";
import CourseAccess from "../../schemas/course/CourseAccess";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import Batch from "../../schemas/course/Batch";
import CourseQuizAttempt from "../../schemas/course/CourseQuizAttempt";
import UserCourseProgress from "../../schemas/course/UserCourseProgress";
import ScormTracking from "../../schemas/course/ScormTracking";
import { generateError } from "../../config/Error/functions";
import {
  getDepartmentScopedUserMatch,
  isWithinValidityWindow,
  normalizeRole,
  resolveDepartmentRecord,
  toObjectId,
} from "../courseAccess/utils/accessControl";
import { getVisibleCourseScopeForUser } from "../course/courseScope.helpers";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { buildSuperadminDashboardSummary } from "./superadminDashboard.service";

type DashboardFilters = {
  from?: Date;
  to?: Date;
  departmentId: string;
  role: string;
  userId: string;
  courseId: string;
  batchStatus: string;
  completionStatus: string;
  activityStatus: string;
};

const COMPLETED_STATUSES = new Set(["completed", "passed"]);
const LEARNER_ROLES = new Set(["learner", "student", "patient", "user"]);

function stringifyId(value: any) {
  return value ? String(value) : "";
}

function parseDate(value: unknown, endOfDay = false) {
  if (!value) {
    return undefined;
  }

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }

  return date;
}

function isValidObjectId(value: string) {
  return Boolean(value && mongoose.Types.ObjectId.isValid(value));
}

function getFilters(query: any): DashboardFilters {
  return {
    from: parseDate(query?.from),
    to: parseDate(query?.to, true),
    departmentId: stringifyId(query?.departmentId),
    role: normalizeRole(query?.role),
    userId: stringifyId(query?.userId),
    courseId: stringifyId(query?.courseId),
    batchStatus: String(query?.batchStatus || "").trim().toLowerCase(),
    completionStatus: String(query?.completionStatus || "").trim().toLowerCase(),
    activityStatus: String(query?.activityStatus || "").trim().toLowerCase(),
  };
}

function isWithinDateRange(value: any, filters: DashboardFilters) {
  if (!filters.from && !filters.to) {
    return true;
  }

  if (!value) {
    return false;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to);
}

function getBatchStatus(startDate?: Date | string | null, endDate?: Date | string | null) {
  const now = new Date();
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  if (start && start > now) {
    return "upcoming";
  }

  if (end && end < now) {
    return "completed";
  }

  return "active";
}

function normalizeUserRole(user: any) {
  return normalizeRole(user?.role || user?.userType || "user") || "user";
}

function isLearner(user: any) {
  return LEARNER_ROLES.has(normalizeUserRole(user));
}

function isManager(user: any) {
  const role = normalizeUserRole(user);
  return role === "manager" || /^l\d+-manager$/i.test(role);
}

function isUserActive(user: any) {
  return user?.is_active === true && user?.is_enabled !== false;
}

function buildChartEntries(map: Map<string, number>) {
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value);
}

function getMonthBuckets(count = 6) {
  const buckets: Array<{ label: string; start: Date; end: Date }> = [];
  const now = new Date();

  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0, 23, 59, 59, 999);
    buckets.push({
      label: start.toLocaleString("en-US", { month: "short" }),
      start,
      end,
    });
  }

  return buckets;
}

function buildMonthlyTrend(items: any[], dateKey: string) {
  return getMonthBuckets().map((bucket) => ({
    label: bucket.label,
    value: items.filter((item) => {
      const value = item?.[dateKey];
      if (!value) {
        return false;
      }

      const date = new Date(value);
      return date >= bucket.start && date <= bucket.end;
    }).length,
  }));
}

function getDepartmentLabel(user: any) {
  return String(user?.department || "Unassigned").trim() || "Unassigned";
}

function getEnrollmentProgress(enrollment: any, progressByKey: Map<string, any>) {
  const key = `${stringifyId(enrollment.userId)}:${stringifyId(enrollment.courseId)}`;
  const progress = progressByKey.get(key);
  const value = Number(progress?.progress ?? enrollment?.progressPercent);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function isEnrollmentCompleted(enrollment: any, progressByKey: Map<string, any>) {
  if (String(enrollment?.status) === "completed") {
    return true;
  }

  const key = `${stringifyId(enrollment.userId)}:${stringifyId(enrollment.courseId)}`;
  return COMPLETED_STATUSES.has(String(progressByKey.get(key)?.lessonStatus || ""));
}

async function resolveScope(actor: any) {
  const role = normalizeRole(actor?.role || actor?.userType);
  const companyId = stringifyId(actor?.company || actor?.companyId);

  if (!isValidObjectId(companyId)) {
    throw generateError("This account is missing a valid company scope", 403);
  }

  const company = await Company.findById(companyId)
    .select("_id company_name")
    .lean();

  if (!company) {
    throw generateError("The company assigned to this account no longer exists", 403);
  }

  if (role !== "departmenthead") {
    return {
      role,
      company,
      companyId,
      department: null,
    };
  }

  const departmentName = String(actor?.department || "").trim();
  if (!departmentName) {
    throw generateError("Department head is missing department scope", 403);
  }

  const department = await resolveDepartmentRecord({
    companyId,
    departmentName,
  }).catch(() => null);

  if (!department) {
    throw generateError("Department head is not mapped to a valid department", 403);
  }

  return {
    role,
    company,
    companyId,
    department,
  };
}

function filterUsers(options: {
  users: any[];
  filters: DashboardFilters;
  selectedDepartment?: any;
  isDepartmentHead: boolean;
}) {
  const selectedDepartmentValues = options.selectedDepartment
    ? [
        options.selectedDepartment.departmentName,
        options.selectedDepartment.title,
        options.selectedDepartment.code,
      ]
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    : [];

  return options.users.filter((user) => {
    if (
      selectedDepartmentValues.length &&
      !selectedDepartmentValues.includes(String(user.department || "").trim().toLowerCase())
    ) {
      return false;
    }

    if (options.filters.role && normalizeUserRole(user) !== options.filters.role) {
      return false;
    }

    if (
      options.isDepartmentHead &&
      options.filters.userId &&
      stringifyId(user._id) !== options.filters.userId
    ) {
      return false;
    }

    if (options.filters.activityStatus === "active" && !isUserActive(user)) {
      return false;
    }

    if (options.filters.activityStatus === "inactive" && isUserActive(user)) {
      return false;
    }

    return isWithinDateRange(user.createdAt, options.filters);
  });
}

async function getScopedAssignments(options: {
  role: string;
  companyId: string;
  department: any;
  departmentUserIds: string[];
}) {
  const accessDocs = await CourseAccess.find({
    companyId: toObjectId(options.companyId),
  })
    .select("courseId accessLevel companyId departmentId userId validFrom validTill createdAt")
    .lean();

  const activeDocs = accessDocs.filter((doc: any) =>
    isWithinValidityWindow(doc.validFrom, doc.validTill)
  );

  if (options.role !== "departmenthead") {
    return activeDocs;
  }

  const userIds = new Set(options.departmentUserIds);
  return activeDocs.filter((doc: any) => {
    if (String(doc.accessLevel) === "company") {
      return true;
    }

    if (String(doc.accessLevel) === "department") {
      return stringifyId(doc.departmentId) === stringifyId(options.department?._id);
    }

    return userIds.has(stringifyId(doc.userId));
  });
}

export async function buildScopedDashboardSummary(actor: any, query: any) {
  const filters = getFilters(query);
  const scope = await resolveScope(actor);
  const isDepartmentHead = scope.role === "departmenthead";

  const departments = await Department.find({
    company: toObjectId(scope.companyId),
    deletedAt: { $exists: false },
  })
    .select("_id departmentName code createdAt")
    .sort({ departmentName: 1 })
    .lean();

  const selectedDepartment =
    isDepartmentHead
      ? scope.department
      : filters.departmentId && isValidObjectId(filters.departmentId)
        ? departments.find((department: any) => stringifyId(department._id) === filters.departmentId) || null
        : null;

  const userMatch: any = {
    company: toObjectId(scope.companyId),
    deletedAt: { $exists: false },
  };

  if (isDepartmentHead && scope.department) {
    Object.assign(userMatch, getDepartmentScopedUserMatch(scope.department));
  }

  const directScopedUsers = await User.find(userMatch)
    .select(
      "_id name email username role userType department is_active is_enabled createdAt updatedAt"
    )
    .sort({ createdAt: -1 })
    .lean();

  const learnerMembershipUserIds = await Company.distinct("userId", {
    type: "user",
    companyOrg: toObjectId(scope.companyId),
    deletedAt: { $exists: false },
  });

  const scopedUserIdMap = new Map<string, mongoose.Types.ObjectId>();
  const directScopedUserIdSet = new Set<string>();
  directScopedUsers.forEach((user: any) => {
    const id = stringifyId(user._id);
    if (id && isValidObjectId(id)) {
      directScopedUserIdSet.add(id);
      scopedUserIdMap.set(id, toObjectId(id));
    }
  });
  learnerMembershipUserIds.forEach((userId: any) => {
    const id = stringifyId(userId);
    if (id && isValidObjectId(id) && !scopedUserIdMap.has(id)) {
      scopedUserIdMap.set(id, toObjectId(id));
    }
  });

  const membershipOnlyUserIds = Array.from(scopedUserIdMap.entries())
    .filter(([id]) => !directScopedUserIdSet.has(id))
    .map(([, objectId]) => objectId);

  const membershipOnlyUsers = membershipOnlyUserIds.length
    ? await User.find({
        _id: { $in: membershipOnlyUserIds },
        deletedAt: { $exists: false },
      })
        .select(
          "_id name email username role userType department is_active is_enabled createdAt updatedAt"
        )
        .sort({ createdAt: -1 })
        .lean()
    : [];

  const allScopedUsers = [...directScopedUsers, ...membershipOnlyUsers];

  const users = filterUsers({
    users: allScopedUsers,
    filters,
    selectedDepartment,
    isDepartmentHead,
  });
  const allScopedUserIds = allScopedUsers.map((user: any) => stringifyId(user._id));
  const userIds = users.map((user: any) => stringifyId(user._id));
  const userObjectIds = userIds.filter(isValidObjectId).map((id) => toObjectId(id));
  const userById = new Map(users.map((user: any) => [stringifyId(user._id), user]));

  const [visibleCourseScope, assignments] = await Promise.all([
    getVisibleCourseScopeForUser(actor),
    getScopedAssignments({
      role: scope.role,
      companyId: scope.companyId,
      department: scope.department,
      departmentUserIds: allScopedUserIds,
    }),
  ]);

  const allVisibleCourseIds = [
    ...new Set(visibleCourseScope.courseIds.map(stringifyId).filter(Boolean)),
  ];
  const allVisibleCourseObjectIds = allVisibleCourseIds
    .filter(isValidObjectId)
    .map((courseId) => toObjectId(courseId));
  const allVisibleCourses = allVisibleCourseObjectIds.length
    ? await Course.find({ _id: { $in: allVisibleCourseObjectIds } })
        .select("_id title status taxonomy metrics progression createdAt updatedAt")
        .sort({ title: 1 })
        .lean()
    : [];

  let visibleCourseIds = allVisibleCourseIds;
  if (filters.courseId) {
    visibleCourseIds = visibleCourseIds.filter((courseId) => courseId === filters.courseId);
  }

  const visibleCourseObjectIds = visibleCourseIds
    .filter(isValidObjectId)
    .map((courseId) => toObjectId(courseId));
  const courses = visibleCourseObjectIds.length
    ? await Course.find({
        _id: { $in: visibleCourseObjectIds },
      })
        .select("_id title status taxonomy metrics progression createdAt updatedAt")
        .sort({ createdAt: -1 })
        .lean()
    : [];
  const courseById = new Map(courses.map((course: any) => [stringifyId(course._id), course]));

  let batches = await Batch.find({
    companyId: toObjectId(scope.companyId),
    ...(filters.courseId && isValidObjectId(filters.courseId)
      ? { courseIds: toObjectId(filters.courseId) }
      : {}),
  })
    .select("_id name companyId courseIds userIds startDate endDate createdAt updatedAt")
    .sort({ createdAt: -1 })
    .lean();

  const allScopedUserIdSet = new Set(allScopedUserIds);
  const filteredUserIdSet = new Set(userIds);
  const hasUserFilter = Boolean(
    filters.departmentId || filters.role || filters.userId || filters.activityStatus
  );

  batches = batches.filter((batch: any) => {
    const batchUserIds = (batch.userIds || []).map(stringifyId).filter(Boolean);
    const hasScopedUser = batchUserIds.some((userId: string) => allScopedUserIdSet.has(userId));
    const hasFilteredUser = batchUserIds.some((userId: string) => filteredUserIdSet.has(userId));

    if (isDepartmentHead && !hasScopedUser) {
      return false;
    }

    if (hasUserFilter && !hasFilteredUser) {
      return false;
    }

    if (filters.batchStatus && getBatchStatus(batch.startDate, batch.endDate) !== filters.batchStatus) {
      return false;
    }

    return isWithinDateRange(batch.createdAt, filters);
  });

  const recordMatch = {
    userId: { $in: userObjectIds },
    courseId: { $in: visibleCourseObjectIds },
  };

  const [rawEnrollments, progressRecords, quizAttempts, scormTracking] =
    userObjectIds.length && visibleCourseObjectIds.length
      ? await Promise.all([
          CourseEnrollment.find(recordMatch)
            .select(
              "_id userId courseId status progressPercent validFrom validTill dueDate sources createdAt updatedAt"
            )
            .lean(),
          UserCourseProgress.find(recordMatch)
            .select(
              "userId courseId lessonStatus progress score attempts lastAccessed createdAt updatedAt"
            )
            .lean(),
          CourseQuizAttempt.find(recordMatch)
            .select(
              "userId courseId quizTitle percentage score maxScore submittedAt createdAt updatedAt"
            )
            .lean(),
          ScormTracking.find(recordMatch)
            .select(
              "userId courseId lessonStatus score attempts lastAccessed interactions.review.status createdAt updatedAt"
            )
            .lean(),
        ])
      : [[], [], [], []];

  const progressByKey = new Map<string, any>();
  progressRecords.forEach((progress: any) => {
    progressByKey.set(
      `${stringifyId(progress.userId)}:${stringifyId(progress.courseId)}`,
      progress
    );
  });

  let enrollments = rawEnrollments.filter((enrollment: any) =>
    isWithinDateRange(enrollment.createdAt, filters)
  );
  if (filters.completionStatus === "completed") {
    enrollments = enrollments.filter((enrollment: any) =>
      isEnrollmentCompleted(enrollment, progressByKey)
    );
  } else if (filters.completionStatus === "pending") {
    enrollments = enrollments.filter(
      (enrollment: any) => !isEnrollmentCompleted(enrollment, progressByKey)
    );
  } else if (filters.completionStatus === "not_started") {
    enrollments = enrollments.filter(
      (enrollment: any) =>
        String(enrollment.status) === "not_started" &&
        getEnrollmentProgress(enrollment, progressByKey) === 0
    );
  } else if (filters.completionStatus === "in_progress") {
    enrollments = enrollments.filter((enrollment: any) => {
      const value = getEnrollmentProgress(enrollment, progressByKey);
      return value > 0 && !isEnrollmentCompleted(enrollment, progressByKey);
    });
  }

  const completedEnrollments = enrollments.filter((enrollment: any) =>
    isEnrollmentCompleted(enrollment, progressByKey)
  );
  const pendingEnrollments = enrollments.filter(
    (enrollment: any) => !isEnrollmentCompleted(enrollment, progressByKey)
  );
  const progressValues = enrollments.map((enrollment: any) =>
    getEnrollmentProgress(enrollment, progressByKey)
  );
  const averageProgress = progressValues.length
    ? Math.round(progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length)
    : null;

  const quizPercentages = quizAttempts
    .filter((attempt: any) => isWithinDateRange(attempt.submittedAt || attempt.createdAt, filters))
    .map((attempt: any) => Number(attempt.percentage))
    .filter((value: number) => Number.isFinite(value));
  const averageQuizScore = quizPercentages.length
    ? Math.round(
        quizPercentages.reduce((sum: number, value: number) => sum + value, 0) /
          quizPercentages.length
      )
    : null;

  const usersByRoleMap = new Map<string, number>();
  users.forEach((user: any) => {
    const role = normalizeUserRole(user);
    usersByRoleMap.set(role, (usersByRoleMap.get(role) || 0) + 1);
  });

  const coursesByStatusMap = new Map<string, number>();
  courses.forEach((course: any) => {
    const status = String(course.status || "draft").toLowerCase();
    coursesByStatusMap.set(status, (coursesByStatusMap.get(status) || 0) + 1);
  });

  const batchesByStatusMap = new Map<string, number>();
  batches.forEach((batch: any) => {
    const status = getBatchStatus(batch.startDate, batch.endDate);
    batchesByStatusMap.set(status, (batchesByStatusMap.get(status) || 0) + 1);
  });

  const enrollmentsByStatusMap = new Map<string, number>([
    ["Completed", 0],
    ["In progress", 0],
    ["Not started", 0],
  ]);
  enrollments.forEach((enrollment: any) => {
    const progress = getEnrollmentProgress(enrollment, progressByKey);
    const label = isEnrollmentCompleted(enrollment, progressByKey)
      ? "Completed"
      : progress > 0
        ? "In progress"
        : "Not started";
    enrollmentsByStatusMap.set(label, (enrollmentsByStatusMap.get(label) || 0) + 1);
  });

  const progressDistributionMap = new Map<string, number>([
    ["0%", 0],
    ["1-49%", 0],
    ["50-79%", 0],
    ["80-99%", 0],
    ["100%", 0],
  ]);
  progressValues.forEach((progress) => {
    const label =
      progress <= 0
        ? "0%"
        : progress < 50
          ? "1-49%"
          : progress < 80
            ? "50-79%"
            : progress < 100
              ? "80-99%"
              : "100%";
    progressDistributionMap.set(label, (progressDistributionMap.get(label) || 0) + 1);
  });

  const quizPerformanceMap = new Map<string, number>([
    ["80-100%", 0],
    ["60-79%", 0],
    ["Below 60%", 0],
  ]);
  quizPercentages.forEach((percentage) => {
    const label = percentage >= 80 ? "80-100%" : percentage >= 60 ? "60-79%" : "Below 60%";
    quizPerformanceMap.set(label, (quizPerformanceMap.get(label) || 0) + 1);
  });

  const activeUsers = users.filter(isUserActive);
  const learners = users.filter(isLearner);
  const managers = users.filter(isManager);
  const departmentHeads = users.filter(
    (user: any) => normalizeUserRole(user) === "departmenthead"
  );
  const admins = users.filter((user: any) => normalizeUserRole(user) === "admin");

  const enrollmentByUser = new Map<string, any[]>();
  enrollments.forEach((enrollment: any) => {
    const userId = stringifyId(enrollment.userId);
    enrollmentByUser.set(userId, [...(enrollmentByUser.get(userId) || []), enrollment]);
  });

  const progressByUser = new Map<string, any[]>();
  progressRecords.forEach((progress: any) => {
    const userId = stringifyId(progress.userId);
    progressByUser.set(userId, [...(progressByUser.get(userId) || []), progress]);
  });

  const quizByUser = new Map<string, any[]>();
  quizAttempts.forEach((attempt: any) => {
    const userId = stringifyId(attempt.userId);
    quizByUser.set(userId, [...(quizByUser.get(userId) || []), attempt]);
  });

  const learnerRows = learners.map((user: any) => {
    const id = stringifyId(user._id);
    const userEnrollments = enrollmentByUser.get(id) || [];
    const userProgress = progressByUser.get(id) || [];
    const userQuizAttempts = quizByUser.get(id) || [];
    const progress = userEnrollments.length
      ? Math.round(
          userEnrollments.reduce(
            (sum, enrollment) => sum + getEnrollmentProgress(enrollment, progressByKey),
            0
          ) / userEnrollments.length
        )
      : 0;
    const completed = userEnrollments.filter((enrollment) =>
      isEnrollmentCompleted(enrollment, progressByKey)
    ).length;
    const lastActivity = userProgress
      .map((entry) => entry.lastAccessed || entry.updatedAt)
      .filter(Boolean)
      .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
    const quizScores = userQuizAttempts
      .map((attempt) => Number(attempt.percentage))
      .filter((value) => Number.isFinite(value));

    return {
      _id: user._id,
      name: user.name || user.email || user.username || "Unnamed learner",
      email: user.email || user.username || "",
      department: getDepartmentLabel(user),
      isActive: isUserActive(user),
      assignedCourses: userEnrollments.length,
      completedCourses: completed,
      pendingCourses: Math.max(userEnrollments.length - completed, 0),
      progress,
      averageQuizScore: quizScores.length
        ? Math.round(quizScores.reduce((sum, value) => sum + value, 0) / quizScores.length)
        : null,
      lastActivity,
    };
  });

  const engagementCutoff = new Date();
  engagementCutoff.setDate(engagementCutoff.getDate() - 30);
  const allLowEngagementUsers = learnerRows
    .filter(
      (learner) =>
        learner.assignedCourses > 0 &&
        (!learner.lastActivity || new Date(learner.lastActivity) < engagementCutoff)
    )
    .sort((left, right) => left.progress - right.progress);
  const lowEngagementUsers = allLowEngagementUsers.slice(0, 6);

  const topLearners = learnerRows
    .filter((learner) => learner.assignedCourses > 0)
    .sort((left, right) => {
      if (right.progress !== left.progress) {
        return right.progress - left.progress;
      }
      return (right.averageQuizScore || 0) - (left.averageQuizScore || 0);
    })
    .slice(0, 6);

  const now = new Date();
  const expiryCutoff = new Date(now);
  expiryCutoff.setDate(expiryCutoff.getDate() + 30);
  const allExpiringBatches = batches
    .filter((batch: any) => {
      if (!batch.endDate) {
        return false;
      }
      const endDate = new Date(batch.endDate);
      return endDate >= now && endDate <= expiryCutoff;
    })
    .map((batch: any) => ({
      _id: batch._id,
      name: batch.name,
      endDate: batch.endDate,
      userCount: (batch.userIds || []).filter((userId: any) =>
        filteredUserIdSet.has(stringifyId(userId))
      ).length,
    }));

  const allExpiringEnrollments = enrollments
    .filter((enrollment: any) => {
      const deadline = enrollment.dueDate || enrollment.validTill;
      if (!deadline || isEnrollmentCompleted(enrollment, progressByKey)) {
        return false;
      }
      const date = new Date(deadline);
      return date >= now && date <= expiryCutoff;
    })
    .map((enrollment: any) => ({
      _id: enrollment._id,
      learnerName:
        userById.get(stringifyId(enrollment.userId))?.name ||
        userById.get(stringifyId(enrollment.userId))?.email ||
        "Learner",
      courseTitle: courseById.get(stringifyId(enrollment.courseId))?.title || "Course",
      deadline: enrollment.dueDate || enrollment.validTill,
      progress: getEnrollmentProgress(enrollment, progressByKey),
    }));
  const expiringBatches = allExpiringBatches.slice(0, 5);
  const expiringEnrollments = allExpiringEnrollments.slice(0, 6);

  const pendingReviews = scormTracking.reduce((total: number, tracking: any) => {
    return (
      total +
      (tracking.interactions || []).filter(
        (interaction: any) => interaction?.review?.status === "pending"
      ).length
    );
  }, 0);

  const departmentProgress =
    scope.role === "admin"
      ? departments
          .map((department: any) => {
            const departmentValues = [
              department.departmentName,
              department.title,
              department.code,
            ]
              .map((value) => String(value || "").trim().toLowerCase())
              .filter(Boolean);
            const departmentUserIds = new Set(
              users
                .filter((user: any) =>
                  departmentValues.includes(String(user.department || "").trim().toLowerCase())
                )
                .map((user: any) => stringifyId(user._id))
            );
            const departmentEnrollments = enrollments.filter((enrollment: any) =>
              departmentUserIds.has(stringifyId(enrollment.userId))
            );
            const completed = departmentEnrollments.filter((enrollment: any) =>
              isEnrollmentCompleted(enrollment, progressByKey)
            ).length;
            const progress = departmentEnrollments.length
              ? Math.round(
                  departmentEnrollments.reduce(
                    (sum: number, enrollment: any) =>
                      sum + getEnrollmentProgress(enrollment, progressByKey),
                    0
                  ) / departmentEnrollments.length
                )
              : 0;

            return {
              label: department.departmentName || department.code || "Department",
              value: progress,
              users: departmentUserIds.size,
              completionRate: departmentEnrollments.length
                ? Math.round((completed / departmentEnrollments.length) * 100)
                : 0,
            };
          })
          .filter((entry) => entry.users > 0)
          .sort((left, right) => right.value - left.value)
      : [];

  const courseEnrollmentMap = new Map<string, number>();
  enrollments.forEach((enrollment: any) => {
    const courseId = stringifyId(enrollment.courseId);
    courseEnrollmentMap.set(courseId, (courseEnrollmentMap.get(courseId) || 0) + 1);
  });
  const topCourses = courses
    .map((course: any) => ({
      _id: course._id,
      title: course.title || "Untitled course",
      status: course.status || "draft",
      enrollmentCount: courseEnrollmentMap.get(stringifyId(course._id)) || 0,
      popularityScore: Number(course.metrics?.popularityScore || 0),
    }))
    .sort((left, right) => {
      if (right.enrollmentCount !== left.enrollmentCount) {
        return right.enrollmentCount - left.enrollmentCount;
      }
      return right.popularityScore - left.popularityScore;
    })
    .slice(0, 5);

  const batchProgress = batches.slice(0, 6).map((batch: any) => {
    const batchUserIds = new Set(
      (batch.userIds || [])
        .map(stringifyId)
        .filter((userId: string) => filteredUserIdSet.has(userId))
    );
    const batchCourseIds = new Set((batch.courseIds || []).map(stringifyId));
    const batchEnrollments = enrollments.filter(
      (enrollment: any) =>
        batchUserIds.has(stringifyId(enrollment.userId)) &&
        batchCourseIds.has(stringifyId(enrollment.courseId))
    );
    const completed = batchEnrollments.filter((enrollment: any) =>
      isEnrollmentCompleted(enrollment, progressByKey)
    ).length;

    return {
      _id: batch._id,
      name: batch.name || "Batch",
      status: getBatchStatus(batch.startDate, batch.endDate),
      userCount: batchUserIds.size,
      courseCount: batchCourseIds.size,
      completionRate: batchEnrollments.length
        ? Math.round((completed / batchEnrollments.length) * 100)
        : 0,
      endDate: batch.endDate,
    };
  });

  const recentActivity = [
    ...users.slice(0, 5).map((user: any) => ({
      id: `user-${user._id}`,
      type: "user",
      title: user.name || user.email || user.username || "New user",
      detail: `${normalizeUserRole(user)} · ${getDepartmentLabel(user)}`,
      createdAt: user.createdAt,
    })),
    ...progressRecords.map((progress: any) => ({
      id: `progress-${progress._id}`,
      type: "progress",
      title:
        userById.get(stringifyId(progress.userId))?.name ||
        userById.get(stringifyId(progress.userId))?.email ||
        "Learner activity",
      detail: `${courseById.get(stringifyId(progress.courseId))?.title || "Course"} · ${Math.round(
        Number(progress.progress || 0)
      )}%`,
      createdAt: progress.lastAccessed || progress.updatedAt,
    })),
    ...quizAttempts.map((attempt: any) => ({
      id: `quiz-${attempt._id}`,
      type: "quiz",
      title:
        userById.get(stringifyId(attempt.userId))?.name ||
        userById.get(stringifyId(attempt.userId))?.email ||
        "Quiz attempt",
      detail: `${courseById.get(stringifyId(attempt.courseId))?.title || "Course"} · ${Math.round(
        Number(attempt.percentage || 0)
      )}%`,
      createdAt: attempt.submittedAt || attempt.updatedAt,
    })),
    ...batches.slice(0, 4).map((batch: any) => ({
      id: `batch-${batch._id}`,
      type: "batch",
      title: batch.name || "Batch",
      detail: `${getBatchStatus(batch.startDate, batch.endDate)} batch`,
      createdAt: batch.createdAt,
    })),
  ]
    .filter((item) => item.createdAt && isWithinDateRange(item.createdAt, filters))
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    )
    .slice(0, 8);

  const completionTrendSource = completedEnrollments.map((enrollment: any) => ({
    completedAt: enrollment.updatedAt || enrollment.createdAt,
  }));
  const engagementTrendSource = progressRecords.map((progress: any) => ({
    activityAt: progress.lastAccessed || progress.updatedAt,
  }));
  const roles = [...new Set(allScopedUsers.map(normalizeUserRole).filter(Boolean))].sort();

  return {
    role: scope.role,
    scope: {
      companyId: scope.company._id,
      companyName: scope.company.company_name || null,
      departmentId: scope.department?._id || null,
      departmentName: scope.department?.departmentName || actor?.department || null,
    },
    appliedFilters: {
      from: filters.from || null,
      to: filters.to || null,
      departmentId: selectedDepartment?._id || "",
      role: filters.role || "",
      userId: filters.userId || "",
      courseId: filters.courseId || "",
      batchStatus: filters.batchStatus || "",
      completionStatus: filters.completionStatus || "",
      activityStatus: filters.activityStatus || "",
    },
    filterOptions: {
      departments:
        scope.role === "admin"
          ? departments.map((department: any) => ({
              value: stringifyId(department._id),
              label: department.departmentName || department.code || "Department",
            }))
          : [],
      roles: roles.map((role) => ({ value: role, label: role })),
      users: allScopedUsers
        .filter(isLearner)
        .map((user: any) => ({
          value: stringifyId(user._id),
          label: user.name || user.email || user.username || "Learner",
        })),
      courses: allVisibleCourses.map((course: any) => ({
        value: stringifyId(course._id),
        label: course.title || "Untitled course",
      })),
    },
    stats: {
      totalCompanies: 1,
      totalUsers: users.length,
      activeUsers: activeUsers.length,
      inactiveUsers: Math.max(users.length - activeUsers.length, 0),
      learners: learners.length,
      managers: managers.length,
      departmentHeads: departmentHeads.length,
      admins: admins.length,
      totalDepartments: isDepartmentHead ? 1 : departments.length,
      totalCourses: courses.length,
      publishedCourses: courses.filter((course: any) => String(course.status) === "published").length,
      totalAssignments: assignments.filter(
        (assignment: any) =>
          !filters.courseId || stringifyId(assignment.courseId) === filters.courseId
      ).length,
      totalEnrollments: enrollments.length,
      completedEnrollments: completedEnrollments.length,
      pendingCompletions: pendingEnrollments.length,
      completionRate: enrollments.length
        ? Math.round((completedEnrollments.length / enrollments.length) * 100)
        : null,
      averageProgress,
      totalBatches: batches.length,
      activeBatches: batches.filter(
        (batch: any) => getBatchStatus(batch.startDate, batch.endDate) === "active"
      ).length,
      completedBatches: batches.filter(
        (batch: any) => getBatchStatus(batch.startDate, batch.endDate) === "completed"
      ).length,
      upcomingBatches: batches.filter(
        (batch: any) => getBatchStatus(batch.startDate, batch.endDate) === "upcoming"
      ).length,
      quizAttempts: quizPercentages.length,
      averageQuizScore,
      pendingReviews,
      lowEngagementUsers: allLowEngagementUsers.length,
      expiringItems: allExpiringBatches.length + allExpiringEnrollments.length,
    },
    charts: {
      usersByRole: buildChartEntries(usersByRoleMap),
      userActivity: [
        { label: "Active", value: activeUsers.length },
        { label: "Inactive", value: Math.max(users.length - activeUsers.length, 0) },
      ],
      coursesByStatus: buildChartEntries(coursesByStatusMap),
      batchesByStatus: buildChartEntries(batchesByStatusMap),
      enrollmentsByStatus: buildChartEntries(enrollmentsByStatusMap),
      progressDistribution: buildChartEntries(progressDistributionMap),
      quizPerformance: buildChartEntries(quizPerformanceMap),
      completionTrend: buildMonthlyTrend(completionTrendSource, "completedAt"),
      engagementTrend: buildMonthlyTrend(engagementTrendSource, "activityAt"),
      departmentProgress,
    },
    highlights: {
      topCourses,
      recentUsers: users.slice(0, 6).map((user: any) => ({
        _id: user._id,
        name: user.name || user.email || user.username || "Unnamed user",
        email: user.email || user.username || "",
        role: normalizeUserRole(user),
        department: getDepartmentLabel(user),
        isActive: isUserActive(user),
        createdAt: user.createdAt,
      })),
      recentActivity,
      lowEngagementUsers,
      topLearners,
      learnerProgress: learnerRows
        .sort((left, right) => left.progress - right.progress)
        .slice(0, 8),
      expiringBatches,
      expiringEnrollments,
      batchProgress,
    },
    availability: {
      learnerProgress: enrollments.length > 0 || progressRecords.length > 0,
      quizPerformance: quizPercentages.length > 0,
      pendingReviews: scormTracking.length > 0,
      departmentProgress: departmentProgress.length > 0,
      deadlines: expiringBatches.length > 0 || expiringEnrollments.length > 0,
    },
  };
}

export const getScopedDashboardSummaryService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const actor = req.bodyData || req.user;
    const role = normalizeRole(actor?.role || actor?.userType);
    ensurePermission(
      actor,
      PERMISSION_KEYS.VIEW_DASHBOARD,
      "You do not have permission to view the dashboard"
    );

    if (!["superadmin", "admin", "departmenthead"].includes(role)) {
      throw generateError(
        "This dashboard is only available to superadmin, admin, and department head accounts",
        403
      );
    }

    const data =
      role === "superadmin"
        ? await buildSuperadminDashboardSummary(req.query)
        : await buildScopedDashboardSummary(actor, req.query);

    return res.status(200).send({
      status: "success",
      message: "Dashboard summary fetched successfully",
      data,
    });
  } catch (err: any) {
    next(err);
  }
};
