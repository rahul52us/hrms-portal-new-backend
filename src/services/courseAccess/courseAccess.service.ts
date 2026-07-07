import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import CourseAccess from "../../schemas/course/CourseAccess";
import Course from "../../schemas/course/Course";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import { normalizeCourseAssessment } from "../course/courseMetadata.helpers";
import {
  buildDepartmentLookup,
  ensurePublishedCourse,
  ensureRole,
  getAccessScopeLabel,
  getActorContext,
  getDepartmentScopedUserMatch,
  getValidityStatus,
  isLearnerRole,
  isWithinValidityWindow,
  resolveActorDepartmentRecord,
  resolveDepartmentRecord,
  resolveUserDepartmentRecord,
  toObjectId,
} from "./utils/accessControl";
import { createCourseAccessValidation } from "./utils/validation";
import {
  buildMergedEnrollmentSummary,
  enrichEnrollmentSources,
  getActiveEnrollmentSources,
  normalizeEnrollmentSources,
  resolveEffectiveEnrollmentAssessment,
  upsertEnrollmentSources,
} from "./utils/enrollmentSources";
import {
  PERMISSION_KEYS,
  ensureCourseViewPermission,
  ensurePermission,
} from "../permissions/permission.utils";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { upsertCourseCompanyMembership } from "../company/courseMembership.service";

function stringifyId(value: any) {
  return value ? String(value) : "";
}

function resolveSelfEnrollmentValidTill(course: any, validFrom: Date) {
  const durationDays = Number(course?.commerce?.accessDurationDays);
  if (!Number.isFinite(durationDays) || durationDays <= 0) {
    return null;
  }

  const validTill = new Date(validFrom);
  validTill.setUTCDate(validTill.getUTCDate() + Math.floor(durationDays));
  return validTill;
}

function buildAccessKey(item: {
  accessLevel: string;
  companyId?: any;
  departmentId?: any;
  userId?: any;
}) {
  return `${item.accessLevel}:${stringifyId(item.companyId)}:${stringifyId(item.departmentId)}:${stringifyId(item.userId)}`;
}

async function insertMissingEnrollments(options: {
  courseIds: string[];
  assignedBy: string;
  assessmentCriteria?: {
    totalMarks?: number | null;
    passingMarks?: number | null;
  } | null;
  validFrom?: Date | null;
  validTill?: Date | null;
  dueDate?: Date | null;
  users: any[];
}) {
  if (!options.users.length || !options.courseIds.length) {
    return { createdCount: 0, skippedCount: 0, createdUserIds: [] as string[] };
  }

  const upsertResult = await upsertEnrollmentSources({
    courseIds: options.courseIds,
    users: options.users,
    source: {
      type: "direct",
      assignedBy: options.assignedBy,
      assessmentCriteria: options.assessmentCriteria || null,
      validFrom: options.validFrom || new Date(),
      validTill: options.validTill || null,
      dueDate: options.dueDate || null,
    },
  });

  return {
    createdCount: upsertResult.createdCount + upsertResult.updatedCount,
    skippedCount: upsertResult.skippedCount,
    createdUserIds: upsertResult.createdEntries
      .concat(upsertResult.updatedEntries)
      .map((entry) => entry.split(":")[1]),
  };
}

function isEnrollmentSyncEligible(accessDoc: any) {
  if (!accessDoc) {
    return false;
  }

  if (!accessDoc.validTill) {
    return true;
  }

  const validTill = new Date(accessDoc.validTill);
  return !Number.isNaN(validTill.getTime()) && validTill.getTime() >= Date.now();
}

function buildAssessmentCriteria(course: any, passingMarks?: number | null) {
  const normalized = normalizeCourseAssessment({
    totalMarks: course?.assessment?.totalMarks ?? null,
    passingMarks: passingMarks ?? null,
  });

  if (normalized.totalMarks !== null && normalized.passingMarks === null) {
    throw generateError(`Passing marks are required for ${course?.title || "the selected course"}`, 422);
  }

  return normalized;
}

function compareDateValue(left?: Date | null, right?: Date | null) {
  const leftValue = left ? new Date(left).toISOString() : null;
  const rightValue = right ? new Date(right).toISOString() : null;
  return leftValue === rightValue;
}

