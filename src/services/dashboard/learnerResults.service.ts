import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import Company from "../../schemas/company/Company";
import Department from "../../schemas/Department/Department.schema";
import User from "../../schemas/User/User";
import Course from "../../schemas/course/Course";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import CourseQuizAttempt from "../../schemas/course/CourseQuizAttempt";
import ScormTracking from "../../schemas/course/ScormTracking";
import UserCourseProgress from "../../schemas/course/UserCourseProgress";
import UserSectionProgress from "../../schemas/course/UserSectionProgress";
import Batch from "../../schemas/course/Batch";
import {
  getDepartmentScopedUserMatch,
  normalizeRole,
  resolveDepartmentRecord,
  toObjectId,
} from "../courseAccess/utils/accessControl";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import {
  buildCourseHierarchyProgress,
  buildCourseStructureLookup,
  formatScorm12Time,
  parseScorm12Time,
  serializeCourseHierarchyModules,
} from "../scorm/scormTracking.helpers";
import { serializeScormTrackingRecord } from "../scorm/scormAnswerReview.helpers";
import {
  getCourseQuizAnswerSectionsForUser,
} from "../course/courseQuiz.service";

const LEARNER_ROLES = new Set(["learner", "student", "patient", "user"]);
const COMPLETED_STATUSES = new Set(["completed", "passed"]);

function stringifyId(value: any) {
  return value ? String(value) : "";
}

function isObjectId(value: unknown) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function parseDate(value: unknown, endOfDay = false) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return date;
}

function parseNumber(value: unknown) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeSearch(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function isLearner(user: any) {
  return LEARNER_ROLES.has(normalizeRole(user?.role || user?.userType || "user"));
}

function isActive(user: any) {
  return user?.is_active === true && user?.is_enabled !== false;
}

function maxDate(values: any[]) {
  const dates = values
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());
  return dates[0] || null;
}

function average(values: any[]) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length
    ? Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 100) / 100
    : null;
}

