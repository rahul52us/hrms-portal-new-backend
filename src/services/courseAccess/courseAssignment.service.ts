import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import CourseAccess from "../../schemas/course/CourseAccess";
import User from "../../schemas/User/User";
import { normalizeCourseAssessment } from "../course/courseMetadata.helpers";
import {
  accessDocCanAssignToDepartment,
  accessDocCanAssignToUser,
  buildDepartmentLookup,
  ensurePublishedCourse,
  ensureRole,
  getActorContext,
  getDepartmentScopedUserMatch,
  isWithinValidityWindow,
  resolveActorDepartmentRecord,
  resolveDepartmentRecord,
  resolveUserDepartmentRecord,
  toObjectId,
} from "./utils/accessControl";
import { createCourseAccessRecords, ensureCompanyLevelCourseAccess } from "./courseAccess.service";
import { assignCourseValidation } from "./utils/validation";
import { parsePossibleArray, resolveUploadedUsers } from "./utils/assignmentParsing";
import { upsertEnrollmentSources } from "./utils/enrollmentSources";
import { PERMISSION_KEYS, ensurePermission } from "../permissions/permission.utils";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";

function stringifyId(value: any) {
  return value ? String(value) : "";
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

function buildCourseIds(body: any) {
  return [...new Set([...parsePossibleArray(body.courseIds), body.courseId].filter(Boolean).map((item) => String(item).trim()))];
}

function normalizeNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw generateError("Passing marks must be a valid non-negative number", 422);
  }

  return Math.round(numericValue * 100) / 100;
}

function parseAssessmentCriteriaByCourse(value: any) {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }

    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      throw generateError("assessmentCriteriaByCourse must be valid JSON", 422);
    }
  }

  return typeof value === "object" ? value : {};
}

async function buildAssignmentCourseContext(courseIds: string[], criteriaInput: any) {
  const criteriaByCourseInput = parseAssessmentCriteriaByCourse(criteriaInput);
  const assessmentCriteriaByCourse = new Map<string, { totalMarks: number | null; passingMarks: number | null }>();

  for (const courseId of courseIds) {
    const course = await ensurePublishedCourse(courseId);
    const requestedCriteria =
      criteriaByCourseInput?.[courseId] || criteriaByCourseInput?.[String(course?._id)] || {};
    const totalMarks = normalizeNullableNumber(course?.assessment?.totalMarks);
    const passingMarks = normalizeNullableNumber(requestedCriteria?.passingMarks);

    if (totalMarks !== null && passingMarks === null) {
      throw generateError(`Passing marks are required for ${course?.title || "the selected course"}`, 422);
    }

    if (totalMarks !== null && passingMarks !== null && passingMarks > totalMarks) {
      throw generateError(
        `Passing marks for ${course?.title || "the selected course"} cannot exceed total marks (${totalMarks})`,
        422
      );
    }

    assessmentCriteriaByCourse.set(
      courseId,
      normalizeCourseAssessment({
        totalMarks,
        passingMarks,
      })
    );
  }

  return { assessmentCriteriaByCourse };
}