function hasAccessDocChanged(existingAccess: any, nextAccess: any) {
  return !(
    Boolean(existingAccess?.allowFurtherAssignment) === Boolean(nextAccess?.allowFurtherAssignment) &&
    JSON.stringify(existingAccess?.assessmentCriteria || null) === JSON.stringify(nextAccess?.assessmentCriteria || null) &&
    compareDateValue(existingAccess?.validFrom, nextAccess?.validFrom) &&
    compareDateValue(existingAccess?.validTill, nextAccess?.validTill)
  );
}

async function resolveCompanyForAccess(body: any) {
  if (body.accessLevel === "company" && body.companyId) {
    const company = await Company.findById(body.companyId).lean();
    if (!company) {
      throw generateError("Company not found", 404);
    }

    return company;
  }

  if (body.accessLevel === "department") {
    if (body.companyId) {
      const company = await Company.findById(body.companyId).lean();
      if (!company) {
        throw generateError("Company not found", 404);
      }

      return company;
    }

    return null;
  }

  if (body.accessLevel === "user") {
    const sampleUser = await User.findOne({
      _id: toObjectId(body.userIds[0]),
      deletedAt: { $exists: false },
    })
      .select("company")
      .lean();

    if (!sampleUser) {
      throw generateError("User not found", 404);
    }

    const company = await Company.findById(sampleUser.company).lean();
    if (!company) {
      throw generateError("Company not found for the selected user", 404);
    }

    return company;
  }

  return null;
}

export async function ensureCompanyLevelCourseAccess(
  payload: {
    courseId: string;
    companyId: string;
    assessmentCriteria?: {
      totalMarks?: number | null;
      passingMarks?: number | null;
    } | null;
    validFrom?: Date | string | null;
    validTill?: Date | string | null;
  },
  actorUserId: string
) {
  const validFrom = payload.validFrom ? new Date(payload.validFrom) : new Date();
  const validTill = payload.validTill ? new Date(payload.validTill) : null;

  const companyAccessDoc = {
    courseId: toObjectId(payload.courseId),
    companyId: toObjectId(payload.companyId),
    departmentId: null,
    userId: null,
    accessLevel: "company" as const,
    allowFurtherAssignment: false,
    assessmentCriteria: payload.assessmentCriteria || null,
    validFrom,
    validTill,
    assignedBy: toObjectId(actorUserId),
  };

  const existingAccess = await CourseAccess.findOne({
    courseId: companyAccessDoc.courseId,
    accessLevel: "company",
    companyId: companyAccessDoc.companyId,
  }).lean();

  if (existingAccess) {
    if (hasAccessDocChanged(existingAccess, companyAccessDoc)) {
      await CourseAccess.updateOne(
        { _id: existingAccess._id },
        {
          $set: {
            allowFurtherAssignment: companyAccessDoc.allowFurtherAssignment,
            assessmentCriteria: companyAccessDoc.assessmentCriteria,
            validFrom: companyAccessDoc.validFrom,
            validTill: companyAccessDoc.validTill,
            assignedBy: companyAccessDoc.assignedBy,
          },
        }
      );
      return {
        createdCount: 0,
        updatedCount: 1,
        skippedCount: 0,
        accessLevel: "company" as const,
        validFrom,
        validTill,
      };
    }

    return {
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 1,
      accessLevel: "company" as const,
      validFrom,
      validTill,
    };
  }

  await CourseAccess.create(companyAccessDoc);

  return {
    createdCount: 1,
    updatedCount: 0,
    skippedCount: 0,
    accessLevel: "company" as const,
    validFrom,
    validTill,
  };
}

