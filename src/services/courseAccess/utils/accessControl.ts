import mongoose from "mongoose";
import { generateError } from "../../../config/Error/functions";
import Course from "../../../schemas/course/Course";
import Department from "../../../schemas/Department/Department.schema";

export type ActorContext = {
  userId: string;
  role: string;
  companyId?: string;
  departmentName?: string;
};

export function normalizeRole(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead");
}

export function isLearnerRole(value: unknown) {
  const role = normalizeRole(value);
  return role === "user" || role === "learner" || role === "manager" || /^l\d+-manager$/i.test(role);
}

export function isManagerRole(value: unknown) {
  const role = normalizeRole(value);
  return role === "manager" || /^l\d+-manager$/i.test(role);
}

export function toObjectId(id: string) {
  return new mongoose.Types.ObjectId(id);
}

export function getActorContext(req: any): ActorContext {
  return {
    userId: String(req.userId || req.user?._id || ""),
    role: normalizeRole(req.user?.role || req.bodyData?.role || req.user?.userType || req.bodyData?.userType),
    companyId: req.user?.company ? String(req.user.company) : req.bodyData?.company ? String(req.bodyData.company) : undefined,
    departmentName: String(req.user?.department || req.bodyData?.department || "").trim() || undefined,
  };
}

export function ensureRole(actor: ActorContext, roles: string[]) {
  if (!roles.includes(actor.role)) {
    throw generateError(`Only ${roles.join(", ")} can perform this action`, 403);
  }
}

