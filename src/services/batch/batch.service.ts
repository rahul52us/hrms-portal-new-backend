import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import Batch from "../../schemas/course/Batch";
import BatchEnrollment from "../../schemas/course/BatchEnrollment";
import Course from "../../schemas/course/Course";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import UserCourseProgress from "../../schemas/course/UserCourseProgress";
import UserSectionProgress from "../../schemas/course/UserSectionProgress";
import User from "../../schemas/User/User";
import {
  accessDocCanAssignToUser,
  buildDepartmentLookup,
  ensurePublishedCourse,
  ensureRole,
  getActorContext,
  getValidityStatus,
  isLearnerRole,
  isWithinValidityWindow,
  resolveActorDepartmentRecord,
  resolveUserDepartmentRecord,
  toObjectId,
} from "../courseAccess/utils/accessControl";
import {
  parsePossibleArray,
  parseWorkbookSheetsFromFile,
} from "../courseAccess/utils/assignmentParsing";
import {
  buildMergedEnrollmentSummary,
  getActiveEnrollmentSources,
  normalizeEnrollmentSources,
  removeBatchEnrollmentSources,
  resolveEffectiveEnrollmentAssessment,
  upsertEnrollmentSources,
} from "../courseAccess/utils/enrollmentSources";
import {
  buildCourseHierarchyProgress,
  serializeCourseHierarchyModules,
} from "../scorm/scormTracking.helpers";
import { createBatchValidation, updateBatchValidation } from "../courseAccess/utils/validation";
import CourseAccess from "../../schemas/course/CourseAccess";
import { PERMISSION_KEYS, ensurePermission } from "../permissions/permission.utils";
import {
  buildCourseAssessmentSummary,
  serializeCoursePresentation,
} from "../course/courseMetadata.helpers";
import { getCertificateSnapshotForCourse } from "../certificate/certificate.service";
import { sanitizeCourseCurriculumForLearner } from "../course/courseQuiz.service";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";

const PHONE_REGEX = /^[0-9+()\-\s]{7,20}$/;

function stringifyId(value: any) {
  return value ? String(value) : "";
}

function getBatchStatus(startDate?: Date | string | null, endDate?: Date | string | null, isCompleted = false) {
  if (isCompleted) {
    return "completed";
  }

  return getValidityStatus(startDate || null, endDate || null);
}

function buildBatchPayload(body: any) {
  return {
    ...body,
    courseIds: parsePossibleArray(body.courseIds),
    userIds: parsePossibleArray(body.userIds),
  };
}

function formatFailure(entry: any) {
  return {
    phone: entry?.phone || entry?.reference || "",
    reason: entry?.reason || "Unknown error",
    rowNumber: entry?.rowNumber,
    userId: entry?.userId,
    courseId: entry?.courseId,
  };
}