function serializeMatchedUser(user: any) {
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

  const accessDocs = (await CourseAccess.find(query).lean()).filter((accessDoc: any) =>
    isWithinValidityWindow(accessDoc.validFrom, accessDoc.validTill)
  );

  if (!accessDocs.length) {
    throw generateError("This course is visible but not open for further assignment", 403);
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

  if (actor.role === "departmenthead" && !actorDepartment) {
    return accessDocs.filter((accessDoc: any) => String(accessDoc.accessLevel) !== "department");
  }

  return accessDocs;
}

function canAssignCompanyWide(options: { accessDocs: any[]; companyId?: string }) {
  if (!options.companyId) {
    return false;
  }

  return options.accessDocs.some(
    (accessDoc: any) =>
      String(accessDoc.accessLevel) === "company" && String(accessDoc.companyId) === String(options.companyId)
  );
}

async function resolveTargetUsers(options: {
  actor: any;
  actorDepartment: any;
  assignmentType: string;
  userIds?: string[];
  departmentId?: string;
  departmentName?: string;
  companyId?: string;
  csvBuffer?: Buffer;
  uploadedFileName?: string;
  uploadedMimeType?: string;
}) {
  const departmentLookup = await buildDepartmentLookup(options.actor.companyId || options.companyId);
  const failures: any[] = [];
  let targetUsers: any[] = [];

  if (options.assignmentType === "users") {
    const uniqueUserIds = [...new Set((options.userIds || []).map((userId) => String(userId).trim()).filter(Boolean))];
    targetUsers = await User.find({
      _id: { $in: uniqueUserIds.map((userId) => toObjectId(userId)) },
      deletedAt: { $exists: false },
      ...(options.actor.companyId ? { company: toObjectId(options.actor.companyId) } : {}),
      ...(options.companyId ? { company: toObjectId(options.companyId) } : {}),
    }).lean();

    if (targetUsers.length !== uniqueUserIds.length) {
      throw generateError("One or more selected users were not found in your allowed scope", 404);
    }
  }

  if (options.assignmentType === "department") {
    const department = await resolveDepartmentRecord({
      companyId: options.actor.companyId || options.companyId,
      departmentId: options.departmentId,
      departmentName: options.departmentName,
    });

    if (!department) {
      throw generateError("Department is required", 400);
    }

    targetUsers = await User.find({
      company: toObjectId(String(department.company)),
      deletedAt: { $exists: false },
      role: { $nin: ["admin", "superadmin"] },
      ...getDepartmentScopedUserMatch(department),
    }).lean();

    if (!targetUsers.length) {
      throw generateError("No users were found in the selected department", 404);
    }
  }

  if (options.assignmentType === "company") {
    if (options.actor.role === "departmenthead") {
      throw generateError("Department heads cannot assign company-wide enrollments", 403);
    }

    const resolvedCompanyId = options.actor.companyId || options.companyId;
    if (!resolvedCompanyId) {
      throw generateError("companyId is required for company assignment", 400);
    }

    targetUsers = await User.find({
      company: toObjectId(resolvedCompanyId),
      deletedAt: { $exists: false },
      role: { $nin: ["admin", "superadmin"] },
    }).lean();

    if (!targetUsers.length) {
      throw generateError("No users were found in the selected company", 404);
    }
  }

  if (options.assignmentType === "csv") {
    if (!options.csvBuffer) {
      throw generateError("CSV file is required", 400);
    }

    const csvUsers = await resolveUploadedUsers({
      fileBuffer: options.csvBuffer,
      fileName: options.uploadedFileName,
      mimeType: options.uploadedMimeType,
      actor: options.actor,
      actorDepartment: options.actorDepartment,
      departmentLookup,
      companyId: options.companyId || options.actor.companyId,
      requirePhone: false,
    });

    failures.push(...csvUsers.failures);
    targetUsers = csvUsers.matchedUsers;
  }

  return { targetUsers, failures, departmentLookup };
}

export const assignCourseService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensurePermission(req.bodyData || req.user, PERMISSION_KEYS.ASSIGN_COURSES, "You do not have permission to assign courses");
    const payload = {
      ...req.body,
      courseIds: buildCourseIds(req.body),
      userIds: parsePossibleArray(req.body.userIds),
      assignmentType: req.body.assignmentType || (req.file ? "csv" : undefined),
    };

    const { error, value } = assignCourseValidation.validate(payload, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      throw generateError(error.details.map((item) => item.message).join(", "), 422);
    }

    const courseIds = [...new Set([...parsePossibleArray(value.courseIds), value.courseId].filter(Boolean))];
    if (!courseIds.length) {
      throw generateError("At least one courseId is required", 422);
    }

    const requestedCompanyId =
      actor.role === "superadmin"
        ? String(value.companyId || "").trim() || undefined
        : actor.companyId;
    await ensureCompanyManagementAccess({
      actor,
      requestedCompanyId,
      actionLabel: "assign courses to this company",
      allowSuperadminWithoutCompany: false,
    });

    const { assessmentCriteriaByCourse } = await buildAssignmentCourseContext(
      courseIds,
      req.body?.assessmentCriteriaByCourse
    );

    if (actor.role === "superadmin") {
      const accessLevel =
        value.assignmentType === "company"
          ? "company"
          : value.assignmentType === "department"
            ? "department"
            : value.assignmentType === "users" || value.assignmentType === "csv"
              ? "user"
              : null;

      if (!accessLevel) {
        throw generateError("Superadmin assignment supports company, department, users, or CSV", 400);
      }

      let superadminUserIds = value.userIds;
      let csvFailures: any[] = [];

      if (value.assignmentType === "csv") {
        if (!req.file?.buffer) {
          throw generateError("Upload file is required", 400);
        }

        const csvUsers = await resolveUploadedUsers({
          fileBuffer: req.file.buffer,
          fileName: req.file?.originalname,
          mimeType: req.file?.mimetype,
          actor,
          actorDepartment: null,
          departmentLookup: await buildDepartmentLookup(value.companyId),
          companyId: value.companyId,
          requirePhone: false,
        });
        superadminUserIds = csvUsers.matchedUsers.map((user: any) => String(user._id));
        csvFailures = csvUsers.failures;
      }

      const results = [];
      for (const courseId of courseIds) {
        const assessmentCriteria = assessmentCriteriaByCourse.get(courseId) || null;
        const result = await createCourseAccessRecords(
          {
            courseId,
            accessLevel,
            companyId: value.companyId,
            departmentId: value.departmentId,
            departmentName: value.departmentName,
            userIds: superadminUserIds,
            passingMarks: assessmentCriteria?.passingMarks ?? null,
            allowFurtherAssignment: value.allowFurtherAssignment,
            validFrom: value.validFrom,
            validTill: value.validTill || value.dueDate || null,
            assignToAllUsers: true,
          },
          actor.userId
        );
        results.push({ courseId, ...result });
      }

      return res.status(201).send({
        status: "success",
        message: "Course assignments processed successfully",
        data: {
          courseCount: courseIds.length,
          successCount: results.reduce(
            (total, item) => total + Number(item.createdCount || 0) + Number(item.updatedCount || 0),
            0
          ),
          failed: csvFailures.map(formatFailure),
          failedEntries: csvFailures.map(formatFailure),
          results,
        },
      });
    }

    ensureRole(actor, ["admin", "departmenthead"]);
    const actorDepartment = await resolveActorDepartmentRecord(actor).catch(() => null);
    if (actor.role === "departmenthead" && !actor.departmentName) {
      throw generateError("Department head is missing department scope", 403);
    }

    const assignmentCompanyId = String(actor.companyId || value.companyId || "").trim() || undefined;
    const targetDepartment =
      value.assignmentType === "department"
        ? await resolveDepartmentRecord({
            companyId: assignmentCompanyId,
            departmentId: value.departmentId,
            departmentName: value.departmentName,
          })
        : null;

    const assignableAccessByCourse = new Map<string, any[]>();
    for (const courseId of courseIds) {
      assignableAccessByCourse.set(courseId, await getAssignableAccessDocs(actor, actorDepartment, courseId));
    }

    if (value.assignmentType === "company") {
      for (const courseId of courseIds) {
        const accessDocs = assignableAccessByCourse.get(courseId) || [];
        if (!canAssignCompanyWide({ accessDocs, companyId: assignmentCompanyId })) {
          throw generateError("Company-wide assignment requires an active company-level course grant", 403);
        }
      }
    }

    if (value.assignmentType === "department") {
      for (const courseId of courseIds) {
        const accessDocs = assignableAccessByCourse.get(courseId) || [];
        const canAssignDepartment = accessDocs.some((accessDoc: any) =>
          accessDocCanAssignToDepartment({
            accessDoc,
            actor,
            actorDepartmentId: actorDepartment ? String(actorDepartment._id) : null,
            targetCompanyId: String(targetDepartment?.company || assignmentCompanyId || ""),
            targetDepartmentId: String(targetDepartment?._id || ""),
          })
        );

        if (!canAssignDepartment) {
          throw generateError("Department assignment requires an active company or department-level course grant", 403);
        }
      }
    }

    const { targetUsers, failures, departmentLookup } = await resolveTargetUsers({
      actor,
      actorDepartment,
      assignmentType: value.assignmentType,
      userIds: value.userIds,
      departmentId: value.departmentId,
      departmentName: value.departmentName,
      companyId: value.companyId,
      csvBuffer: req.file?.buffer,
      uploadedFileName: req.file?.originalname,
      uploadedMimeType: req.file?.mimetype,
    });

    if (!targetUsers.length) {
      return res.status(200).send({
        status: "success",
        message: "No new enrollments were created",
        data: {
          courseCount: courseIds.length,
          successCount: 0,
          failed: failures.map(formatFailure),
          failedEntries: failures.map(formatFailure),
        },
      });
    }

    const allowedUsersByCourse = new Map<string, any[]>();
    for (const courseId of courseIds) {
      allowedUsersByCourse.set(courseId, []);
    }

    for (const targetUser of targetUsers) {
      const targetDepartment = resolveUserDepartmentRecord(targetUser, departmentLookup);
      const targetDepartmentId = targetDepartment ? String(targetDepartment._id) : null;

      if (actor.role === "departmenthead" && String(targetDepartmentId) !== String(actorDepartment?._id)) {
        failures.push({
          userId: targetUser._id,
          email: targetUser.email || targetUser.username,
          reason: "User is outside your department scope",
        });
        continue;
      }

      for (const courseId of courseIds) {
        const accessDocs = assignableAccessByCourse.get(courseId) || [];
        const hasAccess = accessDocs.some((accessDoc: any) =>
          accessDocCanAssignToUser({
            accessDoc,
            actor,
            actorDepartmentId: actorDepartment ? String(actorDepartment._id) : null,
            targetUser,
            targetDepartmentId,
          })
        );

        if (!hasAccess) {
          failures.push({
            userId: targetUser._id,
            email: targetUser.email || targetUser.username,
            courseId,
            reason: "User does not have an eligible access grant for this course",
          });
          continue;
        }

        allowedUsersByCourse.get(courseId)?.push(targetUser);
      }
    }

    const sourceValidFrom = value.validFrom ? new Date(value.validFrom) : new Date();
    const sourceValidTill = value.validTill ? new Date(value.validTill) : value.dueDate ? new Date(value.dueDate) : null;
    let successCount = 0;
    let hierarchyAccessCreatedCount = 0;

    for (const courseId of courseIds) {
      const permittedUsers = Array.from(
        new Map((allowedUsersByCourse.get(courseId) || []).map((user) => [String(user._id), user])).values()
      );

      if (!permittedUsers.length) {
        continue;
      }

      const resolvedCompanyId =
        assignmentCompanyId ||
        (permittedUsers[0]?.company ? String(permittedUsers[0].company) : undefined);
      const assessmentCriteria = assessmentCriteriaByCourse.get(courseId) || null;

      if (resolvedCompanyId) {
        const companyAccessResult = await ensureCompanyLevelCourseAccess(
          {
            courseId,
            companyId: resolvedCompanyId,
            assessmentCriteria,
            validFrom: sourceValidFrom,
            validTill: sourceValidTill,
          },
          actor.userId
        );
        hierarchyAccessCreatedCount += companyAccessResult.createdCount;
      }

      if (value.assignmentType === "department" && targetDepartment) {
        const departmentAccessResult = await createCourseAccessRecords(
          {
            courseId,
            accessLevel: "department",
            companyId: resolvedCompanyId || String(targetDepartment.company),
            departmentId: String(targetDepartment._id),
            passingMarks: assessmentCriteria?.passingMarks ?? null,
            allowFurtherAssignment: false,
            validFrom: sourceValidFrom,
            validTill: sourceValidTill,
            assignToAllUsers: false,
          },
          actor.userId
        );

        hierarchyAccessCreatedCount += Number(departmentAccessResult.createdCount || 0);
      }

      const result = await upsertEnrollmentSources({
        courseIds: [courseId],
        users: permittedUsers,
        source: {
          type: "direct",
          assignedBy: actor.userId,
          assessmentCriteria: assessmentCriteriaByCourse.get(courseId) || null,
          validFrom: sourceValidFrom,
          validTill: sourceValidTill,
          dueDate: value.dueDate || sourceValidTill,
        },
      });

      successCount += result.createdCount + result.updatedCount;

      result.skippedEntries.forEach((entry) => {
        const [, userId] = entry.split(":");
        const skippedUser = permittedUsers.find((user) => stringifyId(user._id) === userId);
        failures.push({
          userId,
          email: skippedUser?.email || skippedUser?.username,
          courseId,
          reason: "User is already assigned to this course",
        });
      });
    }

    return res.status(201).send({
      status: "success",
      message: "Course assignments processed successfully",
      data: {
        courseCount: courseIds.length,
        successCount,
        hierarchyAccessCreatedCount,
        failed: failures.map(formatFailure),
        failedEntries: failures.map(formatFailure),
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const previewCourseAssignmentUploadService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    ensurePermission(req.bodyData || req.user, PERMISSION_KEYS.ASSIGN_COURSES, "You do not have permission to assign courses");
    ensureRole(actor, ["superadmin", "admin", "departmenthead"]);

    if (!req.file?.buffer) {
      throw generateError("Upload file is required", 400);
    }

    const actorDepartment =
      actor.role === "departmenthead" ? await resolveActorDepartmentRecord(actor).catch(() => null) : null;
    const requestedCompanyId =
      actor.role === "superadmin"
        ? String(req.body.companyId || "").trim() || undefined
        : actor.companyId;

    if (actor.role === "superadmin" && !requestedCompanyId) {
      throw generateError("companyId is required to validate the upload", 422);
    }

    await ensureCompanyManagementAccess({
      actor,
      requestedCompanyId,
      actionLabel: "assign courses to this company",
      allowSuperadminWithoutCompany: false,
    });

    const departmentLookup = await buildDepartmentLookup(requestedCompanyId || actor.companyId);
    const preview = await resolveUploadedUsers({
      fileBuffer: req.file.buffer,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      actor,
      actorDepartment,
      departmentLookup,
      companyId: requestedCompanyId,
      requirePhone: false,
    });

    return res.status(200).send({
      status: "success",
      message: "Upload preview generated successfully",
      data: {
        matchedUsers: preview.matchedUsers.map(serializeMatchedUser),
        failedEntries: preview.failures.map(formatFailure),
        matchedCount: preview.matchedUsers.length,
        failedCount: preview.failures.length,
        fileName: req.file.originalname,
      },
    });
  } catch (err: any) {
    next(err);
  }
};