export async function createCourseAccessRecords(payload: any, actorUserId: string) {
  const course = await ensurePublishedCourse(payload.courseId);
  const assessmentCriteria = buildAssessmentCriteria(course, payload.passingMarks);

  const resolvedCompany = await resolveCompanyForAccess(payload);
  const companyId = payload.companyId || stringifyId(resolvedCompany?._id) || undefined;
  const department =
    payload.accessLevel === "department"
      ? await resolveDepartmentRecord({
          companyId,
          departmentId: payload.departmentId,
          departmentName: payload.departmentName,
        })
      : null;

  const validFrom = payload.validFrom ? new Date(payload.validFrom) : new Date();
  const validTill = payload.validTill ? new Date(payload.validTill) : null;
  const companyAccessResult =
    payload.accessLevel !== "company" && companyId
      ? await ensureCompanyLevelCourseAccess(
          {
            courseId: payload.courseId,
            companyId,
            assessmentCriteria,
            validFrom,
            validTill,
          },
          actorUserId
        )
      : {
          createdCount: 0,
          skippedCount: 0,
          accessLevel: "company" as const,
          validFrom,
          validTill,
        };

  let targetUsers: any[] = [];
  if (payload.accessLevel === "user") {
    const uniqueUserIds = [...new Set(payload.userIds.map((userId: string) => String(userId).trim()))];
    targetUsers = await User.find({
      _id: { $in: uniqueUserIds.map((userId: any) => toObjectId(String(userId))) },
      deletedAt: { $exists: false },
    }).lean();

    if (targetUsers.length !== uniqueUserIds.length) {
      throw generateError("One or more selected users were not found", 404);
    }
  }

  if (companyId) {
    if (department && stringifyId(department.company) !== stringifyId(companyId)) {
      throw generateError("Department does not belong to the selected company", 400);
    }

    if (targetUsers.some((user) => stringifyId(user.company) !== stringifyId(companyId))) {
      throw generateError("All selected users must belong to the selected company", 400);
    }
  }

  const docsToCreate =
    payload.accessLevel === "company"
      ? [
          {
            courseId: toObjectId(payload.courseId),
            companyId: toObjectId(companyId!),
            departmentId: null,
            userId: null,
            accessLevel: "company",
            allowFurtherAssignment: payload.allowFurtherAssignment,
            assessmentCriteria,
            validFrom,
            validTill,
            assignedBy: toObjectId(actorUserId),
          },
        ]
      : payload.accessLevel === "department"
        ? [
            {
              courseId: toObjectId(payload.courseId),
              companyId: companyId ? toObjectId(companyId) : department?.company || null,
              departmentId: department?._id || null,
              userId: null,
              accessLevel: "department",
              allowFurtherAssignment: payload.allowFurtherAssignment,
              assessmentCriteria,
              validFrom,
              validTill,
              assignedBy: toObjectId(actorUserId),
            },
          ]
        : targetUsers.map((user) => ({
            courseId: toObjectId(payload.courseId),
            companyId: user.company ? toObjectId(String(user.company)) : null,
            departmentId: null,
            userId: toObjectId(String(user._id)),
            accessLevel: "user",
            allowFurtherAssignment: payload.allowFurtherAssignment,
            assessmentCriteria,
            validFrom,
            validTill,
            assignedBy: toObjectId(actorUserId),
          }));

  const existingAccess = await CourseAccess.find({
    $or: docsToCreate.map((item) => {
      if (item.accessLevel === "company") {
        return {
          courseId: item.courseId,
          accessLevel: "company",
          companyId: item.companyId,
        };
      }

      if (item.accessLevel === "department") {
        return {
          courseId: item.courseId,
          accessLevel: "department",
          departmentId: item.departmentId,
        };
      }

      return {
        courseId: item.courseId,
        accessLevel: "user",
        userId: item.userId,
      };
    }),
  }).lean();

  const existingKeys = new Set(existingAccess.map((item: any) => buildAccessKey(item)));

  const docsForInsert = docsToCreate.filter((item) => {
    return !existingKeys.has(buildAccessKey(item));
  });

  const docsForUpdate = docsToCreate.filter((item) => {
    const matchingAccess = existingAccess.find(
      (existingItem: any) => buildAccessKey(existingItem) === buildAccessKey(item)
    );
    return matchingAccess && hasAccessDocChanged(matchingAccess, item);
  });

  if (docsForInsert.length) {
    await CourseAccess.insertMany(docsForInsert);
  }

  for (const accessDoc of docsForUpdate) {
    const matchingAccess = existingAccess.find(
      (existingItem: any) => buildAccessKey(existingItem) === buildAccessKey(accessDoc)
    );

    if (!matchingAccess) {
      continue;
    }

    await CourseAccess.updateOne(
      { _id: matchingAccess._id },
      {
        $set: {
          allowFurtherAssignment: accessDoc.allowFurtherAssignment,
          assessmentCriteria: accessDoc.assessmentCriteria,
          validFrom: accessDoc.validFrom,
          validTill: accessDoc.validTill,
          assignedBy: accessDoc.assignedBy,
        },
      }
    );
  }

  let enrollmentSeedResult = {
    createdCount: 0,
    skippedCount: 0,
    createdUserIds: [] as string[],
  };

  if (payload.assignToAllUsers) {
    const scopeUsers =
      payload.accessLevel === "company"
        ? await User.find({
            company: toObjectId(companyId!),
            deletedAt: { $exists: false },
            role: { $nin: ["admin", "superadmin"] },
          }).lean()
        : payload.accessLevel === "department"
          ? await User.find({
              company: toObjectId(companyId || stringifyId(department?.company)),
              deletedAt: { $exists: false },
              role: { $nin: ["admin", "superadmin"] },
              ...getDepartmentScopedUserMatch(department),
            }).lean()
          : targetUsers;

    enrollmentSeedResult = await insertMissingEnrollments({
      courseIds: [payload.courseId],
      assignedBy: actorUserId,
      assessmentCriteria,
      validFrom,
      validTill,
      users: scopeUsers,
    });
  }

  return {
    createdCount: docsForInsert.length,
    updatedCount: docsForUpdate.length,
    skippedCount: docsToCreate.length - docsForInsert.length - docsForUpdate.length,
    hierarchyCreatedCount: companyAccessResult.createdCount,
    hierarchySkippedCount: companyAccessResult.skippedCount,
    accessLevel: payload.accessLevel,
    allowFurtherAssignment: payload.allowFurtherAssignment,
    assessmentCriteria,
    validFrom,
    validTill,
    enrollmentSeedResult,
  };
}