function formatAssignmentResult(successCount: number, failures: any[]) {
  const failed = failures.map(formatFailure);
  return {
    successCount,
    failed,
    failedEntries: failed,
  };
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serializeBatchUser(user: any) {
  return {
    _id: String(user?._id || ""),
    name: user?.name || "",
    mobileNumber: user?.mobileNumber || user?.username || "",
    email: user?.email || user?.username || "",
    username: user?.username || user?.email || "",
    code: user?.code || "",
    department: user?.department || "",
  };
}

function serializeBatchCourse(course: any) {
  return {
    courseId: String(course?._id || ""),
    courseCode: String(course?.courseCode || "").trim(),
    title: course?.title || "",
  };
}

async function buildCertificateSnapshotSafely(options: {
  userId: string;
  courseId: string;
  course?: any;
  enrollment?: any;
  progressDoc?: any;
  assessmentSummary?: any;
}) {
  try {
    return await getCertificateSnapshotForCourse(options);
  } catch (error) {
    console.warn("[Certificates] Failed to resolve learner certificate status", error);
    return {
      enabled: false,
      status: "not_eligible",
      canIssue: false,
      reason: "Certificate status is not available",
    };
  }
}

async function resolveBatchUploadUsers(options: {
  fileBuffer: Buffer;
  fileName?: string;
  mimeType?: string;
  actor: any;
  actorDepartment: any;
  departmentLookup: Map<string, any>;
  companyId: string;
}) {
  const sheets = await parseWorkbookSheetsFromFile({
    fileBuffer: options.fileBuffer,
    fileName: options.fileName,
    mimeType: options.mimeType,
  });

  const coursesSheet = sheets.find((sheet) => sheet.name.trim().toLowerCase() === "courses");
  const usersSheet = sheets.find((sheet) => sheet.name.trim().toLowerCase() === "users");

  if (!coursesSheet || !usersSheet) {
    throw generateError("Workbook must include separate Courses and Users sheets", 422);
  }

  const courseRows = coursesSheet.rows;
  const userRows = usersSheet.rows;

  if (courseRows.length < 2) {
    throw generateError("Courses sheet must include a header row and at least one course", 422);
  }

  if (userRows.length < 2) {
    throw generateError("Users sheet must include a header row and at least one user", 422);
  }

  const courseHeaders = courseRows[0].map((header) => String(header || "").trim().toLowerCase());
  const userHeaders = userRows[0].map((header) => String(header || "").trim().toLowerCase());
  const getColumnIndex = (headers: string[], ...names: string[]) =>
    headers.findIndex((header) => names.includes(header));

  const courseCodeIndex = getColumnIndex(courseHeaders, "coursecode", "course_code", "course code");
  const userIdIndex = getColumnIndex(userHeaders, "userid", "user_id", "user id");
  const phoneIndex = getColumnIndex(
    userHeaders,
    "phone",
    "phone number",
    "phonenumber",
    "mobile",
    "mobile number",
    "mobilenumber",
    "contact number",
    "contactnumber"
  );
  const codeIndex = getColumnIndex(
    userHeaders,
    "employeeid",
    "employee_id",
    "employee id",
    "code",
    "employee code",
    "employee_code",
    "employeecode"
  );

  if (courseCodeIndex < 0) {
    throw generateError("Courses sheet must include a courseCode column", 422);
  }

  if (userIdIndex < 0 && phoneIndex < 0 && codeIndex < 0) {
    throw generateError("Users sheet must include a phone number, employeeId/code, or userId column", 422);
  }

  const courseFailures: any[] = [];
  const userFailures: any[] = [];

  const normalizedCourseCodes = Array.from(
    new Set(
      courseRows
        .slice(1)
        .map((row) => String(row[courseCodeIndex] || "").trim())
        .filter(Boolean)
        .map((courseCode) => courseCode.toUpperCase())
    )
  );

  const courseDocs = normalizedCourseCodes.length
    ? await Course.find({
        $or: normalizedCourseCodes.map((courseCode) => ({
          courseCode: new RegExp(`^${escapeRegex(courseCode)}$`, "i"),
        })),
      })
        .select("_id title courseCode status")
        .lean()
    : [];

  const courseByCode = new Map(
    courseDocs.map((course: any) => [String(course.courseCode || "").trim().toUpperCase(), course])
  );

  const assignedCourseIdSet = new Set<string>();
  if (courseDocs.length) {
    const accessDocs = await CourseAccess.find({
      accessLevel: "company",
      companyId: toObjectId(options.companyId),
      courseId: { $in: courseDocs.map((course: any) => toObjectId(String(course._id))) },
    }).lean();

    accessDocs
      .filter((accessDoc: any) => isWithinValidityWindow(accessDoc.validFrom, accessDoc.validTill))
      .forEach((accessDoc: any) => {
        assignedCourseIdSet.add(stringifyId(accessDoc.courseId));
      });
  }

  const validCourses: any[] = [];
  const seenCourseIds = new Set<string>();
  for (let rowIndex = 1; rowIndex < courseRows.length; rowIndex += 1) {
    const courseCode = String(courseRows[rowIndex][courseCodeIndex] || "").trim();
    if (!courseCode) {
      courseFailures.push({
        rowNumber: rowIndex + 1,
        courseCode: "",
        reason: "Missing courseCode",
      });
      continue;
    }

    const matchedCourse = courseByCode.get(courseCode.toUpperCase());
    if (!matchedCourse || String(matchedCourse.status || "") !== "published") {
      courseFailures.push({
        rowNumber: rowIndex + 1,
        courseCode,
        reason: "Course not found",
      });
      continue;
    }

    const matchedCourseId = stringifyId(matchedCourse._id);
    if (!assignedCourseIdSet.has(matchedCourseId)) {
      courseFailures.push({
        rowNumber: rowIndex + 1,
        courseCode,
        courseId: matchedCourseId,
        reason: "Course not assigned to company",
      });
      continue;
    }

    if (seenCourseIds.has(matchedCourseId)) {
      courseFailures.push({
        rowNumber: rowIndex + 1,
        courseCode,
        courseId: matchedCourseId,
        reason: "Duplicate course entry",
      });
      continue;
    }

    seenCourseIds.add(matchedCourseId);
    validCourses.push(matchedCourse);
  }

  const validUsers: any[] = [];
  const seenUserIds = new Set<string>();
  for (let rowIndex = 1; rowIndex < userRows.length; rowIndex += 1) {
    const userId = userIdIndex >= 0 ? String(userRows[rowIndex][userIdIndex] || "").trim() : "";
    const phone = phoneIndex >= 0 ? String(userRows[rowIndex][phoneIndex] || "").trim() : "";
    const code = codeIndex >= 0 ? String(userRows[rowIndex][codeIndex] || "").trim() : "";

    if (!userId && !phone && !code) {
      userFailures.push({
        rowNumber: rowIndex + 1,
        phone: "",
        employeeId: "",
        reason: "Missing phone number or employeeId",
      });
      continue;
    }

    if (phone && !PHONE_REGEX.test(phone)) {
      userFailures.push({
        rowNumber: rowIndex + 1,
        phone,
        employeeId: code || "",
        reason: "Invalid phone number format",
      });
      continue;
    }

    if (userId && !mongoose.Types.ObjectId.isValid(userId) && !phone && !code) {
      userFailures.push({
        rowNumber: rowIndex + 1,
        phone: "",
        employeeId: "",
        reason: "Invalid userId",
      });
      continue;
    }

    const match: any = {
      deletedAt: { $exists: false },
      company: toObjectId(options.companyId),
    };

    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      match._id = toObjectId(userId);
    } else if (phone) {
      match.$or = [{ mobileNumber: phone }, { username: phone }];
    } else if (code) {
      match.code = code;
    }

    const user = await User.findOne(match).lean();
    if (!user) {
      userFailures.push({
        rowNumber: rowIndex + 1,
        phone,
        employeeId: code || "",
        reason: code && !phone ? "Invalid employeeId" : "User not found",
      });
      continue;
    }

    if (options.actor.role === "departmenthead") {
      const userDepartment = resolveUserDepartmentRecord(user, options.departmentLookup);
      if (!userDepartment || String(userDepartment._id) !== String(options.actorDepartment?._id)) {
        userFailures.push({
          rowNumber: rowIndex + 1,
          phone,
          employeeId: code || "",
          userId: stringifyId(user._id),
          reason: "User is outside your department scope",
        });
        continue;
      }
    }

    const normalizedUserId = stringifyId(user._id);
    if (seenUserIds.has(normalizedUserId)) {
      userFailures.push({
        rowNumber: rowIndex + 1,
        phone: user.mobileNumber || user.username || phone,
        employeeId: user.code || code || "",
        userId: normalizedUserId,
        reason: "Duplicate user entry",
      });
      continue;
    }

    seenUserIds.add(normalizedUserId);
    validUsers.push(user);
  }

  return {
    validCourses,
    validUsers,
    courseFailures,
    userFailures,
    totalRows: Math.max(courseRows.length - 1, 0) + Math.max(userRows.length - 1, 0),
    totalCourseRows: Math.max(courseRows.length - 1, 0),
    totalUserRows: Math.max(userRows.length - 1, 0),
    validCourseRows: validCourses.length,
    validUserRows: validUsers.length,
    failedCourseRows: courseFailures.length,
    failedUserRows: userFailures.length,
  };
}

