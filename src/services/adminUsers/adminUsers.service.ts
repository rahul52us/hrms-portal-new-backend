import crypto from "crypto";
import { Request, Response } from "express";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { generateError } from "../../config/Error/functions";
import { generateFileName, hashBcrypt } from "../../config/helper/function";
import { deleteFile, uploadFile } from "../../repository/uploadDoc.repository";
import ProfileDetails from "../../schemas/User/ProfileDetails";
import User from "../../schemas/User/User";
import TdsDeclaration from "../../schemas/User/tdsDeclaration.schema";
import Company from "../../schemas/company/Company";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import Department from "../../schemas/Department/Department.schema";
import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  attachEffectivePermissions,
  CONFIGURABLE_PERMISSION_ROLES,
  ensurePermission,
  getPermissionRoleOptions,
  normalizePermissionRecord,
  normalizeRolePermissionMap,
  resolvePermissionCompany,
  validatePermissionRecordForRole,
} from "../permissions/permission.utils";
import {
  assertCompanyIsActiveForManagement,
  ensureCompanyManagementAccess,
} from "../company/utils/activityGuards";
import {
  closeCurrentEmployeeAssignment,
  ensureCurrentEmployeeAssignment,
  getEmployeeAssignmentHistory,
  recordEmployeeAssignmentChange,
} from "../employeeAssignment/employeeAssignment.service";
import {
  canUserLogin,
  getUserAccountStatus,
} from "../auth/utils/userAccountStatus";
import {
  buildEmployeeIdentifier,
  MAX_EMPLOYEE_NUMBER_LENGTH,
} from "../employeeCode/employeeCode.utils";

const ExcelJS = require("exceljs");

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function normalizePhoneNumber(value: unknown) {
  return normalizeText(value).replace(/\s+/g, "");
}

const MANAGED_USER_ISSUE_FILTERS = [
  "missing_department",
  "missing_manager",
  "missing_location",
  "pending_setup",
  "incomplete_profiles",
] as const;

function buildManagedUserIssueMatch(issueInput: unknown) {
  const issue = normalizeText(issueInput).toLowerCase();
  if (!issue) return null;

  if (!MANAGED_USER_ISSUE_FILTERS.includes(issue as any)) {
    throw generateError("Invalid employee issue filter", 400);
  }

  const missingDepartment = {
    $or: [
      { department: { $exists: false } },
      { department: null },
      { department: { $regex: /^\s*$/ } },
    ],
  };
  const missingLocation = {
    $or: [
      { officeLocation: { $exists: false } },
      { officeLocation: null },
    ],
  };
  const workforceRoleMatch = {
    role: {
      $in: [
        "user",
        "departmenthead",
        "department head",
        "department-head",
        "manager",
        /^l\d+[-\s]?manager$/i,
      ],
    },
  };
  let issueCondition: any;

  if (issue === "missing_department") {
    issueCondition = missingDepartment;
  } else if (issue === "missing_manager") {
    issueCondition = {
      $and: [
        {
          role: {
            $nin: ["departmenthead", "department head", "department-head"],
          },
        },
        {
          $or: [
            { reportingManager: { $exists: false } },
            { reportingManager: null },
          ],
        },
      ],
    };
  } else if (issue === "missing_location") {
    issueCondition = missingLocation;
  } else if (issue === "pending_setup") {
    issueCondition = {
      $or: [
        { password: { $exists: false } },
        { password: null },
        { password: "" },
        { setupToken: { $exists: true, $nin: [null, ""] } },
      ],
    };
  } else {
    issueCondition = {
      $or: [
        { designation: { $exists: false } },
        { designation: null },
        { designation: { $regex: /^\s*$/ } },
        { joiningDate: { $exists: false } },
        { joiningDate: null },
        ...missingDepartment.$or,
        ...missingLocation.$or,
      ],
    };
  }

  return {
    $and: [workforceRoleMatch, issueCondition],
  };
}

function normalizeRole(value: unknown) {
  const normalized = normalizeText(value).toLowerCase();
  if (/^department[-\s]?head$/i.test(normalized)) {
    return "departmenthead";
  }

  if (/^head[-\s]?hr$/i.test(normalized) || /^hr[-\s]?admin$/i.test(normalized)) {
    return "hradmin";
  }

  if (/^hr[-\s]?executive$/i.test(normalized)) {
    return "hr";
  }

  const managerMatch = normalized.match(/^l\s*(\d+)\s*[-\s]?\s*manager$/i);
  if (managerMatch) {
    return "user";
  }

  return normalized || "user";
}

function parseManagerRoleLevel(role: unknown) {
  const match = normalizeRole(role).match(/^l(\d+)-manager$/i);
  return match ? Number(match[1]) : null;
}

function getCellValue(cell: any) {
  const rawValue = cell?.value;

  if (rawValue instanceof Date) {
    return rawValue;
  }

  if (rawValue && typeof rawValue === "object") {
    if ("text" in rawValue && rawValue.text) {
      return rawValue.text;
    }
    if ("result" in rawValue && rawValue.result) {
      return rawValue.result;
    }
  }

  return cell?.text ?? rawValue;
}

