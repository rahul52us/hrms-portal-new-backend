import crypto from "crypto";
import { Request, Response } from "express";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { generateError } from "../../config/Error/functions";
import { generateFileName, hashBcrypt } from "../../config/helper/function";
import { deleteFile, uploadFile } from "../../repository/uploadDoc.repository";
import ProfileDetails from "../../schemas/User/ProfileDetails";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
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

const ExcelJS = require("exceljs");

type ManagerInput = {
  level: number;
  managerEmail: string;
  managerName?: string;
  managerId?: mongoose.Types.ObjectId | string;
  status?: "ASSIGNED" | "PENDING";
};

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

function normalizeRole(value: unknown) {
  const normalized = normalizeText(value).toLowerCase();
  if (/^department[-\s]?head$/i.test(normalized)) {
    return "departmenthead";
  }

  const managerMatch = normalized.match(/^l\s*(\d+)\s*[-\s]?\s*manager$/i);
  if (managerMatch) {
    return `l${managerMatch[1]}-manager`;
  }

  return normalized || "user";
}

function parseManagerRoleLevel(role: unknown) {
  const match = normalizeRole(role).match(/^l(\d+)-manager$/i);
  return match ? Number(match[1]) : null;
}

function getCompanyManagerLevels(company: any) {
  return Math.max(1, Number(company?.managerLevels) || 3);
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

function buildProfilePrefix(companyName: string) {
  const tokens = normalizeText(companyName)
    .toUpperCase()
    .match(/[A-Z0-9]+/g) || [];

  const initials = tokens.map((token) => token[0]).join("").slice(0, 4);
  if (initials.length >= 2) {
    return initials;
  }

  const compactName = tokens.join("").slice(0, 4);
  if (compactName.length >= 2) {
    return compactName;
  }

  return "USR";
}

async function generateUniqueProfileId(companyName: string) {
  const prefix = buildProfilePrefix(companyName);
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  while (true) {
    const suffix = Array.from({ length: 5 }, () =>
      characters.charAt(Math.floor(Math.random() * characters.length))
    ).join("");
    const profileId = `${prefix}-${suffix}`;
    const existingUser = await User.findOne({ profileId });

    if (!existingUser) {
      return profileId;
    }
  }
}

async function syncManagedUserProfileDetails(user: any, company: any) {
  const existingProfile = user?.profile_details
    ? await ProfileDetails.findById(user.profile_details)
    : null;

  const personalInfo = {
    ...(existingProfile?.personalInfo || {}),
    name: user?.name || "",
    username: user?.username || user?.email || "",
    email: user?.email || user?.username || "",
    code: user?.code || "",
    title: user?.title || "",
    city: user?.city || "",
    state: user?.state || "",
    designation: user?.designation || "",
    joiningDate: user?.joiningDate || null,
    mobileNumber: user?.mobileNumber || "",
    department: user?.department || "",
    profileId: user?.profileId || "",
    gender: user?.gender ?? null,
    dob: user?.dateOfBirth || null,
    dateOfBirth: user?.dateOfBirth || null,
    company: company?._id || user?.company || null,
  };

  if (existingProfile) {
    existingProfile.personalInfo = personalInfo as any;
    await existingProfile.save();
    return existingProfile;
  }

  return new ProfileDetails({
    user: user._id,
    personalInfo,
  }).save();
}

function getManagedUserSuccessMessage(action: "created" | "updated") {
  return `User ${action} successfully`;
}

function inferRoleFromManagers(managers: ManagerInput[], companyManagerLevels = 3) {
  const sortedLevels = [...managers]
    .map((manager) => Number(manager.level))
    .filter((level) => level > 0)
    .sort((a, b) => a - b);

  if (sortedLevels.length === 0) {
    return `l${companyManagerLevels}-manager`;
  }

  const firstAssignedLevel = sortedLevels[0];
  if (firstAssignedLevel <= 1) {
    return "user";
  }

  return `l${firstAssignedLevel - 1}-manager`;
}

function getExpectedManagerLevelsForRole(role: unknown, companyManagerLevels = 3) {
  const normalizedRole = normalizeRole(role);
  const maxLevel = Math.max(1, Number(companyManagerLevels) || 3);

  if (normalizedRole === "user") {
    return Array.from({ length: maxLevel }, (_, index) => index + 1);
  }

  const managerLevel = parseManagerRoleLevel(normalizedRole);
  if (!managerLevel || managerLevel >= maxLevel) {
    return [];
  }

  return Array.from({ length: maxLevel - managerLevel }, (_, index) => managerLevel + index + 1);
}

function getManagerHeaderLabel(level: number) {
  return `L${level} Manager Phone Number`;
}

function getManagerHeaderHintLabel(level: number) {
  return `L${level} Manager Phone Number (Name)`;
}

function getBulkUploadTypeLabel(role: unknown, companyManagerLevels = 3) {
  const normalizedRole = normalizeRole(role);
  if (normalizedRole === "user") {
    return "Employee/User upload";
  }

  const managerLevel = parseManagerRoleLevel(normalizedRole);
  if (!managerLevel) {
    return "Bulk upload";
  }

  const topLevel = Math.max(1, Number(companyManagerLevels) || 3);
  return managerLevel === topLevel
    ? `Level ${managerLevel} manager upload`
    : `Level ${managerLevel} manager upload`;
}

function dedupeManagers(managers: ManagerInput[]) {
  const uniqueManagers = new Map<string, ManagerInput>();

  for (const manager of Array.isArray(managers) ? managers : []) {
    const level = Number(manager?.level) || 0;
    const managerEmail = normalizePhoneNumber(manager?.managerEmail);
    if (!level || !managerEmail) {
      continue;
    }

    const key = `${level}:${managerEmail}`;
    if (!uniqueManagers.has(key)) {
      uniqueManagers.set(key, {
        level,
        managerEmail,
        managerName: normalizeText(manager?.managerName) || undefined,
      });
    }
  }

  return Array.from(uniqueManagers.values()).sort((a, b) => a.level - b.level);
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
    errors.push(`Email already exists (${existingEmailUser?.email || email})`);
    skipReason = skipReason || "EMAIL_EXISTS";
  }

  if (existingPhoneUser) {
    errors.push(`Phone number already exists (${existingPhoneUser?.mobileNumber || existingPhoneUser?.username || mobileNumber})`);
    skipReason = skipReason ? `${skipReason}_AND_PHONE_EXISTS` : "PHONE_EXISTS";
  }

  if (existingCodeUser) {
    errors.push(
      `Employee code already exists (${code}) and belongs to ${
        existingCodeUser?.mobileNumber || existingCodeUser?.email || existingCodeUser?.username || "another user"
      }`
    );
    skipReason = skipReason ? `${skipReason}_AND_CODE_EXISTS` : "CODE_EXISTS";
  }

  return { errors, skipReason };
}