async function getAssignableAccessDocs(actor: any, actorDepartment: any, courseId: string) {
  const query: any = {
    courseId: toObjectId(courseId),
    allowFurtherAssignment: true,
    $or: [
      actor.companyId ? { accessLevel: "company", companyId: toObjectId(actor.companyId) } : null,
      actor.companyId ? { accessLevel: "department", companyId: toObjectId(actor.companyId) } : null,
      { accessLevel: "user", userId: toObjectId(actor.userId) },
    ].filter(Boolean),
  };

  const accessDocs = await CourseAccess.find(query).lean();
  if (!accessDocs.length) {
    throw generateError("One or more selected courses are not open for further assignment", 403);
  }

  if (actor.role === "departmenthead" && actorDepartment) {
    return accessDocs.filter((accessDoc: any) => {
      if (String(accessDoc.accessLevel) === "company") {
        return true;
      }

      if (String(accessDoc.accessLevel) === "department") {
        return String(accessDoc.departmentId) === String(actorDepartment._id);
      }

      return String(accessDoc.userId) === String(actor.userId);
    });
  }

  return accessDocs;
}

async function resolveBatchUsers(options: {
  actor: any;
  actorDepartment: any;
  companyId: string;
  userIds: string[];
  uploadPreview?: Awaited<ReturnType<typeof resolveBatchUploadUsers>> | null;
}) {
  const failures: any[] = [];
  const departmentLookup = await buildDepartmentLookup(options.companyId);
  const usersById = new Map<string, any>();

  const requestedUserIds = [...new Set(options.userIds.map((userId) => String(userId).trim()).filter(Boolean))];
  if (requestedUserIds.length) {
    const foundUsers = await User.find({
      _id: { $in: requestedUserIds.map((userId) => toObjectId(userId)) },
      company: toObjectId(options.companyId),
      deletedAt: { $exists: false },
    }).lean();

    const foundIds = new Set(foundUsers.map((user) => stringifyId(user._id)));
    requestedUserIds
      .filter((userId) => !foundIds.has(userId))
      .forEach((userId) => {
        failures.push({
          phone: "",
          userId,
          reason: "User not found in the selected company",
        });
      });

    foundUsers.forEach((user) => {
      usersById.set(String(user._id), user);
    });
  }

  if (options.uploadPreview) {
    failures.push(...options.uploadPreview.userFailures, ...options.uploadPreview.courseFailures);
    options.uploadPreview.validUsers.forEach((user) => {
      usersById.set(String(user._id), user);
    });
  }

  let users = Array.from(usersById.values());
  if (options.actor.role === "departmenthead") {
    users = users.filter((user) => {
      const userDepartment = resolveUserDepartmentRecord(user, departmentLookup);
      const isAllowed = Boolean(userDepartment && String(userDepartment._id) === String(options.actorDepartment?._id));
      if (!isAllowed) {
        failures.push({
          phone: user.mobileNumber || user.username || "",
          userId: user._id,
          reason: "User is outside your department scope",
        });
      }
      return isAllowed;
    });
  }

  return { users, failures, departmentLookup };
}

async function assertBatchScopeAccess(options: {
  actor: any;
  actorDepartment: any;
  courseIds: string[];
  users: any[];
  departmentLookup: Map<string, any>;
}) {
  if (options.actor.role === "superadmin") {
    return { allowedUsers: options.users, failures: [] as any[] };
  }

  const accessDocsByCourse = new Map<string, any[]>();
  for (const courseId of options.courseIds) {
    accessDocsByCourse.set(courseId, await getAssignableAccessDocs(options.actor, options.actorDepartment, courseId));
  }

  const failures: any[] = [];
  const allowedUsers = options.users.filter((user) => {
    const userDepartment = resolveUserDepartmentRecord(user, options.departmentLookup);
    const targetDepartmentId = userDepartment ? String(userDepartment._id) : null;

    const canReceiveAllCourses = options.courseIds.every((courseId) => {
      const accessDocs = accessDocsByCourse.get(courseId) || [];
      return accessDocs.some((accessDoc: any) =>
        accessDocCanAssignToUser({
          accessDoc,
          actor: options.actor,
          actorDepartmentId: options.actorDepartment ? String(options.actorDepartment._id) : null,
          targetUser: user,
          targetDepartmentId,
        })
      );
    });

    if (!canReceiveAllCourses) {
      failures.push({
        phone: user.mobileNumber || user.username || "",
        userId: user._id,
        reason: "User does not have valid access to every course in this batch",
      });
      return false;
    }

    return true;
  });

  return { allowedUsers, failures };
}

async function batchMatchesDepartmentScope(options: {
  batch: any;
  actorDepartment: any;
  departmentLookup: Map<string, any>;
}) {
  const batchUserIds = (options.batch?.userIds || [])
    .map((user: any) => stringifyId(user?._id || user))
    .filter((userId: string) => Boolean(userId));

  if (!batchUserIds.length) {
    return false;
  }

  const usersWithDepartments = await User.find({
    _id: { $in: batchUserIds.map((userId: string) => toObjectId(userId)) },
    deletedAt: { $exists: false },
  })
    .select("_id department company")
    .lean();

  if (usersWithDepartments.length !== batchUserIds.length) {
    return false;
  }

  return usersWithDepartments.every((user) => {
    const userDepartment = resolveUserDepartmentRecord(user, options.departmentLookup);
    return Boolean(
      userDepartment &&
      String(userDepartment._id) === String(options.actorDepartment?._id)
    );
  });
}

async function assertBatchScope(actor: any, batch: any) {
  if (!batch) {
    throw generateError("Batch not found", 404);
  }

  const batchCompanyId = String(batch.companyId?._id || batch.companyId);

  if (isLearnerRole(actor.role)) {
    if (actor.companyId && batchCompanyId !== String(actor.companyId)) {
      throw generateError("This batch is outside your company scope", 403);
    }
    return;
  }

  if (actor.role === "superadmin") {
    return;
  }

  if (batchCompanyId !== String(actor.companyId)) {
    throw generateError("This batch is outside your company scope", 403);
  }

  if (actor.role === "departmenthead") {
    const actorDepartment = await resolveActorDepartmentRecord(actor).catch(() => null);
    if (!actorDepartment) {
      throw generateError("Department head is missing department scope", 403);
    }

    const departmentLookup = await buildDepartmentLookup(actor.companyId);
    const isWithinDepartmentScope = await batchMatchesDepartmentScope({
      batch,
      actorDepartment,
      departmentLookup,
    });

    if (!isWithinDepartmentScope) {
      throw generateError("This batch contains users outside your department scope", 403);
    }
  }
}