function normalizeDateValue(value: unknown) {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const parsedExcelDate = new Date(excelEpoch + value * 24 * 60 * 60 * 1000);
    return Number.isNaN(parsedExcelDate.getTime()) ? undefined : parsedExcelDate;
  }

  const normalizedValue = normalizeText(value);
  const numericDateMatch = normalizedValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (numericDateMatch) {
    const [, first, second, year] = numericDateMatch;
    const firstPart = Number(first);
    const secondPart = Number(second);
    const parsedDate =
      firstPart > 12
        ? new Date(Number(year), secondPart - 1, firstPart)
        : secondPart > 12
          ? new Date(Number(year), firstPart - 1, secondPart)
          : new Date(Number(year), secondPart - 1, firstPart);

    if (!Number.isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  }

  const parsed = new Date(normalizedValue);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhoneNumber(value: string) {
  return /^[0-9+()\-\s]{7,20}$/.test(value);
}

function normalizeGender(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  if (typeof value === "number" && [1, 2, 3, 4].includes(value)) {
    return value;
  }

  const normalizedValue = normalizeText(value).toLowerCase();
  if (!normalizedValue) {
    return undefined;
  }

  if (["1", "male"].includes(normalizedValue)) {
    return 1;
  }

  if (["2", "female"].includes(normalizedValue)) {
    return 2;
  }

  if (["3", "other"].includes(normalizedValue)) {
    return 3;
  }

  if (
    ["4", "prefer not to say", "prefer-not-to-say", "prefer_not_to_say"].includes(
      normalizedValue
    )
  ) {
    return 4;
  }

  return undefined;
}

function isFutureDate(dateValue?: Date) {
  if (!dateValue) {
    return false;
  }

  const candidateDate = new Date(dateValue);
  candidateDate.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return candidateDate.getTime() > today.getTime();
}

function getCurrentFinancialYear(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-11
  if (month >= 3) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

async function syncManagedUserTdsDeclaration(user: any) {
  const currentFY = getCurrentFinancialYear();
  const existingTds = await TdsDeclaration.findOne({
    user: user._id,
    financialYear: currentFY,
  });

  if (!existingTds) {
    await new TdsDeclaration({
      user: user._id,
      financialYear: currentFY,
    }).save();
  }
}

async function syncManagedUserProfileDetails(user: any, company: any, payload: any = {}) {
  const existingProfile = user?.profile_details
    ? await ProfileDetails.findById(user.profile_details)
    : null;

  const personalInfo = {
    ...(existingProfile?.personalInfo || {}),
    name: user?.name || "",
    username: user?.username || "",
    code: user?.code || "",
    city: user?.city || "",
    state: user?.state || "",
    designation: user?.designation || "",
    joiningDate: user?.joiningDate || null,
    confirmationDate: user?.confirmationDate || null,
    employmentEndDate: user?.employmentEndDate || null,
    mobileNumber: user?.mobileNumber || "",
    department: user?.department || "",
    team: user?.team || "",
    officeLocation: user?.officeLocation || null,
    gender: user?.gender ?? null,
    dob: user?.dateOfBirth || null,
    dateOfBirth: user?.dateOfBirth || null,
    company: company?._id || user?.company || null,
  };
  delete (personalInfo as any).title;
  delete (personalInfo as any).email;

  if (existingProfile) {
    existingProfile.personalInfo = personalInfo as any;

    // Save new structured fields from payload if they exist
    if (payload.personalDetails) existingProfile.personalDetails = payload.personalDetails;
    if (payload.employmentDetails) existingProfile.employmentDetails = payload.employmentDetails;
    if (payload.statutoryDetails) existingProfile.statutoryDetails = payload.statutoryDetails;
    if (payload.skills) existingProfile.skills = payload.skills;
    if (payload.familyContacts) existingProfile.familyContacts = payload.familyContacts;
    if (payload.employeeDocuments) existingProfile.employeeDocuments = payload.employeeDocuments;

    await existingProfile.save();
    return existingProfile;
  }

  return new ProfileDetails({
    user: user._id,
    personalInfo,
    personalDetails: payload.personalDetails || undefined,
    employmentDetails: payload.employmentDetails || undefined,
    statutoryDetails: payload.statutoryDetails || undefined,
    skills: payload.skills || undefined,
    familyContacts: payload.familyContacts || [],
    employeeDocuments: payload.employeeDocuments || [],
  }).save();
}

function getManagedUserSuccessMessage(action: "created" | "updated") {
  return `User ${action} successfully`;
}

function buildDuplicateUserErrors(options: {
  email?: string;
  mobileNumber?: string;
  code?: string;
  existingEmailUser?: any;
  existingPhoneUser?: any;
  existingCodeUser?: any;
}) {
  const { email, mobileNumber, code, existingEmailUser, existingPhoneUser, existingCodeUser } = options;
  const errors: string[] = [];
  let skipReason = "";

  if (existingEmailUser) {
    errors.push(`Email already exists (${existingEmailUser?.username || email})`);
    skipReason = skipReason || "EMAIL_EXISTS";
  }

  if (existingPhoneUser) {
    errors.push(`Phone number already exists (${existingPhoneUser?.mobileNumber || existingPhoneUser?.username || mobileNumber})`);
    skipReason = skipReason ? `${skipReason}_AND_PHONE_EXISTS` : "PHONE_EXISTS";
  }

  if (existingCodeUser) {
    errors.push(
      `Employee code already exists (${code}) and belongs to ${
        existingCodeUser?.mobileNumber || existingCodeUser?.username || "another user"
      }`
    );
    skipReason = skipReason ? `${skipReason}_AND_CODE_EXISTS` : "CODE_EXISTS";
  }

  return { errors, skipReason };
}

function buildTemplateHeaders(uploadRole: string) {
  const isUserUpload = normalizeRole(uploadRole) === "user";
  const headers = [
    "Sr. No.",
    "Employee Number",
    "Employee Name",
    "Phone Number",
    "Email ID",
    isUserUpload ? "Branch (Optional)" : "Branch",
    "Team (Optional)",
    "City",
    "State",
  ];

  if (isUserUpload) {
    headers.push("Designation", "Joining Date", "Reporting Manager Email (Optional)");
  }

  return headers;
}

function buildTemplateRows(uploadRole: string) {
  const normalizedRole = normalizeRole(uploadRole);
  const commonRows = [
    {
      branch: "Corporate",
      team: "Fullstack",
      city: "Mumbai",
      state: "Maharashtra",
    },
    {
      branch: "Operations",
      team: "Python",
      city: "Bangalore",
      state: "Karnataka",
    },
    {
      branch: "Finance",
      team: "",
      city: "Pune",
      state: "Maharashtra",
    },
  ];

  const employeeExamples = [
    {
      employeeNumber: "4001",
      name: "Aakash Nair",
      email: "aakash.nair@example.com",
      phone: "9876543240",
      designation: "Software Engineer",
      joiningDate: "2025-01-12",
    },
    {
      employeeNumber: "4002",
      name: "Pooja Bansal",
      email: "pooja.bansal@example.com",
      phone: "9876543241",
      designation: "QA Engineer",
      joiningDate: "2025-02-18",
    },
    {
      employeeNumber: "4003",
      name: "Manish Yadav",
      email: "manish.yadav@example.com",
      phone: "9876543242",
      designation: "Backend Developer",
      joiningDate: "2025-03-25",
    },
  ];

  if (normalizedRole !== "user") {
    return [];
  }

  return employeeExamples.map((entry, index) => ([
      index + 1,
      entry.employeeNumber,
      entry.name,
      entry.phone,
      entry.email,
      commonRows[index].branch,
      commonRows[index].team,
      commonRows[index].city,
      commonRows[index].state,
      entry.designation,
      entry.joiningDate,
      "",
    ]));
}

function buildRoleMatch(role: string) {
  const normalizedRole = normalizeRole(role);
  if (normalizedRole === "user") {
    return {
      $in: ["user", "manager", /^l\d+[-\s]?manager$/i],
    };
  }

  const level = parseManagerRoleLevel(normalizedRole);
  if (!level) {
    return normalizedRole;
  }

  return {
    $in: [`l${level}-manager`, `l${level} manager`],
  };
}

function sortRowsByHierarchy(rows: any[]) {
  const rowByIdentifier = new Map<string, any>();
  rows.forEach((row) => {
    [row?.payload?.username, row?.payload?.mobileNumber]
      .map((value) => normalizeEmail(value) || normalizePhoneNumber(value))
      .filter(Boolean)
      .forEach((value) => rowByIdentifier.set(value, row));
  });
  const sorted: any[] = [];
  const state = new Map<any, "visiting" | "visited">();

  const visit = (row: any) => {
    if (state.get(row) === "visited") return;
    if (state.get(row) === "visiting") {
      throw generateError("Bulk file contains a circular reporting hierarchy", 400);
    }
    state.set(row, "visiting");
    const managerIdentifier = normalizeEmail(row?.payload?.reportingManagerUsername) ||
      normalizePhoneNumber(row?.payload?.reportingManagerUsername);
    const managerRow = rowByIdentifier.get(managerIdentifier);
    if (managerRow) visit(managerRow);
    state.set(row, "visited");
    sorted.push(row);
  };

  [...rows]
    .sort((left, right) => Number(left?.rowNumber || 0) - Number(right?.rowNumber || 0))
    .forEach(visit);
  return sorted;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function hasPassword(user: any) {
  return Boolean(typeof user?.password === "string" && user.password.trim());
}

function validatePasswordStrength(password: string) {
  return /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/.test(password);
}

function createSetupToken() {
  return {
    token: crypto.randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
}

async function tryUploadUserPicture(pic: any) {
  if (!pic || !pic.filename || pic?.buffer === "" || !Object.entries(pic || {}).length) {
    return null;
  }

  try {
    pic.filename = generateFileName(pic.filename);
    const url = await uploadFile(pic);

    return {
      name: pic?.filename,
      url,
      type: pic?.type,
    };
  } catch (error: any) {
    console.warn("Profile picture upload failed during managed user save:", error?.message || error);
    return null;
  }
}

async function generateUniqueEmployeeNumber(companyId: string) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  while (true) {
    const employeeNumber = Array.from({ length: 6 }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length))
    ).join("");

    const existingUser = await User.findOne({
      company: new mongoose.Types.ObjectId(companyId),
      $or: [
        { employeeNumber },
        { code: employeeNumber },
        { code: { $regex: new RegExp(`-${employeeNumber}$`, "i") } },
      ],
    });
    if (!existingUser) {
      return employeeNumber;
    }
  }
}

async function generateUniqueCompanyCode() {
  while (true) {
    const companyCode = `CMP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const existingCompany = await Company.findOne({ companyCode });
    if (!existingCompany) {
      return companyCode;
    }
  }
}

async function generateUniqueTenantSlug(companyName: string) {
  const baseSlug = slugify(companyName) || `company-${Date.now()}`;
  let candidate = baseSlug;
  let suffix = 1;

  while (true) {
    const existingCompany = await Company.findOne({ tenantSlug: candidate });
    if (!existingCompany) {
      return candidate;
    }

    suffix += 1;
    candidate = `${baseSlug}-${suffix}`;
  }
}

function buildSetupUrl(setupToken: string) {
  const normalizeBaseUrl = (value?: string) => String(value || "").trim().replace(/\/$/, "");
  const isLocalUrl = (value?: string) => /localhost|127\.0\.0\.1/i.test(String(value || ""));

  const explicitBaseUrl = normalizeBaseUrl(process.env.FRONTEND_BASE_URL);
  const devBaseUrl = normalizeBaseUrl(process.env.FRONTEND_BASE_DEV_URL);
  const prodBaseUrl = normalizeBaseUrl(process.env.FRONTEND_BASE_PROD_URL);

  const resolvedBaseUrl =
    explicitBaseUrl ||
    (process.env.NODE_ENV === "production"
      ? prodBaseUrl || devBaseUrl
      : isLocalUrl(devBaseUrl)
        ? devBaseUrl
        : devBaseUrl || prodBaseUrl) ||
    "http://localhost:3000";

  const appBaseUrl = resolvedBaseUrl.replace(/\/$/, "");
  return `${appBaseUrl}/set-password?token=${encodeURIComponent(setupToken)}`;
}

function normalizeEnvValue(value: unknown) {
  return String(value || "").trim();
}

function getSetupEmailConfig() {
  const host = normalizeEnvValue(process.env.SMTP_HOST);
  const port = Number(normalizeEnvValue(process.env.SMTP_PORT) || 587);
  const user = normalizeEnvValue(process.env.SMTP_USER);
  const pass = normalizeEnvValue(process.env.SMTP_PASS);
  const fromAddress =
    normalizeEnvValue(process.env.SMTP_FROM) ||
    normalizeEnvValue(process.env.MAIL_FROM) ||
    normalizeEnvValue(process.env.WELCOME_REGISTER_EMAIL_USERNAME);
  const fromName =
    normalizeEnvValue(process.env.SMTP_FROM_NAME) ||
    normalizeEnvValue(process.env.COMPANY_NAME) ||
    "HRMS Team";

  return {
    host,
    port,
    user,
    pass,
    fromAddress,
    fromName,
  };
}

function buildSetupEmailTransport() {
  const config = getSetupEmailConfig();

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    authMethod: "PLAIN",
  });
}

function formatSetupMailError(error: any) {
  const config = getSetupEmailConfig();
  const isAuthFailure =
    error?.code === "EAUTH" ||
    /authentication failed|invalid login|535/i.test(error?.message || "") ||
    /535/i.test(error?.response || "");
  const isSenderFailure =
    /sender/i.test(error?.message || "") ||
    /sender/i.test(error?.response || "");

  if (isAuthFailure) {
    return `SMTP authentication failed for ${config.host}. Check SMTP_USER and SMTP_PASS in the backend environment. For Brevo, SMTP_USER must be the SMTP login email and SMTP_PASS must be a valid SMTP key, not your account password or API key.`;
  }

  if (isSenderFailure) {
    return `SMTP login succeeded, but the sender address was rejected. Set SMTP_FROM to a verified Brevo sender email on your authenticated domain.`;
  }

  return error?.message || "Failed to send setup email";
}

async function sendSetupPasswordEmail(user: any) {
  if (!user?.setupToken) {
    return { success: false, message: "Setup token is missing" };
  }

  const config = getSetupEmailConfig();
  if (!config.host || !config.port || !config.user || !config.pass) {
    return {
      success: false,
      message: "SMTP configuration is incomplete. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.",
    };
  }

  if (!config.fromAddress) {
    return {
      success: false,
      message: "SMTP sender is missing. Please set SMTP_FROM to a verified sender email address.",
    };
  }

  try {
    const transporter = buildSetupEmailTransport();
    await transporter.verify();

    const setupUrl = buildSetupUrl(user.setupToken);
    const companyName =
      typeof user?.company === "object" && user?.company?.company_name
        ? user.company.company_name
        : "your company";
    const creatorName =
      typeof user?.createdBy === "object" && user?.createdBy?.name
        ? user.createdBy.name
        : "your admin";

    await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromAddress}>`,
      to: user.username,
      subject: "Set up your HRMS password",
      html: `
        <div style="margin:0;padding:32px 16px;background:#eef4ff;font-family:Arial,Helvetica,sans-serif;color:#10213a;">
          <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 18px 60px rgba(37,99,235,0.16);">
            <div style="padding:32px 36px;background:linear-gradient(135deg,#1d4ed8 0%,#0ea5e9 100%);color:#ffffff;">
              <div style="font-size:13px;letter-spacing:0.16em;text-transform:uppercase;opacity:0.86;margin-bottom:10px;">Human Resource Management System</div>
              <h1 style="margin:0;font-size:30px;line-height:1.2;">Your account is ready</h1>
              <p style="margin:12px 0 0;font-size:15px;line-height:1.7;opacity:0.96;">
                ${creatorName} added you to ${companyName}. Set your password to start using your HRMS workspace.
              </p>
            </div>
            <div style="padding:36px;">
              <p style="margin:0 0 14px;font-size:16px;line-height:1.7;">Hi ${user.name || "there"},</p>
              <p style="margin:0 0 18px;font-size:15px;line-height:1.8;color:#334155;">
                We created your user account and left password setup in your hands for security. Use the button below to choose your password and activate access.
              </p>
              <div style="margin:28px 0;">
                <a href="${setupUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:14px;font-size:15px;font-weight:700;">
                  Set My Password
                </a>
              </div>
              <div style="padding:18px 20px;border-radius:16px;background:#f8fbff;border:1px solid #dbeafe;">
                <p style="margin:0 0 10px;font-size:14px;color:#0f172a;font-weight:700;">Helpful details</p>
                <p style="margin:0 0 8px;font-size:14px;color:#475569;">Company: ${companyName}</p>
                <p style="margin:0 0 8px;font-size:14px;color:#475569;">Email: ${user.username}</p>
                <p style="margin:0;font-size:14px;color:#475569;">This secure link expires in 24 hours.</p>
              </div>
              <p style="margin:24px 0 0;font-size:13px;line-height:1.8;color:#64748b;">
                If the button does not work, copy and paste this URL into your browser:<br />
                <span style="word-break:break-all;color:#2563eb;">${setupUrl}</span>
              </p>
              <p style="margin:24px 0 0;font-size:13px;line-height:1.8;color:#64748b;">
                If you were not expecting this invitation, you can safely ignore this email.
              </p>
            </div>
          </div>
        </div>
      `,
    });

    return { success: true };
  } catch (error: any) {
    console.error("Setup email send error:", error);
    return { success: false, message: formatSetupMailError(error) };
  }
}

async function findUserByEmail(
  email: string,
  excludeUserId?: string,
  companyId?: string | mongoose.Types.ObjectId
) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  const emailRegex = new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i");
  const query: any = {
    username: emailRegex,
    deletedAt: { $exists: false },
  };

  if (excludeUserId) {
    query._id = { $ne: new mongoose.Types.ObjectId(excludeUserId) };
  }

  if (companyId && mongoose.Types.ObjectId.isValid(String(companyId))) {
    query.company = new mongoose.Types.ObjectId(String(companyId));
  }

  return User.findOne(query);
}

async function findUserByPhone(
  phone: string,
  excludeUserId?: string,
  companyId?: string | mongoose.Types.ObjectId
) {
  const normalizedPhone = normalizeText(phone);
  if (!normalizedPhone) {
    return null;
  }

  const query: any = {
    mobileNumber: normalizedPhone,
    deletedAt: { $exists: false },
  };

  if (excludeUserId) {
    query._id = { $ne: new mongoose.Types.ObjectId(excludeUserId) };
  }

  if (companyId && mongoose.Types.ObjectId.isValid(String(companyId))) {
    query.company = new mongoose.Types.ObjectId(String(companyId));
  }

  return User.findOne(query);
}

async function findUserByEmployeeIdentifier({
  companyId,
  employeeNumber,
  code,
  excludeUserId,
}: {
  companyId: string;
  employeeNumber: string;
  code: string;
  excludeUserId?: string;
}) {
  if (
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !normalizeText(employeeNumber) ||
    !normalizeText(code)
  ) {
    return null;
  }

  const query: any = {
    $or: [
      { code: { $regex: new RegExp(`^${escapeRegex(code)}$`, "i") } },
      {
        company: new mongoose.Types.ObjectId(companyId),
        employeeNumber: {
          $regex: new RegExp(`^${escapeRegex(employeeNumber)}$`, "i"),
        },
      },
    ],
  };

  if (excludeUserId) {
    query._id = { $ne: new mongoose.Types.ObjectId(excludeUserId) };
  }

  return User.findOne(query);
}

async function ensureCompanyReference({
  companyId,
  companyName,
  actorId,
  actionLabel,
}: {
  companyId?: string;
  companyName?: string;
  actorId?: string;
  actionLabel: string;
}) {
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    const company = await Company.findOne({
      _id: new mongoose.Types.ObjectId(companyId),
      deletedAt: { $exists: false },
    });

    if (company) {
      assertCompanyIsActiveForManagement(company, actionLabel);
      return company;
    }
  }

  const trimmedCompanyName = normalizeText(companyName);
  if (!trimmedCompanyName) {
    throw generateError("Company is required", 400);
  }

  const existingCompany = await Company.findOne({
    company_name: { $regex: new RegExp(`^${escapeRegex(trimmedCompanyName)}$`, "i") },
    deletedAt: { $exists: false },
  });

  if (existingCompany) {
    assertCompanyIsActiveForManagement(existingCompany, actionLabel);
    return existingCompany;
  }

  const tenantSlug = await generateUniqueTenantSlug(trimmedCompanyName);
  const companyCode = await generateUniqueCompanyCode();

  const company = new Company({
    company_name: trimmedCompanyName,
    companyCode,
    companyType: "company",
    tenantSlug,
    tenantUrl: `${(process.env.FRONTEND_BASE_URL || "http://localhost:3000").replace(/\/$/, "")}/company/${tenantSlug}`,
    verified_email_allowed: false,
    createdBy: actorId ? new mongoose.Types.ObjectId(actorId) : undefined,
    activeUser: actorId ? new mongoose.Types.ObjectId(actorId) : undefined,
    is_active: true,
  });

  await company.save();
  return company;
}

function normalizeObjectIdLike(value: any) {
  if (value && typeof value === "object" && "_id" in value) {
    return normalizeText(value._id);
  }

  return normalizeText(value);
}

function getReportingManagerPayload(payload: any = {}) {
  const directManager =
    payload?.reportingManager ||
    payload?.directManager ||
    null;
  const rawId =
    payload?.reportingManagerId ??
    payload?.directManagerId ??
    directManager?.value ??
    directManager;
  const normalizedId = normalizeObjectIdLike(rawId);
  const id = normalizedId && mongoose.Types.ObjectId.isValid(normalizedId) ? normalizedId : "";
  const directUsername =
    payload?.reportingManagerUsername ??
    payload?.directManagerUsername ??
    directManager?.username ??
    "";
  const username = normalizeEmail(directUsername);

  return { id, username };
}