function buildTemplateHeaders(uploadRole: string, companyManagerLevels: number) {
  const isUserUpload = normalizeRole(uploadRole) === "user";
  const headers = [
    "Sr. No.",
    "Employee Code",
    "Employee Name",
    "Phone Number",
    "Email ID (Optional)",
    isUserUpload ? "Branch (Optional)" : "Branch",
    "City",
    "State",
  ];

  if (isUserUpload) {
    headers.push("Designation", "Joining Date");
  }

  getExpectedManagerLevelsForRole(uploadRole, companyManagerLevels).forEach((level) => {
    headers.push(getManagerHeaderHintLabel(level));
  });

  return headers;
}

function buildTemplateRows(uploadRole: string, companyManagerLevels: number) {
  const normalizedRole = normalizeRole(uploadRole);
  const managerLevel = parseManagerRoleLevel(normalizedRole);
  const expectedManagerLevels = getExpectedManagerLevelsForRole(uploadRole, companyManagerLevels);
  const commonRows = [
    {
      branch: "Corporate",
      city: "Mumbai",
      state: "Maharashtra",
    },
    {
      branch: "Operations",
      city: "Bangalore",
      state: "Karnataka",
    },
    {
      branch: "Finance",
      city: "Pune",
      state: "Maharashtra",
    },
  ];

  const hierarchyExamples = [
    {
      l1: { code: "L1-3001", name: "Aditya Rao", email: "", phone: "9876543230" },
      l2: { code: "L2-2001", name: "Priya Sharma", email: "", phone: "9876543220" },
      l3: { code: "L3-1001", name: "Arjun Mehta", email: "", phone: "9876543210" },
      user: {
        code: "EMP-4001",
        name: "Aakash Nair",
        email: "",
        phone: "9876543240",
        designation: "Software Engineer",
        joiningDate: "2025-01-12",
      },
    },
    {
      l1: { code: "L1-3002", name: "Sneha Iyer", email: "", phone: "9876543231" },
      l2: { code: "L2-2002", name: "Kunal Desai", email: "", phone: "9876543221" },
      l3: { code: "L3-1002", name: "Neha Kapoor", email: "", phone: "9876543211" },
      user: {
        code: "EMP-4002",
        name: "Pooja Bansal",
        email: "",
        phone: "9876543241",
        designation: "QA Engineer",
        joiningDate: "2025-02-18",
      },
    },
    {
      l1: { code: "L1-3003", name: "Varun Malhotra", email: "", phone: "9876543232" },
      l2: { code: "L2-2003", name: "Simran Gill", email: "", phone: "9876543222" },
      l3: { code: "L3-1003", name: "Rohan Verma", email: "", phone: "9876543212" },
      user: {
        code: "EMP-4003",
        name: "Manish Yadav",
        email: "",
        phone: "9876543242",
        designation: "Backend Developer",
        joiningDate: "2025-03-25",
      },
    },
  ];

  const getManagerProfile = (entry: any, level: number, index: number) => {
    if (entry?.[`l${level}`]) {
      return entry[`l${level}`];
    }

    const serial = String(index + 1).padStart(4, "0");
    return {
      code: `L${level}-${serial}`,
      name: `Level ${level} Manager ${index + 1}`,
      email: `l${level}.manager${index + 1}@novaedge.com`,
      phone: `9876500${String(level)}${String(index + 1).padStart(2, "0")}`,
    };
  };

  if (normalizedRole === "user") {
    return hierarchyExamples.map((entry, index) => ([
      index + 1,
      entry.user.code,
      entry.user.name,
      entry.user.phone,
      entry.user.email,
      commonRows[index].branch,
      commonRows[index].city,
      commonRows[index].state,
      entry.user.designation,
      entry.user.joiningDate,
      ...expectedManagerLevels.map((level) => getManagerProfile(entry, level, index).phone),
    ]));
  }

  if (!managerLevel) {
    return [];
  }

  return hierarchyExamples.map((entry, index) => {
    const currentManager = getManagerProfile(entry, managerLevel, index);
    return [
      index + 1,
      currentManager.code,
      currentManager.name,
      currentManager.phone,
      currentManager.email,
      commonRows[index].branch,
      commonRows[index].city,
      commonRows[index].state,
      ...expectedManagerLevels.map((level) => getManagerProfile(entry, level, index).phone),
    ];
  });
}

function buildRoleMatch(role: string) {
  const normalizedRole = normalizeRole(role);
  const level = parseManagerRoleLevel(normalizedRole);
  if (!level) {
    return normalizedRole;
  }

  return {
    $in: [`l${level}-manager`, `l${level} manager`],
  };
}