export async function syncInheritedCourseEnrollmentsForUser(userInput: any) {
  const user =
    userInput?._id && userInput?.company
      ? userInput
      : await User.findOne({
          _id: toObjectId(String(userInput?._id || userInput)),
          deletedAt: { $exists: false },
        }).lean();

  if (!user || !user.company || ["admin", "superadmin"].includes(String(user.role || "").toLowerCase())) {
    return {
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      syncedCourseIds: [] as string[],
    };
  }

  const companyId = String(user.company);
  const departmentLookup = await buildDepartmentLookup(companyId);
  const userDepartment = resolveUserDepartmentRecord(user, departmentLookup);
  const accessQuery: any = {
    $or: [
      {
        accessLevel: "company",
        companyId: toObjectId(companyId),
      },
    ],
  };

  if (userDepartment?._id) {
    accessQuery.$or.push({
      accessLevel: "department",
      departmentId: toObjectId(String(userDepartment._id)),
    });
  }

  const accessDocs = (await CourseAccess.find(accessQuery).sort({ createdAt: 1, _id: 1 }).lean()).filter(
    isEnrollmentSyncEligible
  );

  if (!accessDocs.length) {
    return {
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      syncedCourseIds: [] as string[],
    };
  }

  const courseAccessMap = new Map<string, any>();
  for (const accessDoc of accessDocs) {
    const courseId = stringifyId(accessDoc.courseId);
    if (courseId && !courseAccessMap.has(courseId)) {
      courseAccessMap.set(courseId, accessDoc);
    }
  }

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const syncedCourseIds: string[] = [];

  for (const [courseId, accessDoc] of courseAccessMap.entries()) {
    const upsertResult = await upsertEnrollmentSources({
      courseIds: [courseId],
      users: [user],
      source: {
        type: "direct",
        assignedBy: stringifyId(accessDoc.assignedBy),
        assessmentCriteria: accessDoc.assessmentCriteria || courseAccessMap.get(courseId)?.assessmentCriteria || null,
        validFrom: accessDoc.validFrom || new Date(),
        validTill: accessDoc.validTill || null,
        dueDate: accessDoc.validTill || null,
        assignedAt: accessDoc.createdAt || new Date(),
      },
    });

    createdCount += upsertResult.createdCount;
    updatedCount += upsertResult.updatedCount;
    skippedCount += upsertResult.skippedCount;

    if (upsertResult.createdCount || upsertResult.updatedCount) {
      syncedCourseIds.push(courseId);
    }
  }

  return {
    createdCount,
    updatedCount,
    skippedCount,
    syncedCourseIds,
  };
}