async function assertCompanyAssignedCourses(companyId: string, courseIds: string[]) {
  const uniqueCourseIds = [...new Set(courseIds.map((courseId) => String(courseId).trim()).filter(Boolean))];
  if (!companyId || !uniqueCourseIds.length) {
    return;
  }

  const accessDocs = await CourseAccess.find({
    accessLevel: "company",
    companyId: toObjectId(companyId),
    courseId: { $in: uniqueCourseIds.map((courseId) => toObjectId(courseId)) },
  }).lean();

  const activeAssignedCourseIds = new Set(
    accessDocs
      .filter((accessDoc: any) => isWithinValidityWindow(accessDoc.validFrom, accessDoc.validTill))
      .map((accessDoc: any) => stringifyId(accessDoc.courseId))
  );

  const unassignedCourseIds = uniqueCourseIds.filter((courseId) => !activeAssignedCourseIds.has(courseId));
  if (unassignedCourseIds.length) {
    throw generateError("Only courses already assigned to this company can be added to a batch", 422);
  }
}

function assertBatchDeletePermission(actor: any, batch: any) {
  if (!actor.userId) {
    throw generateError("Authenticated user context is required", 401);
  }

  if (stringifyId(batch?.createdBy?._id || batch?.createdBy) !== String(actor.userId)) {
    throw generateError("Only the batch creator can delete this batch", 403);
  }
}

async function syncBatchEnrollments(batchId: string, userIds: string[], assignedBy: string) {
  if (!userIds.length) {
    return;
  }

  await BatchEnrollment.bulkWrite(
    userIds.map((userId) => ({
      updateOne: {
        filter: { batchId: toObjectId(batchId), userId: toObjectId(userId) },
        update: {
          $setOnInsert: {
            batchId: toObjectId(batchId),
            userId: toObjectId(userId),
            assignedBy: toObjectId(assignedBy),
            status: "active",
          },
        },
        upsert: true,
      },
    }))
  );
}

