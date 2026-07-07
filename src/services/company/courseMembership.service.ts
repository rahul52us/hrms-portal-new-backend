import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import Company from "../../schemas/company/Company";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import User from "../../schemas/User/User";

function normalizeId(value: any) {
  return String(value?._id || value || "").trim();
}

const USER_COMPANY_TYPE = "user";

function buildTenantUrl(tenantSlug: string) {
  const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";

  try {
    const parsedUrl = new URL(baseUrl);
    const hostname = parsedUrl.hostname.replace(/^www\./, "");
    const port = parsedUrl.port ? `:${parsedUrl.port}` : "";

    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return `${parsedUrl.protocol}//${tenantSlug}.localhost${port}`;
    }

    return `${parsedUrl.protocol}//${tenantSlug}.${hostname}${port}`;
  } catch {
    return `https://${tenantSlug}.localhost`;
  }
}

function normalizeDisplayText(value: any) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function buildUserCompanyName(userName: string, parentCompanyName: string, companyId: string) {
  const normalizedUserName = normalizeDisplayText(userName) || "User";
  const normalizedParentCompanyName = normalizeDisplayText(parentCompanyName);

  if (normalizedParentCompanyName) {
    return `${normalizedUserName} - ${normalizedParentCompanyName}`;
  }

  return `${normalizedUserName} - ${normalizeId(companyId).slice(-6).toUpperCase()}`;
}

function buildUserCompanyDocument(userId: string, companyId: string, userName: string, parentCompanyName: string) {
  const normalizedUserId = normalizeId(userId);
  const normalizedCompanyId = normalizeId(companyId);
  const uniqueToken = `${normalizedUserId}-${normalizedCompanyId}`.toLowerCase();
  const companyName = buildUserCompanyName(userName, parentCompanyName, normalizedCompanyId);
  const tenantSlug = `user-${uniqueToken}`;
  const codeSuffix = `${normalizedUserId.slice(-6)}${normalizedCompanyId.slice(-6)}`.toUpperCase();

  return {
    type: USER_COMPANY_TYPE,
    userId: new mongoose.Types.ObjectId(normalizedUserId),
    companyOrg: new mongoose.Types.ObjectId(normalizedCompanyId),
    company_name: companyName,
    companyCode: `USR-${codeSuffix}`,
    companyType: "company",
    tenantSlug,
    tenantUrl: buildTenantUrl(tenantSlug),
    activeUser: new mongoose.Types.ObjectId(normalizedUserId),
    is_active: true,
    verified_email_allowed: false,
    addressInfo: [],
  };
}

function serializeUserCompanyMembership(userCompanyDoc: any) {
  const company = userCompanyDoc?.companyOrg;

  return {
    _id: userCompanyDoc?._id,
    userId: userCompanyDoc?.userId,
    companyId: company?._id || userCompanyDoc?.companyOrg,
    company,
    role: "user",
    status: "active",
    joinedThrough: "course_enrollment",
    courseIds: [],
    lastActiveAt: userCompanyDoc?.lastActiveAt || null,
    createdAt: userCompanyDoc?.createdAt || null,
  };
}

async function getActiveCourseCompany(companyInput: any) {
  const companyId = normalizeId(companyInput);
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    throw generateError("Course company must be assigned before enrollment", 422);
  }

  const company = await Company.findOne({
    _id: new mongoose.Types.ObjectId(companyId),
    deletedAt: { $exists: false },
  }).lean();

  if (!company) {
    throw generateError("Course company not found", 404);
  }

  if (company.is_active === false) {
    throw generateError("This course is currently unavailable because its company is inactive", 403);
  }

  return company;
}