function payloadIncludesReportingManager(payload: any = {}) {
  return [
    "reportingManager",
    "reportingManagerId",
    "reportingManagerUsername",
    "directManager",
    "directManagerId",
    "directManagerUsername",
  ].some((key) => Object.prototype.hasOwnProperty.call(payload || {}, key));
}

async function assertReportingHierarchyIsAcyclic(options: {
  reportingManager: any;
  employeeId?: string;
  companyId: mongoose.Types.ObjectId;
}) {
  const employeeId = normalizeObjectIdLike(options.employeeId);
  const seen = new Set<string>(employeeId ? [employeeId] : []);
  let current = options.reportingManager;

  for (let depth = 0; current; depth += 1) {
    if (depth >= 50) {
      throw generateError("Reporting hierarchy is too deep", 400);
    }

    const currentId = normalizeObjectIdLike(current?._id || current);
    if (!currentId || seen.has(currentId)) {
      throw generateError("Circular reporting hierarchy is not allowed", 400);
    }
    seen.add(currentId);

    const nextManagerId = normalizeObjectIdLike(current?.reportingManager);
    if (!nextManagerId || !mongoose.Types.ObjectId.isValid(nextManagerId)) {
      return;
    }

    current = await User.findOne({
      _id: new mongoose.Types.ObjectId(nextManagerId),
      company: options.companyId,
      deletedAt: { $exists: false },
    })
      .select("_id reportingManager")
      .lean();
  }
}

async function resolveReportingManagerForCompany({
  reportingManagerInput,
  excludeUserId,
  companyId,
}: {
  reportingManagerInput: { id?: string; username?: string };
  excludeUserId?: string;
  companyId: string | mongoose.Types.ObjectId;
}) {
  const managerId = normalizeObjectIdLike(reportingManagerInput?.id);
  const managerUsername = normalizeEmail(reportingManagerInput?.username);

  if (!managerId && !managerUsername) {
    return { reportingManager: null };
  }

  const companyObjectId = new mongoose.Types.ObjectId(String(companyId));
  let reportingManager = null;

  if (managerId) {
    if (!mongoose.Types.ObjectId.isValid(managerId)) {
      throw generateError("Invalid reporting manager id", 400);
    }

    reportingManager = await User.findOne({
      _id: new mongoose.Types.ObjectId(managerId),
      company: companyObjectId,
      deletedAt: { $exists: false },
    }).select("_id name username role company reportingManager is_enabled");
  } else if (managerUsername) {
    reportingManager =
      (await findUserByEmail(managerUsername, excludeUserId, companyObjectId)) ||
      (await findUserByPhone(managerUsername, excludeUserId, companyObjectId));
  }

  if (!reportingManager) {
    throw generateError("Reporting manager was not found in this company", 404);
  }

  if (reportingManager.is_enabled === false) {
    throw generateError("Reporting manager is inactive", 400);
  }

  if (String(reportingManager._id) === String(excludeUserId || "")) {
    throw generateError("A user cannot be their own reporting manager", 400);
  }

  if (normalizeRole(reportingManager.role) === "superadmin") {
    throw generateError("Superadmin cannot be assigned as a company reporting manager", 400);
  }

  await assertReportingHierarchyIsAcyclic({
    reportingManager,
    employeeId: excludeUserId,
    companyId: companyObjectId,
  });

  return { reportingManager };
}

async function resolveOfficeLocationForCompany(
  rawLocation: any,
  companyId: string | mongoose.Types.ObjectId
) {
  const locationId = normalizeObjectIdLike(rawLocation);
  if (!locationId) {
    return null;
  }

  if (!mongoose.Types.ObjectId.isValid(locationId)) {
    throw generateError("Invalid office location id", 400);
  }

  const location = await OfficeLocation.findOne({
    _id: new mongoose.Types.ObjectId(locationId),
    company: new mongoose.Types.ObjectId(String(companyId)),
    deletedAt: null,
  });

  if (!location) {
    throw generateError("Office location not found for this company", 404);
  }

  if (location.is_active === false) {
    throw generateError("Selected office location is inactive", 400);
  }

  return location;
}

async function resolveTeamForDepartment({
  companyId,
  departmentName,
  teamName,
}: {
  companyId: string | mongoose.Types.ObjectId;
  departmentName: string;
  teamName: string;
}) {
  const normalizedTeam = normalizeText(teamName);
  if (!normalizedTeam) {
    return "";
  }

  const normalizedDepartment = normalizeText(departmentName);
  if (!normalizedDepartment) {
    throw generateError("Select a department before assigning a team", 400);
  }

  const department = await Department.findOne({
    company: new mongoose.Types.ObjectId(String(companyId)),
    departmentName: { $regex: new RegExp(`^${escapeRegex(normalizedDepartment)}$`, "i") },
    deletedAt: null,
  }).lean();

  if (!department) {
    throw generateError(`Department "${normalizedDepartment}" does not exist for this company`, 400);
  }

  const team = (Array.isArray((department as any).teams) ? (department as any).teams : []).find(
    (item: any) =>
      item?.isActive !== false &&
      normalizeText(item?.name).toLowerCase() === normalizedTeam.toLowerCase()
  );

  if (!team) {
    throw generateError(`Team "${normalizedTeam}" does not exist in ${normalizedDepartment}`, 400);
  }

  return normalizeText(team.name);
}

function normalizeStringArray(value: any) {
  const source = Array.isArray(value)
    ? value
    : value === undefined || value === null || value === ""
      ? []
      : [value];
  const seen = new Set<string>();
  const output: string[] = [];

  source.forEach((item: any) => {
    const normalized = normalizeText(item);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(normalized);
  });

  return output;
}

function normalizeObjectIdArray(value: any) {
  const source = Array.isArray(value)
    ? value
    : value === undefined || value === null || value === ""
      ? []
      : [value];
  const seen = new Set<string>();
  const output: string[] = [];

  source.forEach((item: any) => {
    const normalized = normalizeObjectIdLike(item);
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    output.push(normalized);
  });

  return output;
}

function getHrScopePayload(value: any = {}) {
  return {
    departments: normalizeStringArray(value.departments || value.departmentNames || value.department),
    teams: normalizeStringArray(value.teams || value.teamNames || value.team),
    officeLocations: normalizeObjectIdArray(
      value.officeLocations ||
        value.officeLocationIds ||
        value.locations ||
        value.locationIds ||
        value.officeLocation
    ),
  };
}

function serializeHrScope(value: any = {}) {
  const officeLocations = normalizeObjectIdArray(value.officeLocations || value.officeLocationIds);
  return {
    departments: normalizeStringArray(value.departments),
    teams: normalizeStringArray(value.teams),
    officeLocations,
    officeLocationIds: officeLocations,
  };
}

async function resolveHrScopeForCompany(rawScope: any, company: any) {
  const scope = getHrScopePayload(rawScope);
  const companyId = String(company?._id || company || "");

  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    throw generateError("Company is required for HR scope", 400);
  }

  const companyDepartments = Array.isArray(company?.departments) ? company.departments : [];
  const departmentSet = new Map(
    companyDepartments.map((department: any) => [
      normalizeText(department).toLowerCase(),
      normalizeText(department),
    ])
  );

  for (const department of scope.departments) {
    if (!departmentSet.has(department.toLowerCase())) {
      throw generateError(`Department "${department}" does not exist for this company`, 400);
    }
  }

  const resolvedDepartments = scope.departments.map(
    (department) => departmentSet.get(department.toLowerCase()) || department
  );

  if (scope.officeLocations.length > 0) {
    const invalidLocation = scope.officeLocations.find(
      (locationId) => !mongoose.Types.ObjectId.isValid(locationId)
    );
    if (invalidLocation) {
      throw generateError("Invalid HR scope office location id", 400);
    }

    const locationCount = await OfficeLocation.countDocuments({
      _id: { $in: scope.officeLocations.map((locationId) => new mongoose.Types.ObjectId(locationId)) },
      company: new mongoose.Types.ObjectId(companyId),
      deletedAt: null,
      is_active: { $ne: false },
    });

    if (locationCount !== scope.officeLocations.length) {
      throw generateError("One or more HR scope office locations are invalid for this company", 400);
    }
  }

  if (scope.teams.length > 0) {
    const departmentQuery: any = {
      company: new mongoose.Types.ObjectId(companyId),
      deletedAt: null,
    };

    if (resolvedDepartments.length > 0) {
      departmentQuery.departmentName = { $in: resolvedDepartments };
    }

    const departments = await Department.find(departmentQuery).lean();
    const validTeams = new Set<string>();
    departments.forEach((department: any) => {
      (Array.isArray(department?.teams) ? department.teams : []).forEach((team: any) => {
        if (team?.isActive !== false && normalizeText(team?.name)) {
          validTeams.add(normalizeText(team.name).toLowerCase());
        }
      });
    });

    for (const team of scope.teams) {
      if (!validTeams.has(team.toLowerCase())) {
        throw generateError(`Team "${team}" does not exist in the selected HR scope departments`, 400);
      }
    }
  }

  return {
    departments: resolvedDepartments,
    teams: scope.teams,
    officeLocations: scope.officeLocations.map((locationId) => new mongoose.Types.ObjectId(locationId)),
  };
}

function exactScopeRegex(value: string) {
  return new RegExp(`^${escapeRegex(value)}$`, "i");
}

function buildHrScopeClauses(actor: any) {
  const scope = serializeHrScope(actor?.hrScope);
  const clauses: any[] = [];

  if (scope.departments.length === 0) {
    clauses.push({ role: "__hr_scope_not_configured__" });
    return clauses;
  }

  clauses.push({
    department: { $in: scope.departments.map(exactScopeRegex) },
  });

  if (scope.teams.length > 0) {
    clauses.push({
      team: { $in: scope.teams.map(exactScopeRegex) },
    });
  }

  if (scope.officeLocations.length > 0) {
    clauses.push({
      officeLocation: {
        $in: scope.officeLocations.map((locationId) => new mongoose.Types.ObjectId(locationId)),
      },
    });
  }

  return clauses;
}

function assertWithinHrScope(actor: any, target: any, actionLabel: string) {
  if (actor?.role !== "hr") {
    return;
  }

  const scope = serializeHrScope(actor?.hrScope);
  if (scope.departments.length === 0) {
    throw generateError("HR department scope is not configured", 403);
  }

  const department = normalizeText(target?.department);
  const team = normalizeText(target?.team);
  const officeLocation = normalizeObjectIdLike(target?.officeLocation || target?.officeLocationId);

  if (!department || !scope.departments.some((item) => item.toLowerCase() === department.toLowerCase())) {
    throw generateError(`You can only ${actionLabel} users in your assigned HR departments`, 403);
  }

  if (
    scope.teams.length > 0 &&
    (!team || !scope.teams.some((item) => item.toLowerCase() === team.toLowerCase()))
  ) {
    throw generateError(`You can only ${actionLabel} users in your assigned HR teams`, 403);
  }

  if (scope.officeLocations.length > 0 && (!officeLocation || !scope.officeLocations.includes(officeLocation))) {
    throw generateError(`You can only ${actionLabel} users in your assigned HR locations`, 403);
  }
}

function serializeOfficeLocation(value: any) {
  if (!value || typeof value !== "object" || !("_id" in value)) {
    return null;
  }

  return {
    _id: value._id,
    name: value.name || "",
    code: value.code || "",
    address: value.address || "",
    city: value.city || "",
    state: value.state || "",
    country: value.country || "",
    pinCode: value.pinCode || "",
    is_active: value.is_active !== false,
  };
}

function serializeManagerReference(value: any) {
  if (!value || typeof value !== "object" || !("_id" in value)) {
    return null;
  }

  return {
    _id: value._id,
    name: value.name || "",
    username: value.username || "",
    role: value.role || "user",
    designation: value.designation || "",
  };
}

function serializeUser(user: any) {
  const userWithPermissions = attachEffectivePermissions({
    user,
    company:
      user?.company && typeof user.company === "object" && "company_name" in user.company
        ? user.company
        : null,
  });
  const company =
    user?.company && typeof user.company === "object" && "company_name" in user.company
      ? user.company
      : null;
  const officeLocation = serializeOfficeLocation(user?.officeLocation);
  const officeLocationId = officeLocation?._id || normalizeObjectIdLike(user?.officeLocation);
  const createdBy =
    user?.createdBy && typeof user.createdBy === "object" && "name" in user.createdBy
      ? user.createdBy
      : null;
  const reportingManager = serializeManagerReference(user?.reportingManager);
  const lifecycleStatus = getUserAccountStatus(user);

  return {
    _id: user?._id,
    name: user?.name || "",
    username: user?.username || "",
    role: user?.role || "user",
    code: user?.code,
    employeeNumber: user?.employeeNumber || "",
    mobileNumber: user?.mobileNumber || "",
    city: user?.city || "",
    state: user?.state || "",
    address: user?.address || "",
    country: user?.country || "",
    postalCode: user?.postalCode || "",
    department: user?.department || "",
    team: user?.team || "",
    hrScope: serializeHrScope(user?.hrScope),
    officeLocationId: officeLocationId || "",
    officeLocation,
    officeLocationName: officeLocation?.name || "",
    designation: user?.designation || "",
    joiningDate: user?.joiningDate || null,
    confirmationDate: user?.confirmationDate || null,
    employmentEndDate: user?.employmentEndDate || null,
    dateOfBirth: user?.dateOfBirth || null,
    gender: user?.gender ?? null,
    companyId: company?._id || user?.company || null,
    company: company
      ? {
          _id: company._id,
          name: company.company_name,
          company_name: company.company_name,
          companyCode: company.companyCode || "",
        }
      : null,
    createdBy: createdBy
      ? {
          _id: createdBy._id,
          name: createdBy.name,
          username: createdBy.username,
          role: createdBy.role,
        }
      : null,
    reportingManagerId: reportingManager?._id || normalizeObjectIdLike(user?.reportingManager) || "",
    reportingManager,
    isEnabled: user?.is_enabled !== false,
    is_enabled: user?.is_enabled !== false,
    canLogin: canUserLogin(user),
    status: lifecycleStatus,
    passwordStatus: hasPassword(user) ? "SET" : "NOT_SET",
    authMethod: hasPassword(user)
      ? "PASSWORD"
      : user?.setupToken
        ? "PASSWORD_SETUP_PENDING"
        : "PASSWORD_NOT_SET",
    pic: user?.pic || null,
    setupTokenExpiry: user?.setupTokenExpiry || null,
    createdAt: user?.createdAt || null,
    updatedAt: user?.updatedAt || null,
    permissions: userWithPermissions.permissions || {},
    permissionOverrides: userWithPermissions.permissionOverrides || {},
    rolePermissionDefaults: userWithPermissions.rolePermissionDefaults || {},
    effectivePermissions: userWithPermissions.effectivePermissions || {},
  };
}