export const createBatchService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensureRole(actor, ["superadmin", "admin", "departmenthead"]);
    ensurePermission(req.bodyData || req.user, PERMISSION_KEYS.MANAGE_BATCHES, "You do not have permission to manage batches");

    const payload = buildBatchPayload(req.body);
    const { error, value } = createBatchValidation.validate(payload, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      throw generateError(error.details.map((item) => item.message).join(", "), 422);
    }

    const manualCourseIds = [...new Set(parsePossibleArray(value.courseIds).map((courseId) => String(courseId).trim()).filter(Boolean))];
    const directUserIds = [...new Set(parsePossibleArray(value.userIds).map((userId) => String(userId).trim()).filter(Boolean))];
    const companyId = actor.role === "superadmin" ? String(value.companyId || "").trim() : String(actor.companyId || "").trim();
    if (!companyId) {
      throw generateError("companyId is required", 422);
    }

    await ensureCompanyManagementAccess({
      actor,
      requestedCompanyId: companyId,
      actionLabel: "create batches for this company",
      allowSuperadminWithoutCompany: false,
    });

    const actorDepartment = await resolveActorDepartmentRecord(actor).catch(() => null);
    const uploadPreview = req.file?.buffer
      ? await resolveBatchUploadUsers({
          fileBuffer: req.file.buffer,
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          actor,
          actorDepartment,
          departmentLookup: await buildDepartmentLookup(companyId),
          companyId,
        })
      : null;

    const uploadedCourseIds = (uploadPreview?.validCourses || []).map((course: any) => stringifyId(course._id));
    const courseIds = [...new Set([...manualCourseIds, ...uploadedCourseIds])];
    if (!courseIds.length) {
      throw generateError("At least one valid course is required to create a batch", 422);
    }

    for (const courseId of courseIds) {
      await ensurePublishedCourse(courseId);
    }

    await assertCompanyAssignedCourses(companyId, courseIds);

    const { users, failures: targetFailures, departmentLookup } = await resolveBatchUsers({
      actor,
      actorDepartment,
      companyId,
      userIds: directUserIds,
      uploadPreview,
    });

    if (!users.length) {
      throw generateError("At least one valid user is required to create a batch", 422);
    }

    const { allowedUsers, failures: scopeFailures } = await assertBatchScopeAccess({
      actor,
      actorDepartment,
      courseIds,
      users,
      departmentLookup,
    });

    if (!allowedUsers.length) {
      throw generateError("No selected users can receive every course in this batch", 422);
    }

    const finalCourseIds = [...new Set([...manualCourseIds, ...uploadedCourseIds])];

    if (!finalCourseIds.length) {
      throw generateError("No valid course assignments remain after validation", 422);
    }

    const batch = await Batch.create({
      name: value.name,
      companyId: toObjectId(companyId),
      courseIds: finalCourseIds.map((courseId) => toObjectId(courseId)),
      userIds: allowedUsers.map((user) => user._id),
      startDate: new Date(value.startDate),
      endDate: value.endDate ? new Date(value.endDate) : null,
      createdBy: toObjectId(actor.userId),
    });

    await syncBatchEnrollments(String(batch._id), allowedUsers.map((user) => String(user._id)), actor.userId);

    await upsertEnrollmentSources({
      courseIds: finalCourseIds,
      users: allowedUsers,
      source: {
        type: "batch",
        batchId: String(batch._id),
        batchName: batch.name,
        assignedBy: actor.userId,
        validFrom: batch.startDate,
        validTill: batch.endDate,
        dueDate: batch.endDate,
        assignedAt: batch.createdAt,
      },
    });

    const result = formatAssignmentResult(allowedUsers.length * finalCourseIds.length, [...targetFailures, ...scopeFailures]);

    return res.status(201).send({
      status: "success",
      message: "Batch created successfully",
      data: {
        batchId: batch._id,
        name: batch.name,
        userCount: allowedUsers.length,
        courseCount: finalCourseIds.length,
        ...result,
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const updateBatchService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensureRole(actor, ["superadmin", "admin", "departmenthead"]);
    ensurePermission(req.bodyData || req.user, PERMISSION_KEYS.MANAGE_BATCHES, "You do not have permission to manage batches");

    const batch = await Batch.findById(req.params.id).lean();
    await assertBatchScope(actor, batch);
    await ensureCompanyManagementAccess({
      actor,
      requestedCompanyId: stringifyId(batch?.companyId),
      actionLabel: "manage batches for this company",
      allowSuperadminWithoutCompany: false,
    });

    const payload = buildBatchPayload(req.body);
    const { error, value } = updateBatchValidation.validate(payload, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      throw generateError(error.details.map((item) => item.message).join(", "), 422);
    }

    const actorDepartment = await resolveActorDepartmentRecord(actor).catch(() => null);
    let targetUsers: any[] = [];
    let targetFailures: any[] = [];
    let departmentLookup = await buildDepartmentLookup(String(batch?.companyId));
    const uploadPreview = req.file?.buffer
      ? await resolveBatchUploadUsers({
          fileBuffer: req.file.buffer,
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          actor,
          actorDepartment,
          departmentLookup,
          companyId: stringifyId(batch?.companyId),
        })
      : null;
    const hasCourseInput = Object.prototype.hasOwnProperty.call(req.body, "courseIds") || Boolean(uploadPreview?.validCourses?.length);
    const hasUserInput = Object.prototype.hasOwnProperty.call(req.body, "userIds") || Boolean(req.file?.buffer);
    const uploadedCourseIds = (uploadPreview?.validCourses || []).map((course: any) => stringifyId(course._id));
    const nextCourseIds = hasCourseInput
      ? [...new Set([
          ...parsePossibleArray(value.courseIds).map((courseId) => String(courseId).trim()).filter(Boolean),
          ...uploadedCourseIds,
        ])]
      : (batch?.courseIds || []).map((courseId: any) => stringifyId(courseId));

    if (!nextCourseIds.length) {
      throw generateError("A batch must contain at least one course", 422);
    }

    for (const courseId of nextCourseIds) {
      await ensurePublishedCourse(courseId);
    }

    await assertCompanyAssignedCourses(stringifyId(batch?.companyId), nextCourseIds);

    if (hasUserInput) {
      const resolved = await resolveBatchUsers({
        actor,
        actorDepartment,
        companyId: stringifyId(batch?.companyId),
        userIds: parsePossibleArray(value.userIds).map((userId: any) => String(userId)),
        uploadPreview,
      });
      targetUsers = resolved.users;
      targetFailures = resolved.failures;
      departmentLookup = resolved.departmentLookup;
    } else {
      targetUsers = await User.find({
        _id: { $in: batch?.userIds || [] },
        company: toObjectId(stringifyId(batch?.companyId)),
        deletedAt: { $exists: false },
      }).lean();
    }

    const { allowedUsers, failures: scopeFailures } = await assertBatchScopeAccess({
      actor,
      actorDepartment,
      courseIds: nextCourseIds,
      users: targetUsers,
      departmentLookup,
    });

    const previousCourseIds = (batch?.courseIds || []).map((courseId: any) => stringifyId(courseId));
    const previousUserIds = (batch?.userIds || []).map((userId: any) => stringifyId(userId));
    const nextUserIds = allowedUsers.map((user) => stringifyId(user._id));

    const addedCourseIds = nextCourseIds.filter((courseId) => !previousCourseIds.includes(courseId));
    const removedCourseIds = previousCourseIds.filter((courseId) => !nextCourseIds.includes(courseId));
    const addedUsers = allowedUsers.filter((user) => !previousUserIds.includes(stringifyId(user._id)));
    const removedUserIds = previousUserIds.filter((userId) => !nextUserIds.includes(userId));

    await Batch.updateOne(
      { _id: batch?._id },
      {
        $set: {
          name: value.name || batch?.name,
          courseIds: nextCourseIds.map((courseId) => toObjectId(courseId)),
          userIds: nextUserIds.map((userId) => toObjectId(userId)),
          startDate: value.startDate ? new Date(value.startDate) : batch?.startDate,
          endDate: Object.prototype.hasOwnProperty.call(req.body, "endDate")
            ? (value.endDate ? new Date(value.endDate) : null)
            : batch?.endDate || null,
        },
      }
    );

    if (addedUsers.length) {
      await syncBatchEnrollments(String(batch?._id), addedUsers.map((user) => stringifyId(user._id)), actor.userId);
    }

    if (removedUserIds.length) {
      await BatchEnrollment.deleteMany({
        batchId: toObjectId(String(batch?._id)),
        userId: { $in: removedUserIds.map((userId) => toObjectId(userId)) },
      });
    }

    if (addedUsers.length) {
      await upsertEnrollmentSources({
        courseIds: nextCourseIds,
        users: addedUsers,
        source: {
          type: "batch",
          batchId: String(batch?._id),
          batchName: value.name || batch?.name,
          assignedBy: actor.userId,
          validFrom: value.startDate ? new Date(value.startDate) : batch?.startDate,
          validTill: Object.prototype.hasOwnProperty.call(req.body, "endDate")
            ? (value.endDate ? new Date(value.endDate) : null)
            : batch?.endDate || null,
          dueDate: Object.prototype.hasOwnProperty.call(req.body, "endDate")
            ? (value.endDate ? new Date(value.endDate) : null)
            : batch?.endDate || null,
        },
      });
    }

    if (addedCourseIds.length && nextUserIds.length) {
      const currentUsers = await User.find({
        _id: { $in: nextUserIds.map((userId) => toObjectId(userId)) },
        deletedAt: { $exists: false },
      }).lean();

      await upsertEnrollmentSources({
        courseIds: addedCourseIds,
        users: currentUsers,
        source: {
          type: "batch",
          batchId: String(batch?._id),
          batchName: value.name || batch?.name,
          assignedBy: actor.userId,
          validFrom: value.startDate ? new Date(value.startDate) : batch?.startDate,
          validTill: Object.prototype.hasOwnProperty.call(req.body, "endDate")
            ? (value.endDate ? new Date(value.endDate) : null)
            : batch?.endDate || null,
          dueDate: Object.prototype.hasOwnProperty.call(req.body, "endDate")
            ? (value.endDate ? new Date(value.endDate) : null)
            : batch?.endDate || null,
        },
      });
    }

    if (removedCourseIds.length) {
      await removeBatchEnrollmentSources({
        batchId: String(batch?._id),
        courseIds: removedCourseIds,
      });
    }

    if (value.removeAccessOnUserRemoval && removedUserIds.length) {
      await removeBatchEnrollmentSources({
        batchId: String(batch?._id),
        userIds: removedUserIds,
      });
    }

    const result = formatAssignmentResult(
      addedUsers.length * nextCourseIds.length + addedCourseIds.length * nextUserIds.length,
      [...targetFailures, ...scopeFailures]
    );

    return res.status(200).send({
      status: "success",
      message: "Batch updated successfully",
      data: {
        batchId: batch?._id,
        name: value.name || batch?.name,
        addedCourseIds,
        removedCourseIds,
        addedUserCount: addedUsers.length,
        removedUserCount: removedUserIds.length,
        ...result,
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const listBatchesService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    if (!isLearnerRole(actor.role)) {
      ensurePermission(req.bodyData || req.user, PERMISSION_KEYS.VIEW_BATCHES, "You do not have permission to view batches");
    }
    ensureRole(actor, ["superadmin", "admin", "departmenthead"]);

    const requestedCompanyId =
      actor.role === "superadmin"
        ? String(req.query.companyId || "").trim() || undefined
        : actor.companyId;

    const batches = await Batch.find({
      ...(requestedCompanyId ? { companyId: toObjectId(requestedCompanyId) } : {}),
    })
      .populate("companyId", "company_name")
      .populate("createdBy", "name email username role")
      .sort({ createdAt: -1 })
      .lean();

    let scopedBatches = batches;
    if (actor.role === "departmenthead") {
      const actorDepartment = await resolveActorDepartmentRecord(actor).catch(() => null);
      if (!actorDepartment) {
        throw generateError("Department head is missing department scope", 403);
      }

      const departmentLookup = await buildDepartmentLookup(actor.companyId);
      const visibilityChecks = await Promise.all(
        batches.map(async (batch) => ({
          batch,
          isVisible: await batchMatchesDepartmentScope({
            batch,
            actorDepartment,
            departmentLookup,
          }),
        }))
      );

      scopedBatches = visibilityChecks
        .filter((entry) => entry.isVisible)
        .map((entry) => entry.batch);
    }

    return res.status(200).send({
      status: "success",
      message: "Batches fetched successfully",
      data: scopedBatches.map((batch: any) => ({
        _id: batch._id,
        name: batch.name,
        company: batch.companyId,
        courseCount: (batch.courseIds || []).length,
        userCount: (batch.userIds || []).length,
        startDate: batch.startDate,
        endDate: batch.endDate,
        status: getBatchStatus(batch.startDate, batch.endDate),
        isExpired: getBatchStatus(batch.startDate, batch.endDate) === "expired",
        createdBy: batch.createdBy,
        createdAt: batch.createdAt,
      })),
    });
  } catch (err: any) {
    next(err);
  }
};

export const getBatchDetailsService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    if (!isLearnerRole(actor.role)) {
      ensurePermission(req.bodyData || req.user, PERMISSION_KEYS.VIEW_BATCHES, "You do not have permission to view batches");
    }
    const batch = await Batch.findById(req.params.id)
      .populate("companyId", "company_name")
      .populate("createdBy", "name email username role")
      .populate("courseIds", "title status description curriculum thumbnailUrl")
      .populate("userIds", "name email username department")
      .lean();

    await assertBatchScope(actor, batch);

    if (isLearnerRole(actor.role)) {
      const enrollment = await BatchEnrollment.findOne({
        batchId: batch?._id,
        userId: toObjectId(actor.userId),
      }).lean();

      if (!enrollment) {
        throw generateError("You do not have access to this batch", 403);
      }
    }

    const progressEnrollments =
      isLearnerRole(actor.role)
        ? await CourseEnrollment.find({
            userId: toObjectId(actor.userId),
            courseId: { $in: (batch?.courseIds || []).map((course: any) => course._id || course) },
          }).lean()
        : [];

    const progressMap = new Map(
      progressEnrollments.map((enrollment: any) => [stringifyId(enrollment.courseId), enrollment])
    );

    return res.status(200).send({
      status: "success",
      message: "Batch details fetched successfully",
      data: {
        _id: batch?._id,
        name: batch?.name,
        company: batch?.companyId,
        startDate: batch?.startDate,
        endDate: batch?.endDate,
        status: getBatchStatus(batch?.startDate, batch?.endDate),
        isExpired: getBatchStatus(batch?.startDate, batch?.endDate) === "expired",
        createdBy: batch?.createdBy,
        users: (batch?.userIds || []).map((user: any) => ({
          _id: user._id,
          name: user.name || user.mobileNumber || user.email || user.username,
          mobileNumber: user.mobileNumber || user.username || "",
          email: user.email || user.username,
          department: user.department || "",
        })),
        courses: (batch?.courseIds || []).map((course: any) => {
          const enrollment = progressMap.get(stringifyId(course._id));
          const merged = enrollment ? buildMergedEnrollmentSummary({ ...enrollment, courseId: course }) : null;
          const batchSource = merged?.sources?.find(
            (source: any) => source.type === "batch" && String(source.batchId) === String(batch?._id)
          );

          return {
            _id: course._id,
            title: course.title,
            status: merged?.status || "not_started",
            progress: merged?.progress || 0,
            description: course.description,
            curriculum: course.curriculum,
            thumbnailUrl: course.thumbnailUrl,
            sourceLabel: batchSource?.label || `From Batch: ${batch?.name || "Batch"}`,
            validTill: batchSource?.validTill || batch?.endDate || null,
            isExpired: Boolean(batchSource?.isExpired),
          };
        }),
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const previewBatchUploadService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensureRole(actor, ["superadmin", "admin", "departmenthead"]);
    ensurePermission(req.bodyData || req.user, PERMISSION_KEYS.MANAGE_BATCHES, "You do not have permission to manage batches");

    if (!req.file?.buffer) {
      throw generateError("Upload file is required", 400);
    }

    const companyId = actor.role === "superadmin" ? String(req.body.companyId || "").trim() : String(actor.companyId || "").trim();
    if (!companyId) {
      throw generateError("companyId is required to validate the upload", 422);
    }

    await ensureCompanyManagementAccess({
      actor,
      requestedCompanyId: companyId,
      actionLabel: "create batches for this company",
      allowSuperadminWithoutCompany: false,
    });

    const actorDepartment = actor.role === "departmenthead" ? await resolveActorDepartmentRecord(actor).catch(() => null) : null;
    const departmentLookup = await buildDepartmentLookup(companyId);
    const preview = await resolveBatchUploadUsers({
      fileBuffer: req.file.buffer,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      actor,
      actorDepartment,
      departmentLookup,
      companyId,
    });

    let allowedUsers = preview.validUsers;
    let scopeFailures: any[] = [];

    if (preview.validCourses.length && preview.validUsers.length) {
      const scopedResult = await assertBatchScopeAccess({
        actor,
        actorDepartment,
        courseIds: preview.validCourses.map((course: any) => stringifyId(course._id)),
        users: preview.validUsers,
        departmentLookup,
      });
      allowedUsers = scopedResult.allowedUsers;
      scopeFailures = scopedResult.failures;
    }

    const validUserIdSet = new Set(allowedUsers.map((user) => stringifyId(user._id)));
    const courseFailures = preview.courseFailures.map((entry) => ({
      rowNumber: entry.rowNumber,
      courseCode: entry.courseCode || "",
      courseId: entry.courseId || "",
      reason: entry.reason,
    }));
    const userFailures = [
      ...preview.userFailures.map((entry) => ({
        rowNumber: entry.rowNumber,
        phone: entry.phone || "",
        employeeId: entry.employeeId || "",
        userId: entry.userId || "",
        reason: entry.reason,
      })),
      ...scopeFailures.map((entry) => ({
        rowNumber: undefined,
        phone: entry.phone || "",
        employeeId: "",
        userId: entry.userId || "",
        reason: entry.reason,
      })),
    ];

    const validCourses = preview.validCourses.map(serializeBatchCourse);
    const validUsers = allowedUsers.map(serializeBatchUser);

    return res.status(200).send({
      status: "success",
      message: "Batch upload preview generated successfully",
      data: {
        matchedUsers: validUsers,
        matchedCourses: validCourses,
        courseErrors: courseFailures,
        userErrors: userFailures,
        failedEntries: [...courseFailures, ...userFailures].map((entry: any) => ({
          phone: entry.phone || "",
          reason: entry.reason,
          rowNumber: entry.rowNumber,
          userId: entry.userId,
          courseId: entry.courseId,
        })),
        matchedCount: validUsers.length,
        courseCount: validCourses.length,
        failedCount: courseFailures.length + userFailures.length,
        fileName: req.file.originalname,
        totalRows: preview.totalRows,
        validRowCount: validCourses.length + validUsers.length,
        summary: {
          totalRows: preview.totalRows,
          validRows: preview.validCourseRows + validUserIdSet.size,
          failedRows: courseFailures.length + userFailures.length,
          courseRows: preview.totalCourseRows,
          userRows: preview.totalUserRows,
          validCourseRows: preview.validCourseRows,
          validUserRows: validUsers.length,
          failedCourseRows: courseFailures.length,
          failedUserRows: userFailures.length,
        },
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const deleteBatchService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensureRole(actor, ["superadmin", "admin", "departmenthead"]);
    ensurePermission(req.bodyData || req.user, PERMISSION_KEYS.MANAGE_BATCHES, "You do not have permission to manage batches");

    const batch = await Batch.findById(req.params.id).lean();
    await assertBatchScope(actor, batch);
    assertBatchDeletePermission(actor, batch);
    await ensureCompanyManagementAccess({
      actor,
      requestedCompanyId: stringifyId(batch?.companyId),
      actionLabel: "manage batches for this company",
      allowSuperadminWithoutCompany: false,
    });

    const batchId = stringifyId(batch?._id);
    if (!batchId) {
      throw generateError("Batch not found", 404);
    }

    await removeBatchEnrollmentSources({ batchId });
    await BatchEnrollment.deleteMany({ batchId: toObjectId(batchId) });
    await Batch.deleteOne({ _id: toObjectId(batchId) });

    return res.status(200).send({
      status: "success",
      message: "Batch deleted successfully",
      data: {
        batchId,
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const getMyCoursesService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    if (!actor.userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    const enrollments = await CourseEnrollment.find({
      userId: toObjectId(actor.userId),
    })
      .populate({
        path: "courseId",
        populate: [
          { path: "company", select: "company_name" },
          {
            path: "createdBy",
            select: "name designation company pic",
            populate: { path: "company", select: "company_name" },
          },
        ],
      })
      .sort({ updatedAt: -1 })
      .lean();
    const courseProgressDocs = await UserCourseProgress.find({
      userId: toObjectId(actor.userId),
      courseId: {
        $in: enrollments
          .map((enrollment: any) => enrollment.courseId?._id || enrollment.courseId)
          .filter(Boolean)
          .map((courseId: any) => toObjectId(stringifyId(courseId))),
      },
    })
      .select("courseId progress score lessonStatus")
      .lean();
    const courseProgressMap = new Map(
      courseProgressDocs.map((progressDoc: any) => [stringifyId(progressDoc.courseId), progressDoc])
    );

    const data = await Promise.all(enrollments
      .filter((enrollment: any) => enrollment.courseId && enrollment.courseId.status === "published")
      .map(async (enrollment: any) => {
        const presentationCourse = serializeCoursePresentation(enrollment.courseId);
        const merged = buildMergedEnrollmentSummary(enrollment);
        const progressDoc = courseProgressMap.get(merged.courseId);
        const effectiveAssessment = resolveEffectiveEnrollmentAssessment(
          enrollment,
          presentationCourse?.assessment
        );
        const assessmentSummary = buildCourseAssessmentSummary({
          assessment: effectiveAssessment,
          score: progressDoc?.score ?? null,
          progress: progressDoc?.progress ?? merged.progress,
          lessonStatus: progressDoc?.lessonStatus ?? merged.status,
        });
        const certificate = await buildCertificateSnapshotSafely({
          userId: actor.userId,
          courseId: merged.courseId,
          course: enrollment.courseId,
          enrollment,
          progressDoc,
          assessmentSummary,
        });

        return {
          courseId: merged.courseId,
          title: merged.title,
          progress: merged.progress,
          status: merged.status,
          sources: merged.sources,
          validTill: merged.validTill,
          isExpired: merged.isExpired,
          visibilityStatus: merged.visibilityStatus,
          description: presentationCourse?.description,
          thumbnailUrl: presentationCourse?.thumbnailUrl,
          taxonomy: presentationCourse?.taxonomy,
          progression: presentationCourse?.progression,
          curriculum: sanitizeCourseCurriculumForLearner(presentationCourse?.curriculum),
          commerce: presentationCourse?.commerce,
          visibility: presentationCourse?.visibility,
          highlights: presentationCourse?.highlights,
          instructor: presentationCourse?.instructor,
          assessment: effectiveAssessment,
          assessmentSummary,
          certificate,
        };
      }));

    return res.status(200).send({
      status: "success",
      message: "My courses fetched successfully",
      data,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getMyCourseDetailsService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    if (!actor.userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    const courseId = String(req.params.courseId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      throw generateError("Invalid course id", 400);
    }

    const enrollment = await CourseEnrollment.findOne({
      userId: toObjectId(actor.userId),
      courseId: toObjectId(courseId),
    })
      .populate({
        path: "courseId",
        populate: [
          { path: "company", select: "company_name" },
          {
            path: "createdBy",
            select: "name designation company pic",
            populate: { path: "company", select: "company_name" },
          },
        ],
      })
      .lean();

    if (!enrollment || !enrollment.courseId) {
      throw generateError("Course not found in your enrollments", 404);
    }

    if (String((enrollment.courseId as any).status) !== "published") {
      throw generateError("Course not found", 404);
    }

    const [courseProgressDoc, sectionProgressDocs] = await Promise.all([
      UserCourseProgress.findOne({
        userId: toObjectId(actor.userId),
        courseId: toObjectId(courseId),
      }).lean(),
      UserSectionProgress.find({
        userId: toObjectId(actor.userId),
        courseId: toObjectId(courseId),
      }).lean(),
    ]);

    const merged = buildMergedEnrollmentSummary(enrollment);
    const presentationCourse = serializeCoursePresentation(enrollment.courseId);
    const hierarchy = buildCourseHierarchyProgress({
      course: presentationCourse,
      userId: actor.userId,
      courseId,
      sectionProgressDocs,
      courseProgressDoc,
    });
    const effectiveAssessment = resolveEffectiveEnrollmentAssessment(enrollment, presentationCourse?.assessment);
    const assessmentSummary = buildCourseAssessmentSummary({
      assessment: effectiveAssessment,
      score: hierarchy.course.score ?? null,
      progress: hierarchy.course.progress,
      lessonStatus: hierarchy.course.lessonStatus,
    });
    const certificate = await buildCertificateSnapshotSafely({
      userId: actor.userId,
      courseId,
      course: enrollment.courseId,
      enrollment,
      progressDoc: courseProgressDoc,
      assessmentSummary,
    });

    return res.status(200).send({
      status: "success",
      message: "My course details fetched successfully",
      data: {
        ...(presentationCourse as any),
        curriculum: sanitizeCourseCurriculumForLearner((presentationCourse as any)?.curriculum),
        progress: hierarchy.course.progress,
        status: merged.status,
        sources: merged.sources,
        validTill: merged.validTill,
        isExpired: merged.isExpired,
        visibilityStatus: merged.visibilityStatus,
        assessment: effectiveAssessment,
        assessmentSummary,
        certificate,
        progressModules: serializeCourseHierarchyModules(hierarchy.modules),
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const getMyBatchesService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    if (!actor.userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    const batchEnrollments = await BatchEnrollment.find({
      userId: toObjectId(actor.userId),
    })
      .populate({
        path: "batchId",
        populate: [
          { path: "companyId", select: "company_name" },
          { path: "createdBy", select: "name email username role" },
          { path: "courseIds", select: "_id title" },
        ],
      })
      .sort({ createdAt: -1 })
      .lean();

    const batchIds = batchEnrollments
      .map((batchEnrollment: any) => batchEnrollment.batchId)
      .filter(Boolean)
      .map((batch: any) => batch._id || batch);
    const allCourseIds = batchEnrollments.flatMap((batchEnrollment: any) =>
      ((batchEnrollment.batchId?.courseIds || []) as any[]).map((course: any) => course._id || course)
    );

    const courseEnrollments = await CourseEnrollment.find({
      userId: toObjectId(actor.userId),
      courseId: { $in: allCourseIds.map((courseId: any) => toObjectId(stringifyId(courseId))) },
    }).lean();

    const enrollmentMap = new Map(
      courseEnrollments.map((enrollment: any) => [stringifyId(enrollment.courseId), enrollment])
    );

    const data = batchEnrollments
      .filter((batchEnrollment: any) => batchEnrollment.batchId)
      .map((batchEnrollment: any) => {
        const batch: any = batchEnrollment.batchId;
        const batchCourseIds = (batch.courseIds || []).map((course: any) => stringifyId(course._id || course));
        const completedCount = batchCourseIds.filter((courseId: string) => {
          const enrollment = enrollmentMap.get(courseId);
          const batchSource = normalizeEnrollmentSources(enrollment).find(
            (source: any) => String(source.type) === "batch" && stringifyId(source.batchId) === stringifyId(batch._id)
          );
          return batchSource && enrollment?.status === "completed";
        }).length;
        const totalCount = batchCourseIds.length;
        const isCompleted = totalCount > 0 && completedCount === totalCount;

        return {
          _id: batch._id,
          name: batch.name,
          company: batch.companyId,
          courseCount: totalCount,
          completedCount,
          startDate: batch.startDate,
          endDate: batch.endDate,
          status: getBatchStatus(batch.startDate, batch.endDate, isCompleted),
          isExpired: getBatchStatus(batch.startDate, batch.endDate, isCompleted) === "expired",
          durationLabel: batch.endDate
            ? `${new Date(batch.startDate).toLocaleDateString()} - ${new Date(batch.endDate).toLocaleDateString()}`
            : `Started ${new Date(batch.startDate).toLocaleDateString()}`,
          createdBy: batch.createdBy,
        };
      });

    return res.status(200).send({
      status: "success",
      message: "My batches fetched successfully",
      data,
    });
  } catch (err: any) {
    next(err);
  }
};