export const createCourseAccessService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensureRole(actor, ["superadmin"]);
    ensurePermission(req.bodyData || req.user, PERMISSION_KEYS.ASSIGN_COURSES, "You do not have permission to assign courses");

    const { error, value } = createCourseAccessValidation.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      throw generateError(error.details.map((item) => item.message).join(", "), 422);
    }

    await ensureCompanyManagementAccess({
      actor,
      requestedCompanyId: value.companyId,
      actionLabel: "assign courses to this company",
      allowSuperadminWithoutCompany: true,
    });

    const result = await createCourseAccessRecords(value, actor.userId);

    return res.status(201).send({
      status: "success",
      message: "Course access saved successfully",
      data: result,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getAccessibleCoursesService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);

    if (!actor.userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    if (actor.role === "superadmin") {
      const courses = await mongoose
        .model("Course")
        .find({ status: "published", "visibility.type": "private" })
        .sort({ createdAt: -1 })
        .lean();

      return res.status(200).send({
        status: "success",
        message: "Published courses fetched successfully",
        data: courses.map((course: any) => ({
          ...course,
          access: {
            canAssign: false,
            matchedScopes: [],
          },
          enrollment: null,
        })),
      });
    }

    if (isLearnerRole(actor.role)) {
      const enrollments = await CourseEnrollment.find({
        userId: toObjectId(actor.userId),
      })
        .populate("courseId")
        .populate("assignedBy", "name email username role")
        .sort({ createdAt: -1 })
        .lean();

      const data = enrollments
        .filter(
          (enrollment: any) =>
            enrollment.courseId &&
            enrollment.courseId.status === "published" &&
            String(enrollment.courseId.visibility?.type || "private") === "private"
        )
        .filter((enrollment: any) => getActiveEnrollmentSources(enrollment).length > 0)
        .map((enrollment: any) => {
          const effectiveAssessment = resolveEffectiveEnrollmentAssessment(
            enrollment,
            enrollment.courseId?.assessment
          );

          return {
            ...enrollment.courseId,
            assessment: effectiveAssessment,
            access: {
              canAssign: false,
              matchedScopes: [],
            },
            enrollment: {
              _id: enrollment._id,
              status: enrollment.status,
              validityStatus: getValidityStatus(enrollment.validFrom, enrollment.validTill),
              validFrom: enrollment.validFrom,
              validTill: enrollment.validTill,
              dueDate: enrollment.dueDate,
              assignedBy: enrollment.assignedBy,
              assignedAt: enrollment.createdAt,
              sources: normalizeEnrollmentSources(enrollment)
                .filter((source: any) => isWithinValidityWindow(source.validFrom, source.validTill))
                .map((source: any) => ({
                  type: source.type,
                  batchId: source.batchId || null,
                  batchName: source.batchName || null,
                  validFrom: source.validFrom || null,
                  validTill: source.validTill || null,
                  dueDate: source.dueDate || null,
                  assignedAt: source.assignedAt || enrollment.createdAt,
                })),
            },
          };
        });

      return res.status(200).send({
        status: "success",
        message: "Assigned courses fetched successfully",
        data,
      });
    }

    ensureRole(actor, ["admin", "departmenthead"]);
    ensureCourseViewPermission(req.bodyData || req.user, "You do not have permission to view courses");

    const actorDepartment = await resolveActorDepartmentRecord(actor).catch(() => null);
    const accessQuery: any = {
      $or: [
        actor.companyId
          ? { accessLevel: "company", companyId: toObjectId(actor.companyId) }
          : null,
        actor.companyId
          ? { accessLevel: "department", companyId: toObjectId(actor.companyId) }
          : null,
        { accessLevel: "user", userId: toObjectId(actor.userId) },
      ].filter(Boolean),
    };

    const accessDocs = await CourseAccess.find(accessQuery)
      .populate("courseId")
      .populate("assignedBy", "name email username role")
      .populate("companyId", "company_name")
      .populate("departmentId", "title code")
      .sort({ createdAt: -1 })
      .lean();

    const groupedCourses = new Map<string, any>();

    for (const accessDoc of accessDocs) {
      const course = accessDoc.courseId as any;
      if (
        !course ||
        String(course.status) !== "published" ||
        String(course.visibility?.type || "private") !== "private" ||
        !isWithinValidityWindow(accessDoc.validFrom, accessDoc.validTill)
      ) {
        continue;
      }

      if (
        actor.role === "departmenthead" &&
        String(accessDoc.accessLevel) === "department" &&
        actorDepartment &&
        stringifyId(accessDoc.departmentId) !== stringifyId(actorDepartment._id)
      ) {
        continue;
      }

      if (actor.role === "departmenthead" && String(accessDoc.accessLevel) === "department" && !actorDepartment) {
        continue;
      }

      const key = stringifyId(course._id);
      const current = groupedCourses.get(key) || {
        ...course,
        access: {
          canAssign: false,
          matchedScopes: [],
        },
        enrollment: null,
      };

      current.access.matchedScopes.push({
        _id: accessDoc._id,
        accessLevel: accessDoc.accessLevel,
        allowFurtherAssignment: accessDoc.allowFurtherAssignment,
        assessmentCriteria: accessDoc.assessmentCriteria || null,
        label: getAccessScopeLabel(accessDoc),
        validityStatus: getValidityStatus(accessDoc.validFrom, accessDoc.validTill),
        validFrom: accessDoc.validFrom,
        validTill: accessDoc.validTill,
        grantedBy: accessDoc.assignedBy,
        company: accessDoc.companyId,
        department: accessDoc.departmentId,
        grantedAt: accessDoc.createdAt,
      });

      if (accessDoc.allowFurtherAssignment) {
        if (actor.role === "admin") {
          current.access.canAssign = true;
        } else if (actor.role === "departmenthead") {
          current.access.canAssign =
            String(accessDoc.accessLevel) === "company" ||
            (String(accessDoc.accessLevel) === "department" &&
              actorDepartment &&
              stringifyId(accessDoc.departmentId) === stringifyId(actorDepartment._id));
        }
      }

      groupedCourses.set(key, current);
    }

    return res.status(200).send({
      status: "success",
      message: "Accessible courses fetched successfully",
      data: Array.from(groupedCourses.values()),
    });
  } catch (err: any) {
    next(err);
  }
};

