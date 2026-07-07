import mongoose from "mongoose";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import Course from "../../schemas/course/Course";
import CourseAccess from "../../schemas/course/CourseAccess";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import Batch from "../../schemas/course/Batch";
import CourseQuizAttempt from "../../schemas/course/CourseQuizAttempt";
import UserCourseProgress from "../../schemas/course/UserCourseProgress";
import ScormTracking from "../../schemas/course/ScormTracking";
import { normalizeRole } from "../courseAccess/utils/accessControl";

type DashboardFilters = {
  from?: Date;
  to?: Date;
  companyId?: string;
  role?: string;
  courseId?: string;
  batchStatus?: string;
  activityStatus?: string;
};

const COMPLETED_LESSON_STATUSES = new Set(["completed", "passed"]);
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

function parseObjectId(value?: string) {
  return value && mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : undefined;
}

function buildDateMatch(from?: Date, to?: Date) {
  if (!from && !to) {
    return undefined;
  }

  return {
    ...(from ? { $gte: from } : {}),
    ...(to ? { $lte: to } : {}),
  };
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

function buildChartEntries(map: Map<string, number>) {
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value);
}

function getMonthBuckets(count = 6) {
  const buckets: Array<{ key: string; label: string; start: Date; end: Date }> = [];
  const now = new Date();

  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0, 23, 59, 59, 999);
    buckets.push({
      key: `${start.getFullYear()}-${start.getMonth()}`,
      label: start.toLocaleString("en-US", { month: "short" }),
      start,
      end,
    });
  }

  return buckets;
}

function buildMonthlyTrend(items: any[], dateKey: string) {
  const buckets = getMonthBuckets();

  return buckets.map((bucket) => ({
    label: bucket.label,
    value: items.filter((item) => {
      const rawDate = item?.[dateKey];
      if (!rawDate) {
        return false;
      }

      const date = new Date(rawDate);
      return date >= bucket.start && date <= bucket.end;
    }).length,
  }));
}

function normalizeUserRole(user: any) {
  return normalizeRole(user?.role || user?.userType || "user") || "user";
}

function isUserActive(user: any) {
  return user?.is_active === true && user?.is_enabled !== false;
}

function getCompanyName(companyById: Map<string, any>, companyId: any) {
  return companyById.get(stringifyId(companyId))?.company_name || "Unassigned";
}

function getFilters(query: any): DashboardFilters {
  return {
    from: parseDate(query?.from),
    to: parseDate(query?.to, true),
    companyId: stringifyId(query?.companyId),
    role: String(query?.role || "").trim().toLowerCase(),
    courseId: stringifyId(query?.courseId),
    batchStatus: String(query?.batchStatus || "").trim().toLowerCase(),
    activityStatus: String(query?.activityStatus || "").trim().toLowerCase(),
  };
}