async function saveManagedUser({
  payload,
  actor,
  existingUserId,
  sendSetupEmail,
}: {
  payload: any;
  actor: {
    role: string;
    companyId?: string;
    userId?: string;
    department?: string;
    hrScope?: any;
    permissions?: Record<string, boolean>;
    permissionOverrides?: Record<string, boolean>;
    effectivePermissions?: Record<string, boolean>;
  };
  existingUserId?: string;
  sendSetupEmail?: boolean;
}) {
  let codeInput = normalizeText(
    payload?.code || payload?.employeeNumber || payload?.employeeCode
  );
  const name = normalizeText(payload?.name);
  const email = normalizeEmail(payload?.username);
  const mobileNumber = normalizeText(payload?.mobileNumber || payload?.phoneNumber);
  const designation = normalizeText(payload?.designation);
  const role = normalizeRole(payload?.role);
  const isHrAccountRole = role === "hradmin" || role === "hr";
  const password = normalizeText(payload?.password);
  const reportingManagerInput = getReportingManagerPayload(payload);
  const shouldApplyReportingManager = payloadIncludesReportingManager(payload);
  if (!name) {
    throw generateError("Name is required", 400);
  }

  if (email && !isValidEmail(email)) {
    throw generateError("Enter a valid email address", 400);
  }

  if (!email) {
    throw generateError("Email is required for account access", 400);
  }

  if (mobileNumber && !isValidPhoneNumber(mobileNumber)) {
    throw generateError("Enter a valid mobile number", 400);
  }

  if (!normalizeText(payload?.role)) {
    throw generateError("Role is required", 400);
  }

  if (password && !validatePasswordStrength(password)) {
    throw generateError(
      "Password must contain at least 8 characters, including one uppercase letter, one lowercase letter, and one digit.",
      400
    );
  }

  const selfManagerIdentifiers = [email, mobileNumber].filter(Boolean);
  if (reportingManagerInput.username && selfManagerIdentifiers.includes(reportingManagerInput.username)) {
    throw generateError("A user cannot be their own manager", 400);
  }

  const existingEmailUser = email ? await findUserByEmail(email, existingUserId) : null;
  if (existingEmailUser) {
    throw generateError(`${email} is already registered`, 400);
  }

  const existingPhoneUser = mobileNumber ? await findUserByPhone(mobileNumber, existingUserId) : null;
  if (existingPhoneUser) {
    throw generateError(`${mobileNumber} is already registered`, 400);
  }

  const effectiveCompanyId = actor.role === "superadmin" ? payload?.companyId || payload?.company : actor.companyId;
  const effectiveCompanyName = actor.role === "superadmin" ? payload?.companyName || payload?.companyNameInput : undefined;

  const company = await ensureCompanyReference({
    companyId: effectiveCompanyId,
    companyName: effectiveCompanyName,
    actorId: actor.userId,
    actionLabel: "add users to this company",
  });
  if (!codeInput && role === "admin") {
    codeInput = await generateUniqueEmployeeNumber(String(company._id));
  }
  if (!codeInput) {
    throw generateError("Employee code is required", 400);
  }
  const employeeIdentifier = buildEmployeeIdentifier(
    company.companyCode,
    codeInput
  );
  if (!employeeIdentifier) {
    throw generateError(
      `Employee number can contain only letters, numbers, and single hyphens and cannot exceed ${MAX_EMPLOYEE_NUMBER_LENGTH} characters`,
      400
    );
  }
  const { code, employeeNumber } = employeeIdentifier;
  const existingCodeUser = await findUserByEmployeeIdentifier({
    companyId: String(company._id),
    employeeNumber,
    code,
    excludeUserId: existingUserId,
  });
  if (existingCodeUser) {
    throw generateError(
      `Employee number ${employeeNumber} is already assigned in ${company.company_name}`,
      400
    );
  }

  if (
    actor.role === "departmenthead" &&
    ["admin", "superadmin", "departmenthead", "hradmin", "hr"].includes(role)
  ) {
    throw generateError("Department head can only manage employees", 403);
  }

  if (
    actor.role === "hr" &&
    ["admin", "superadmin", "departmenthead", "hradmin", "hr"].includes(role)
  ) {
    throw generateError("Scoped HR can only manage employees", 403);
  }

  if (
    actor.role === "hradmin" &&
    ["admin", "superadmin", "hradmin"].includes(role)
  ) {
    throw generateError("HR Admin cannot create or update admin, superadmin, or another HR Admin role", 403);
  }

  let user = existingUserId ? await User.findById(existingUserId) : null;
  const isCreate = !user;
  const previousAssignmentUser = user
    ? user.toObject({ depopulate: true })
    : null;
  const payloadIncludesHrScope = Object.prototype.hasOwnProperty.call(payload || {}, "hrScope");
  const resolvedHrScope =
    role === "hr"
      ? await resolveHrScopeForCompany(
          payloadIncludesHrScope ? payload?.hrScope : user?.hrScope || {},
          company
        )
      : {
          departments: [],
          teams: [],
          officeLocations: [],
        };

  if (role === "hr" && resolvedHrScope.departments.length === 0) {
    throw generateError("At least one department is required for scoped HR", 400);
  }

  if (isCreate && !password && !sendSetupEmail) {
    throw generateError("Enter a password or send a setup invite", 400);
  }
  const payloadIncludesDepartment = Object.prototype.hasOwnProperty.call(payload || {}, "department");
  const payloadIncludesTeam = Object.prototype.hasOwnProperty.call(payload || {}, "team");
  const payloadIncludesOfficeLocation =
    Object.prototype.hasOwnProperty.call(payload || {}, "officeLocationId") ||
    Object.prototype.hasOwnProperty.call(payload || {}, "officeLocation");
  const payloadIncludesDateOfBirth =
    Object.prototype.hasOwnProperty.call(payload || {}, "dateOfBirth") ||
    Object.prototype.hasOwnProperty.call(payload || {}, "dob");
  const payloadIncludesGender = Object.prototype.hasOwnProperty.call(payload || {}, "gender");
  const payloadIncludesConfirmationDate = Object.prototype.hasOwnProperty.call(payload || {}, "confirmationDate");
  const payloadIncludesEmploymentEndDate = Object.prototype.hasOwnProperty.call(payload || {}, "employmentEndDate");
  const rawDateOfBirth = payload?.dateOfBirth ?? payload?.dob;
  const parsedDateOfBirth = payloadIncludesDateOfBirth
    ? normalizeDateValue(rawDateOfBirth)
    : user?.dateOfBirth;
  const normalizedGender = payloadIncludesGender ? normalizeGender(payload?.gender) : user?.gender;
  const parsedConfirmationDate = payloadIncludesConfirmationDate
    ? normalizeDateValue(payload?.confirmationDate)
    : user?.confirmationDate;
  const parsedEmploymentEndDate = payloadIncludesEmploymentEndDate
    ? normalizeDateValue(payload?.employmentEndDate)
    : user?.employmentEndDate;
  const resolvedDepartment =
    isHrAccountRole
      ? ""
      : actor.role === "departmenthead"
      ? normalizeText(actor.department)
      : payloadIncludesDepartment
        ? normalizeText(payload?.department)
        : normalizeText(user?.department);
  const previousDepartment = normalizeText(user?.department);
  const requestedTeam = payloadIncludesTeam
    ? isHrAccountRole
      ? ""
      : normalizeText(payload?.team)
    : resolvedDepartment === previousDepartment
      ? normalizeText(user?.team)
      : "";
  const resolvedOfficeLocation = payloadIncludesOfficeLocation
    ? isHrAccountRole
      ? null
      : await resolveOfficeLocationForCompany(
        payload?.officeLocationId ?? payload?.officeLocation,
        company._id
      )
    : null;

  if (payloadIncludesDateOfBirth && rawDateOfBirth && !parsedDateOfBirth) {
    throw generateError("Enter a valid date of birth", 400);
  }

  if (parsedDateOfBirth && isFutureDate(parsedDateOfBirth)) {
    throw generateError("Date of birth cannot be in the future", 400);
  }

  if (payloadIncludesGender && normalizeText(payload?.gender) && normalizedGender === undefined) {
    throw generateError("Select a valid gender", 400);
  }

  if (payloadIncludesConfirmationDate && payload?.confirmationDate && !parsedConfirmationDate) {
    throw generateError("Enter a valid confirmation date", 400);
  }

  if (payloadIncludesEmploymentEndDate && payload?.employmentEndDate && !parsedEmploymentEndDate) {
    throw generateError("Enter a valid employment end date", 400);
  }

  const effectiveJoiningDate = normalizeDateValue(payload?.joiningDate) || user?.joiningDate;
  if (parsedConfirmationDate && effectiveJoiningDate && parsedConfirmationDate < effectiveJoiningDate) {
    throw generateError("Confirmation date cannot be before joining date", 400);
  }
  if (parsedEmploymentEndDate && effectiveJoiningDate && parsedEmploymentEndDate < effectiveJoiningDate) {
    throw generateError("Employment end date cannot be before joining date", 400);
  }
  if (parsedEmploymentEndDate && parsedConfirmationDate && parsedEmploymentEndDate < parsedConfirmationDate) {
    throw generateError("Employment end date cannot be before confirmation date", 400);
  }

  if (role === "departmenthead") {
    if (!resolvedDepartment) {
      throw generateError("Department is required", 400);
    }
  }

  if (resolvedDepartment) {
    const companyDepartments = Array.isArray(company?.departments) ? company.departments : [];
    if (!companyDepartments.includes(resolvedDepartment)) {
      throw generateError(
        `Department "${resolvedDepartment}" does not exist for this company. Please create a Department Head for it first.`,
        400
      );
    }
  }

  const resolvedTeam = requestedTeam
    ? await resolveTeamForDepartment({
        companyId: company._id,
        departmentName: resolvedDepartment,
        teamName: requestedTeam,
      })
    : "";
  const nextOfficeLocationId = payloadIncludesOfficeLocation
    ? isHrAccountRole
      ? undefined
      : resolvedOfficeLocation?._id
    : user?.officeLocation;

  assertWithinHrScope(
    actor,
    {
      department: resolvedDepartment,
      team: resolvedTeam,
      officeLocation: nextOfficeLocationId,
    },
    "manage"
  );

  if (isCreate) {
    if (["hr", "hradmin"].includes(role)) {
      ensurePermission(actor, PERMISSION_KEYS.CREATE_HR_USERS, "You do not have permission to create HR users");
    } else if (role === "departmenthead") {
      ensurePermission(actor, PERMISSION_KEYS.CREATE_DEPARTMENT_HEADS, "You do not have permission to create department heads");
    } else {
      ensurePermission(actor, PERMISSION_KEYS.CREATE_USERS, "You do not have permission to create users");
    }
  } else {
    ensurePermission(actor, PERMISSION_KEYS.EDIT_USERS, "You do not have permission to edit users");

    const previousRole = normalizeRole(user?.role);
    if (role !== previousRole) {
      if (["hr", "hradmin"].includes(role)) {
        ensurePermission(actor, PERMISSION_KEYS.CREATE_HR_USERS, "You do not have permission to assign HR roles");
      } else if (role === "departmenthead") {
        ensurePermission(actor, PERMISSION_KEYS.CREATE_DEPARTMENT_HEADS, "You do not have permission to assign the department head role");
      }
    }
  }

  const hasExistingReportingManager = Boolean(user?.reportingManager);

  if (
    shouldApplyReportingManager &&
    (reportingManagerInput.id || reportingManagerInput.username || hasExistingReportingManager)
  ) {
    ensurePermission(actor, PERMISSION_KEYS.ASSIGN_MANAGERS, "You do not have permission to assign managers");
  }

  if (!user) {
    user = new User({
      code,
      employeeNumber,
      createdAt: new Date(),
      createdBy: actor.userId ? new mongoose.Types.ObjectId(actor.userId) : undefined,
    });
  }

  user.code = code;
  user.employeeNumber = employeeNumber;
  user.name = name;
  user.username = email;
  user.role = role;
  user.company = company._id;
  (user as any).mobileNumber = mobileNumber || undefined;
  user.city = normalizeText(payload?.city || user.city).toLowerCase();
  user.state = normalizeText(payload?.state || user.state).toLowerCase();
  user.designation = designation;
  user.joiningDate = normalizeDateValue(payload?.joiningDate) || user.joiningDate;
  if (payloadIncludesConfirmationDate) {
    user.confirmationDate = parsedConfirmationDate || undefined;
  }
  if (payloadIncludesEmploymentEndDate) {
    user.employmentEndDate = parsedEmploymentEndDate || undefined;
  }
  if (payloadIncludesDateOfBirth) {
    user.dateOfBirth = parsedDateOfBirth || undefined;
  }
  if (payloadIncludesGender) {
    user.gender = normalizedGender;
  }
  user.department = isHrAccountRole ? "" : resolvedDepartment;
  user.team = isHrAccountRole ? "" : resolvedTeam;
  (user as any).hrScope = role === "hr" ? resolvedHrScope : {
    departments: [],
    teams: [],
    officeLocations: [],
  };
  if (isHrAccountRole) {
    user.officeLocation = undefined;
  } else if (payloadIncludesOfficeLocation) {
    user.officeLocation = resolvedOfficeLocation?._id || undefined;
  }
  user.updatedAt = new Date();
  if (shouldApplyReportingManager || isCreate) {
    const resolvedReportingManager = await resolveReportingManagerForCompany({
      reportingManagerInput,
      excludeUserId: String(user._id),
      companyId: company._id,
    });

    if (resolvedReportingManager.reportingManager) {
      assertWithinHrScope(actor, resolvedReportingManager.reportingManager, "assign reporting managers to");
    }

    user.reportingManager = resolvedReportingManager.reportingManager?._id || undefined;
  }

  let setupInfo: {
    setupUrl: string;
    setupTokenExpiry: Date;
    emailSent?: boolean;
    emailError?: string;
  } | null = null;

  if (password) {
    user.password = await hashBcrypt(password);
    user.setupToken = undefined;
    user.setupTokenExpiry = undefined;
  } else if (isCreate && sendSetupEmail && email) {
    const setupToken = createSetupToken();
    user.setupToken = setupToken.token;
    user.setupTokenExpiry = setupToken.expiresAt;
    setupInfo = {
      setupUrl: buildSetupUrl(setupToken.token),
      setupTokenExpiry: setupToken.expiresAt,
    };
  }

  if (payload?.pic?.isDeleted && user.pic?.name) {
    await deleteFile(user.pic.name).catch(() => undefined);
    user.pic = undefined;
  }

  const uploadedPic = await tryUploadUserPicture(payload?.pic);
  if (uploadedPic) {
    if (user.pic?.name) {
      await deleteFile(user.pic.name).catch(() => undefined);
    }
    user.pic = uploadedPic;
  }

  await mongoose.connection.transaction(async (session) => {
    await user.save({ session });
    await recordEmployeeAssignmentChange({
      user,
      previousUser: previousAssignmentUser,
      changedBy: actor.userId,
      changeReason: normalizeText(
        payload?.assignmentChangeReason ||
          payload?.changeReason ||
          (isCreate ? "Initial employee assignment" : "Employee assignment updated")
      ),
      changeType: isCreate ? "initial_assignment" : undefined,
      source: isCreate ? "managed_user_create" : "managed_user_update",
      session,
    });
  });

  await syncManagedUserTdsDeclaration(user);

  const profileDetails = await syncManagedUserProfileDetails(user, company, payload);
  if (profileDetails && String(user.profile_details || "") !== String(profileDetails._id || "")) {
    user.profile_details = profileDetails._id;
    await user.save();
  }

  const populatedUser = await User.findById(user._id)
      .populate("company", "company_name companyCode")
      .populate("officeLocation", "name code address city state country pinCode is_active")
      .populate("createdBy", "name username role")
      .populate("reportingManager", "name username role designation");

  if (setupInfo && populatedUser) {
    const emailResult = await sendSetupPasswordEmail(populatedUser);
    setupInfo.emailSent = Boolean(emailResult.success);
    if (!emailResult.success) {
      setupInfo.emailError = emailResult.message || "Setup email was not sent";
    }
  }

  return {
    user: populatedUser,
    setup: setupInfo,
    companyWasAutoCreated:
      actor.role === "superadmin" &&
      !effectiveCompanyId &&
      normalizeText(effectiveCompanyName) &&
      normalizeText(effectiveCompanyName).toLowerCase() === company.company_name?.toLowerCase(),
  };
}