export async function ensurePublishedCourse(courseId: string) {
  if (!mongoose.Types.ObjectId.isValid(courseId)) {
    throw generateError("Invalid course id", 400);
  }

  const course = await Course.findById(courseId).lean();
  if (!course) {
    throw generateError("Course not found", 404);
  }

  if (String(course.status) !== "published") {
    throw generateError("Only published courses can be shared or assigned", 400);
  }

  return course;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function resolveDepartmentRecord(options: {
  companyId?: string;
  departmentId?: string | null;
  departmentName?: string | null;
}) {
  const { companyId, departmentId, departmentName } = options;

  if (departmentId) {
    if (!mongoose.Types.ObjectId.isValid(departmentId)) {
      throw generateError("Invalid department id", 400);
    }

    const department = await Department.findById(departmentId).lean();
    if (!department) {
      throw generateError("Department not found", 404);
    }

    if (companyId && String(department.company) !== String(companyId)) {
      throw generateError("Department does not belong to the selected company", 400);
    }

    return department;
  }

  const normalizedDepartmentName = String(departmentName || "").trim();
  if (!companyId || !normalizedDepartmentName) {
    return null;
  }

  const department = await Department.findOne({
    company: toObjectId(companyId),
    $or: [
      { departmentName: { $regex: `^${escapeRegex(normalizedDepartmentName)}$`, $options: "i" } },
      { title: { $regex: `^${escapeRegex(normalizedDepartmentName)}$`, $options: "i" } },
      { code: { $regex: `^${escapeRegex(normalizedDepartmentName)}$`, $options: "i" } },
    ],
  }).lean();

  if (!department) {
    throw generateError(
      `Department "${normalizedDepartmentName}" is not mapped in the department directory`,
      404
    );
  }

  return department;
}

function buildDepartmentKeys(department: any) {
  return [department?.departmentName, department?.title, department?.code]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

export async function buildDepartmentLookup(companyId?: string) {
  if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
    return new Map<string, any>();
  }

  const departments = await Department.find({ company: toObjectId(companyId) }).lean();
  const map = new Map<string, any>();

  for (const department of departments) {
    for (const key of buildDepartmentKeys(department)) {
      map.set(key, department);
    }
  }

  return map;
}

export function resolveUserDepartmentRecord(user: any, departmentLookup: Map<string, any>) {
  const rawDepartment = String(user?.department || "").trim().toLowerCase();
  if (!rawDepartment) {
    return null;
  }

  return departmentLookup.get(rawDepartment) || null;
}

export async function resolveActorDepartmentRecord(actor: ActorContext) {
  if (!actor.companyId || !actor.departmentName) {
    return null;
  }

  return resolveDepartmentRecord({
    companyId: actor.companyId,
    departmentName: actor.departmentName,
  });
}

export function getDepartmentScopedUserMatch(department: any) {
  const values = [department?.departmentName, department?.title, department?.code]
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  if (!values.length) {
    return { department: "__missing_department__" };
  }

  return { department: { $in: values } };
}

export function accessDocMatchesUser(accessDoc: any, user: any, userDepartmentId?: string | null) {
  if (!accessDoc || !user) {
    return false;
  }

  if (String(accessDoc.accessLevel) === "company") {
    return accessDoc.companyId && String(accessDoc.companyId) === String(user.company);
  }

  if (String(accessDoc.accessLevel) === "department") {
    return Boolean(userDepartmentId && accessDoc.departmentId && String(accessDoc.departmentId) === String(userDepartmentId));
  }

  return accessDoc.userId && String(accessDoc.userId) === String(user._id);
}

export function accessDocCanAssignToUser(options: {
  accessDoc: any;
  actor: ActorContext;
  actorDepartmentId?: string | null;
  targetUser: any;
  targetDepartmentId?: string | null;
}) {
  const { accessDoc, actor, actorDepartmentId, targetUser, targetDepartmentId } = options;

  if (!accessDoc?.allowFurtherAssignment) {
    return false;
  }

  if (actor.role === "admin") {
    if (!actor.companyId || String(targetUser.company) !== String(actor.companyId)) {
      return false;
    }
  }

  if (actor.role === "departmenthead") {
    if (!actor.companyId || String(targetUser.company) !== String(actor.companyId)) {
      return false;
    }

    if (!actorDepartmentId || !targetDepartmentId || String(actorDepartmentId) !== String(targetDepartmentId)) {
      return false;
    }
  }

  if (String(accessDoc.accessLevel) === "company") {
    return accessDoc.companyId && String(accessDoc.companyId) === String(targetUser.company);
  }

  if (String(accessDoc.accessLevel) === "department") {
    return Boolean(targetDepartmentId && accessDoc.departmentId && String(accessDoc.departmentId) === String(targetDepartmentId));
  }

  return accessDoc.userId && String(accessDoc.userId) === String(targetUser._id);
}

export function accessDocCanAssignToDepartment(options: {
  accessDoc: any;
  actor: ActorContext;
  actorDepartmentId?: string | null;
  targetCompanyId: string;
  targetDepartmentId: string;
}) {
  const { accessDoc, actor, actorDepartmentId, targetCompanyId, targetDepartmentId } = options;

  if (!accessDoc?.allowFurtherAssignment) {
    return false;
  }

  if (actor.role === "admin" && String(actor.companyId) !== String(targetCompanyId)) {
    return false;
  }

  if (actor.role === "departmenthead") {
    if (String(actor.companyId) !== String(targetCompanyId)) {
      return false;
    }

    if (!actorDepartmentId || String(actorDepartmentId) !== String(targetDepartmentId)) {
      return false;
    }
  }

  if (String(accessDoc.accessLevel) === "company") {
    return accessDoc.companyId && String(accessDoc.companyId) === String(targetCompanyId);
  }

  if (String(accessDoc.accessLevel) === "department") {
    return accessDoc.departmentId && String(accessDoc.departmentId) === String(targetDepartmentId);
  }

  return false;
}

export function getAccessScopeLabel(accessDoc: any) {
  if (String(accessDoc?.accessLevel) === "company") {
    return "Company-wide course";
  }

  if (String(accessDoc?.accessLevel) === "department") {
    return "Department course";
  }

  return "Direct user course";
}

export function isWithinValidityWindow(validFrom?: Date | string | null, validTill?: Date | string | null) {
  const now = new Date();
  const start = validFrom ? new Date(validFrom) : null;
  const end = validTill ? new Date(validTill) : null;

  if (start && start > now) {
    return false;
  }

  if (end && end < now) {
    return false;
  }

  return true;
}

export function getValidityStatus(validFrom?: Date | string | null, validTill?: Date | string | null) {
  const now = new Date();
  const end = validTill ? new Date(validTill) : null;

  if (end && end < now) {
    return "expired";
  }

  if (end) {
    const diffInDays = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (diffInDays <= 7) {
      return "expiring_soon";
    }
  }

  return "active";
}