export async function buildSuperadminDashboardSummary(query: any) {
  const filters = getFilters(query);
  const createdAtMatch = buildDateMatch(filters.from, filters.to);
  const selectedCompanyId = parseObjectId(filters.companyId);
  const selectedCourseId = parseObjectId(filters.courseId);

  const allCompanies = await Company.find({ deletedAt: { $exists: false } })
    .select("_id company_name companyEmail is_active createdAt")
    .sort({ createdAt: -1 })
    .lean();
  const companyById = new Map(allCompanies.map((company: any) => [stringifyId(company._id), company]));

  const companyScope = allCompanies.filter((company: any) => {
    if (selectedCompanyId && stringifyId(company._id) !== filters.companyId) {
      return false;
    }

    if (filters.from && new Date(company.createdAt || 0) < filters.from) {
      return false;
    }

    if (filters.to && new Date(company.createdAt || 0) > filters.to) {
      return false;
    }

    return true;
  });

  const userMatch: any = {
    deletedAt: { $exists: false },
    ...(selectedCompanyId ? { company: selectedCompanyId } : {}),
    ...(createdAtMatch ? { createdAt: createdAtMatch } : {}),
  };

  if (filters.role) {
    userMatch.$or = [{ role: filters.role }, { userType: filters.role }];
  }

  if (filters.activityStatus === "active") {
    userMatch.is_active = true;
    userMatch.is_enabled = { $ne: false };
  } else if (filters.activityStatus === "inactive") {
    userMatch.$and = [
      {
        $or: [
          { is_active: { $ne: true } },
          { is_enabled: false },
        ],
      },
    ];
  }

  const users = await User.find(userMatch)
    .select("_id name email username role userType company department is_active is_enabled createdAt")
    .sort({ createdAt: -1 })
    .lean();
  const userIds = users.map((user: any) => user._id);

  const companyCourseIds = selectedCompanyId
    ? await CourseAccess.find({ companyId: selectedCompanyId }).distinct("courseId")
    : [];

  const courseMatch: any = {
    ...(createdAtMatch ? { createdAt: createdAtMatch } : {}),
  };

  if (selectedCourseId) {
    courseMatch._id = selectedCourseId;
  } else if (selectedCompanyId) {
    courseMatch.$or = [
      { company: selectedCompanyId },
      { _id: { $in: companyCourseIds } },
    ];
  }

  const courses = await Course.find(courseMatch)
    .select("_id title status taxonomy company createdAt metrics")
    .sort({ createdAt: -1 })
    .lean();
  const courseIds = courses.map((course: any) => course._id);
  const courseById = new Map(courses.map((course: any) => [stringifyId(course._id), course]));

  const batchMatch: any = {
    ...(selectedCompanyId ? { companyId: selectedCompanyId } : {}),
    ...(selectedCourseId ? { courseIds: selectedCourseId } : {}),
    ...(createdAtMatch ? { createdAt: createdAtMatch } : {}),
  };
  let batches = await Batch.find(batchMatch)
    .select("_id name companyId courseIds userIds startDate endDate createdAt")
    .sort({ createdAt: -1 })
    .lean();

  if (filters.batchStatus) {
    batches = batches.filter(
      (batch: any) => getBatchStatus(batch.startDate, batch.endDate) === filters.batchStatus
    );
  }

  const enrollmentMatch: any = {
    ...(userIds.length ? { userId: { $in: userIds } } : { userId: { $in: [] } }),
    ...(courseIds.length ? { courseId: { $in: courseIds } } : { courseId: { $in: [] } }),
    ...(createdAtMatch ? { createdAt: createdAtMatch } : {}),
  };
  const enrollments = await CourseEnrollment.find(enrollmentMatch)
    .select("_id courseId userId status progressPercent validTill dueDate createdAt updatedAt")
    .lean();

  const progressMatch: any = {
    ...(userIds.length ? { userId: { $in: userIds } } : { userId: { $in: [] } }),
    ...(courseIds.length ? { courseId: { $in: courseIds } } : { courseId: { $in: [] } }),
  };
  const [progressRecords, quizAttempts, scormTracking] = await Promise.all([
    UserCourseProgress.find(progressMatch)
      .select("userId courseId lessonStatus progress score lastAccessed createdAt updatedAt")
      .lean(),
    CourseQuizAttempt.find(progressMatch)
      .select("userId courseId percentage score maxScore submittedAt createdAt updatedAt")
      .lean(),
    ScormTracking.find(progressMatch)
      .select("userId courseId lessonStatus score lastAccessed interactions.review.status")
      .lean(),
  ]);

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

  const enrollmentsByStatusMap = new Map<string, number>();
  enrollments.forEach((enrollment: any) => {
    const status = String(enrollment.status || "not_started");
    enrollmentsByStatusMap.set(status, (enrollmentsByStatusMap.get(status) || 0) + 1);
  });

  const progressByEnrollment = new Map<string, any>();
  progressRecords.forEach((progress: any) => {
    progressByEnrollment.set(`${stringifyId(progress.userId)}:${stringifyId(progress.courseId)}`, progress);
  });

  const completedEnrollments = enrollments.filter((enrollment: any) => {
    if (String(enrollment.status) === "completed") {
      return true;
    }

    const progress = progressByEnrollment.get(
      `${stringifyId(enrollment.userId)}:${stringifyId(enrollment.courseId)}`
    );
    return COMPLETED_LESSON_STATUSES.has(String(progress?.lessonStatus || ""));
  });

  const progressValues = enrollments
    .map((enrollment: any) => {
      const progress = progressByEnrollment.get(
        `${stringifyId(enrollment.userId)}:${stringifyId(enrollment.courseId)}`
      );
      return Number(progress?.progress ?? enrollment.progressPercent);
    })
    .filter((value: number) => Number.isFinite(value));
  const averageProgress = progressValues.length
    ? Math.round(progressValues.reduce((sum: number, value: number) => sum + value, 0) / progressValues.length)
    : null;

  const quizPercentages = quizAttempts
    .map((attempt: any) => Number(attempt.percentage))
    .filter((value: number) => Number.isFinite(value));
  const averageQuizScore = quizPercentages.length
    ? Math.round(quizPercentages.reduce((sum: number, value: number) => sum + value, 0) / quizPercentages.length)
    : null;
  const quizPerformanceMap = new Map<string, number>([
    ["80-100%", 0],
    ["60-79%", 0],
    ["Below 60%", 0],
  ]);
  quizPercentages.forEach((percentage: number) => {
    const band = percentage >= 80 ? "80-100%" : percentage >= 60 ? "60-79%" : "Below 60%";
    quizPerformanceMap.set(band, (quizPerformanceMap.get(band) || 0) + 1);
  });

  const pendingReviewCount = scormTracking.reduce((total: number, tracking: any) => {
    const pending = (tracking.interactions || []).filter(
      (interaction: any) => interaction?.review?.status === "pending"
    ).length;
    return total + pending;
  }, 0);

  const activeUsers = users.filter(isUserActive);
  const admins = users.filter((user: any) =>
    ["admin", "superadmin"].includes(normalizeUserRole(user))
  ).length;
  const managers = users.filter((user: any) =>
    ["manager", "departmenthead"].includes(normalizeUserRole(user))
  ).length;
  const learners = users.filter((user: any) => LEARNER_ROLES.has(normalizeUserRole(user)));

  const userDistributionMap = new Map<string, number>();
  users.forEach((user: any) => {
    const companyName = getCompanyName(companyById, user.company);
    userDistributionMap.set(companyName, (userDistributionMap.get(companyName) || 0) + 1);
  });

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
    }))
    .sort((left, right) => right.enrollmentCount - left.enrollmentCount)
    .slice(0, 5);

  const now = new Date();
  const engagementCutoff = new Date(now);
  engagementCutoff.setDate(engagementCutoff.getDate() - 30);
  const recentlyEngagedUserIds = new Set(
    progressRecords
      .filter((progress: any) => new Date(progress.lastAccessed || progress.updatedAt) >= engagementCutoff)
      .map((progress: any) => stringifyId(progress.userId))
  );
  const enrolledUserIds = new Set(enrollments.map((enrollment: any) => stringifyId(enrollment.userId)));

  const lowEngagementLearners = learners.filter(
    (user: any) =>
      enrolledUserIds.has(stringifyId(user._id)) &&
      !recentlyEngagedUserIds.has(stringifyId(user._id))
  );
  const lowEngagementUsers = lowEngagementLearners
    .slice(0, 6)
    .map((user: any) => ({
      _id: user._id,
      name: user.name || user.email || user.username || "Unnamed learner",
      email: user.email || user.username || "",
      companyName: getCompanyName(companyById, user.company),
      lastActivity: null,
    }));

  const engagementByCompany = new Map<
    string,
    { companyId: string; name: string; learners: number; activeLearners: number }
  >();
  learners.forEach((user: any) => {
    const companyId = stringifyId(user.company);
    if (!companyId) {
      return;
    }

    if (!engagementByCompany.has(companyId)) {
      engagementByCompany.set(companyId, {
        companyId,
        name: getCompanyName(companyById, companyId),
        learners: 0,
        activeLearners: 0,
      });
    }

    const entry = engagementByCompany.get(companyId)!;
    entry.learners += 1;
    if (recentlyEngagedUserIds.has(stringifyId(user._id))) {
      entry.activeLearners += 1;
    }
  });
  const lowEngagementCompanies = Array.from(engagementByCompany.values())
    .map((entry) => ({
      ...entry,
      engagementRate: entry.learners
        ? Math.round((entry.activeLearners / entry.learners) * 100)
        : 0,
    }))
    .filter((entry) => entry.learners > 0)
    .sort((left, right) => left.engagementRate - right.engagementRate)
    .slice(0, 5);

  const expiryCutoff = new Date(now);
  expiryCutoff.setDate(expiryCutoff.getDate() + 30);
  const expiringBatches = batches
    .filter((batch: any) => {
      if (!batch.endDate) {
        return false;
      }
      const endDate = new Date(batch.endDate);
      return endDate >= now && endDate <= expiryCutoff;
    })
    .slice(0, 5)
    .map((batch: any) => ({
      _id: batch._id,
      name: batch.name,
      companyName: getCompanyName(companyById, batch.companyId),
      endDate: batch.endDate,
      userCount: (batch.userIds || []).length,
    }));

  const expiringEnrollments = enrollments
    .filter((enrollment: any) => {
      if (!enrollment.validTill) {
        return false;
      }
      const validTill = new Date(enrollment.validTill);
      return validTill >= now && validTill <= expiryCutoff;
    })
    .slice(0, 5)
    .map((enrollment: any) => ({
      _id: enrollment._id,
      courseTitle: courseById.get(stringifyId(enrollment.courseId))?.title || "Course",
      validTill: enrollment.validTill,
    }));

  const recentActivity = [
    ...companyScope.slice(0, 4).map((company: any) => ({
      id: `company-${company._id}`,
      type: "company",
      title: company.company_name || "New company",
      detail: company.is_active ? "Active company added" : "Company added",
      createdAt: company.createdAt,
    })),
    ...users.slice(0, 5).map((user: any) => ({
      id: `user-${user._id}`,
      type: "user",
      title: user.name || user.email || user.username || "New user",
      detail: `${normalizeUserRole(user)} · ${getCompanyName(companyById, user.company)}`,
      createdAt: user.createdAt,
    })),
    ...courses.slice(0, 4).map((course: any) => ({
      id: `course-${course._id}`,
      type: "course",
      title: course.title || "New course",
      detail: `Course ${course.status || "draft"}`,
      createdAt: course.createdAt,
    })),
    ...batches.slice(0, 4).map((batch: any) => ({
      id: `batch-${batch._id}`,
      type: "batch",
      title: batch.name || "New batch",
      detail: `${getBatchStatus(batch.startDate, batch.endDate)} · ${getCompanyName(
        companyById,
        batch.companyId
      )}`,
      createdAt: batch.createdAt,
    })),
  ]
    .filter((item) => item.createdAt)
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    )
    .slice(0, 8);

  const completionTrendSource = completedEnrollments.map((enrollment: any) => ({
    completedAt: enrollment.updatedAt || enrollment.createdAt,
  }));

  const allRoles = new Set<string>();
  const allUsersForOptions = await User.find({ deletedAt: { $exists: false } })
    .select("role userType")
    .lean();
  allUsersForOptions.forEach((user: any) => allRoles.add(normalizeUserRole(user)));

  return {
    role: "superadmin",
    scope: {
      companyId: filters.companyId || null,
      companyName: selectedCompanyId
        ? companyById.get(filters.companyId || "")?.company_name || null
        : null,
      departmentId: null,
      departmentName: null,
    },
    appliedFilters: {
      from: filters.from || null,
      to: filters.to || null,
      companyId: filters.companyId || "",
      role: filters.role || "",
      courseId: filters.courseId || "",
      batchStatus: filters.batchStatus || "",
      activityStatus: filters.activityStatus || "",
    },
    filterOptions: {
      companies: allCompanies.map((company: any) => ({
        value: stringifyId(company._id),
        label: company.company_name || "Unnamed company",
      })),
      roles: Array.from(allRoles)
        .filter(Boolean)
        .sort()
        .map((role) => ({ value: role, label: role })),
      courses: await Course.find({})
        .select("_id title")
        .sort({ title: 1 })
        .lean()
        .then((items: any[]) =>
          items.map((course: any) => ({
            value: stringifyId(course._id),
            label: course.title || "Untitled course",
          }))
        ),
    },
    stats: {
      totalCompanies: companyScope.length,
      activeCompanies: companyScope.filter((company: any) => company.is_active === true).length,
      inactiveCompanies: companyScope.filter((company: any) => company.is_active !== true).length,
      totalUsers: users.length,
      activeUsers: activeUsers.length,
      inactiveUsers: Math.max(users.length - activeUsers.length, 0),
      admins,
      managers,
      learners: learners.length,
      totalCourses: courses.length,
      publishedCourses: courses.filter((course: any) => course.status === "published").length,
      unpublishedCourses: courses.filter((course: any) => course.status !== "published").length,
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
      totalEnrollments: enrollments.length,
      completedEnrollments: completedEnrollments.length,
      completionRate: enrollments.length
        ? Math.round((completedEnrollments.length / enrollments.length) * 100)
        : null,
      averageProgress,
      quizAttempts: quizAttempts.length,
      averageQuizScore,
      pendingReviews: pendingReviewCount,
      lowEngagementUsers: lowEngagementLearners.length,
      expiringItems: expiringBatches.length + expiringEnrollments.length,
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
      companyUserDistribution: buildChartEntries(userDistributionMap).slice(0, 8),
      quizPerformance: buildChartEntries(quizPerformanceMap),
      userGrowth: buildMonthlyTrend(users, "createdAt"),
      completionTrend: buildMonthlyTrend(completionTrendSource, "completedAt"),
    },
    highlights: {
      topCourses,
      recentUsers: users.slice(0, 6).map((user: any) => ({
        _id: user._id,
        name: user.name || user.email || user.username || "Unnamed user",
        email: user.email || user.username || "",
        role: normalizeUserRole(user),
        companyName: getCompanyName(companyById, user.company),
        isActive: isUserActive(user),
        createdAt: user.createdAt,
      })),
      recentCompanies: companyScope.slice(0, 6).map((company: any) => ({
        _id: company._id,
        name: company.company_name || "Unnamed company",
        email: company.companyEmail || "",
        isActive: company.is_active === true,
        createdAt: company.createdAt,
      })),
      recentActivity,
      lowEngagementUsers,
      lowEngagementCompanies,
      expiringBatches,
      expiringEnrollments,
    },
    availability: {
      learnerProgress: progressRecords.length > 0 || enrollments.length > 0,
      quizPerformance: quizAttempts.length > 0,
      pendingReviews: scormTracking.length > 0,
    },
  };
}