function getRequesterContext(req: any) {
  const role = normalizeRole(req?.user?.role || req?.bodyData?.role);
  return {
    role,
    userId: req?.userId ? String(req.userId) : undefined,
    companyId: req?.user?.company ? String(req.user.company) : undefined,
    department: normalizeText(req?.user?.department),
    hrScope: serializeHrScope(req?.user?.hrScope || req?.bodyData?.hrScope || {}),
    permissions: req?.user?.permissions || req?.bodyData?.permissions || {},
    permissionOverrides: req?.user?.permissionOverrides || req?.bodyData?.permissionOverrides || {},
    effectivePermissions: req?.user?.effectivePermissions || req?.bodyData?.effectivePermissions || {},
  };
}

function assertAdminAccess(req: any) {
  const requester = getRequesterContext(req);
  if (!["admin", "superadmin", "departmenthead", "hradmin", "hr"].includes(requester.role)) {
    throw generateError("Only admin, superadmin, department head, or HR can manage users", 403);
  }

  if (requester.role === "departmenthead" && !requester.department) {
    throw generateError("Department head is missing department access", 403);
  }

  if (requester.role === "hr" && requester.hrScope.departments.length === 0) {
    throw generateError("HR department scope is missing", 403);
  }

  return requester;
}

function assertSuperAdminRequester(req: any) {
  const requester = assertAdminAccess(req);
  if (requester.role !== "superadmin") {
    throw generateError("Only superadmin can manage permission settings", 403);
  }

  return requester;
}

export async function createCompanyAdminForCompanyCreation({
  companyId,
  admin,
  actor,
}: {
  companyId: string;
  admin: any;
  actor: {
    role: string;
    userId?: string;
    companyId?: string;
    department?: string;
    hrScope?: any;
    permissions?: Record<string, boolean>;
    permissionOverrides?: Record<string, boolean>;
    effectivePermissions?: Record<string, boolean>;
  };
}) {
  const result = await saveManagedUser({
    payload: {
      ...admin,
      companyId,
      role: "admin",
      employeeNumber:
        normalizeText(admin?.employeeNumber || admin?.code) ||
        await generateUniqueEmployeeNumber(companyId),
      designation: normalizeText(admin?.designation) || "Company Admin",
    },
    actor,
    sendSetupEmail: !normalizeText(admin?.password) && admin?.sendInvite !== false,
  });

  return {
    user: serializeUser(result.user),
    setup: result.setup || null,
  };
}

async function parseBulkWorkbook(
  fileBuffer: Buffer,
  options: {
    companyId?: string;
    companyName?: string;
    uploadRole?: string;
  } = {}
) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    throw generateError("Excel worksheet is missing", 400);
  }

  const headerRow = worksheet.getRow(1);
  const headers = headerRow.values
    .slice(1)
    .map((value: any) => normalizeText(value));

  const headerMap = new Map<string, number>();
  headers.forEach((header: string, index: number) => {
    if (header) {
      headerMap.set(header.toLowerCase(), index + 1);
    }
  });

  const resolveHeader = (...aliases: string[]) => {
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (headerMap.has(key)) {
        return headerMap.get(key) || 0;
      }
    }
    return 0;
  };

  const employeeNumberColumn = resolveHeader(
    "employee number",
    "employee no",
    "employee id",
    "employee code",
    "code"
  );
  const nameColumn = resolveHeader("employee name", "name");
  const emailColumn = resolveHeader("email id", "email", "email id (optional)");
  const mobileNumberColumn = resolveHeader(
    "contact number",
    "contact num",
    "mobile number",
    "phone",
    "phone number"
  );
  const departmentColumn = resolveHeader(
    "department",
    "branch",
    "department (optional)",
    "branch (optional)"
  );
  const teamColumn = resolveHeader("team", "team (optional)");
  const cityColumn = resolveHeader("city");
  const stateColumn = resolveHeader("state");
  const designationColumn = resolveHeader("designation");
  const joiningDateColumn = resolveHeader("joining date", "date of joining");
  const roleColumn = resolveHeader("role");
  const companyColumn = resolveHeader("company");
  const passwordColumn = resolveHeader("password");
  const reportingManagerColumn = resolveHeader(
    "reporting manager email",
    "reporting manager email (optional)",
    "reporting manager",
    "direct manager email"
  );
  const legacyManagerHeaders = headers.filter((header: string) =>
    /^l\s*\d+\s*manager/i.test(header)
  );
  if (legacyManagerHeaders.length > 0) {
    throw generateError(
      "L1/L2 manager columns are no longer supported. Use Reporting Manager Email (Optional).",
      400
    );
  }

  const explicitUploadRole = normalizeRole(options.uploadRole);
  const requestedUploadRole =
    explicitUploadRole === "user"
      ? "user"
      : "";
  const requiredHeaders = [
    { label: "Employee Number", column: employeeNumberColumn },
    { label: "Employee Name", column: nameColumn },
    { label: "Phone Number", column: mobileNumberColumn },
    { label: "Email ID", column: emailColumn },
    { label: "Branch", column: departmentColumn },
  ];

  if (requestedUploadRole === "user") {
    requiredHeaders.push({ label: "Designation", column: designationColumn });
    requiredHeaders.push({ label: "Joining Date", column: joiningDateColumn });
  }

  for (const header of requiredHeaders) {
    if (!header.column) {
      throw generateError(`Missing required column: ${header.label}`, 400);
    }
  }

  const rows: any[] = [];
  const seenPhones = new Set<string>();
  const seenEmployeeNumbers = new Set<string>();

  if (explicitUploadRole && !requestedUploadRole) {
    throw generateError("Bulk upload currently supports employees only", 400);
  }

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const readCell = (columnNumber: number) =>
      columnNumber ? getCellValue(row.getCell(columnNumber)) : "";

    const employeeNumber = normalizeText(readCell(employeeNumberColumn));
    const name = normalizeText(readCell(nameColumn));
    const username = normalizeEmail(readCell(emailColumn));
    const mobileNumber = normalizeText(readCell(mobileNumberColumn));
    const department = normalizeText(readCell(departmentColumn));
    const team = normalizeText(readCell(teamColumn));
    const city = normalizeText(readCell(cityColumn)).toLowerCase();
    const state = normalizeText(readCell(stateColumn)).toLowerCase();
    const designation = normalizeText(readCell(designationColumn));
    const joiningDate = normalizeDateValue(readCell(joiningDateColumn));
    const rawRole = normalizeText(readCell(roleColumn));
    const companyName = normalizeText(readCell(companyColumn)) || normalizeText(options.companyName);
    const password = normalizeText(readCell(passwordColumn));
    const reportingManagerUsername = normalizeEmail(readCell(reportingManagerColumn));

    const role = requestedUploadRole
      ? requestedUploadRole
      : rawRole
        ? normalizeRole(rawRole)
        : "user";

    const hasRowValues =
      Boolean(employeeNumber) ||
      Boolean(name) ||
      Boolean(username) ||
      Boolean(mobileNumber) ||
      Boolean(department) ||
      Boolean(team) ||
      Boolean(city) ||
      Boolean(state) ||
      Boolean(designation) ||
      Boolean(joiningDate) ||
      Boolean(rawRole) ||
      Boolean(companyName) ||
      Boolean(reportingManagerUsername);

    if (!hasRowValues) {
      continue;
    }

    const errors: string[] = [];
    if (!name) {
      errors.push("Name is required");
    }
    if (!employeeNumber) {
      errors.push("Employee number is required");
    }
    if (!mobileNumber) {
      errors.push("Phone number is required");
    }
    if (mobileNumber && !isValidPhoneNumber(mobileNumber)) {
      errors.push("Phone number is invalid");
    }
    if (!username) {
      errors.push("Email is required");
    } else if (!isValidEmail(username)) {
      errors.push("Email is invalid");
    }
    if (!department && role !== "user" && role !== "admin" && role !== "superadmin") {
      errors.push("Department is required");
    }
    if (requestedUploadRole === "user" && !designation) {
      errors.push("Designation is required");
    }
    if (requestedUploadRole === "user" && !joiningDate) {
      errors.push("Joining date is required");
    }
    if (!companyName && !options.companyId) {
      errors.push("Company is required");
    }
    if (mobileNumber && seenPhones.has(mobileNumber)) {
      errors.push("Duplicate phone number in file");
    }
    if (employeeNumber && seenEmployeeNumbers.has(employeeNumber.toLowerCase())) {
      errors.push("Duplicate employee number in file");
    }
    if (
      reportingManagerUsername &&
      [username, normalizePhoneNumber(mobileNumber)].includes(reportingManagerUsername)
    ) {
      errors.push("A user cannot be their own manager");
    }
    if (parseManagerRoleLevel(role)) {
      errors.push("Manager-level roles are no longer supported");
    }

    if (mobileNumber) {
      seenPhones.add(mobileNumber);
    }
    if (employeeNumber) {
      seenEmployeeNumbers.add(employeeNumber.toLowerCase());
    }

    rows.push({
      rowNumber,
      payload: {
        employeeNumber,
        name,
        username,
        mobileNumber,
        department,
        team,
        city,
        state,
        designation,
        joiningDate,
        role,
        companyId: options.companyId,
        companyName,
        reportingManagerUsername,
        password,
        uploadRole: role,
      },
      errors,
    });
  }

  return rows;
}