export const enrollInPublicCourseService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    if (!actor.userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    if (!isLearnerRole(actor.role)) {
      throw generateError("Only learners can enroll in public courses", 403);
    }

    const courseId = String(req.params.courseId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      throw generateError("Invalid course id", 400);
    }

    const course = await Course.findOne({
      _id: toObjectId(courseId),
      status: "published",
      "visibility.type": "public",
    })
      .populate("company", "company_name companyCode is_active primaryThemeColor sidebarColors")
      .lean();

    if (!course) {
      throw generateError("Published public course not found", 404);
    }

    const courseCompanyId = stringifyId((course.company as any)?._id || course.company);
    if (!courseCompanyId || !mongoose.Types.ObjectId.isValid(courseCompanyId)) {
      throw generateError("Course company must be assigned before enrollment", 422);
    }

    const user = await User.findById(actor.userId).select("_id role userType is_active is_enabled").lean();
    if (!user) {
      throw generateError("Learner account not found", 404);
    }

    const existingEnrollment = await CourseEnrollment.findOne({
      courseId: toObjectId(courseId),
      userId: user._id,
    }).lean();
    const hasActiveEnrollment = Boolean(
      existingEnrollment && getActiveEnrollmentSources(existingEnrollment).length > 0
    );

    if (!hasActiveEnrollment && String(course.commerce?.pricingModel || "free").toLowerCase() === "paid") {
      throw generateError("Payment is required before enrolling in this course", 402);
    }

    const membership = await upsertCourseCompanyMembership({
      userId: actor.userId,
      courseId,
      companyId: course.company,
    });

    let enrollmentResult = {
      createdCount: 0,
      updatedCount: 0,
      skippedCount: hasActiveEnrollment ? 1 : 0,
    };

    if (!hasActiveEnrollment) {
      const validFrom = new Date();
      const validTill = resolveSelfEnrollmentValidTill(course, validFrom);

      try {
        const result = await upsertEnrollmentSources({
          courseIds: [courseId],
          users: [user],
          source: {
            type: "self",
            assignedBy: actor.userId,
            assessmentCriteria: normalizeCourseAssessment(course.assessment || {}),
            validFrom,
            validTill,
          },
        });

        enrollmentResult = {
          createdCount: result.createdCount,
          updatedCount: result.updatedCount,
          skippedCount: result.skippedCount,
        };
      } catch (error: any) {
        if (Number(error?.code) !== 11000) {
          throw error;
        }
      }

      if (enrollmentResult.createdCount > 0) {
        await Course.updateOne(
          { _id: toObjectId(courseId) },
          {
            $inc: {
              "metrics.totalEnrollments": 1,
              "metrics.popularityScore": 1,
            },
          }
        );
      }
    }

    const enrollment = await CourseEnrollment.findOne({
      courseId: toObjectId(courseId),
      userId: user._id,
    })
      .populate("assignedBy", "name email username role")
      .lean();

    if (!enrollment) {
      throw generateError("Unable to create course enrollment", 500);
    }

    const created = enrollmentResult.createdCount > 0;
    return res.status(created ? 201 : 200).send({
      status: "success",
      message: created
        ? "Course enrollment created successfully"
        : "You are already enrolled in this course",
      data: {
        created,
        alreadyEnrolled: !created,
        courseId,
        enrollment: {
          _id: enrollment._id,
          status: enrollment.status,
          progressPercent: enrollment.progressPercent,
          validFrom: enrollment.validFrom,
          validTill: enrollment.validTill,
          dueDate: enrollment.dueDate,
          assessmentCriteria: resolveEffectiveEnrollmentAssessment(enrollment, course.assessment),
          sources: enrichEnrollmentSources(enrollment),
        },
        membership,
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const getAssignedCoursesService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensureRole(actor, ["superadmin", "admin", "departmenthead"]);
    ensureCourseViewPermission(req.bodyData || req.user, "You do not have permission to view assigned courses");

    const requestedCompanyId =
      actor.role === "superadmin"
        ? String(req.query.companyId || "").trim() || undefined
        : actor.companyId;

    const accessDocs = await CourseAccess.find({
      ...(requestedCompanyId ? { companyId: toObjectId(requestedCompanyId) } : {}),
    })
      .populate("courseId", "title status")
      .populate("assignedBy", "name email username role")
      .populate("companyId", "company_name")
      .populate("departmentId", "title code")
      .populate("userId", "name email username department")
      .sort({ createdAt: -1 })
      .lean();

    const courseFilter = String(req.query.courseId || "").trim();
    const departmentFilter = String(req.query.department || "").trim().toLowerCase();
    const userFilter = String(req.query.userId || "").trim();
    const assignmentTypeFilter = String(req.query.assignmentType || "").trim().toLowerCase();

    let scopedAccessDocs = accessDocs;
    if (actor.role === "departmenthead" && actor.companyId) {
      const actorDepartment = await resolveActorDepartmentRecord(actor).catch(() => null);
      if (!actorDepartment) {
        throw generateError("Department head is missing department scope", 403);
      }

      const departmentLookup = await buildDepartmentLookup(actor.companyId);
      const departmentUsers = await User.find({
        company: toObjectId(actor.companyId),
        deletedAt: { $exists: false },
        ...getDepartmentScopedUserMatch(actorDepartment),
      })
        .select("_id department")
        .lean();
      const allowedUserIds = new Set(departmentUsers.map((user) => stringifyId(user._id)));

      scopedAccessDocs = accessDocs.filter((accessDoc: any) => {
        if (String(accessDoc.accessLevel) === "company") {
          return true;
        }

        if (String(accessDoc.accessLevel) === "department") {
          return stringifyId(accessDoc.departmentId?._id || accessDoc.departmentId) === stringifyId(actorDepartment._id);
        }

        return allowedUserIds.has(stringifyId(accessDoc.userId?._id || accessDoc.userId));
      });
    }

    const data = scopedAccessDocs
      .filter((accessDoc: any) => accessDoc.courseId)
      .filter((accessDoc: any) => !assignmentTypeFilter || String(accessDoc.accessLevel) === assignmentTypeFilter)
      .filter((accessDoc: any) => !courseFilter || stringifyId(accessDoc.courseId?._id) === courseFilter)
      .filter((accessDoc: any) => {
        if (!departmentFilter) {
          return true;
        }

        const title = String(accessDoc.departmentId?.title || "").trim().toLowerCase();
        const code = String(accessDoc.departmentId?.code || "").trim().toLowerCase();
        return title === departmentFilter || code === departmentFilter;
      })
      .filter((accessDoc: any) => !userFilter || stringifyId(accessDoc.userId?._id) === userFilter)
      .map((accessDoc: any) => ({
        _id: accessDoc._id,
        courseId: accessDoc.courseId?._id,
        courseName: accessDoc.courseId?.title,
        course: accessDoc.courseId,
        assignedTo:
          accessDoc.accessLevel === "company"
            ? accessDoc.companyId?.company_name
            : accessDoc.accessLevel === "department"
              ? accessDoc.departmentId?.title || accessDoc.departmentId?.code
              : accessDoc.userId?.name || accessDoc.userId?.email || accessDoc.userId?.username,
        assignmentType: accessDoc.accessLevel,
        validFrom: accessDoc.validFrom,
        validTill: accessDoc.validTill,
        status: getValidityStatus(accessDoc.validFrom, accessDoc.validTill),
        isExpired: getValidityStatus(accessDoc.validFrom, accessDoc.validTill) === "expired",
        allowFurtherAssignment: accessDoc.allowFurtherAssignment,
        assessmentCriteria: accessDoc.assessmentCriteria || null,
        assignedBy: accessDoc.assignedBy,
        company: accessDoc.companyId,
        department: accessDoc.departmentId,
        user: accessDoc.userId,
        createdAt: accessDoc.createdAt,
      }));

    return res.status(200).send({
      status: "success",
      message: "Assigned courses fetched successfully",
      data,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getCourseAssignmentsAuditService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensureRole(actor, ["superadmin", "admin", "departmenthead"]);
    ensureCourseViewPermission(req.bodyData || req.user, "You do not have permission to view course assignments");

    const requestedCompanyId =
      actor.role === "superadmin"
        ? String(req.query.companyId || "").trim() || undefined
        : actor.companyId;
    const courseFilter = String(req.query.courseId || "").trim();
    const userFilter = String(req.query.userId || "").trim();

    const userQuery: any = {
      deletedAt: { $exists: false },
      ...(requestedCompanyId ? { company: toObjectId(requestedCompanyId) } : {}),
      ...(userFilter ? { _id: toObjectId(userFilter) } : {}),
    };

    const candidateUsers = await User.find(userQuery).select("_id name email username department company").lean();
    let allowedUsers = candidateUsers;

    if (actor.role === "departmenthead" && actor.companyId) {
      const actorDepartment = await resolveActorDepartmentRecord(actor).catch(() => null);
      const departmentLookup = await buildDepartmentLookup(actor.companyId);

      allowedUsers = candidateUsers.filter((user) => {
        const userDepartment = resolveUserDepartmentRecord(user, departmentLookup);
        return Boolean(userDepartment && String(userDepartment._id) === String(actorDepartment?._id));
      });
    }

    if (!allowedUsers.length) {
      return res.status(200).send({
        status: "success",
        message: "Course assignments fetched successfully",
        data: [],
      });
    }

    const allowedUserIds = allowedUsers.map((user) => user._id);
    const enrollments = await CourseEnrollment.find({
      userId: { $in: allowedUserIds },
      ...(courseFilter ? { courseId: toObjectId(courseFilter) } : {}),
    })
      .populate("courseId", "title status")
      .populate("userId", "name email username department company")
      .populate("assignedBy", "name email username role")
      .populate("sources.assignedBy", "name email username role")
      .sort({ updatedAt: -1 })
      .lean();

    const data = enrollments
      .filter((enrollment: any) => enrollment.courseId)
      .flatMap((enrollment: any) => {
        const merged = buildMergedEnrollmentSummary(enrollment);
        const sources = enrichEnrollmentSources(enrollment);

        return sources.map((source: any, index: number) => ({
          _id: `${enrollment._id}-${source.type}-${source.batchId || index}`,
          user: enrollment.userId,
          course: enrollment.courseId,
          source: source.type,
          batchId: source.batchId || null,
          batchName: source.batchName || null,
          assignedBy: source.assignedBy || enrollment.assignedBy,
          validTill: source.validTill || null,
          isExpired: source.isExpired,
          status: source.status,
          courseStatus: merged.status,
        }));
      });

    return res.status(200).send({
      status: "success",
      message: "Course assignments fetched successfully",
      data,
    });
  } catch (err: any) {
    next(err);
  }
};

export const revokeCourseAccessService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensureRole(actor, ["superadmin"]);

    const { id } = req.params;
    if (!id) throw generateError("Access ID is required", 400);

    const accessDoc = await CourseAccess.findById(id);
    if (!accessDoc) {
      throw generateError("Course access record not found", 404);
    }

    let userFilter: any = {};
    if (String(accessDoc.accessLevel) === "company") {
      userFilter = { company: accessDoc.companyId };
    } else if (String(accessDoc.accessLevel) === "department") {
      const department = await resolveDepartmentRecord({ departmentId: String(accessDoc.departmentId) }).catch(() => null);
      if (department) {
        userFilter = {
           company: department.company,
           ...getDepartmentScopedUserMatch(department)
        };
      } else {
        userFilter = { _id: null };
      }
    } else if (String(accessDoc.accessLevel) === "user") {
      userFilter = { _id: accessDoc.userId };
    } else {
      userFilter = { _id: null };
    }

    const users = await User.find(userFilter).select("_id").lean();
    const userIds = users.map(u => u._id);

    if (userIds.length > 0) {
      await CourseEnrollment.deleteMany({
        courseId: accessDoc.courseId,
        userId: { $in: userIds }
      });
    }

    await accessDoc.deleteOne();

    return res.status(200).send({
      status: "success",
      message: "Course access and corresponding enrollments revoked successfully",
    });
  } catch (err: any) {
    next(err);
  }
};