function getRolePriority(role: string) {
  const normalizedRole = normalizeRole(role);
  if (normalizedRole === "superadmin") {
    return 1000;
  }
  if (normalizedRole === "admin") {
    return 999;
  }

  const managerLevel = parseManagerRoleLevel(normalizedRole);
  if (managerLevel) {
    return managerLevel;
  }

  return 0;
}

function sortRowsByHierarchy(rows: any[]) {
  return [...rows].sort((a, b) => {
    const roleDiff = getRolePriority(b?.payload?.role) - getRolePriority(a?.payload?.role);
    if (roleDiff !== 0) {
      return roleDiff;
    }

    return Number(a?.rowNumber || 0) - Number(b?.rowNumber || 0);
  });
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function deriveNameFromEmail(email: string) {
  const normalizedEmail = normalizeEmail(email);
  const localPart = normalizedEmail.split("@")[0] || normalizedEmail;
  const words = localPart
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  return words.join(" ") || normalizedEmail;
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

export function calculateUserActiveState(user: any) {
  const managers = Array.isArray(user?.managers) ? user.managers : [];
  return managers.every((manager: any) => manager?.status === "ASSIGNED");
}

async function generateUniqueUserCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  while (true) {
    const code = Array.from({ length: 6 }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length))
    ).join("");

    const existingUser = await User.findOne({ code });
    if (!existingUser) {
      return code;
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
      to: user.email || user.username,
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
                <p style="margin:0 0 8px;font-size:14px;color:#475569;">Email: ${user.email || user.username}</p>
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
    $or: [{ email: emailRegex }, { username: emailRegex }],
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
    $or: [
      { mobileNumber: normalizedPhone },
      { username: normalizedPhone },
      { email: new RegExp(`^${escapeRegex(normalizedPhone)}$`, "i") },
    ],
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

async function findUserByCode(code: string, excludeUserId?: string) {
  const normalizedCode = normalizeText(code);
  if (!normalizedCode) {
    return null;
  }

  const query: any = {
    code: { $regex: new RegExp(`^${escapeRegex(normalizedCode)}$`, "i") },
    deletedAt: { $exists: false },
  };

  if (excludeUserId) {
    query._id = { $ne: new mongoose.Types.ObjectId(excludeUserId) };
  }

  return User.findOne(query);
}

async function ensureCompanyReference({
  companyId,
  companyName,
  managerLevels,
  actorId,
  actionLabel,
}: {
  companyId?: string;
  companyName?: string;
  managerLevels?: number;
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
    managerLevels: Math.max(1, Number(managerLevels) || 3),
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

async function resolveManagers(
  managers: ManagerInput[],
  excludeUserId?: string,
  companyId?: string | mongoose.Types.ObjectId
) {
  const normalizedManagers = (Array.isArray(managers) ? managers : [])
    .map((manager, index) => ({
      level: Number(manager?.level) || index + 1,
      managerEmail: normalizePhoneNumber(manager?.managerEmail),
    }))
    .filter((manager) => manager.managerEmail)
    .sort((a, b) => a.level - b.level);

  const resolvedManagers: any[] = [];
  for (const manager of normalizedManagers) {
    const matchingManager = await findUserByPhone(manager.managerEmail, excludeUserId, companyId);
    resolvedManagers.push({
      level: manager.level,
      managerEmail: manager.managerEmail,
      managerId: matchingManager?._id,
      status: matchingManager ? "ASSIGNED" : "PENDING",
    });
  }

  return resolvedManagers;
}

export async function syncUserManagerStateById(userId: string | mongoose.Types.ObjectId) {
  const user = await User.findById(userId);
  if (!user) {
    return null;
  }

  user.managers = await resolveManagers(
    (user.managers || []) as ManagerInput[],
    String(user._id),
    String(user.company || "")
  );
  user.is_active = calculateUserActiveState(user);
  await user.save();
  return user;
}

export async function syncDependentUsersForManagerEmail(managerEmail: string) {
  const normalizedManagerEmail = normalizePhoneNumber(managerEmail);
  if (!normalizedManagerEmail) {
    return;
  }

  const dependentUsers = await User.find({
    "managers.managerEmail": normalizedManagerEmail,
    deletedAt: { $exists: false },
  });

  for (const dependentUser of dependentUsers) {
    await syncUserManagerStateById(dependentUser._id);
  }
}

function serializeUser(user: any) {
  const userWithPermissions = attachEffectivePermissions({
    user,
    company:
      user?.company && typeof user.company === "object" && "company_name" in user.company
        ? user.company
        : null,
  });
  const normalizedEmail = user?.email || user?.username || "";
  const company =
    user?.company && typeof user.company === "object" && "company_name" in user.company
      ? user.company
      : null;
  const createdBy =
    user?.createdBy && typeof user.createdBy === "object" && "name" in user.createdBy
      ? user.createdBy
      : null;

  const managers = Array.isArray(user?.managers)
    ? [...user.managers]
        .sort((a: any, b: any) => Number(a?.level || 0) - Number(b?.level || 0))
        .map((manager: any) => ({
          level: manager?.level,
          managerEmail: manager?.managerEmail,
          managerId:
            manager?.managerId && typeof manager.managerId === "object" && "_id" in manager.managerId
              ? manager.managerId._id
              : manager?.managerId || null,
          manager:
            manager?.managerId && typeof manager.managerId === "object" && "_id" in manager.managerId
              ? {
                  _id: manager.managerId._id,
                  name: manager.managerId.name,
                  email: manager.managerId.email || manager.managerId.username,
                  role: manager.managerId.role,
                }
              : null,
          status: manager?.status || "PENDING",
        }))
    : [];
  const lifecycleStatus = user?.is_enabled === false ? "INACTIVE" : user?.is_active ? "ACTIVE" : "PENDING";

  return {
    _id: user?._id,
    name: user?.name || "",
    email: user?.email || "",
    username: user?.username || normalizedEmail,
    role: user?.role || user?.userType || "user",
    userType: user?.userType || user?.role || "user",
    code: user?.code,
    profileId: user?.profileId || "",
    mobileNumber: user?.mobileNumber || "",
    city: user?.city || "",
    state: user?.state || "",
    department: user?.department || "",
    designation: user?.designation || "",
    joiningDate: user?.joiningDate || null,
    dateOfBirth: user?.dateOfBirth || null,
    gender: user?.gender ?? null,
    companyId: company?._id || user?.company || null,
    company: company
      ? {
          _id: company._id,
          name: company.company_name,
          company_name: company.company_name,
          managerLevels: company.managerLevels || 3,
        }
      : null,
    createdBy: createdBy
      ? {
          _id: createdBy._id,
          name: createdBy.name,
          email: createdBy.email || createdBy.username,
          username: createdBy.username,
          role: createdBy.role,
        }
      : null,
    managers,
    isActive: lifecycleStatus === "ACTIVE",
    is_active: Boolean(user?.is_active),
    isEnabled: user?.is_enabled !== false,
    is_enabled: user?.is_enabled !== false,
    canLogin: Boolean(user?.is_active) && user?.is_enabled !== false,
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

function parseManagersPayload(payloadManagers: any[]) {
  return dedupeManagers((Array.isArray(payloadManagers) ? payloadManagers : [])
    .map((manager, index) => ({
      level: Number(manager?.level) || index + 1,
      managerEmail: normalizePhoneNumber(manager?.managerEmail),
    }))
    .filter((manager) => manager.managerEmail));
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
    permissions?: Record<string, boolean>;
    permissionOverrides?: Record<string, boolean>;
    effectivePermissions?: Record<string, boolean>;
  };
  existingUserId?: string;
  sendSetupEmail?: boolean;
}) {
  const code = normalizeText(payload?.code);
  const name = normalizeText(payload?.name);
  const email = normalizeEmail(payload?.email || payload?.username);
  const mobileNumber = normalizeText(payload?.mobileNumber || payload?.phoneNumber);
  const designation = normalizeText(payload?.designation);
  const role = normalizeRole(payload?.role);
  const password = normalizeText(payload?.password);
  const managersInput = parseManagersPayload(payload?.managers);
  const requestedManagerLevels = Math.max(
    1,
    Number(payload?.companyManagerLevels) ||
      Number(payload?.managerLevels) ||
      parseManagerRoleLevel(role) ||
      managersInput.reduce((max, manager) => Math.max(max, Number(manager.level) || 0), 0) ||
      3
  );

  if (!name) {
    throw generateError("Name is required", 400);
  }

  if (!code) {
    throw generateError("Employee code is required", 400);
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
  if (managersInput.some((manager) => selfManagerIdentifiers.includes(manager.managerEmail))) {
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

  const existingCodeUser = await findUserByCode(code, existingUserId);
  if (existingCodeUser) {
    throw generateError(`${code} is already assigned to another user`, 400);
  }

  const effectiveCompanyId = actor.role === "superadmin" ? payload?.companyId || payload?.company : actor.companyId;
  const effectiveCompanyName = actor.role === "superadmin" ? payload?.companyName || payload?.companyNameInput : undefined;

  const company = await ensureCompanyReference({
    companyId: effectiveCompanyId,
    companyName: effectiveCompanyName,
    managerLevels: requestedManagerLevels,
    actorId: actor.userId,
    actionLabel: "add users to this company",
  });

  const companyManagerLevels = getCompanyManagerLevels(company);
  const roleLevel = parseManagerRoleLevel(role);
  if (
    actor.role === "departmenthead" &&
    ["admin", "superadmin", "departmenthead"].includes(role)
  ) {
    throw generateError("Department head can only manage users and managers", 403);
  }

  if (roleLevel && roleLevel > companyManagerLevels) {
    throw generateError(`Role ${role} exceeds the configured manager levels for this company`, 400);
  }

  if (managersInput.some((manager) => Number(manager.level) > companyManagerLevels)) {
    throw generateError(`Manager assignment exceeds the configured manager levels for this company`, 400);
  }

  let user = existingUserId ? await User.findById(existingUserId) : null;
  const isCreate = !user;
  if (isCreate && !password && !sendSetupEmail) {
    throw generateError("Enter a password or send a setup invite", 400);
  }
  const payloadIncludesDepartment = Object.prototype.hasOwnProperty.call(payload || {}, "department");
  const payloadIncludesDateOfBirth =
    Object.prototype.hasOwnProperty.call(payload || {}, "dateOfBirth") ||
    Object.prototype.hasOwnProperty.call(payload || {}, "dob");
  const payloadIncludesGender = Object.prototype.hasOwnProperty.call(payload || {}, "gender");
  const rawDateOfBirth = payload?.dateOfBirth ?? payload?.dob;
  const parsedDateOfBirth = payloadIncludesDateOfBirth
    ? normalizeDateValue(rawDateOfBirth)
    : user?.dateOfBirth;
  const normalizedGender = payloadIncludesGender ? normalizeGender(payload?.gender) : user?.gender;
  const resolvedDepartment =
    actor.role === "departmenthead"
      ? normalizeText(actor.department)
      : payloadIncludesDepartment
        ? normalizeText(payload?.department)
        : normalizeText(user?.department);

  if (payloadIncludesDateOfBirth && rawDateOfBirth && !parsedDateOfBirth) {
    throw generateError("Enter a valid date of birth", 400);
  }

  if (parsedDateOfBirth && isFutureDate(parsedDateOfBirth)) {
    throw generateError("Date of birth cannot be in the future", 400);
  }

  if (payloadIncludesGender && normalizeText(payload?.gender) && normalizedGender === undefined) {
    throw generateError("Select a valid gender", 400);
  }

  if (role === "departmenthead" || roleLevel) {
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

  if (isCreate) {
    if (role === "departmenthead") {
      ensurePermission(actor, PERMISSION_KEYS.CREATE_DEPARTMENT_HEADS, "You do not have permission to create department heads");
    } else if (parseManagerRoleLevel(role)) {
      ensurePermission(actor, PERMISSION_KEYS.CREATE_MANAGERS, "You do not have permission to create managers");
    } else {
      ensurePermission(actor, PERMISSION_KEYS.CREATE_USERS, "You do not have permission to create users");
    }
  } else {
    ensurePermission(actor, PERMISSION_KEYS.EDIT_USERS, "You do not have permission to edit users");

    const previousRole = normalizeRole(user?.role || user?.userType);
    if (role !== previousRole) {
      if (role === "departmenthead") {
        ensurePermission(actor, PERMISSION_KEYS.CREATE_DEPARTMENT_HEADS, "You do not have permission to assign the department head role");
      } else if (parseManagerRoleLevel(role)) {
        ensurePermission(actor, PERMISSION_KEYS.CREATE_MANAGERS, "You do not have permission to assign manager roles");
      }
    }
  }

  if (managersInput.length > 0) {
    ensurePermission(actor, PERMISSION_KEYS.ASSIGN_MANAGERS, "You do not have permission to assign managers");
  }

  if (!user) {
    user = new User({
      code,
      createdAt: new Date(),
      createdBy: actor.userId ? new mongoose.Types.ObjectId(actor.userId) : undefined,
    });
  }

  user.code = code;
  user.name = name;
  user.email = email || undefined;
  user.username = email || mobileNumber;
  user.role = role;
  user.userType = role;
  user.company = company._id;
  (user as any).mobileNumber = mobileNumber || undefined;
  user.city = normalizeText(payload?.city || user.city);
  user.state = normalizeText(payload?.state || user.state);
  user.designation = designation;
  user.joiningDate = normalizeDateValue(payload?.joiningDate) || user.joiningDate;
  if (payloadIncludesDateOfBirth) {
    user.dateOfBirth = parsedDateOfBirth || undefined;
  }
  if (payloadIncludesGender) {
    user.gender = normalizedGender;
  }
  user.title = normalizeText(payload?.title || user.title);
  user.department = resolvedDepartment;
  user.updatedAt = new Date();
  user.managers = await resolveManagers(managersInput, String(user._id), company._id);
  if (!user.profileId) {
    user.profileId = await generateUniqueProfileId(company.company_name || "USER");
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

  user.is_active = calculateUserActiveState(user);
  await user.save();

  const profileDetails = await syncManagedUserProfileDetails(user, company);
  if (profileDetails && String(user.profile_details || "") !== String(profileDetails._id || "")) {
    user.profile_details = profileDetails._id;
    await user.save();
  }

  await syncDependentUsersForManagerEmail(email || mobileNumber);

  const populatedUser = await User.findById(user._id)
      .populate("company", "company_name managerLevels")
      .populate("createdBy", "name email username role")
      .populate("managers.managerId", "name email username role");

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

async function ensureManagerHierarchyUsers({
  payload,
  actor,
}: {
  payload: any;
  actor: { role: string; companyId?: string; userId?: string; department?: string };
}) {
  const managersInput = parseManagersPayload(payload?.managers)
    .filter((manager) => manager.managerEmail)
    .sort((a, b) => b.level - a.level);

  for (const manager of managersInput) {
    const existingManager = await findUserByPhone(manager.managerEmail);
    if (existingManager) {
      continue;
    }

    const higherManagers = managersInput
      .filter(
        (candidate) =>
          candidate.level > manager.level &&
          candidate.managerEmail &&
          candidate.managerEmail !== manager.managerEmail
      )
      .map((candidate) => ({
        level: candidate.level,
        managerEmail: candidate.managerEmail,
      }));

    await saveManagedUser({
      payload: {
        code: await generateUniqueUserCode(),
        name: manager.managerName || deriveNameFromEmail(manager.managerEmail),
        email: manager.managerEmail,
        mobileNumber: manager.managerEmail,
        role: `l${manager.level}-manager`,
        companyId: payload?.companyId,
        companyName: payload?.companyName,
        companyManagerLevels: payload?.companyManagerLevels,
        city: payload?.city,
        state: payload?.state,
        department: actor.role === "departmenthead" ? actor.department : payload?.department,
        managers: higherManagers,
      },
      actor,
      sendSetupEmail: true,
    });
  }
}

function getRequesterContext(req: any) {
  const role = normalizeRole(req?.user?.role || req?.bodyData?.role || req?.user?.userType);
  return {
    role,
    userId: req?.userId ? String(req.userId) : undefined,
    companyId: req?.user?.company ? String(req.user.company) : undefined,
    department: normalizeText(req?.user?.department),
    permissions: req?.user?.permissions || req?.bodyData?.permissions || {},
    permissionOverrides: req?.user?.permissionOverrides || req?.bodyData?.permissionOverrides || {},
    effectivePermissions: req?.user?.effectivePermissions || req?.bodyData?.effectivePermissions || {},
  };
}

function assertAdminAccess(req: any) {
  const requester = getRequesterContext(req);
  if (!["admin", "superadmin", "departmenthead"].includes(requester.role)) {
    throw generateError("Only admin, superadmin, or department head can manage users", 403);
  }

  if (requester.role === "departmenthead" && !requester.department) {
    throw generateError("Department head is missing department access", 403);
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

async function parseBulkWorkbook(
  fileBuffer: Buffer,
  options: {
    companyId?: string;
    companyName?: string;
    companyManagerLevels?: number;
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

  const employeeCodeColumn = resolveHeader("employee code", "code");
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
  const cityColumn = resolveHeader("city");
  const stateColumn = resolveHeader("state");
  const designationColumn = resolveHeader("designation");
  const joiningDateColumn = resolveHeader("joining date", "date of joining");
  const roleColumn = resolveHeader("role");
  const companyColumn = resolveHeader("company");
  const passwordColumn = resolveHeader("password");
  const managerColumnMap = new Map<number, { level: number; columnNumber: number }>();
  headers.forEach((header: string, index: number) => {
      const match = header.match(/^l\s*(\d+)\s*manager\s*phone\s*number(\s*\(name\))?$/i);
      if (!match) {
        return;
      }

      const level = Number(match[1]);
      if (!managerColumnMap.has(level)) {
        managerColumnMap.set(level, {
          level,
          columnNumber: index + 1,
        });
      }
    });
  const managerColumns = Array.from(managerColumnMap.values()).sort((a, b) => a.level - b.level);

  const fileManagerLevels =
    managerColumns.reduce((max: number, managerColumn: any) => Math.max(max, managerColumn.level), 0) || 0;
  const explicitUploadRole = normalizeRole(options.uploadRole);
  const requestedUploadRole =
    explicitUploadRole && !["admin", "superadmin", "departmenthead"].includes(explicitUploadRole)
      ? explicitUploadRole
      : "";
  const companyManagerLevels = Math.max(1, Number(options.companyManagerLevels) || fileManagerLevels || 3);
  const importHierarchyLevels = Math.max(1, fileManagerLevels || companyManagerLevels || 3);
  const expectedManagerLevels = requestedUploadRole
    ? getExpectedManagerLevelsForRole(requestedUploadRole, companyManagerLevels)
    : [];
  const expectedManagerLevelSet = new Set(expectedManagerLevels);

  const requiredHeaders = [
    { label: "Employee Code", column: employeeCodeColumn },
    { label: "Employee Name", column: nameColumn },
    { label: "Phone Number", column: mobileNumberColumn },
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
  const seenCodes = new Set<string>();

  if (explicitUploadRole && !requestedUploadRole) {
    throw generateError("Bulk upload only supports manager and employee/user roles", 400);
  }

  if (requestedUploadRole) {
    const unexpectedManagerHeaders = managerColumns.filter(
      (managerColumn: any) => !expectedManagerLevelSet.has(managerColumn.level)
    );
    if (unexpectedManagerHeaders.length > 0) {
      throw generateError(
        `Unexpected manager column(s) for ${getBulkUploadTypeLabel(requestedUploadRole, companyManagerLevels)}: ${unexpectedManagerHeaders
          .map((managerColumn: any) => getManagerHeaderLabel(managerColumn.level))
          .join(", ")}`,
        400
      );
    }
  }

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const readCell = (columnNumber: number) =>
      columnNumber ? getCellValue(row.getCell(columnNumber)) : "";

    const employeeCode = normalizeText(readCell(employeeCodeColumn));
    const name = normalizeText(readCell(nameColumn));
    const email = normalizeEmail(readCell(emailColumn));
    const mobileNumber = normalizeText(readCell(mobileNumberColumn));
    const department = normalizeText(readCell(departmentColumn));
    const city = normalizeText(readCell(cityColumn));
    const state = normalizeText(readCell(stateColumn));
    const designation = normalizeText(readCell(designationColumn));
    const joiningDate = normalizeDateValue(readCell(joiningDateColumn));
    const rawRole = normalizeText(readCell(roleColumn));
    const companyName = normalizeText(readCell(companyColumn)) || normalizeText(options.companyName);
    const password = normalizeText(readCell(passwordColumn));

    const managers = dedupeManagers(
      managerColumns.map((managerColumn: any) => ({
        level: managerColumn.level,
        managerEmail: normalizePhoneNumber(getCellValue(row.getCell(managerColumn.columnNumber))),
      }))
    );
    const role = requestedUploadRole
      ? requestedUploadRole
      : rawRole
        ? normalizeRole(rawRole)
        : inferRoleFromManagers(managers, importHierarchyLevels);

    const hasRowValues =
      Boolean(employeeCode) ||
      Boolean(name) ||
      Boolean(email) ||
      Boolean(mobileNumber) ||
      Boolean(department) ||
      Boolean(city) ||
      Boolean(state) ||
      Boolean(designation) ||
      Boolean(joiningDate) ||
      Boolean(rawRole) ||
      Boolean(companyName) ||
      managers.length > 0;

    if (!hasRowValues) {
      continue;
    }

    const errors: string[] = [];
    if (!name) {
      errors.push("Name is required");
    }
    if (!employeeCode) {
      errors.push("Employee code is required");
    }
    if (!mobileNumber) {
      errors.push("Phone number is required");
    }
    if (mobileNumber && !isValidPhoneNumber(mobileNumber)) {
      errors.push("Phone number is invalid");
    }
    if (email && !isValidEmail(email)) {
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
    if (employeeCode && seenCodes.has(employeeCode.toLowerCase())) {
      errors.push("Duplicate employee code in file");
    }
    if (managers.some((manager: any) => normalizePhoneNumber(manager.managerEmail) === mobileNumber)) {
      errors.push("A user cannot be their own manager");
    }
    if (parseManagerRoleLevel(role) && Number(parseManagerRoleLevel(role)) > companyManagerLevels) {
      errors.push("Role exceeds the configured company manager levels");
    }
    if (managers.some((manager: any) => manager.level > companyManagerLevels)) {
      errors.push("Manager column exceeds the configured company manager levels");
    }

    if (mobileNumber) {
      seenPhones.add(mobileNumber);
    }
    if (employeeCode) {
      seenCodes.add(employeeCode.toLowerCase());
    }

    rows.push({
      rowNumber,
      payload: {
        code: employeeCode,
        name,
        email,
        mobileNumber,
        department,
        city,
        state,
        designation,
        joiningDate,
        role,
        companyId: options.companyId,
        companyName,
        companyManagerLevels,
        managers,
        password,
        uploadRole: role,
      },
      errors,
    });
  }

  return rows;
}

async function validateBulkRow(row: any) {
  const existingEmailUser = row.payload.email ? await findUserByEmail(row.payload.email) : null;
  const existingPhoneUser = row.payload.mobileNumber ? await findUserByPhone(row.payload.mobileNumber) : null;
  const existingCodeUser = row.payload.code ? await findUserByCode(row.payload.code) : null;
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
  const resolvedManagers = [];
  const rowManagers = Array.isArray(row.payload.managers) ? row.payload.managers : [];
  const assignedManagersByLevel = new Map<number, any>();

  if (row.payload.department && existingCompany) {
    const companyDepartments = Array.isArray(existingCompany.departments) ? existingCompany.departments : [];
    if (!companyDepartments.includes(row.payload.department)) {
      errors.push(`Department "${row.payload.department}" does not exist for this company`);
    }
  }

  const duplicateValidation = buildDuplicateUserErrors({
    email: row.payload.email,
    mobileNumber: row.payload.mobileNumber,
    code: row.payload.code,
    existingEmailUser,
    existingPhoneUser,
    existingCodeUser,
  });
  errors.push(...duplicateValidation.errors);

  for (const managerInput of rowManagers) {
    const managerEmail = normalizePhoneNumber(managerInput?.managerEmail);
    const expectedRole = `l${Number(managerInput?.level)}-manager`;
    const matchedManager = managerEmail ? await findUserByPhone(managerEmail) : null;
    let managerStatus: string = "PENDING";

    if (!matchedManager) {
      managerStatus = "NOT_FOUND";
      errors.push(`${getManagerHeaderLabel(Number(managerInput?.level))} not found: ${managerEmail}`);
    } else if (
      existingCompany &&
      String(matchedManager.company || "") !== String(existingCompany._id)
    ) {
      managerStatus = "WRONG_COMPANY";
      errors.push(`${getManagerHeaderLabel(Number(managerInput?.level))} not found in the selected company: ${managerEmail}`);
    } else if (normalizeRole(matchedManager.role || matchedManager.userType) !== expectedRole) {
      managerStatus = "INVALID_ROLE";
      errors.push(`${managerEmail} is not an ${expectedRole.toUpperCase()} user`);
    } else {
      managerStatus = "ASSIGNED";
      assignedManagersByLevel.set(Number(managerInput.level), matchedManager);
    }

    resolvedManagers.push({
      level: Number(managerInput.level),
      managerEmail,
      status: managerStatus,
    });
  }

  for (const managerInput of rowManagers) {
    const managerLevel = Number(managerInput.level);
    const currentManager = assignedManagersByLevel.get(managerLevel);
    if (!currentManager) {
      continue;
    }

    const configuredManagers = Array.isArray(currentManager.managers) ? currentManager.managers : [];
    const higherManagers = rowManagers.filter((candidate: any) => Number(candidate.level) > managerLevel);
    for (const higherManager of higherManagers) {
      const hasMatchingHierarchy = configuredManagers.some(
        (configuredManager: any) =>
          Number(configuredManager?.level) === Number(higherManager.level) &&
          normalizePhoneNumber(configuredManager?.managerEmail) === normalizePhoneNumber(higherManager.managerEmail)
      );

      if (!hasMatchingHierarchy) {
        errors.push(
          `${getManagerHeaderLabel(managerLevel)} ${normalizePhoneNumber(managerInput.managerEmail)} is not linked to ${getManagerHeaderLabel(
            Number(higherManager.level)
          )} ${normalizePhoneNumber(higherManager.managerEmail)}`
        );
      }
    }
  }

  return {
    existingEmailUser,
    existingPhoneUser,
    existingCodeUser,
    existingCompany,
    resolvedManagers,
    errors,
    skipReason: duplicateValidation.skipReason,
  };
}

async function buildBulkPreview(rows: any[]) {
  const previewRows = [];

  for (const row of rows) {
    const validation = await validateBulkRow(row);

    previewRows.push({
      rowNumber: row.rowNumber,
      name: row.payload.name,
      mobileNumber: row.payload.mobileNumber,
      email: row.payload.email,
      code: row.payload.code,
      department: row.payload.department,
      city: row.payload.city,
      state: row.payload.state,
      role: row.payload.role,
      company: row.payload.companyName || validation.existingCompany?.company_name || "",
      companyStatus: validation.existingCompany ? "EXISTS" : "WILL_CREATE",
      action: validation.existingEmailUser || validation.existingPhoneUser || validation.existingCodeUser ? "SKIP" : "CREATE",
      skipReason: validation.skipReason,
      managers: validation.resolvedManagers.map((manager: any) => ({
        level: manager.level,
        managerEmail: manager.managerEmail,
        status: manager.status,
      })),
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

    const accessibleCompanyMatch: any = {
      deletedAt: { $exists: false },
      type: { $ne: "user" },
    };

    if (companyId) {
      accessibleCompanyMatch._id = new mongoose.Types.ObjectId(companyId);
    }

    const accessibleCompanies = await Company.find(accessibleCompanyMatch)
      .select("_id company_name managerLevels rolePermissions")
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
      baseClauses.push({ role: { $nin: ["admin", "superadmin", "departmenthead"] } });
    } else if (requester.role === "admin") {
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
          ["admin", "superadmin", "departmenthead"].includes(requestedRole)
            ? "__no_matching_role__"
            : buildRoleMatch(requestedRole),
      });
    } else if (requester.role === "admin" && requestedRole) {
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
          { email: { $regex: searchRegex } },
          { username: { $regex: searchRegex } },
          { role: { $regex: searchRegex } },
        ],
      });
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
          .populate("company", "company_name managerLevels rolePermissions")
          .populate("createdBy", "name email username role")
          .populate("managers.managerId", "name email username role")
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
    const requestedLevels = Math.max(1, Number(req.query.companyManagerLevels) || 0);
    const uploadRole = normalizeRole(req.query.uploadRole);

    if (!uploadRole || ["admin", "superadmin", "departmenthead"].includes(uploadRole)) {
      throw generateError("A valid upload role is required", 400);
    }

    let companyManagerLevels = requestedLevels;
    if (!companyManagerLevels && requestedCompanyId && mongoose.Types.ObjectId.isValid(requestedCompanyId)) {
      const company = await Company.findOne({
        _id: new mongoose.Types.ObjectId(requestedCompanyId),
        deletedAt: { $exists: false },
      });
      companyManagerLevels = getCompanyManagerLevels(company);
    }

    companyManagerLevels = Math.max(1, companyManagerLevels || parseManagerRoleLevel(uploadRole) || 3);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Template");
    const headers = buildTemplateHeaders(uploadRole, companyManagerLevels);
    const rows = buildTemplateRows(uploadRole, companyManagerLevels);

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
        code: normalizeText(req.body?.code) || await generateUniqueUserCode(),
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

export async function deleteManagedUserHandler(req: Request, res: Response) {
  try {
    const requester = assertAdminAccess(req);
    ensurePermission(requester, PERMISSION_KEYS.EDIT_USERS, "You do not have permission to delete users");
    const targetUser = await User.findById(req.params.id);

    if (!targetUser || targetUser.deletedAt) {
      throw generateError("User not found", 404);
    }

    const targetRole = normalizeRole(targetUser.role || targetUser.userType);
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

    if (requester.role !== "superadmin") {
      await ensureCompanyManagementAccess({
        actor: requester,
        requestedCompanyId: targetCompanyId,
        actionLabel: "manage users for this company",
      });
    }

    targetUser.deletedAt = new Date();
    targetUser.is_active = false;
    targetUser.is_enabled = false;
    targetUser.setupToken = undefined;
    targetUser.setupTokenExpiry = undefined;
    targetUser.updatedAt = new Date();
    await targetUser.save();

    await syncDependentUsersForManagerEmail(targetUser.email || targetUser.username || "");

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
      .populate("company", "company_name managerLevels rolePermissions")
      .populate("createdBy", "name email username role")
      .populate("managers.managerId", "name email username role");

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

    return res.status(200).json({
      success: true,
      message: nextStatus ? "User activated successfully" : "User deactivated successfully",
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
      throw generateError("Only admin and department head permissions can be configured", 400);
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
      .populate("company", "company_name managerLevels rolePermissions")
      .populate("createdBy", "name email username role")
      .populate("managers.managerId", "name email username role");

    if (!targetUser || targetUser.deletedAt) {
      throw generateError("User not found", 404);
    }

    if (normalizeRole(targetUser.role) === "superadmin") {
      throw generateError("Superadmin permissions cannot be overridden", 400);
    }

    const targetRole = normalizeRole(targetUser.role || targetUser.userType);
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
    const bulkCompanyManagerLevels = Number(req.body?.companyManagerLevels || req.body?.managerLevels) || 0;

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

    let resolvedBulkManagerLevels = bulkCompanyManagerLevels;
    if (!resolvedBulkManagerLevels && bulkCompanyId && mongoose.Types.ObjectId.isValid(bulkCompanyId)) {
      const selectedCompany = await Company.findOne({
        _id: new mongoose.Types.ObjectId(bulkCompanyId),
        deletedAt: { $exists: false },
      });
      resolvedBulkManagerLevels = getCompanyManagerLevels(selectedCompany);
    }

    const rows = await parseBulkWorkbook(req.file.buffer, {
      companyId: bulkCompanyId,
      companyName: bulkCompanyName,
      companyManagerLevels: resolvedBulkManagerLevels,
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
            email: row.payload.email,
            mobileNumber: row.payload.mobileNumber,
            code: row.payload.code,
            existingEmailUser: validation.existingEmailUser,
            existingPhoneUser: validation.existingPhoneUser,
            existingCodeUser: validation.existingCodeUser,
          });
          failedCount += 1;
          results.push({
            rowNumber: row.rowNumber,
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
          mobileNumber: row.payload.mobileNumber,
          success: true,
          action: "CREATE",
          user: serializeUser(result.user),
        });
      } catch (error: any) {
        failedCount += 1;
        results.push({
          rowNumber: row.rowNumber,
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
  user.is_active = calculateUserActiveState(user);
  await user.save();

  const populatedUser = await User.findById(user._id)
      .populate("company", "company_name managerLevels rolePermissions")
      .populate("createdBy", "name email username role")
      .populate("managers.managerId", "name email username role");

  return serializeUser(populatedUser);
}