async function validateBulkRow(row: any) {
  const existingEmailUser = row.payload.username ? await findUserByEmail(row.payload.username) : null;
  const existingPhoneUser = row.payload.mobileNumber ? await findUserByPhone(row.payload.mobileNumber) : null;
  const existingCompany = row.payload.companyId && mongoose.Types.ObjectId.isValid(row.payload.companyId)
    ? await Company.findOne({
        _id: new mongoose.Types.ObjectId(row.payload.companyId),
        deletedAt: { $exists: false },
      })
    : row.payload.companyName
      ? await Company.findOne({
          company_name: { $regex: new RegExp(`^${escapeRegex(row.payload.companyName)}$`, "i") },
          deletedAt: { $exists: false },
        })
      : null;
  const errors = [...row.errors];
  const reportingManagerUsername = normalizeEmail(row.payload.reportingManagerUsername);
  let resolvedReportingManager: any = null;
  let existingCodeUser: any = null;

  if (existingCompany && row.payload.employeeNumber) {
    const employeeIdentifier = buildEmployeeIdentifier(
      existingCompany.companyCode,
      row.payload.employeeNumber
    );
    if (!employeeIdentifier) {
      errors.push(
        `Employee number can contain only letters, numbers, and single hyphens and cannot exceed ${MAX_EMPLOYEE_NUMBER_LENGTH} characters`
      );
    } else {
      row.payload.employeeNumber = employeeIdentifier.employeeNumber;
      row.payload.code = employeeIdentifier.code;
      existingCodeUser = await findUserByEmployeeIdentifier({
        companyId: String(existingCompany._id),
        employeeNumber: employeeIdentifier.employeeNumber,
        code: employeeIdentifier.code,
      });
    }
  }

  if (row.payload.department && existingCompany) {
    const companyDepartments = Array.isArray(existingCompany.departments) ? existingCompany.departments : [];
    if (!companyDepartments.includes(row.payload.department)) {
      errors.push(`Department "${row.payload.department}" does not exist for this company`);
    }
  }

  if (row.payload.team && existingCompany) {
    if (!row.payload.department) {
      errors.push("Department is required when team is provided");
    } else {
      const department = await Department.findOne({
        company: existingCompany._id,
        departmentName: { $regex: new RegExp(`^${escapeRegex(row.payload.department)}$`, "i") },
        deletedAt: null,
      }).lean();
      const hasTeam = (Array.isArray((department as any)?.teams) ? (department as any).teams : []).some(
        (team: any) =>
          team?.isActive !== false &&
          normalizeText(team?.name).toLowerCase() === normalizeText(row.payload.team).toLowerCase()
      );

      if (!hasTeam) {
        errors.push(`Team "${row.payload.team}" does not exist in ${row.payload.department}`);
      }
    }
  }

  const duplicateValidation = buildDuplicateUserErrors({
    email: row.payload.username,
    mobileNumber: row.payload.mobileNumber,
    code: row.payload.code || row.payload.employeeNumber,
    existingEmailUser,
    existingPhoneUser,
    existingCodeUser,
  });
  errors.push(...duplicateValidation.errors);

  if (reportingManagerUsername) {
    const matchedManager =
      (await findUserByEmail(reportingManagerUsername)) ||
      (await findUserByPhone(reportingManagerUsername));
    if (!matchedManager) {
      errors.push(`Reporting manager not found: ${reportingManagerUsername}`);
    } else if (
      existingCompany &&
      String(matchedManager.company || "") !== String(existingCompany._id)
    ) {
      errors.push(`Reporting manager is not in the selected company: ${reportingManagerUsername}`);
    } else if (["admin", "superadmin"].includes(normalizeRole(matchedManager.role))) {
      errors.push("Admin and superadmin accounts cannot be reporting managers");
    } else {
      resolvedReportingManager = {
        _id: matchedManager._id,
        name: matchedManager.name || "",
        username: matchedManager.username || reportingManagerUsername,
        status: "ASSIGNED",
      };
    }
  }

  return {
    existingEmailUser,
    existingPhoneUser,
    existingCodeUser,
    existingCompany,
    resolvedReportingManager,
    errors,
    skipReason: duplicateValidation.skipReason,
  };
}

async function buildBulkPreview(rows: any[]) {
  const previewRows = [];
  const seenIdentifiers = new Set<string>();

  for (const row of rows) {
    const validation = await validateBulkRow(row);
    const identifierKey = row.payload.code
      ? String(row.payload.code).toUpperCase()
      : "";
    if (identifierKey && seenIdentifiers.has(identifierKey)) {
      validation.errors.push("Duplicate employee number in file");
    }
    if (identifierKey) {
      seenIdentifiers.add(identifierKey);
    }

    previewRows.push({
      rowNumber: row.rowNumber,
      name: row.payload.name,
      mobileNumber: row.payload.mobileNumber,
      username: row.payload.username,
      employeeNumber: row.payload.employeeNumber,
      code: row.payload.code,
      department: row.payload.department,
      team: row.payload.team,
      city: row.payload.city,
      state: row.payload.state,
      role: row.payload.role,
      company: row.payload.companyName || validation.existingCompany?.company_name || "",
      companyStatus: validation.existingCompany ? "EXISTS" : "WILL_CREATE",
      action: validation.existingEmailUser || validation.existingPhoneUser || validation.existingCodeUser ? "SKIP" : "CREATE",
      skipReason: validation.skipReason,
      reportingManager: validation.resolvedReportingManager,
      errors: validation.errors,
    });
  }

  return previewRows;
}

export async function listManagedUsersHandler(req: Request, res: Response) {
  try {
    const requester = assertAdminAccess(req);
    ensurePermission(requester, PERMISSION_KEYS.VIEW_USERS, "You do not have permission to view users");
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 10)));
    const search = normalizeText(req.query.search);
    const requestedRoleText = normalizeText(req.query.role);
    const requestedRole = requestedRoleText ? normalizeRole(requestedRoleText) : "";
    const departmentFilter = normalizeText(req.query.department);
    const teamFilter = normalizeText(req.query.team);
    const officeLocationId = normalizeText(req.query.officeLocationId || req.query.locationId);
    const issueFilter = normalizeText(req.query.issue);
    const issueMatch = buildManagedUserIssueMatch(issueFilter);
    const companyId =
      requester.role === "superadmin"
        ? normalizeText(req.query.companyId)
        : requester.companyId;

    if (requester.role !== "superadmin" && !companyId) {
      throw generateError("Company context is required", 422);
    }

    if (companyId && !mongoose.Types.ObjectId.isValid(companyId)) {
      throw generateError("Invalid company id", 400);
    }

    if (officeLocationId && !mongoose.Types.ObjectId.isValid(officeLocationId)) {
      throw generateError("Invalid office location id", 400);
    }

    const accessibleCompanyMatch: any = {
      deletedAt: { $exists: false },
      type: { $ne: "user" },
    };

    if (companyId) {
      accessibleCompanyMatch._id = new mongoose.Types.ObjectId(companyId);
    }

    const accessibleCompanies = await Company.find(accessibleCompanyMatch)
      .select("_id company_name companyCode rolePermissions")
      .lean();
    const accessibleCompanyIds = accessibleCompanies.map((company: any) => company._id);

    const learnerMemberships = accessibleCompanyIds.length
      ? await Company.find({
          type: "user",
          companyOrg: { $in: accessibleCompanyIds },
          deletedAt: { $exists: false },
        })
          .select("userId companyOrg")
          .lean()
      : [];

    const membershipCompanyByUser = new Map<string, string>();
    learnerMemberships.forEach((membership: any) => {
      const userKey = String(membership?.userId || "");
      const membershipCompanyId = String(membership?.companyOrg || "");
      if (userKey && membershipCompanyId && !membershipCompanyByUser.has(userKey)) {
        membershipCompanyByUser.set(userKey, membershipCompanyId);
      }
    });

    const membershipUserIds = Array.from(membershipCompanyByUser.keys())
      .filter((value) => mongoose.Types.ObjectId.isValid(value))
      .map((value) => new mongoose.Types.ObjectId(value));

    const companyScopeCondition = companyId && mongoose.Types.ObjectId.isValid(companyId)
      ? { company: new mongoose.Types.ObjectId(companyId) }
      : accessibleCompanyIds.length
        ? { company: { $in: accessibleCompanyIds } }
        : null;
    const scopeConditions = [
      companyScopeCondition,
      membershipUserIds.length ? { _id: { $in: membershipUserIds } } : null,
    ].filter(Boolean);
    const scopeMatch =
      scopeConditions.length === 0
        ? null
        : scopeConditions.length === 1
          ? scopeConditions[0]
          : { $or: scopeConditions };

    const baseClauses: any[] = [{ deletedAt: { $exists: false } }];
    if (scopeMatch) {
      baseClauses.push(scopeMatch);
    }

    if (requester.role === "departmenthead" && requester.department) {
      baseClauses.push({ department: requester.department });
      baseClauses.push({ role: { $nin: ["admin", "superadmin", "departmenthead", "hradmin", "hr"] } });
    } else if (requester.role === "hr") {
      baseClauses.push({ role: { $nin: ["admin", "superadmin", "departmenthead", "hradmin", "hr"] } });
      baseClauses.push(...buildHrScopeClauses(requester));
    } else if (["admin", "hradmin"].includes(requester.role)) {
      baseClauses.push({ role: { $nin: ["admin", "superadmin"] } });
    }

    const baseMatch =
      baseClauses.length === 1
        ? baseClauses[0]
        : { $and: baseClauses };

    const matchClauses = [...baseClauses];

    if (requester.role === "departmenthead" && requestedRole) {
      matchClauses.push({
        role:
          ["admin", "superadmin", "departmenthead", "hradmin", "hr"].includes(requestedRole)
            ? "__no_matching_role__"
            : buildRoleMatch(requestedRole),
      });
    } else if (requester.role === "hr" && requestedRole) {
      matchClauses.push({
        role:
          ["admin", "superadmin", "departmenthead", "hradmin", "hr"].includes(requestedRole)
            ? "__no_matching_role__"
            : buildRoleMatch(requestedRole),
      });
    } else if (["admin", "hradmin"].includes(requester.role) && requestedRole) {
      matchClauses.push({
        role:
          requestedRole !== "admin" && requestedRole !== "superadmin"
            ? buildRoleMatch(requestedRole)
            : { $nin: ["admin", "superadmin"] },
      });
    } else if (requester.role === "superadmin" && requestedRole) {
      matchClauses.push({ role: buildRoleMatch(requestedRole) });
    }

    if (search) {
      const searchRegex = new RegExp(escapeRegex(search), "i");
      matchClauses.push({
        $or: [
          { name: { $regex: searchRegex } },
          { mobileNumber: { $regex: searchRegex } },
          { username: { $regex: searchRegex } },
          { code: { $regex: searchRegex } },
          { employeeNumber: { $regex: searchRegex } },
          { role: { $regex: searchRegex } },
        ],
      });
    }

    if (officeLocationId) {
      matchClauses.push({
        officeLocation: new mongoose.Types.ObjectId(officeLocationId),
      });
    }

    if (departmentFilter) {
      matchClauses.push({
        department: { $regex: new RegExp(`^${escapeRegex(departmentFilter)}$`, "i") },
      });
    }

    if (teamFilter) {
      matchClauses.push({
        team: { $regex: new RegExp(`^${escapeRegex(teamFilter)}$`, "i") },
      });
    }

    if (issueMatch) {
      matchClauses.push(issueMatch);
    }

    const match =
      matchClauses.length === 1
        ? matchClauses[0]
        : { $and: matchClauses };

    const availableRolesRaw = accessibleCompanyIds.length || membershipUserIds.length
      ? await User.distinct("role", baseMatch)
      : [];
    const availableRoles = availableRolesRaw
      .map((role: any) => normalizeRole(role))
      .filter((role: string, index: number, arr: string[]) => role && arr.indexOf(role) === index)
      .sort((a: string, b: string) => a.localeCompare(b));

    const total = accessibleCompanyIds.length || membershipUserIds.length
      ? await User.countDocuments(match)
      : 0;
    const users = total
      ? await User.find(match)
          .populate("company", "company_name companyCode rolePermissions")
          .populate("department", "departmentName")
          .populate("officeLocation", "name code address city state country pinCode is_active")
          .populate("createdBy", "name username role")
          .populate("reportingManager", "name username role designation")
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
      : [];
    const companyById = new Map(
      accessibleCompanies.map((company: any) => [String(company._id), company])
    );

    return res.status(200).json({
      success: true,
      data: {
        users: users.map((user: any) => {
          const membershipCompanyId = membershipCompanyByUser.get(String(user?._id || ""));
          const preferredCompanyId = companyId || membershipCompanyId;
          const preferredCompany =
            preferredCompanyId && companyById.has(String(preferredCompanyId))
              ? companyById.get(String(preferredCompanyId))
              : null;

          if (preferredCompany && (companyId || !user.company)) {
            user.company = preferredCompany;
          }

          return serializeUser(user);
        }),
        availableRoles,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        page,
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to fetch users",
    });
  }
}

