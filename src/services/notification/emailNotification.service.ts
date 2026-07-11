import { Request, Response } from "express";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import NotificationSchema from "../../schemas/Notification/notification.schema";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import BatchEnrollment from "../../schemas/course/BatchEnrollment";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import CourseQuizAttempt from "../../schemas/course/CourseQuizAttempt";

type RecipientMode = "all" | "selected";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UPCOMING_WINDOW_DAYS = 14;

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function normalizeLower(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function normalizeEnvValue(value: unknown) {
  return String(value || "").trim();
}

function getNotificationEmailConfig() {
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
    "LMS Team";
  const logoUrl =
    normalizeEnvValue(process.env.COMPANY_LOGO_URL) ||
    normalizeEnvValue(process.env.SMTP_FROM_LOGO_URL) ||
    normalizeEnvValue(process.env.APP_LOGO_URL);

  return {
    host,
    port,
    user,
    pass,
    fromAddress,
    fromName,
    logoUrl,
  };
}

function buildNotificationEmailTransport() {
  const config = getNotificationEmailConfig();

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

function formatNotificationMailError(error: any) {
  const config = getNotificationEmailConfig();
  const isAuthFailure =
    error?.code === "EAUTH" ||
    /authentication failed|invalid login|535/i.test(error?.message || "") ||
    /535/i.test(error?.response || "");
  const isSenderFailure =
    /sender/i.test(error?.message || "") ||
    /sender/i.test(error?.response || "");

  if (isAuthFailure) {
    return `SMTP authentication failed for ${config.host}. Check SMTP_USER and SMTP_PASS in the backend environment.`;
  }

  if (isSenderFailure) {
    return "SMTP login succeeded, but the sender address was rejected. Set SMTP_FROM to a verified sender email address.";
  }

  return error?.message || "Failed to send notification email";
}

function validateNotificationEmailConfig() {
  const config = getNotificationEmailConfig();

  if (!config.host || !config.port || !config.user || !config.pass) {
    return "SMTP configuration is incomplete. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.";
  }

  if (!config.fromAddress) {
    return "SMTP sender is missing. Please set SMTP_FROM to a verified sender email address.";
  }

  return "";
}

function normalizeArray(value: unknown) {
  if (!value) {
    return [];
  }

  return (Array.isArray(value) ? value : [value])
    .map((entry) => normalizeLower(entry))
    .filter(Boolean);
}

function getRequester(req: any) {
  return {
    userId: req?.userId ? String(req.userId) : "",
    role: normalizeLower(req?.user?.role || req?.bodyData?.role || req?.user?.userType),
  };
}

function assertSuperAdmin(req: any) {
  const requester = getRequester(req);
  if (requester.role !== "superadmin") {
    const error: any = new Error("Only superadmin can send company notifications");
    error.statusCode = 403;
    throw error;
  }
  return requester;
}

function escapeHtml(value: unknown) {
  return normalizeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidUrl(value: unknown) {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  try {
    const parsed = new URL(text);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function renderPlaceholders(template: string, context: Record<string, string>) {
  return normalizeText(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    return context[key] ?? "";
  });
}

function buildNotificationEmailHtml({
  company,
  user,
  subject,
  message,
  ctaText,
  ctaUrl,
  priority,
}: {
  company: any;
  user: any;
  subject: string;
  message: string;
  ctaText?: string;
  ctaUrl?: string;
  priority?: string;
}) {
  const config = getNotificationEmailConfig();
  const companyName = company?.company_name || "LMS";
  const brandName = config.fromName || "LMS Team";
  const brandLogoUrl = config.logoUrl;
  const brandColor = "#334155";
  const buttonColor = "#475569";
  const safeCtaUrl = isValidUrl(ctaUrl) ? normalizeText(ctaUrl) : "";
  const userName = user?.name || user?.email || user?.username || "there";
  const context = {
    user_name: userName,
    company_name: companyName,
    course_name: "your course",
    batch_name: "your batch",
    due_date: "the due date",
  };
  const renderedMessage = renderPlaceholders(message, context)
    .split(/\r?\n/)
    .map((line) => escapeHtml(line))
    .join("<br />");

  return `
  <div style="margin:0;padding:0;background:#f6f8fb;font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f8fb;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 14px 40px rgba(15,23,42,0.08);border:1px solid #e5eaf1;">
            <tr>
              <td style="padding:0;background:#f8fafc;border-bottom:1px solid #e5eaf1;">
                <div style="padding:28px 34px;">
                  ${
                    brandLogoUrl
                      ? `<img src="${escapeHtml(brandLogoUrl)}" alt="${escapeHtml(brandName)}" style="max-height:44px;max-width:180px;object-fit:contain;margin-bottom:18px;" />`
                      : `<div style="display:inline-block;background:#ffffff;border:1px solid #dbe3ee;color:${brandColor};border-radius:12px;padding:9px 13px;font-weight:800;margin-bottom:18px;">${escapeHtml(brandName)}</div>`
                  }
                  <div style="font-size:12px;text-transform:uppercase;letter-spacing:1.4px;color:#64748b;font-weight:800;">${escapeHtml(priority || "normal")} notification</div>
                  <h1 style="margin:8px 0 0;color:#0f172a;font-size:26px;line-height:1.22;font-weight:800;">${escapeHtml(subject)}</h1>
                  <p style="margin:10px 0 0;color:#64748b;font-size:14px;line-height:1.6;">For ${escapeHtml(companyName)}</p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:34px;">
                <p style="margin:0 0 16px;font-size:16px;line-height:1.7;">Hi ${escapeHtml(userName)},</p>
                <p style="margin:0;color:#334155;font-size:16px;line-height:1.75;">${renderedMessage}</p>
                ${
                  safeCtaUrl && normalizeText(ctaText)
                    ? `<div style="margin-top:28px;"><a href="${escapeHtml(safeCtaUrl)}" style="display:inline-block;background:${buttonColor};color:#ffffff;text-decoration:none;font-weight:800;border-radius:12px;padding:13px 22px;">${escapeHtml(ctaText)}</a></div>`
                    : ""
                }
                <p style="margin:32px 0 0;color:#475569;font-size:15px;line-height:1.7;">Regards,<br /><strong>${escapeHtml(companyName)} Team</strong></p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 34px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.6;">
                Sent by ${escapeHtml(brandName)} for ${escapeHtml(companyName)}. You are receiving this email because you are part of ${escapeHtml(companyName)}.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>`;
}

function getUpcomingDateThreshold() {
  const date = new Date();
  date.setDate(date.getDate() + UPCOMING_WINDOW_DAYS);
  return date;
}

async function buildUserSignals(users: any[]) {
  const userIds = users.map((user) => user._id);
  const now = new Date();
  const upcomingDate = getUpcomingDateThreshold();

  const [courseEnrollments, quizAttempts, batchEnrollments] = await Promise.all([
    CourseEnrollment.find({ userId: { $in: userIds } })
      .populate("courseId", "title status")
      .lean(),
    CourseQuizAttempt.find({ userId: { $in: userIds } }).lean(),
    BatchEnrollment.find({ userId: { $in: userIds } })
      .populate("batchId", "name endDate")
      .lean(),
  ]);

  const courseMap = new Map<string, any[]>();
  const quizMap = new Map<string, any[]>();
  const batchMap = new Map<string, any[]>();

  courseEnrollments.forEach((enrollment: any) => {
    const key = String(enrollment.userId);
    courseMap.set(key, [...(courseMap.get(key) || []), enrollment]);
  });

  quizAttempts.forEach((attempt: any) => {
    const key = String(attempt.userId);
    quizMap.set(key, [...(quizMap.get(key) || []), attempt]);
  });

  batchEnrollments.forEach((enrollment: any) => {
    const key = String(enrollment.userId);
    batchMap.set(key, [...(batchMap.get(key) || []), enrollment]);
  });

  return users.map((user) => {
    const key = String(user._id);
    const enrollments = courseMap.get(key) || [];
    const attempts = quizMap.get(key) || [];
    const batches = batchMap.get(key) || [];
    const pendingCourses = enrollments.filter((entry: any) => entry.status !== "completed");
    const completedCourses = enrollments.filter((entry: any) => entry.status === "completed");
    const inProgressCourses = enrollments.filter((entry: any) => entry.status === "in_progress");
    const notStartedCourses = enrollments.filter((entry: any) => entry.status === "not_started");
    const overdueCourses = pendingCourses.filter((entry: any) => {
      const dueDate = entry.dueDate || entry.validTill;
      return dueDate && new Date(dueDate) < now;
    });
    const expiringCourses = pendingCourses.filter((entry: any) => {
      const dueDate = entry.validTill || entry.dueDate;
      return dueDate && new Date(dueDate) >= now && new Date(dueDate) <= upcomingDate;
    });
    const endingBatches = batches.filter((entry: any) => {
      const endDate = entry?.batchId?.endDate;
      return entry.status === "active" && endDate && new Date(endDate) >= now && new Date(endDate) <= upcomingDate;
    });

    const courseStatus =
      enrollments.length === 0
        ? "none"
        : completedCourses.length === enrollments.length
          ? "completed"
          : inProgressCourses.length > 0
            ? "in_progress"
            : "pending";
    const quizStatus =
      attempts.length === 0
        ? "not_attempted"
        : attempts.some((attempt: any) => Number(attempt.percentage || 0) < 70)
          ? "needs_attention"
          : "completed";

    return {
      ...user,
      notificationSignals: {
        assignedCourses: enrollments.length,
        pendingCourses: pendingCourses.length,
        completedCourses: completedCourses.length,
        inProgressCourses: inProgressCourses.length,
        notStartedCourses: notStartedCourses.length,
        overdueCourses: overdueCourses.length,
        expiringCourses: expiringCourses.length,
        batchEndingSoon: endingBatches.length > 0,
        batchEndingSoonCount: endingBatches.length,
        quizAttempts: attempts.length,
        courseStatus,
        quizStatus,
      },
    };
  });
}

function serializeNotificationUser(user: any) {
  const lifecycleStatus = user?.is_enabled === false ? "inactive" : user?.is_active ? "active" : "pending";
  const managers = Array.isArray(user?.managers)
    ? user.managers.map((manager: any) => ({
        level: manager?.level,
        managerEmail: manager?.managerEmail,
        managerName: manager?.managerId?.name || "",
        managerId: manager?.managerId?._id || manager?.managerId || null,
        status: manager?.status || "PENDING",
      }))
    : [];

  return {
    _id: user._id,
    name: user.name || user.email || user.username || "Unnamed user",
    email: user.email || user.username || "",
    role: user.role || user.userType || "user",
    department: user.department || "",
    designation: user.designation || "",
    isActive: lifecycleStatus === "active",
    status: lifecycleStatus,
    managers,
    notificationSignals: user.notificationSignals,
  };
}

function applyNotificationFilters(users: any[], filters: any = {}) {
  const roles = normalizeArray(filters.role);
  const departments = normalizeArray(filters.department);
  const managers = normalizeArray(filters.manager);
  const statuses = normalizeArray(filters.status);
  const courseStatuses = normalizeArray(filters.courseStatus);
  const quizStatuses = normalizeArray(filters.quizStatus);

  return users.filter((user) => {
    const serialized = serializeNotificationUser(user);
    const signals = serialized.notificationSignals || {};

    if (roles.length && !roles.includes(normalizeLower(serialized.role))) {
      return false;
    }

    if (departments.length && !departments.includes(normalizeLower(serialized.department))) {
      return false;
    }

    if (statuses.length && !statuses.includes(normalizeLower(serialized.status))) {
      return false;
    }

    if (courseStatuses.length && !courseStatuses.includes(normalizeLower(signals.courseStatus))) {
      return false;
    }

    if (quizStatuses.length && !quizStatuses.includes(normalizeLower(signals.quizStatus))) {
      return false;
    }

    if (managers.length) {
      const managerValues = (serialized.managers || []).flatMap((manager: any) => [
        normalizeLower(manager.managerEmail),
        normalizeLower(manager.managerName),
        normalizeLower(manager.managerId),
      ]);
      if (!managers.some((manager) => managerValues.includes(manager))) {
        return false;
      }
    }

    if (filters.pendingCourses && Number(signals.pendingCourses || 0) === 0) {
      return false;
    }

    if (filters.completedCourses && Number(signals.completedCourses || 0) === 0) {
      return false;
    }

    if (filters.courseExpiringSoon && Number(signals.expiringCourses || 0) === 0) {
      return false;
    }

    if (filters.batchEndingSoon && !signals.batchEndingSoon) {
      return false;
    }

    if (filters.overdueCourses && Number(signals.overdueCourses || 0) === 0) {
      return false;
    }

    if (filters.notStarted && Number(signals.notStartedCourses || 0) === 0) {
      return false;
    }

    if (filters.inProgress && Number(signals.inProgressCourses || 0) === 0) {
      return false;
    }

    return true;
  });
}

async function loadCompanyNotificationUsers(companyId: string) {
  const users = await User.find({
    company: new mongoose.Types.ObjectId(companyId),
    deletedAt: { $exists: false },
  })
    .populate("managers.managerId", "name email username role")
    .sort({ name: 1, email: 1 })
    .lean();

  return buildUserSignals(users);
}

export async function listCompanyNotificationUsers(req: Request, res: Response) {
  try {
    assertSuperAdmin(req);
    const companyId = normalizeText(req.query.companyId);
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      return res.status(400).json({ success: false, error: "Valid company id is required" });
    }

    const company = await Company.findOne({
      _id: new mongoose.Types.ObjectId(companyId),
      deletedAt: { $exists: false },
    }).lean();

    if (!company) {
      return res.status(404).json({ success: false, error: "Company not found" });
    }

    const users = await loadCompanyNotificationUsers(companyId);
    const serializedUsers = users.map(serializeNotificationUser);
    const departments = Array.from(new Set(serializedUsers.map((user) => user.department).filter(Boolean))).sort();
    const roles = Array.from(new Set(serializedUsers.map((user) => user.role).filter(Boolean))).sort();
    const managers = Array.from(
      new Map(
        serializedUsers
          .flatMap((user) => user.managers || [])
          .filter((manager: any) => manager.managerEmail)
          .map((manager: any) => [
            String(manager.managerEmail).toLowerCase(),
            {
              label: manager.managerName || manager.managerEmail,
              value: manager.managerEmail,
            },
          ])
      ).values()
    );

    return res.status(200).json({
      success: true,
      data: {
        company: {
          _id: company._id,
          company_name: company.company_name,
          logo: company.logo || null,
          primaryThemeColor: company.primaryThemeColor || "#2563EB",
          is_active: company.is_active,
        },
        users: serializedUsers,
        filters: {
          roles,
          departments,
          managers,
        },
      },
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to load notification users",
    });
  }
}

export async function sendCompanyNotification(req: Request, res: Response) {
  try {
    const requester = assertSuperAdmin(req);
    const {
      companyId,
      recipientMode = "selected",
      userIds = [],
      filters = {},
      notificationType,
      subject,
      message,
      ctaText,
      ctaUrl,
      priority,
    } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      return res.status(400).json({ success: false, error: "Valid company id is required" });
    }

    if (!normalizeText(subject)) {
      return res.status(400).json({ success: false, error: "Subject is required" });
    }

    if (!normalizeText(message)) {
      return res.status(400).json({ success: false, error: "Message is required" });
    }

    if (normalizeText(ctaUrl) && !isValidUrl(ctaUrl)) {
      return res.status(400).json({ success: false, error: "CTA URL must be a valid http or https URL" });
    }

    const mode: RecipientMode = recipientMode === "all" ? "all" : "selected";
    const company = await Company.findOne({
      _id: new mongoose.Types.ObjectId(companyId),
      deletedAt: { $exists: false },
    }).lean();

    if (!company) {
      return res.status(404).json({ success: false, error: "Company not found" });
    }

    let candidates = await loadCompanyNotificationUsers(companyId);

    if (mode === "selected") {
      const selectedIds = normalizeArray(userIds).filter((id) => mongoose.Types.ObjectId.isValid(id));
      if (!selectedIds.length) {
        return res.status(400).json({ success: false, error: "Select at least one recipient" });
      }
      const selectedSet = new Set(selectedIds);
      candidates = candidates.filter((user) => selectedSet.has(String(user._id)));
    } else {
      candidates = applyNotificationFilters(candidates, filters);
    }

    const uniqueByEmail = new Map<string, any>();
    candidates.forEach((user) => {
      const email = normalizeLower(user.email || user.username);
      if (EMAIL_PATTERN.test(email) && !uniqueByEmail.has(email)) {
        uniqueByEmail.set(email, user);
      }
    });

    const recipients = Array.from(uniqueByEmail.values());
    if (!recipients.length) {
      return res.status(400).json({ success: false, error: "No recipients with valid email addresses were found" });
    }

    const configError = validateNotificationEmailConfig();
    if (configError) {
      return res.status(500).json({ success: false, error: configError });
    }

    const mailConfig = getNotificationEmailConfig();
    const transporter = buildNotificationEmailTransport();

    try {
      await transporter.verify();
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: formatNotificationMailError(error),
      });
    }

    let sentCount = 0;
    let failedCount = 0;
    const failedRecipients: Array<{ email: string; error: string }> = [];

    for (const recipient of recipients) {
      const html = buildNotificationEmailHtml({
        company,
        user: recipient,
        subject,
        message,
        ctaText,
        ctaUrl,
        priority,
      });
      const recipientEmail = recipient.email || recipient.username;

      try {
        await transporter.sendMail({
          from: `"${mailConfig.fromName}" <${mailConfig.fromAddress}>`,
          to: recipientEmail,
          subject,
          html,
        });
        sentCount += 1;
      } catch (error: any) {
        failedCount += 1;
        failedRecipients.push({
          email: recipientEmail,
          error: formatNotificationMailError(error),
        });
      }
    }

    await NotificationSchema.create({
      username: "superadmin",
      company: company._id,
      message: normalizeText(message),
      type: "email_notification_log",
      priority:
        normalizeLower(priority) === "urgent"
          ? "critical"
          : normalizeLower(priority) === "important"
            ? "high"
            : "medium",
      metadata: {
        sender: requester.userId,
        notificationType,
        subject,
        recipientMode: mode,
        requestedRecipientCount: candidates.length,
        recipientCount: recipients.length,
        sentCount,
        failedCount,
        failedRecipients: failedRecipients.slice(0, 20),
        filters,
      },
    });

    return res.status(200).json({
      success: true,
      message:
        failedCount > 0
          ? "Notification sent with some delivery failures"
          : "Notification sent successfully",
      data: {
        recipientCount: recipients.length,
        sentCount,
        failedCount,
        failedRecipients: failedRecipients.slice(0, 5),
      },
      sentCount,
      failedCount,
    });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || "Failed to send notification",
    });
  }
}
