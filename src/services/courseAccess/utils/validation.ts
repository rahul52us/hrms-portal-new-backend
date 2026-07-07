import Joi from "joi";

const objectId = Joi.string().trim().hex().length(24);

export const createCourseAccessValidation = Joi.object({
  courseId: objectId.required(),
  accessLevel: Joi.string().valid("company", "department", "user").required(),
  companyId: objectId.allow("", null),
  departmentId: objectId.allow("", null),
  departmentName: Joi.string().trim().allow("", null),
  userIds: Joi.array().items(objectId).default([]),
  passingMarks: Joi.number().min(0).allow(null),
  allowFurtherAssignment: Joi.boolean().default(false),
  assignToAllUsers: Joi.boolean().default(false),
  validFrom: Joi.date().iso().allow(null, ""),
  validTill: Joi.date().iso().allow(null, ""),
}).custom((value, helpers) => {
  if (value.accessLevel === "company" && !value.companyId) {
    return helpers.error("any.invalid", { message: "companyId is required for company access" });
  }

  if (
    value.accessLevel === "department" &&
    !value.departmentId &&
    !String(value.departmentName || "").trim()
  ) {
    return helpers.error("any.invalid", { message: "departmentId or departmentName is required for department access" });
  }

  if (value.accessLevel === "user" && (!Array.isArray(value.userIds) || value.userIds.length === 0)) {
    return helpers.error("any.invalid", { message: "At least one userId is required for user access" });
  }

  if (value.validFrom && value.validTill && new Date(value.validTill) < new Date(value.validFrom)) {
    return helpers.error("any.invalid", { message: "validTill must be later than validFrom" });
  }

  return value;
}, "course access validation");

export const assignCourseValidation = Joi.object({
  courseId: objectId.allow("", null),
  courseIds: Joi.alternatives().try(
    Joi.array().items(objectId).min(1),
    Joi.string().trim().allow("", null)
  ),
  assignmentType: Joi.string().valid("company", "users", "department", "csv").required(),
  userIds: Joi.alternatives().try(
    Joi.array().items(objectId).default([]),
    Joi.string().trim().allow("", null)
  ),
  departmentId: objectId.allow("", null),
  departmentName: Joi.string().trim().allow("", null),
  companyId: objectId.allow("", null),
  assessmentCriteriaByCourse: Joi.alternatives().try(Joi.object(), Joi.string().trim().allow("", null)),
  dueDate: Joi.date().iso().allow(null, ""),
  validFrom: Joi.date().iso().allow(null, ""),
  validTill: Joi.date().iso().allow(null, ""),
  allowFurtherAssignment: Joi.boolean().default(false),
}).custom((value, helpers) => {
  const resolvedCourseIds = Array.isArray(value.courseIds)
    ? value.courseIds
    : String(value.courseIds || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  if (!resolvedCourseIds.length && !value.courseId) {
    return helpers.error("any.invalid", { message: "At least one courseId is required" });
  }

  if (value.assignmentType === "company" && !value.companyId) {
    return helpers.error("any.invalid", { message: "companyId is required for company assignment" });
  }

  if (value.assignmentType === "users") {
    const userIds = Array.isArray(value.userIds)
      ? value.userIds
      : String(value.userIds || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);

    if (!userIds.length) {
      return helpers.error("any.invalid", { message: "At least one userId is required for user assignment" });
    }
  }

  if (
    value.assignmentType === "department" &&
    !value.departmentId &&
    !String(value.departmentName || "").trim()
  ) {
    return helpers.error("any.invalid", { message: "departmentId or departmentName is required for department assignment" });
  }

  if (value.validFrom && value.validTill && new Date(value.validTill) < new Date(value.validFrom)) {
    return helpers.error("any.invalid", { message: "validTill must be later than validFrom" });
  }

  return value;
}, "course assignment validation");

export const createBatchValidation = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  companyId: objectId.allow("", null),
  courseIds: Joi.alternatives().try(
    Joi.array().items(objectId).default([]),
    Joi.string().trim().allow("", null)
  ),
  userIds: Joi.alternatives().try(
    Joi.array().items(objectId).default([]),
    Joi.string().trim().allow("", null)
  ),
  startDate: Joi.date().iso().required(),
  endDate: Joi.date().iso().allow(null, ""),
}).custom((value, helpers) => {
  const resolvedCourseIds = Array.isArray(value.courseIds)
    ? value.courseIds
    : String(value.courseIds || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const resolvedUserIds = Array.isArray(value.userIds)
    ? value.userIds
    : String(value.userIds || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  if (value.endDate && new Date(value.endDate) < new Date(value.startDate)) {
    return helpers.error("any.invalid", { message: "endDate must be later than startDate" });
  }

  return value;
}, "batch validation");

export const updateBatchValidation = Joi.object({
  name: Joi.string().trim().min(2).max(120).allow("", null),
  courseIds: Joi.alternatives().try(
    Joi.array().items(objectId).default([]),
    Joi.string().trim().allow("", null)
  ),
  userIds: Joi.alternatives().try(
    Joi.array().items(objectId).default([]),
    Joi.string().trim().allow("", null)
  ),
  startDate: Joi.date().iso().allow(null, ""),
  endDate: Joi.date().iso().allow(null, ""),
  removeAccessOnUserRemoval: Joi.boolean().default(false),
}).custom((value, helpers) => {
  const resolvedCourseIds = Array.isArray(value.courseIds)
    ? value.courseIds
    : String(value.courseIds || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const resolvedUserIds = Array.isArray(value.userIds)
    ? value.userIds
    : String(value.userIds || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  if (!resolvedCourseIds.length && !resolvedUserIds.length && !value.name && !value.startDate && value.endDate === undefined) {
    return helpers.error("any.invalid", { message: "Provide at least one field to update" });
  }

  if (value.startDate && value.endDate && new Date(value.endDate) < new Date(value.startDate)) {
    return helpers.error("any.invalid", { message: "endDate must be later than startDate" });
  }

  return value;
}, "batch update validation");