export async function downloadBulkUploadTemplateHandler(req: Request, res: Response) {
  try {
    const requester = assertAdminAccess(req);
    ensurePermission(requester, PERMISSION_KEYS.VIEW_USERS, "You do not have permission to download bulk upload templates");

    const requestedCompanyId =
      requester.role === "superadmin"
        ? normalizeText(req.query.companyId)
        : requester.companyId;
    const uploadRole = normalizeRole(req.query.uploadRole);

    if (!uploadRole || ["admin", "superadmin", "departmenthead", "hradmin", "hr"].includes(uploadRole)) {
      throw generateError("A valid upload role is required", 400);
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Template");
    const headers = buildTemplateHeaders(uploadRole);
    const rows = buildTemplateRows(uploadRole);

    worksheet.addRow(headers);
    rows.forEach((row) => worksheet.addRow(row));

    worksheet.getRow(1).font = { bold: true };
    worksheet.columns = headers.map((header, index) => ({
      key: `column_${index}`,
      width: Math.max(18, String(header).length + 4),
    }));

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `bulk-upload-template-${uploadRole}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
    return res.status(200).send(Buffer.from(buffer));
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to download bulk upload template",
    });
  }
}

export async function createManagedUserHandler(req: Request, res: Response) {
  try {
    const requester = assertAdminAccess(req);
    await ensureCompanyManagementAccess({
      actor: requester,
      requestedCompanyId:
        requester.role === "superadmin"
          ? normalizeText(req.body?.companyId || req.body?.company)
          : requester.companyId,
      actionLabel: "add users to this company",
      allowSuperadminWithoutCompany: true,
    });
    const result = await saveManagedUser({
      payload: req.body,
      actor: requester,
      sendSetupEmail: Boolean(req.body?.sendInvite || req.body?.sendSetupEmail),
    });

    return res.status(201).json({
      success: true,
      message: getManagedUserSuccessMessage("created"),
      data: {
        user: serializeUser(result.user),
        setup: result.setup || null,
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to create user",
    });
  }
}

export async function createCompanyAdminHandler(req: Request, res: Response) {
  try {
    const requester = assertSuperAdminRequester(req);
    const companyId = normalizeText(req.body?.companyId || req.body?.company);

    if (!companyId) {
      throw generateError("Company is required", 400);
    }

    await ensureCompanyManagementAccess({
      actor: requester,
      requestedCompanyId: companyId,
      actionLabel: "add an admin to this company",
      allowSuperadminWithoutCompany: false,
    });

    const result = await saveManagedUser({
      payload: {
        ...req.body,
        companyId,
        role: "admin",
        employeeNumber:
          normalizeText(req.body?.employeeNumber || req.body?.code) ||
          await generateUniqueEmployeeNumber(companyId),
        designation: normalizeText(req.body?.designation) || "Company Admin",
      },
      actor: requester,
      sendSetupEmail: !normalizeText(req.body?.password) && req.body?.sendInvite !== false,
    });

    return res.status(201).json({
      success: true,
      message: "Company admin created successfully",
      data: {
        user: serializeUser(result.user),
        setup: result.setup || null,
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to create company admin",
    });
  }
}

export async function updateManagedUserHandler(req: Request, res: Response) {
  try {
    const requester = assertAdminAccess(req);
    const existingUser = await User.findById(req.params.id);

    if (!existingUser || existingUser.deletedAt) {
      throw generateError("User not found", 404);
    }

    if (
      requester.role !== "superadmin" &&
      requester.companyId &&
      String(existingUser.company || "") !== requester.companyId
    ) {
      throw generateError("You can only update users from your company", 403);
    }

    if (
      requester.role === "departmenthead" &&
      normalizeText(existingUser.department) !== normalizeText(requester.department)
    ) {
      throw generateError("You can only update users from your department", 403);
    }

    const existingTargetRole = normalizeRole(existingUser.role);
    if (
      requester.role === "hr" &&
      ["admin", "superadmin", "departmenthead", "hradmin", "hr"].includes(existingTargetRole)
    ) {
      throw generateError("Scoped HR can only update employees and managers", 403);
    }

    if (
      requester.role === "hradmin" &&
      ["admin", "superadmin"].includes(existingTargetRole)
    ) {
      throw generateError("HR Admin cannot update admin or superadmin accounts", 403);
    }

    assertWithinHrScope(requester, existingUser, "update");

    await ensureCompanyManagementAccess({
      actor: requester,
      requestedCompanyId: String(existingUser.company || ""),
      actionLabel: "manage users for this company",
      allowSuperadminWithoutCompany: false,
    });

    const result = await saveManagedUser({
      payload: req.body,
      actor: requester,
      existingUserId: req.params.id,
      sendSetupEmail: false,
    });

    return res.status(200).json({
      success: true,
      message: getManagedUserSuccessMessage("updated"),
      data: {
        user: serializeUser(result.user),
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to update user",
    });
  }
}

export async function getManagedUserAssignmentHistoryHandler(
  req: Request,
  res: Response
) {
  try {
    const requester = assertAdminAccess(req);
    ensurePermission(
      requester,
      PERMISSION_KEYS.VIEW_USERS,
      "You do not have permission to view employee history"
    );

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      throw generateError("Invalid user id", 400);
    }

    const targetUser = await User.findById(req.params.id);
    if (!targetUser || targetUser.deletedAt) {
      throw generateError("User not found", 404);
    }

    const targetCompanyId = String(targetUser.company || "");
    if (
      requester.role !== "superadmin" &&
      (!requester.companyId || requester.companyId !== targetCompanyId)
    ) {
      throw generateError(
        "You can only view employee history from your company",
        403
      );
    }

    if (
      requester.role === "departmenthead" &&
      normalizeText(targetUser.department) !== normalizeText(requester.department)
    ) {
      throw generateError(
        "You can only view employee history from your department",
        403
      );
    }

    if (requester.role === "hr") {
      assertWithinHrScope(requester, targetUser, "view history for");
    }

    await ensureCurrentEmployeeAssignment({
      user: targetUser,
      changedBy: requester.userId,
      source: "history_read_backfill",
    });

    const history = await getEmployeeAssignmentHistory({
      employeeId: String(targetUser._id),
      companyId: targetCompanyId,
    });

    return res.status(200).json({
      success: true,
      message: "Employee assignment history retrieved successfully",
      data: {
        employee: {
          _id: targetUser._id,
          name: targetUser.name || "",
          code: targetUser.code || "",
        },
        history,
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to retrieve employee assignment history",
    });
  }
}

export async function deleteManagedUserHandler(req: Request, res: Response) {
  try {
    const requester = assertAdminAccess(req);
    ensurePermission(requester, PERMISSION_KEYS.EDIT_USERS, "You do not have permission to delete users");
    const targetUser = await User.findById(req.params.id);

    if (!targetUser || targetUser.deletedAt) {
      throw generateError("User not found", 404);
    }

    const targetRole = normalizeRole(targetUser.role);
    if (targetRole === "superadmin") {
      throw generateError("Superadmin accounts cannot be deleted", 400);
    }

    if (requester.userId && String(targetUser._id) === requester.userId) {
      throw generateError("You cannot delete your own account", 400);
    }

    if (
      requester.role === "admin" &&
      ["admin", "superadmin"].includes(targetRole)
    ) {
      throw generateError("You can only delete users from your company scope", 403);
    }

    if (
      requester.role === "departmenthead" &&
      ["admin", "superadmin", "departmenthead"].includes(targetRole)
    ) {
      throw generateError("You can only delete users from your department scope", 403);
    }

    if (
      requester.role === "hr" &&
      ["admin", "superadmin", "departmenthead", "hradmin", "hr"].includes(targetRole)
    ) {
      throw generateError("Scoped HR can only delete employees and managers", 403);
    }

    if (
      requester.role === "hradmin" &&
      ["admin", "superadmin"].includes(targetRole)
    ) {
      throw generateError("HR Admin cannot delete admin or superadmin accounts", 403);
    }

    const targetCompanyId = String(targetUser.company || "");
    if (
      requester.role !== "superadmin" &&
      requester.companyId &&
      targetCompanyId !== requester.companyId
    ) {
      throw generateError("You can only delete users from your company", 403);
    }

    if (
      requester.role === "departmenthead" &&
      normalizeText(targetUser.department) !== normalizeText(requester.department)
    ) {
      throw generateError("You can only delete users from your department", 403);
    }

    assertWithinHrScope(requester, targetUser, "delete");

    if (requester.role !== "superadmin") {
      await ensureCompanyManagementAccess({
        actor: requester,
        requestedCompanyId: targetCompanyId,
        actionLabel: "manage users for this company",
      });
    }

    const directReportCount = await User.countDocuments({
      deletedAt: { $exists: false },
      reportingManager: targetUser._id,
    });

    if (directReportCount > 0) {
      throw generateError("Move this user's direct reports to another manager before deleting the user", 400);
    }

    targetUser.deletedAt = new Date();
    targetUser.is_enabled = false;
    targetUser.setupToken = undefined;
    targetUser.setupTokenExpiry = undefined;
    targetUser.updatedAt = new Date();
    await mongoose.connection.transaction(async (session) => {
      await ensureCurrentEmployeeAssignment({
        user: targetUser,
        changedBy: requester.userId,
        source: "managed_user_delete_backfill",
        session,
      });
      await targetUser.save({ session });
      await closeCurrentEmployeeAssignment({
        employeeId: String(targetUser._id),
        companyId: targetCompanyId,
        changedBy: requester.userId,
        endChangeType: "employment_ended",
        endReason: normalizeText(req.body?.reason) || "Employee removed",
        effectiveAt: targetUser.deletedAt,
        session,
      });
    });

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
      data: {
        userId: targetUser._id,
        deletedAt: targetUser.deletedAt,
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to delete user",
    });
  }
}

export async function updateManagedUserStatusHandler(req: Request, res: Response) {
  try {
    const requester = assertAdminAccess(req);
    ensurePermission(requester, PERMISSION_KEYS.EDIT_USERS, "You do not have permission to update user status");
    const targetUser = await User.findById(req.params.id)
      .populate("company", "company_name companyCode rolePermissions")
      .populate("createdBy", "name username role")
      .populate("reportingManager", "name username role designation");

    if (!targetUser || targetUser.deletedAt) {
      throw generateError("User not found", 404);
    }

    const targetCompanyId = String(
      (targetUser.company as any)?._id || targetUser.company || ""
    );

    if (
      requester.role !== "superadmin" &&
      requester.companyId &&
      targetCompanyId !== requester.companyId
    ) {
      throw generateError("You can only update users from your company", 403);
    }

    if (
      requester.role === "departmenthead" &&
      normalizeText(targetUser.department) !== normalizeText(requester.department)
    ) {
      throw generateError("You can only update users from your department", 403);
    }

    const targetRole = normalizeRole(targetUser.role);
    if (
      requester.role === "hr" &&
      ["admin", "superadmin", "departmenthead", "hradmin", "hr"].includes(targetRole)
    ) {
      throw generateError("Scoped HR can only update employee and manager status", 403);
    }

    if (
      requester.role === "hradmin" &&
      ["admin", "superadmin"].includes(targetRole)
    ) {
      throw generateError("HR Admin cannot update admin or superadmin status", 403);
    }

    assertWithinHrScope(requester, targetUser, "update");

    if (requester.role !== "superadmin") {
      await ensureCompanyManagementAccess({
        actor: requester,
        requestedCompanyId: targetCompanyId,
        actionLabel: "manage users for this company",
      });
    }

    const nextStatus =
      typeof req.body?.isEnabled === "boolean"
        ? req.body.isEnabled
        : targetUser.is_enabled === false;

    targetUser.is_enabled = nextStatus;
    targetUser.updatedAt = new Date();
    await targetUser.save();
    const updatedStatus = getUserAccountStatus(targetUser);

    return res.status(200).json({
      success: true,
      message: nextStatus
        ? updatedStatus === "ACTIVE"
          ? "User activated successfully"
          : "User enabled. Password setup is still required"
        : "User deactivated successfully",
      data: {
        user: serializeUser(targetUser),
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to update user status",
    });
  }
}

export async function getPermissionConfigHandler(req: Request, res: Response) {
  try {
    const requester = assertSuperAdminRequester(req);
    const company = await resolvePermissionCompany({
      actor: requester,
      requestedCompanyId: normalizeText(req.query.companyId),
    });

    if (!company) {
      throw generateError("Company not found", 404);
    }

    const rolePermissions = normalizeRolePermissionMap(company.rolePermissions);

    return res.status(200).json({
      success: true,
      data: {
        companyId: company._id,
        companyName: company.company_name,
        catalog: PERMISSION_CATALOG,
        roles: getPermissionRoleOptions(),
        rolePermissions,
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to load permission settings",
    });
  }
}

export async function updateRolePermissionsHandler(req: Request, res: Response) {
  try {
    const requester = assertSuperAdminRequester(req);
    const company = await resolvePermissionCompany({
      actor: requester,
      requestedCompanyId: normalizeText(req.body?.companyId || req.query.companyId),
    });

    if (!company) {
      throw generateError("Company not found", 404);
    }

    const role = normalizeRole(req.params.role || req.body?.role);
    if (!role) {
      throw generateError("Role is required", 400);
    }

    if (!CONFIGURABLE_PERMISSION_ROLES.includes(role as (typeof CONFIGURABLE_PERMISSION_ROLES)[number])) {
      throw generateError("Only admin, HR Admin, HR, and department head permissions can be configured", 400);
    }

    const permissionValidation = validatePermissionRecordForRole({
      role,
      permissions: req.body?.permissions,
    });
    if (!permissionValidation.valid) {
      throw generateError(permissionValidation.errors.join(" "), 400);
    }

    const currentRolePermissions = normalizeRolePermissionMap(company.rolePermissions);
    currentRolePermissions[role] = permissionValidation.sanitizedPermissions;
    company.rolePermissions = currentRolePermissions;
    company.updatedAt = new Date();
    await company.save();

    return res.status(200).json({
      success: true,
      message: "Role permissions updated successfully",
      data: {
        companyId: company._id,
        role,
        permissions: currentRolePermissions[role],
        rolePermissions: currentRolePermissions,
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to update role permissions",
    });
  }
}

export async function updateUserPermissionsHandler(req: Request, res: Response) {
  try {
    const requester = assertSuperAdminRequester(req);
    const targetUser = await User.findById(req.params.id)
      .populate("company", "company_name companyCode rolePermissions")
      .populate("createdBy", "name username role")
      .populate("reportingManager", "name username role designation");

    if (!targetUser || targetUser.deletedAt) {
      throw generateError("User not found", 404);
    }

    if (normalizeRole(targetUser.role) === "superadmin") {
      throw generateError("Superadmin permissions cannot be overridden", 400);
    }

    const targetRole = normalizeRole(targetUser.role);
    if (!CONFIGURABLE_PERMISSION_ROLES.includes(targetRole as (typeof CONFIGURABLE_PERMISSION_ROLES)[number])) {
      throw generateError("Only admin and department head permissions can be overridden", 400);
    }

    const permissionValidation = validatePermissionRecordForRole({
      role: targetRole,
      permissions: req.body?.permissions,
    });
    if (!permissionValidation.valid) {
      throw generateError(permissionValidation.errors.join(" "), 400);
    }

    targetUser.permissions = permissionValidation.sanitizedPermissions;
    targetUser.updatedAt = new Date();
    await targetUser.save();

    return res.status(200).json({
      success: true,
      message: "User permission overrides updated successfully",
      data: {
        user: serializeUser(targetUser),
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to update user permission overrides",
    });
  }
}

export async function bulkManagedUsersHandler(req: any, res: Response) {
  try {
    const requester = assertAdminAccess(req);
    if (!req.file?.buffer) {
      throw generateError("Excel file is required", 400);
    }

    const dryRun = String(req.body?.dryRun || req.query?.dryRun || "").toLowerCase() === "true";
    const bulkCompanyId =
      requester.role === "superadmin"
        ? normalizeText(req.body?.companyId || req.body?.company)
        : requester.companyId;
    const bulkCompanyName =
      requester.role === "superadmin"
        ? normalizeText(req.body?.companyName || req.body?.companyNameInput)
        : "";
    if (requester.role === "superadmin" && !bulkCompanyId && !bulkCompanyName) {
      throw generateError("Company selection is required for bulk upload", 400);
    }

    const bulkTargetCompanyId = requester.role === "superadmin" ? bulkCompanyId : requester.companyId;
    if (bulkTargetCompanyId) {
      await ensureCompanyManagementAccess({
        actor: requester,
        requestedCompanyId: bulkTargetCompanyId,
        actionLabel: "bulk add users to this company",
        allowSuperadminWithoutCompany: true,
      });
    }

    const rows = await parseBulkWorkbook(req.file.buffer, {
      companyId: bulkCompanyId,
      companyName: bulkCompanyName,
      uploadRole: normalizeText(req.body?.uploadRole || req.body?.role),
    });
    const previewRows = await buildBulkPreview(rows);

    if (dryRun) {
      return res.status(200).json({
        success: true,
        data: {
          preview: previewRows,
          totalRows: previewRows.length,
        },
      });
    }

    const orderedRows = sortRowsByHierarchy(rows);
    const results = [];
    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;

    for (const row of orderedRows) {
      const validation = await validateBulkRow(row);

      if (validation.errors.length > 0) {
        failedCount += 1;
        results.push({
          rowNumber: row.rowNumber,
          username: row.payload.username,
          mobileNumber: row.payload.mobileNumber,
          success: false,
          error: validation.errors.join(", "),
        });
        continue;
      }

      try {
        const existingUser = validation.existingEmailUser || validation.existingPhoneUser || validation.existingCodeUser;
        if (existingUser) {
          const duplicateValidation = buildDuplicateUserErrors({
            email: row.payload.username,
            mobileNumber: row.payload.mobileNumber,
            code: row.payload.code,
            existingEmailUser: validation.existingEmailUser,
            existingPhoneUser: validation.existingPhoneUser,
            existingCodeUser: validation.existingCodeUser,
          });
          failedCount += 1;
          results.push({
            rowNumber: row.rowNumber,
            username: row.payload.username,
            mobileNumber: row.payload.mobileNumber,
            success: false,
            error: duplicateValidation.errors.join(", ") || "User already exists",
            action: "SKIP",
            skipReason: duplicateValidation.skipReason,
          });
          continue;
        }

        const result = await saveManagedUser({
          payload: row.payload,
          actor: requester,
          existingUserId: undefined,
          sendSetupEmail: false,
        });

        createdCount += 1;
        results.push({
          rowNumber: row.rowNumber,
          username: row.payload.username,
          mobileNumber: row.payload.mobileNumber,
          success: true,
          action: "CREATE",
          user: serializeUser(result.user),
        });
      } catch (error: any) {
        failedCount += 1;
        results.push({
          rowNumber: row.rowNumber,
          username: row.payload.username,
          mobileNumber: row.payload.mobileNumber,
          success: false,
          error: error?.message || "Failed to create user",
        });
      }
    }

    return res.status(200).json({
      success: true,
      message:
        failedCount > 0
          ? "Bulk upload completed with partial success"
          : "Bulk upload completed successfully",
      data: {
        totalRows: rows.length,
        createdCount,
        updatedCount,
        failedCount,
        results,
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to process bulk upload",
    });
  }
}

export async function setPasswordFromSetupToken(token: string, password: string) {
  const normalizedToken = normalizeText(token);
  if (!normalizedToken) {
    throw generateError("Token is required", 400);
  }

  const user = await User.findOne({
    setupToken: normalizedToken,
    setupTokenExpiry: { $gt: new Date() },
    deletedAt: { $exists: false },
  });

  if (!user) {
    throw generateError("Invalid or expired setup token", 400);
  }

  user.password = await hashBcrypt(password);
  user.setupToken = undefined;
  user.setupTokenExpiry = undefined;
  await user.save();

  const populatedUser = await User.findById(user._id)
      .populate("company", "company_name companyCode rolePermissions")
      .populate("createdBy", "name username role")
      .populate("reportingManager", "name username role designation");

  return serializeUser(populatedUser);
}

export async function getManagedUserProfileDetailsHandler(req: Request, res: Response) {
  try {
    const targetUserId = req.params.id;
    // In a real app we might check permissions, but for now we assume admin/hr access via middleware
    const user = await User.findById(targetUserId).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const profileDetails = await ProfileDetails.findOne({ user: targetUserId })
      .populate("employeeDocuments.documentFileId")
      .populate("employeeDocuments.createdBy", "name")
      .populate("employeeDocuments.approvedBy", "name");

    const responseData: any = profileDetails ? profileDetails.toObject() : {};
    if (responseData.personalInfo) {
      delete responseData.personalInfo;
    }

    // Attach core user fields so the admin UI can display them correctly
    responseData.user = {
      _id: user._id,
      company: user.company,
      department: user.department,
      officeLocation: user.officeLocation,
      employeeNumber: user.employeeNumber,
      code: user.code,
      name: user.name,
      designation: user.designation,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      username: user.username,
      mobileNumber: user.mobileNumber,
      address: user.address,
      city: user.city,
      state: user.state,
      country: user.country,
      postalCode: user.postalCode,
      pic: user.pic,
    };

    return res.status(200).json({ success: true, data: responseData });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch profile details" });
  }
}

export async function updateManagedUserPersonalDetailsHandler(req: Request, res: Response) {
  try {
    const targetUserId = req.params.id;
    let profile = await ProfileDetails.findOne({ user: targetUserId });
    if (!profile) profile = new ProfileDetails({ user: targetUserId });
    
    // Sanitize enum and date fields
    if (req.body.maritalStatus === "") {
      delete req.body.maritalStatus;
    }
    if (req.body.anniversaryDate === "") {
      delete req.body.anniversaryDate;
    }

    // Save additional personal details (extracting only relevant fields for ProfileDetails)
    profile.personalDetails = {
      knownAs: req.body.knownAs,
      maritalStatus: req.body.maritalStatus,
      anniversaryDate: req.body.anniversaryDate,
      fatherHusbandName: req.body.fatherHusbandName,
      bloodGroup: req.body.bloodGroup,
      religion: req.body.religion,
      nationality: req.body.nationality,
      emergencyContactName: req.body.emergencyContactName,
      emergencyContactNumber: req.body.emergencyContactNumber,
      personalEmail: req.body.personalEmail,
    };
    await profile.save();

    // Sync core fields back to User collection
    const user = await User.findById(targetUserId);
    if (user) {
      if (req.body.employeeNumber !== undefined) user.employeeNumber = req.body.employeeNumber;
      if (req.body.designation !== undefined) user.designation = req.body.designation;
      if (req.body.fullName !== undefined) user.name = req.body.fullName;
      
      if (req.body.dateOfBirth !== undefined) {
        user.dateOfBirth = req.body.dateOfBirth === "" ? null : req.body.dateOfBirth;
      }
      if (req.body.gender !== undefined) {
        const genderMap: Record<string, number> = { 'male': 1, 'female': 2, 'other': 3 };
        user.gender = genderMap[String(req.body.gender).toLowerCase()] || user.gender;
      }
      if (req.body.mobileNumber !== undefined) user.mobileNumber = req.body.mobileNumber;
      if (req.body.email !== undefined) user.username = req.body.email; // assuming email mapped to username
      if (req.body.address !== undefined) user.address = req.body.address;
      if (req.body.city !== undefined) user.city = req.body.city;
      if (req.body.state !== undefined) user.state = req.body.state;
      if (req.body.country !== undefined) user.country = req.body.country;
      if (req.body.postalCode !== undefined) user.postalCode = req.body.postalCode;
      if (req.body.department !== undefined) user.department = req.body.department;
      if (req.body.officeLocation !== undefined) user.officeLocation = req.body.officeLocation;

      if (req.body.pic) {
        if (req.body.pic.isDeleted) {
          user.pic = null;
        } else if (req.body.pic.isAdd && req.body.pic.buffer) {
          if (req.body.pic.filename) {
            const lastDotIndex = req.body.pic.filename.lastIndexOf('.');
            if (lastDotIndex !== -1) {
              const name = req.body.pic.filename.substring(0, lastDotIndex);
              const ext = req.body.pic.filename.substring(lastDotIndex);
              req.body.pic.filename = `${name}_${Date.now()}${ext}`;
            } else {
              req.body.pic.filename = `${req.body.pic.filename}_${Date.now()}`;
            }
          }
          const uploadedUrl = await uploadFile(req.body.pic);
          user.pic = { url: uploadedUrl };
        }
      }

      console.log("DEBUG BACKEND BEFORE SAVE: department=", user.department, "location=", user.officeLocation);
      await user.save();
      console.log("DEBUG BACKEND AFTER SAVE!");
    }

    return res.status(200).json({ success: true, data: profile });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || "Failed to update personal details" });
  }
}

export async function updateManagedUserFamilyContactsHandler(req: Request, res: Response) {
  try {
    const targetUserId = req.params.id;
    let profile = await ProfileDetails.findOne({ user: targetUserId });
    if (!profile) profile = new ProfileDetails({ user: targetUserId });
    profile.familyContacts = req.body.familyContacts;
    await profile.save();
    return res.status(200).json({ success: true, data: profile });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || "Failed to update family contacts" });
  }
}

export async function updateManagedUserSkillsHandler(req: Request, res: Response) {
  try {
    const targetUserId = req.params.id;
    let profile = await ProfileDetails.findOne({ user: targetUserId });
    if (!profile) profile = new ProfileDetails({ user: targetUserId });
    profile.skills = req.body;
    await profile.save();
    return res.status(200).json({ success: true, data: profile });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || "Failed to update skills" });
  }
}

export async function updateManagedUserStatutoryDetailsHandler(req: Request, res: Response) {
  try {
    const targetUserId = req.params.id;
    let profile = await ProfileDetails.findOne({ user: targetUserId });
    if (!profile) profile = new ProfileDetails({ user: targetUserId });
    profile.statutoryDetails = req.body;
    await profile.save();
    return res.status(200).json({ success: true, data: profile });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || "Failed to update statutory details" });
  }
}

export async function updateManagedUserEmployeeDocumentsHandler(req: Request, res: Response) {
  try {
    const targetUserId = req.params.id;
    let profile = await ProfileDetails.findOne({ user: targetUserId });
    if (!profile) profile = new ProfileDetails({ user: targetUserId });
    profile.employeeDocuments = req.body.employeeDocuments;
    await profile.save();
    return res.status(200).json({ success: true, data: profile });
  } catch (error: any) {
    return res.status(500).json({ status: false, message: "Server error", error: error instanceof Error ? error.message : "Unknown error" });
  }
}

export async function updateManagedUserReportingManagerHandler(req: Request, res: Response) {
  try {
    const targetUserId = req.params.id;
    const newManagerId = req.body.reportingManager || null;
    const user = await User.findById(targetUserId);

    if (!user) {
      return res.status(404).json({ status: false, message: "User not found" });
    }

    // Assign the new manager
    user.reportingManager = newManagerId;
    await user.save();

    return res.json({
      status: true,
      message: "Reporting manager updated successfully",
      data: {
        _id: user._id,
        reportingManager: user.reportingManager
      }
    });
  } catch (error) {
    console.error("Error updating reporting manager:", error);
    return res.status(500).json({ status: false, message: "Server error", error: error instanceof Error ? error.message : "Unknown error" });
  }
}