function getEnrollmentProgress(enrollment: any, progress: any) {
  const value = Number(progress?.progress ?? enrollment?.progressPercent ?? 0);
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function isCompleted(enrollment: any, progress: any) {
  return (
    normalizeStatus(enrollment?.status) === "completed" ||
    COMPLETED_STATUSES.has(normalizeStatus(progress?.lessonStatus)) ||
    getEnrollmentProgress(enrollment, progress) >= 100
  );
}

function getPassThreshold(enrollment: any, course: any) {
  const passingMarks = Number(
    enrollment?.assessmentCriteria?.passingMarks ?? course?.assessment?.passingMarks
  );
  const totalMarks = Number(
    enrollment?.assessmentCriteria?.totalMarks ?? course?.assessment?.totalMarks
  );
  if (!Number.isFinite(passingMarks)) return null;
  if (Number.isFinite(totalMarks) && totalMarks > 0) {
    return Math.max(0, Math.min(100, (passingMarks / totalMarks) * 100));
  }
  return Math.max(0, Math.min(100, passingMarks));
}

function getPassStatus(score: number | null, threshold: number | null, lessonStatus: string) {
  if (lessonStatus === "passed") return "passed";
  if (lessonStatus === "failed") return "failed";
  if (score === null || threshold === null) return "not_available";
  return score >= threshold ? "passed" : "failed";
}

function getBatchDetails(enrollment: any) {
  return (enrollment?.sources || [])
    .filter((source: any) => source?.type === "batch")
    .map((source: any) => ({
      _id: stringifyId(source.batchId),
      name: String(source.batchName || "Batch"),
    }));
}

async function resolveActorScope(actor: any) {
  const role = normalizeRole(actor?.role || actor?.userType);
  if (!["superadmin", "admin", "departmenthead"].includes(role)) {
    throw generateError("Learner results are not available for this role", 403);
  }

  ensurePermission(
    actor,
    PERMISSION_KEYS.VIEW_LEARNER_PROGRESS_RESULTS,
    "You do not have permission to view learner progress and results"
  );

  if (role === "superadmin") {
    return { role, companyId: "", department: null };
  }

  const companyId = stringifyId(actor?.company || actor?.companyId);
  if (!isObjectId(companyId)) {
    throw generateError("This account is missing a valid company scope", 403);
  }

  const company = await Company.findById(companyId).select("_id").lean();
  if (!company) {
    throw generateError("The company assigned to this account no longer exists", 403);
  }

  if (role === "admin") {
    return { role, companyId, department: null };
  }

  const departmentName = String(actor?.department || "").trim();
  const department = departmentName
    ? await resolveDepartmentRecord({ companyId, departmentName }).catch(() => null)
    : null;
  if (!department) {
    throw generateError("Department head is not mapped to a valid department", 403);
  }

  return { role, companyId, department };
}

function buildUserMatch(scope: any, query: any) {
  const match: any = {
    deletedAt: { $exists: false },
    $or: [
      { role: { $in: Array.from(LEARNER_ROLES) } },
      { userType: { $in: Array.from(LEARNER_ROLES) } },
    ],
  };

  if (scope.role === "superadmin") {
    if (query.companyId && isObjectId(query.companyId)) {
      match.company = toObjectId(query.companyId);
    }
  } else {
    match.company = toObjectId(scope.companyId);
  }

  if (scope.role === "departmenthead") {
    Object.assign(match, getDepartmentScopedUserMatch(scope.department));
  } else if (query.departmentId && isObjectId(query.departmentId)) {
    match.department = { $exists: true };
  }

  if (query.userId && isObjectId(query.userId)) {
    match._id = toObjectId(query.userId);
  }

  return match;
}

async function filterUsersByDepartment(users: any[], scope: any, query: any) {
  if (scope.role === "departmenthead" || !query.departmentId || !isObjectId(query.departmentId)) {
    return users;
  }

  const department = await Department.findById(query.departmentId)
    .select("_id company departmentName code")
    .lean();
  if (!department) return [];

  const allowedCompanyId =
    scope.role === "superadmin" ? stringifyId(query.companyId) : stringifyId(scope.companyId);
  if (allowedCompanyId && stringifyId(department.company) !== allowedCompanyId) {
    return [];
  }

  const departmentValues = [department.departmentName, department.code]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  return users.filter((user) =>
    departmentValues.includes(String(user.department || "").trim().toLowerCase())
  );
}

function buildRecordMaps(records: any[]) {
  const map = new Map<string, any[]>();
  records.forEach((record) => {
    const key = `${stringifyId(record.userId)}:${stringifyId(record.courseId)}`;
    map.set(key, [...(map.get(key) || []), record]);
  });
  return map;
}

function summarizeResult(options: {
  enrollment: any;
  user: any;
  course: any;
  company: any;
  progress: any;
  sections: any[];
  quizzes: any[];
  tracking: any[];
}) {
  const { enrollment, user, course, company, progress, sections, quizzes, tracking } = options;
  const progressPercent = getEnrollmentProgress(enrollment, progress);
  const completed = isCompleted(enrollment, progress);
  const totalSections = Number(course?.curriculum?.totalSections || 0);
  const completedSections = sections.filter(
    (section) =>
      section?.isCompleted ||
      Boolean(section?.completedAt) ||
      COMPLETED_STATUSES.has(normalizeStatus(section?.lessonStatus)) ||
      Number(section?.progress || 0) >= 100
  ).length;
  const quizScores = quizzes.map((attempt) => attempt?.percentage);
  const scormScores = tracking.map((item) => item?.score);
  const score = average([
    ...quizScores,
    ...scormScores,
    ...(Number.isFinite(Number(progress?.score)) ? [progress.score] : []),
  ]);
  const passThreshold = getPassThreshold(enrollment, course);
  const lessonStatus = normalizeStatus(progress?.lessonStatus);
  const lastActivity = maxDate([
    progress?.lastAccessed,
    ...sections.map((section) => section?.lastAccessed || section?.updatedAt),
    ...quizzes.map((attempt) => attempt?.submittedAt || attempt?.updatedAt),
    ...tracking.map((item) => item?.lastAccessed || item?.updatedAt),
    enrollment?.updatedAt,
  ]);
  const completionDate = completed
    ? maxDate([
        ...sections.map((section) => section?.completedAt),
        enrollment?.updatedAt,
      ])
    : null;
  const submissionDate = maxDate([
    ...quizzes.map((attempt) => attempt?.submittedAt || attempt?.updatedAt),
    ...tracking.map((item) => item?.updatedAt || item?.lastAccessed),
  ]);
  const batches = getBatchDetails(enrollment);
  const sectionTime = formatScorm12Time(
    sections.reduce(
      (total, section) => total + (parseScorm12Time(section?.totalTime || "") || 0),
      0
    )
  );
  const timeSpent =
    progress?.totalTime && progress.totalTime !== "00:00:00"
      ? progress.totalTime
      : sectionTime;

  return {
    _id: stringifyId(enrollment._id),
    enrollmentId: stringifyId(enrollment._id),
    learner: {
      _id: stringifyId(user?._id),
      name: user?.name || user?.email || user?.username || "Unnamed learner",
      email: user?.email || user?.username || "",
      mobileNumber: user?.mobileNumber || "",
      department: user?.department || "Unassigned",
      isActive: isActive(user),
    },
    company: {
      _id: stringifyId(company?._id || user?.company),
      name: company?.company_name || "Unassigned",
    },
    course: {
      _id: stringifyId(course?._id),
      title: course?.title || "Course",
      status: normalizeStatus(course?.status) || "draft",
      totalSections,
    },
    batches,
    progressPercent,
    status: completed ? "completed" : progressPercent > 0 ? "in_progress" : "not_started",
    lessonStatus: lessonStatus || normalizeStatus(enrollment?.status) || "not_started",
    completedSections,
    totalSections,
    timeSpent: timeSpent || "00:00:00",
    attempts: quizzes.length + tracking.reduce(
      (total, item) => total + Math.max(1, Number(item?.attempts || 1)),
      0
    ),
    answerCount:
      quizzes.reduce((total, attempt) => total + (attempt?.answers?.length || 0), 0) +
      tracking.reduce(
        (total, item) =>
          total + Number(item?.interactionCount ?? item?.interactions?.length ?? 0),
        0
      ),
    score,
    passThreshold,
    passStatus: getPassStatus(score, passThreshold, lessonStatus),
    lastActivity,
    submissionDate,
    completionDate,
    quizAttempts: quizzes.length,
    scormAttempts: tracking.length,
    manualQuizResults: quizzes.map((attempt) => ({
      _id: stringifyId(attempt?._id),
      quizId: String(attempt?.quizId || ""),
      title: String(attempt?.quizTitle || "Course quiz"),
      type: attempt?.scope === "module" ? "Module Quiz" : "Course Quiz",
      moduleTitle: String(attempt?.moduleTitle || ""),
      score: Number(attempt?.score || 0),
      maxScore: Number(attempt?.maxScore || 0),
      percentage: Number(attempt?.percentage || 0),
      attemptNumber: Number(attempt?.attemptNumber || 1),
      submittedAt: attempt?.submittedAt || attempt?.updatedAt || null,
    })),
  };
}

function matchesFilters(row: any, query: any) {
  const search = normalizeSearch(query.search);
  if (search) {
    const searchValues = [
      row.learner.name,
      row.learner.email,
      row.learner.mobileNumber,
      row.course.title,
      ...row.manualQuizResults.map((quiz: any) => quiz.title),
      ...row.manualQuizResults.map((quiz: any) => quiz.moduleTitle),
      ...row.batches.map((batch: any) => batch.name),
    ].map(normalizeSearch);
    if (!searchValues.some((value) => value.includes(search))) return false;
  }

  const completionStatus = normalizeStatus(query.completionStatus);
  if (completionStatus && row.status !== completionStatus) return false;

  const courseStatus = normalizeStatus(query.courseStatus);
  if (courseStatus && row.course.status !== courseStatus) return false;

  const passFail = normalizeStatus(query.passFail);
  if (passFail && row.passStatus !== passFail) return false;

  const scoreMin = parseNumber(query.scoreMin);
  const scoreMax = parseNumber(query.scoreMax);
  if (scoreMin !== null && (row.score === null || row.score < scoreMin)) return false;
  if (scoreMax !== null && (row.score === null || row.score > scoreMax)) return false;

  const activityStatus = normalizeStatus(query.activityStatus);
  if (activityStatus === "active" && !row.learner.isActive) return false;
  if (activityStatus === "inactive" && row.learner.isActive) return false;

  const from = parseDate(query.from);
  const to = parseDate(query.to, true);
  const activityDate = row.lastActivity ? new Date(row.lastActivity) : null;
  if (from && (!activityDate || activityDate < from)) return false;
  if (to && (!activityDate || activityDate > to)) return false;

  const batchId = stringifyId(query.batchId);
  if (batchId && !row.batches.some((batch: any) => batch._id === batchId)) return false;

  return true;
}

function sortRows(rows: any[], query: any) {
  const sortBy = String(query.sortBy || "lastActivity");
  const direction = String(query.sortOrder || "desc").toLowerCase() === "asc" ? 1 : -1;
  const getValue = (row: any) => {
    switch (sortBy) {
      case "score":
        return row.score ?? -1;
      case "progress":
        return row.progressPercent ?? 0;
      case "completionDate":
        return row.completionDate ? new Date(row.completionDate).getTime() : 0;
      case "learnerName":
        return normalizeSearch(row.learner.name);
      case "submissionDate":
        return row.submissionDate ? new Date(row.submissionDate).getTime() : 0;
      default:
        return row.lastActivity ? new Date(row.lastActivity).getTime() : 0;
    }
  };

  return [...rows].sort((left, right) => {
    const leftValue = getValue(left);
    const rightValue = getValue(right);
    if (typeof leftValue === "string" && typeof rightValue === "string") {
      return leftValue.localeCompare(rightValue) * direction;
    }
    return (Number(leftValue) - Number(rightValue)) * direction;
  });
}

async function loadResultContext(actor: any, query: any) {
  const scope = await resolveActorScope(actor);
  let users = await User.find(buildUserMatch(scope, query))
    .select("_id name email username mobileNumber role userType company department is_active is_enabled")
    .lean();
  users = (await filterUsersByDepartment(users, scope, query)).filter(isLearner);

  const userIds = users.map((user) => user._id);
  const userById = new Map(users.map((user) => [stringifyId(user._id), user]));
  const enrollmentMatch: any = {
    userId: { $in: userIds },
  };
  if (query.courseId && isObjectId(query.courseId)) {
    enrollmentMatch.courseId = toObjectId(query.courseId);
  }

  const enrollments = userIds.length
    ? await CourseEnrollment.find(enrollmentMatch).sort({ updatedAt: -1 }).lean()
    : [];
  const courseIds = [...new Set(enrollments.map((item) => stringifyId(item.courseId)))]
    .filter(isObjectId)
    .map(toObjectId);
  const [courses, progressRecords, sectionRecords, quizAttempts, trackingRecords] =
    courseIds.length && userIds.length
      ? await Promise.all([
          Course.find({ _id: { $in: courseIds } })
            .select("_id title status assessment curriculum progression")
            .lean(),
          UserCourseProgress.find({ userId: { $in: userIds }, courseId: { $in: courseIds } }).lean(),
          UserSectionProgress.find({ userId: { $in: userIds }, courseId: { $in: courseIds } }).lean(),
          CourseQuizAttempt.find({ userId: { $in: userIds }, courseId: { $in: courseIds } }).lean(),
          ScormTracking.aggregate([
            {
              $match: {
                userId: { $in: userIds },
                courseId: { $in: courseIds },
              },
            },
            {
              $project: {
                userId: 1,
                courseId: 1,
                score: 1,
                attempts: 1,
                lessonStatus: 1,
                totalTime: 1,
                lastAccessed: 1,
                updatedAt: 1,
                interactionCount: {
                  $size: { $ifNull: ["$interactions", []] },
                },
              },
            },
          ]),
        ])
      : [[], [], [], [], []];

  const companyIds = [...new Set(users.map((user) => stringifyId(user.company)))]
    .filter(isObjectId)
    .map(toObjectId);
  const companies = companyIds.length
    ? await Company.find({ _id: { $in: companyIds } }).select("_id company_name").lean()
    : [];

  return {
    scope,
    users,
    enrollments,
    userById,
    courseById: new Map(courses.map((course) => [stringifyId(course._id), course])),
    companyById: new Map(companies.map((company) => [stringifyId(company._id), company])),
    progressByKey: new Map(
      progressRecords.map((item) => [
        `${stringifyId(item.userId)}:${stringifyId(item.courseId)}`,
        item,
      ])
    ),
    sectionsByKey: buildRecordMaps(sectionRecords),
    quizzesByKey: buildRecordMaps(quizAttempts),
    trackingByKey: buildRecordMaps(trackingRecords),
  };
}

async function buildFilterOptions(scope: any, users: any[], rows: any[], query: any) {
  const companyMatch =
    scope.role === "superadmin" ? { deletedAt: { $exists: false } } : { _id: toObjectId(scope.companyId) };
  const companies = await Company.find(companyMatch).select("_id company_name").sort({ company_name: 1 }).lean();
  const selectedCompanyId =
    scope.role === "superadmin" ? stringifyId(query.companyId) : stringifyId(scope.companyId);
  const departments = selectedCompanyId && isObjectId(selectedCompanyId)
    ? await Department.find({
        company: toObjectId(selectedCompanyId),
        deletedAt: { $exists: false },
      })
        .select("_id departmentName code")
        .sort({ departmentName: 1 })
        .lean()
    : [];
  const scopedDepartmentId = scope.department ? stringifyId(scope.department._id) : "";
  const rawBatches = selectedCompanyId && isObjectId(selectedCompanyId)
    ? await Batch.find({ companyId: toObjectId(selectedCompanyId) })
        .select("_id name userIds")
        .sort({ name: 1 })
        .lean()
    : [];
  const scopedUserIds = new Set(users.map((user) => stringifyId(user._id)));
  const batches =
    scope.role === "departmenthead"
      ? rawBatches.filter((batch: any) =>
          (batch.userIds || []).some((userId: any) => scopedUserIds.has(stringifyId(userId)))
        )
      : rawBatches;

  const courseOptions = new Map<string, string>();
  rows.forEach((row) => courseOptions.set(row.course._id, row.course.title));

  return {
    companies:
      scope.role === "superadmin"
        ? companies.map((company) => ({
            value: stringifyId(company._id),
            label: company.company_name || "Unnamed company",
          }))
        : [],
    departments:
      scope.role === "departmenthead"
        ? [{
            value: scopedDepartmentId,
            label: scope.department?.departmentName || scope.department?.code || "Department",
          }]
        : departments.map((department: any) => ({
            value: stringifyId(department._id),
            label: department.departmentName || department.code || "Department",
          })),
    courses: Array.from(courseOptions.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    batches: batches.map((batch) => ({
      value: stringifyId(batch._id),
      label: batch.name || "Batch",
    })),
    users: users
      .map((user) => ({
        value: stringifyId(user._id),
        label: user.name || user.email || user.username || "Learner",
      }))
      .sort((left, right) => left.label.localeCompare(right.label)),
  };
}

export const getLearnerResultsService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const actor = req.bodyData || req.user;
    const context = await loadResultContext(actor, req.query);
    const filteredRows = context.enrollments
      .map((enrollment) => {
        const user = context.userById.get(stringifyId(enrollment.userId));
        const course = context.courseById.get(stringifyId(enrollment.courseId));
        if (!user || !course) return null;
        const key = `${stringifyId(enrollment.userId)}:${stringifyId(enrollment.courseId)}`;
        return summarizeResult({
          enrollment,
          user,
          course,
          company: context.companyById.get(stringifyId(user.company)),
          progress: context.progressByKey.get(key),
          sections: context.sectionsByKey.get(key) || [],
          quizzes: context.quizzesByKey.get(key) || [],
          tracking: context.trackingByKey.get(key) || [],
        });
      })
      .filter(Boolean)
      .filter((row) => matchesFilters(row, req.query));
    const rows = sortRows(filteredRows, req.query);
    const scores = rows.map((row: any) => row.score).filter(Number.isFinite);
    const completed = rows.filter((row: any) => row.status === "completed").length;
    const passed = rows.filter((row: any) => row.passStatus === "passed").length;
    const failed = rows.filter((row: any) => row.passStatus === "failed").length;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const start = (page - 1) * limit;

    return res.status(200).send({
      status: "success",
      message: "Learner progress and results fetched successfully",
      data: {
        scope: context.scope,
        summary: {
          totalResults: rows.length,
          completed,
          pending: Math.max(rows.length - completed, 0),
          averageProgress: average(rows.map((row: any) => row.progressPercent)),
          averageScore: average(scores),
          passed,
          failed,
          recentSubmissions: rows
            .filter((row: any) => row.answerCount > 0)
            .sort(
              (left: any, right: any) =>
                new Date(right.submissionDate || 0).getTime() -
                new Date(left.submissionDate || 0).getTime()
            )
            .slice(0, 5),
          lowScoreLearners: rows
            .filter((row: any) => row.score !== null && row.score < 60)
            .sort((left: any, right: any) => left.score - right.score)
            .slice(0, 5),
          recentlyCompleted: rows
            .filter((row: any) => row.completionDate)
            .sort(
              (left: any, right: any) =>
                new Date(right.completionDate).getTime() -
                new Date(left.completionDate).getTime()
            )
            .slice(0, 5),
        },
        filterOptions: await buildFilterOptions(context.scope, context.users, rows, req.query),
        pagination: {
          page,
          limit,
          total: rows.length,
          totalPages: Math.max(1, Math.ceil(rows.length / limit)),
        },
        results: rows.slice(start, start + limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getLearnerResultDetailService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!isObjectId(req.params.enrollmentId)) {
      throw generateError("Invalid learner result reference", 400);
    }

    const actor = req.bodyData || req.user;
    const scope = await resolveActorScope(actor);
    const enrollment = await CourseEnrollment.findById(req.params.enrollmentId).lean();
    if (!enrollment) {
      throw generateError("Learner result not found", 404);
    }

    let users = await User.find(buildUserMatch(scope, {
      companyId: req.query.companyId,
      userId: stringifyId(enrollment.userId),
    }))
      .select("_id name email username mobileNumber role userType company department is_active is_enabled")
      .lean();
    users = (await filterUsersByDepartment(users, scope, {})).filter(isLearner);
    const learner = users.find((user) => stringifyId(user._id) === stringifyId(enrollment.userId));
    if (!learner) {
      throw generateError("You cannot access this learner result", 403);
    }

    const course = await Course.findById(enrollment.courseId)
      .select("_id title status assessment curriculum progression")
      .lean();
    if (!course) {
      throw generateError("Course not found", 404);
    }

    const keyQuery = {
      userId: enrollment.userId,
      courseId: enrollment.courseId,
    };
    const [company, progress, sections, trackingDocs, quizAnswerSections] = await Promise.all([
      Company.findById(learner.company).select("_id company_name").lean(),
      UserCourseProgress.findOne(keyQuery).lean(),
      UserSectionProgress.find(keyQuery).lean(),
      ScormTracking.find(keyQuery)
        .select([
          "_id",
          "userId",
          "courseId",
          "moduleId",
          "sectionId",
          "lessonStatus",
          "completionStatus",
          "successStatus",
          "progressMeasure",
          "progress",
          "score",
          "scoreRaw",
          "scoreScaled",
          "scoreMin",
          "scoreMax",
          "lessonLocation",
          "suspendData",
          "decoded_suspend_data",
          "totalTime",
          "attempts",
          "lastAccessed",
          "createdAt",
          "updatedAt",
          "interactions._id",
          "interactions.index",
          "interactions.questionNumber",
          "interactions.id",
          "interactions.type",
          "interactions.question",
          "interactions.questionTitle",
          "interactions.questionPrompt",
          "interactions.questionAssetPaths",
          "interactions.questionBankMatched",
          "interactions.learnerResponse",
          "interactions.learnerResponseRaw",
          "interactions.learnerResponseText",
          "interactions.result",
          "interactions.isCorrect",
          "interactions.score",
          "interactions.latency",
          "interactions.time",
          "interactions.attemptTimestamp",
          "interactions.maxMarks",
          "interactions.source",
          "interactions.correctResponses",
          "interactions.correctResponsesRaw",
          "interactions.correctResponseTexts",
          "interactions.review",
        ].join(" "))
        .populate("interactions.review.reviewedBy", "name email username")
        .sort({ updatedAt: -1 })
        .lean(),
      getCourseQuizAnswerSectionsForUser({
        userId: stringifyId(enrollment.userId),
        courseId: stringifyId(enrollment.courseId),
      }),
    ]);
    const quizzes = await CourseQuizAttempt.find(keyQuery).lean();
    const hierarchy = buildCourseHierarchyProgress({
      course,
      userId: stringifyId(enrollment.userId),
      courseId: stringifyId(enrollment.courseId),
      sectionProgressDocs: sections,
      courseProgressDoc: progress,
    });
    const structureLookup = buildCourseStructureLookup(course);
    const answerSectionMap = new Map<string, any>();
    const legacyCourseProgress = progress
      ? {
          ...progress,
          moduleId: "__course__",
          sectionId: "__course__",
        }
      : null;
    const appendAnswerSection = (trackingDoc: any) => {
      const moduleId = String(trackingDoc.moduleId || "").trim();
      const sectionId = String(trackingDoc.sectionId || "").trim();
      const moduleMetadata = structureLookup.get(moduleId);
      const serializedSection = serializeScormTrackingRecord(trackingDoc, {
        courseTitle: course.title || "",
        moduleTitle:
          moduleMetadata?.moduleTitle ||
          (moduleId === "__course__" ? course.title || "Course" : ""),
        sectionTitle:
          moduleMetadata?.sectionLookup.get(sectionId) ||
          (sectionId === "__course__" ? "Course SCORM activity" : ""),
      });
      if (!serializedSection.interactions.length) {
        return;
      }

      const key = `${moduleId}:${sectionId}`;
      const existingSection = answerSectionMap.get(key);
      if (
        !existingSection ||
        serializedSection.interactions.length >= existingSection.interactions.length
      ) {
        answerSectionMap.set(key, serializedSection);
      }
    };
    [...sections, ...trackingDocs].forEach(appendAnswerSection);
    if (!answerSectionMap.size && legacyCourseProgress) {
      appendAnswerSection(legacyCourseProgress);
    }
    const answerSections = Array.from(answerSectionMap.values());
    const row = summarizeResult({
      enrollment,
      user: learner,
      course,
      company,
      progress,
      sections,
      quizzes,
      tracking: trackingDocs,
    });

    return res.status(200).send({
      status: "success",
      message: "Learner result detail fetched successfully",
      data: {
        ...row,
        modules: serializeCourseHierarchyModules(hierarchy.modules),
        answerSections: [...answerSections, ...quizAnswerSections],
      },
    });
  } catch (error) {
    next(error);
  }
};