export async function upsertCourseCompanyMembership(options: {
  userId: string;
  courseId: string;
  companyId: any;
}) {
  const company = await getActiveCourseCompany(options.companyId);
  const user = await User.findById(options.userId).select("name").lean();
  const now = new Date();
  const userCompanyDoc = buildUserCompanyDocument(
    options.userId,
    String(company._id),
    String(user?.name || ""),
    String((company as any)?.company_name || "")
  );

  const relationDoc = await Company.findOneAndUpdate(
    {
      type: USER_COMPANY_TYPE,
      companyOrg: company._id,
      userId: new mongoose.Types.ObjectId(options.userId),
      deletedAt: { $exists: false },
    },
    {
      $set: {
        lastActiveAt: now,
        updatedAt: now,
      },
      $unset: {
        departments: "",
        courseIds: "",
        createdBy: "",
        managerLevels: "",
      },
      $setOnInsert: {
        ...userCompanyDoc,
        createdAt: now,
      },
    },
    { upsert: true, new: true }
  )
    .populate("companyOrg", "company_name companyCode primaryThemeColor sidebarColors is_active")
    .lean();

  return serializeUserCompanyMembership(relationDoc);
}

export async function syncCourseMembershipsForExistingEnrollments(options: {
  courseId: string;
  companyId: any;
  previousCompanyId?: any;
}) {
  const company = await getActiveCourseCompany(options.companyId);
  const courseObjectId = new mongoose.Types.ObjectId(options.courseId);
  const enrollments = await CourseEnrollment.find({ courseId: courseObjectId })
    .select("userId")
    .lean();
  const userIds = Array.from(
    new Set(enrollments.map((enrollment: any) => normalizeId(enrollment.userId)).filter(Boolean))
  ).map((userId) => new mongoose.Types.ObjectId(userId));

  const previousCompanyId = normalizeId(options.previousCompanyId);
  if (
    userIds.length &&
    mongoose.Types.ObjectId.isValid(previousCompanyId) &&
    previousCompanyId !== String(company._id)
  ) {
    const previousCompanyCourseIds = await CourseEnrollment.db
      .collection("courses")
      .find(
        {
          company: new mongoose.Types.ObjectId(previousCompanyId),
          _id: { $ne: courseObjectId },
        },
        { projection: { _id: 1 } }
      )
      .toArray();
    const previousCompanyOtherCourseIds = previousCompanyCourseIds.map((course: any) => course._id);

    let userIdsToRetain = new Set<string>();
    if (previousCompanyOtherCourseIds.length) {
      const retainedUserIds = await CourseEnrollment.distinct("userId", {
        userId: { $in: userIds },
        courseId: { $in: previousCompanyOtherCourseIds },
      });
      userIdsToRetain = new Set(retainedUserIds.map((userId: any) => String(userId)));
    }

    const userIdsToDelete = userIds.filter((userId) => !userIdsToRetain.has(String(userId)));
    if (userIdsToDelete.length) {
      await Company.deleteMany({
        type: USER_COMPANY_TYPE,
        companyOrg: new mongoose.Types.ObjectId(previousCompanyId),
        userId: { $in: userIdsToDelete },
        deletedAt: { $exists: false },
      });
    }

    await Company.updateMany(
      {
        type: USER_COMPANY_TYPE,
        companyOrg: company._id,
        userId: { $in: userIds },
        deletedAt: { $exists: false },
      },
      {
        $unset: {
          departments: "",
          courseIds: "",
          createdBy: "",
          managerLevels: "",
        },
      }
    );
  }

  if (!userIds.length) {
    return { membershipCount: 0 };
  }

  const users = await User.find({ _id: { $in: userIds } })
    .select("_id name")
    .lean();
  const userNameById = new Map(
    users.map((user: any) => [String(user._id), String(user.name || "")])
  );
  const now = new Date();
  const operations: any[] = userIds.map((userId) => {
      const userCompanyDoc = buildUserCompanyDocument(
        String(userId),
        String(company._id),
        userNameById.get(String(userId)) || "",
        String((company as any)?.company_name || "")
      );
      return ({
      updateOne: {
        filter: {
          type: USER_COMPANY_TYPE,
          companyOrg: company._id,
          userId,
          deletedAt: { $exists: false },
        },
        update: {
          $set: {
            lastActiveAt: now,
            updatedAt: now,
          },
          $unset: {
            departments: "",
            courseIds: "",
            createdBy: "",
            managerLevels: "",
          },
          $setOnInsert: {
            ...userCompanyDoc,
            createdAt: now,
          },
        },
        upsert: true,
      },
    })});
  await Company.bulkWrite(operations);

  return { membershipCount: userIds.length };
}
