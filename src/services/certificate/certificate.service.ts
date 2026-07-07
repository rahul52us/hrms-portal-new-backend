import axios from "axios";
import { randomBytes } from "crypto";
import { NextFunction, Response } from "express";
import fs from "fs";
import mongoose from "mongoose";
import path from "path";
import { PDFDocument, PDFFont, RGB, StandardFonts, rgb } from "pdf-lib";
import { generateError } from "../../config/Error/functions";
import CertificateTemplate from "../../schemas/course/CertificateTemplate";
import Course from "../../schemas/course/Course";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import IssuedCertificate from "../../schemas/course/IssuedCertificate";
import UserCourseProgress from "../../schemas/course/UserCourseProgress";
import User from "../../schemas/User/User";
import { buildCourseAssessmentSummary } from "../course/courseMetadata.helpers";
import { resolveEffectiveEnrollmentAssessment } from "../courseAccess/utils/enrollmentSources";
import { PERMISSION_KEYS, ensurePermission, hasAnyCourseManagementPermission } from "../permissions/permission.utils";
import { normalizeRole } from "../courseAccess/utils/accessControl";

type CertificateStatus = "disabled" | "not_eligible" | "eligible" | "issued";

type CertificateSnapshot = {
  enabled: boolean;
  status: CertificateStatus;
  canIssue: boolean;
  reason: string;
  certificateNo?: string;
  issuedAt?: Date | string | null;
  downloadUrl?: string;
  templateId?: string;
  templateName?: string;
};

type CertificateEligibilityContext = {
  userId: string;
  courseId: string;
  user?: any;
  course?: any;
  enrollment?: any;
  progressDoc?: any;
  assessmentSummary?: any;
};

type TemplateRenderValueMap = Record<string, string>;

type PositionedPlaceholder = {
  placeholder: string;
  className: string;
  top: number;
  left: number;
  width: number;
  fontSize: number;
  textAlign: "left" | "center" | "right";
  fontFamily: string;
  color: RGB;
};

const DEFAULT_PLACEHOLDERS = ["student_name", "course_name", "issued_on"];
const CERTIFICATE_PUBLIC_URL_BASE = "/public/uploads/certificates";
const DEFAULT_PAGE_WIDTH = 1123;
const DEFAULT_PAGE_HEIGHT = 794;

function stringifyId(value: any) {
  return value ? String(value) : "";
}

function toObjectId(value: string) {
  return new mongoose.Types.ObjectId(value);
}

function uniqueIds(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function formatIssueDate(value: Date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(value);
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeTemplatePlaceholders(html: string) {
  const matches = Array.from(html.matchAll(/%([a-zA-Z0-9_]+)%/g)).map((match) => match[1]);
  const placeholders = uniqueIds(matches.length ? matches : DEFAULT_PLACEHOLDERS);
  return placeholders.length ? placeholders : DEFAULT_PLACEHOLDERS;
}

function extractBackgroundAssetUrl(html: string) {
  const match = html.match(/background(?:-image)?\s*:\s*url\((["']?)(.*?)\1\)/i);
  return String(match?.[2] || "").trim();
}

function fillTemplateHtml(html: string, values: TemplateRenderValueMap) {
  return html.replace(/%([a-zA-Z0-9_]+)%/g, (_match, key) => escapeHtml(values[key] ?? ""));
}

function parseCssPercent(block: string, property: string, fallback: number) {
  const match = block.match(new RegExp(`${property}\\s*:\\s*([0-9.]+)%`, "i"));
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value / 100 : fallback;
}

function parseCssNumber(block: string, property: string, fallback: number) {
  const match = block.match(new RegExp(`${property}\\s*:\\s*([0-9.]+)px`, "i"));
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value : fallback;
}

function parseCssText(block: string, property: string, fallback = "") {
  const match = block.match(new RegExp(`${property}\\s*:\\s*([^;]+)`, "i"));
  return String(match?.[1] || fallback).replace(/["']/g, "").trim();
}

function parseCssColor(block: string) {
  const color = parseCssText(block, "color", "black").toLowerCase();
  if (color === "black") {
    return rgb(0, 0, 0);
  }
  if (color === "white") {
    return rgb(1, 1, 1);
  }

  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (!hex) {
    return rgb(0, 0, 0);
  }

  const raw = hex[1];
  return rgb(
    parseInt(raw.slice(0, 2), 16) / 255,
    parseInt(raw.slice(2, 4), 16) / 255,
    parseInt(raw.slice(4, 6), 16) / 255
  );
}

function parseClassStyleMap(html: string) {
  const styles = new Map<string, string>();
  const classStyleRegex = /\.([a-zA-Z0-9_-]+)\s*\{([\s\S]*?)\}/g;
  let match: RegExpExecArray | null;

  while ((match = classStyleRegex.exec(html))) {
    styles.set(match[1], match[2]);
  }

  return styles;
}

function parsePositionedPlaceholders(html: string) {
  const styles = parseClassStyleMap(html);
  const placeholderRegex = /<div[^>]*class=["']([^"']+)["'][^>]*>\s*%([a-zA-Z0-9_]+)%\s*<\/div>/gi;
  const placeholders: PositionedPlaceholder[] = [];
  let match: RegExpExecArray | null;

  while ((match = placeholderRegex.exec(html))) {
    const className = String(match[1] || "").split(/\s+/)[0];
    const block = styles.get(className) || "";
    const textAlignValue = parseCssText(block, "text-align", "left").toLowerCase();
    const textAlign = textAlignValue === "center" ? "center" : textAlignValue === "right" ? "right" : "left";

    placeholders.push({
      className,
      placeholder: match[2],
      top: parseCssPercent(block, "top", 0.5),
      left: parseCssPercent(block, "left", 0.1),
      width: parseCssPercent(block, "width", 0.8),
      fontSize: parseCssNumber(block, "font-size", 24),
      textAlign,
      fontFamily: parseCssText(block, "font-family", "helvetica").toLowerCase(),
      color: parseCssColor(block),
    });
  }

  if (placeholders.length) {
    return placeholders;
  }

  return DEFAULT_PLACEHOLDERS.map((placeholder, index) => ({
    placeholder,
    className: placeholder,
    top: 0.4 + index * 0.09,
    left: 0.1,
    width: 0.8,
    fontSize: placeholder === "student_name" ? 30 : 22,
    textAlign: "center" as const,
    fontFamily: "helvetica",
    color: rgb(0, 0, 0),
  }));
}

async function fetchBackgroundImage(url: string) {
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.warn(`[Certificates] Failed to fetch template background ${url}`, error);
    return null;
  }
}

async function embedBackgroundImage(pdfDoc: PDFDocument, url: string, bytes: Buffer | null) {
  if (!bytes) {
    return null;
  }

  const isPng = /\.png(?:\?|$)/i.test(url);
  try {
    return isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  } catch (firstError) {
    try {
      return isPng ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
    } catch (secondError) {
      console.warn("[Certificates] Failed to embed certificate background", firstError, secondError);
      return null;
    }
  }
}

async function resolveFont(pdfDoc: PDFDocument, fontFamily: string): Promise<PDFFont> {
  if (fontFamily.includes("times")) {
    return pdfDoc.embedFont(StandardFonts.TimesRoman);
  }

  return pdfDoc.embedFont(StandardFonts.Helvetica);
}

function fitFontSize(font: PDFFont, text: string, requestedSize: number, maxWidth: number) {
  let fontSize = requestedSize;
  while (fontSize > 8 && font.widthOfTextAtSize(text, fontSize) > maxWidth) {
    fontSize -= 1;
  }
  return fontSize;
}

async function renderCertificatePdf(html: string, values: TemplateRenderValueMap) {
  const pdfDoc = await PDFDocument.create();
  const backgroundUrl = extractBackgroundAssetUrl(html);
  const backgroundBytes = await fetchBackgroundImage(backgroundUrl);
  const backgroundImage = await embedBackgroundImage(pdfDoc, backgroundUrl, backgroundBytes);
  const pageWidth = backgroundImage?.width || DEFAULT_PAGE_WIDTH;
  const pageHeight = backgroundImage?.height || DEFAULT_PAGE_HEIGHT;
  const page = pdfDoc.addPage([pageWidth, pageHeight]);

  if (backgroundImage) {
    page.drawImage(backgroundImage, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
    });
  }

  for (const item of parsePositionedPlaceholders(html)) {
    const text = String(values[item.placeholder] || "").trim();
    if (!text) {
      continue;
    }

    const font = await resolveFont(pdfDoc, item.fontFamily);
    const maxWidth = Math.max(20, pageWidth * item.width);
    const fontSize = fitFontSize(font, text, item.fontSize, maxWidth);
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    let x = pageWidth * item.left;

    if (item.textAlign === "center") {
      x += Math.max(0, (maxWidth - textWidth) / 2);
    } else if (item.textAlign === "right") {
      x += Math.max(0, maxWidth - textWidth);
    }

    page.drawText(text, {
      x,
      y: pageHeight - pageHeight * item.top - fontSize,
      size: fontSize,
      font,
      color: item.color,
    });
  }

  return Buffer.from(await pdfDoc.save());
}

function buildCertificateNumber() {
  return `CERT-${new Date().getFullYear()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function buildCertificateFilePaths(certificateNo: string) {
  const safeName = certificateNo.replace(/[^A-Z0-9-]/gi, "-");
  const fileName = `${safeName}.pdf`;
  const renderedPdfPath = path.join("public", "uploads", "certificates", fileName);
  const absolutePath = path.join(process.cwd(), renderedPdfPath);
  const renderedPdfUrl = `${CERTIFICATE_PUBLIC_URL_BASE}/${fileName}`;

  return { fileName, renderedPdfPath, absolutePath, renderedPdfUrl };
}

function serializeIssuedCertificate(certificate: any): CertificateSnapshot {
  return {
    enabled: true,
    status: "issued",
    canIssue: false,
    reason: "Certificate issued",
    certificateNo: certificate.certificateNo,
    issuedAt: certificate.issuedAt || null,
    downloadUrl: certificate.renderedPdfUrl || "",
    templateId: stringifyId(certificate.templateId),
  };
}

function serializeTemplate(template: any) {
  return {
    _id: stringifyId(template?._id),
    name: template?.name || "",
    companyId: template?.companyId ? stringifyId(template.companyId) : null,
    placeholders: Array.isArray(template?.placeholders) ? template.placeholders : DEFAULT_PLACEHOLDERS,
    backgroundAssetUrl: template?.backgroundAssetUrl || "",
    status: template?.status || "draft",
    version: Number(template?.version || 1),
    createdAt: template?.createdAt || null,
    updatedAt: template?.updatedAt || null,
  };
}

async function resolveCertificateTemplate(options: { course?: any; user?: any; companyId?: string | null }) {
  const courseTemplateId = stringifyId(options.course?.progression?.certificateTemplateId);
  if (courseTemplateId && mongoose.Types.ObjectId.isValid(courseTemplateId)) {
    const courseTemplate = await CertificateTemplate.findOne({
      _id: toObjectId(courseTemplateId),
      status: "active",
    }).lean();
    if (courseTemplate) {
      return courseTemplate;
    }
  }

  const companyIds = uniqueIds([
    options.companyId,
    stringifyId(options.user?.company),
    stringifyId(options.course?.company),
  ]).filter((companyId) => mongoose.Types.ObjectId.isValid(companyId));

  for (const companyId of companyIds) {
    const companyTemplate = await CertificateTemplate.findOne({
      companyId: toObjectId(companyId),
      status: "active",
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();
    if (companyTemplate) {
      return companyTemplate;
    }
  }

  return CertificateTemplate.findOne({
    $or: [{ companyId: null }, { companyId: { $exists: false } }],
    status: "active",
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
}

async function resolveEligibilityContext(options: CertificateEligibilityContext) {
  if (!mongoose.Types.ObjectId.isValid(options.userId) || !mongoose.Types.ObjectId.isValid(options.courseId)) {
    throw generateError("Invalid certificate request", 400);
  }

  const [user, course, enrollment, progressDoc, issuedCertificate] = await Promise.all([
    options.user || User.findById(options.userId).select("name email username company code").lean(),
    options.course || Course.findById(options.courseId).lean(),
    options.enrollment ||
      CourseEnrollment.findOne({
        userId: toObjectId(options.userId),
        courseId: toObjectId(options.courseId),
      }).lean(),
    options.progressDoc ||
      UserCourseProgress.findOne({
        userId: toObjectId(options.userId),
        courseId: toObjectId(options.courseId),
      }).lean(),
    IssuedCertificate.findOne({
      userId: toObjectId(options.userId),
      courseId: toObjectId(options.courseId),
      status: "issued",
    }).lean(),
  ]);

  if (!user) {
    throw generateError("Learner not found", 404);
  }
  if (!course) {
    throw generateError("Course not found", 404);
  }
  if (!enrollment) {
    throw generateError("Course not found in learner enrollments", 404);
  }

  const progress = Math.max(
    0,
    Math.min(
      100,
      Number(progressDoc?.progress ?? enrollment?.progressPercent ?? (enrollment?.status === "completed" ? 100 : 0)) || 0
    )
  );
  const effectiveAssessment = resolveEffectiveEnrollmentAssessment(enrollment, course?.assessment);
  const assessmentSummary =
    options.assessmentSummary ||
    buildCourseAssessmentSummary({
      assessment: effectiveAssessment,
      score: progressDoc?.score ?? null,
      progress,
      lessonStatus: progressDoc?.lessonStatus ?? enrollment?.status,
    });
  const template = await resolveCertificateTemplate({
    course,
    user,
    companyId: stringifyId(user?.company || course?.company),
  });

  return {
    user,
    course,
    enrollment,
    progressDoc,
    issuedCertificate,
    progress,
    effectiveAssessment,
    assessmentSummary,
    template,
  };
}

function resolveEligibilityStatus(context: Awaited<ReturnType<typeof resolveEligibilityContext>>): CertificateSnapshot {
  if (context.course?.progression?.certificateEnabled === false) {
    return {
      enabled: false,
      status: "disabled",
      canIssue: false,
      reason: "Certificates are disabled for this course",
    };
  }

  const hasCompletedCourse = context.progress >= 100;
  if (!hasCompletedCourse) {
    return {
      enabled: true,
      status: "not_eligible",
      canIssue: false,
      reason: `Complete the course to unlock the certificate (${Math.round(context.progress)}% complete)`,
    };
  }

  const totalMarks = context.effectiveAssessment?.totalMarks;
  const passingMarks = context.effectiveAssessment?.passingMarks;
  const hasAssessment = Number.isFinite(Number(totalMarks)) && Number(totalMarks) > 0;
  const hasPassingMarks = passingMarks !== null && passingMarks !== undefined && Number.isFinite(Number(passingMarks));

  if (!hasAssessment || !hasPassingMarks) {
    return {
      enabled: true,
      status: "not_eligible",
      canIssue: false,
      reason: "Total marks and passing marks must be configured for this course",
    };
  }

  if (context.assessmentSummary?.outcome !== "passed") {
    const earnedMarks = context.assessmentSummary?.earnedMarks;
    const earnedMarksLabel = Number.isFinite(Number(earnedMarks)) ? Number(earnedMarks) : "not available";
    const reason = context.assessmentSummary?.outcome === "failed"
      ? `Assessment not passed: ${earnedMarksLabel}/${Number(totalMarks)} marks earned; ${Number(passingMarks)} required`
      : `Pass the assessment with at least ${Number(passingMarks)}/${Number(totalMarks)} marks to unlock the certificate`;

    return {
      enabled: true,
      status: "not_eligible",
      canIssue: false,
      reason,
    };
  }

  if (context.issuedCertificate) {
    return serializeIssuedCertificate(context.issuedCertificate);
  }

  if (!context.template) {
    return {
      enabled: true,
      status: "not_eligible",
      canIssue: false,
      reason: "Certificate template is not configured",
    };
  }

  return {
    enabled: true,
    status: "eligible",
    canIssue: true,
    reason: "Certificate is ready to issue",
    templateId: stringifyId(context.template._id),
    templateName: context.template.name,
  };
}

function buildRenderValues(context: Awaited<ReturnType<typeof resolveEligibilityContext>>, issuedAt: Date) {
  const learnerName =
    String(context.user?.name || "").trim() ||
    String(context.user?.username || "").trim() ||
    String(context.user?.email || "").trim() ||
    "Learner";
  const courseName = String(context.course?.title || "").trim() || "Course";
  const issuedOnLabel = formatIssueDate(issuedAt);

  return {
    values: {
      student_name: learnerName,
      course_name: courseName,
      issued_on: issuedOnLabel,
    },
    metadata: {
      learnerName,
      learnerEmail: context.user?.email || context.user?.username || "",
      courseName,
      score: context.progressDoc?.score ?? null,
      completionDate: context.progressDoc?.updatedAt || context.enrollment?.updatedAt || null,
      issuedOnLabel,
    },
  };
}

async function persistCertificatePdf(certificate: any, templateHtml: string, values: TemplateRenderValueMap) {
  const { renderedPdfPath, absolutePath, renderedPdfUrl } = buildCertificateFilePaths(certificate.certificateNo);
  const renderedHtmlSnapshot = fillTemplateHtml(templateHtml, values);
  const pdfBuffer = await renderCertificatePdf(templateHtml, values);
  const update: Record<string, any> = {
    renderedHtmlSnapshot,
  };

  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, pdfBuffer);
    update.renderedPdfPath = renderedPdfPath;
    update.renderedPdfUrl = renderedPdfUrl;
  } catch (error: any) {
    console.warn(
      "[Certificates] Skipping local PDF persistence; filesystem is not writable",
      error?.message || error
    );
  }

  return IssuedCertificate.findByIdAndUpdate(
    certificate._id,
    {
      $set: update,
    },
    { new: true }
  ).lean();
}

async function renderIssuedCertificatePdfBuffer(certificate: any) {
  const context = await resolveEligibilityContext({
    userId: stringifyId(certificate.userId),
    courseId: stringifyId(certificate.courseId),
  });
  const template = await CertificateTemplate.findById(certificate.templateId || context.template?._id).lean();
  if (!template) {
    throw generateError("Certificate template not found", 404);
  }

  const values = buildRenderValues(context, certificate.issuedAt || new Date()).values;
  const renderedHtmlSnapshot = fillTemplateHtml(template.html, values);
  const pdfBuffer = await renderCertificatePdf(template.html, values);

  await IssuedCertificate.findByIdAndUpdate(certificate._id, {
    $set: {
      renderedHtmlSnapshot,
    },
  });

  return pdfBuffer;
}

async function ensureIssuedCertificatePdf(certificate: any) {
  const existingPath = certificate.renderedPdfPath
    ? path.join(process.cwd(), certificate.renderedPdfPath)
    : "";

  if (existingPath && fs.existsSync(existingPath)) {
    return certificate;
  }

  const context = await resolveEligibilityContext({
    userId: stringifyId(certificate.userId),
    courseId: stringifyId(certificate.courseId),
  });
  const template = await CertificateTemplate.findById(certificate.templateId).lean();
  if (!template) {
    throw generateError("Certificate template not found", 404);
  }

  const values = buildRenderValues(context, certificate.issuedAt || new Date()).values;
  return persistCertificatePdf(certificate, template.html, values);
}

export async function getCertificateSnapshotForCourse(options: CertificateEligibilityContext): Promise<CertificateSnapshot> {
  const context = await resolveEligibilityContext(options);
  return resolveEligibilityStatus(context);
}

export async function issueCertificateForCourse(options: CertificateEligibilityContext) {
  const context = await resolveEligibilityContext(options);
  const status = resolveEligibilityStatus(context);

  if (context.issuedCertificate) {
    if (status.status !== "issued") {
      throw generateError(status.reason || "Certificate is not available", 422);
    }
    return ensureIssuedCertificatePdf(context.issuedCertificate);
  }

  const template = context.template;
  if (!status.canIssue || !template) {
    throw generateError(status.reason || "Certificate is not available", 422);
  }

  const issuedAt = new Date();
  const { values, metadata } = buildRenderValues(context, issuedAt);
  const certificateNo = buildCertificateNumber();
  const templateId = template._id;

  const certificate = new IssuedCertificate({
    certificateNo,
    userId: toObjectId(options.userId),
    courseId: toObjectId(options.courseId),
    companyId: context.user?.company || context.course?.company || null,
    templateId,
    templateVersion: Number(template.version || 1),
    issuedAt,
    status: "issued",
    metadata,
  });

  try {
    await certificate.save();
  } catch (error: any) {
    if (Number(error?.code) === 11000) {
      const existing = await IssuedCertificate.findOne({
        userId: toObjectId(options.userId),
        courseId: toObjectId(options.courseId),
        status: "issued",
      }).lean();
      if (existing) {
        return ensureIssuedCertificatePdf(existing);
      }
    }
    throw error;
  }

  return persistCertificatePdf(certificate, template.html, values);
}

export async function tryIssueCertificateForCompletedCourse(options: { userId: string; courseId: string }) {
  try {
    const snapshot = await getCertificateSnapshotForCourse(options);
    if (snapshot.status === "issued" || snapshot.canIssue) {
      return issueCertificateForCourse(options);
    }
  } catch (error) {
    console.warn("[Certificates] Skipped automatic certificate issuance", error);
  }

  return null;
}

export const getMyCertificateService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const userId = stringifyId(req.userId || req.user?._id);
    const courseId = stringifyId(req.params.courseId);
    const data = await getCertificateSnapshotForCourse({ userId, courseId });

    return res.status(200).send({
      status: "success",
      message: "Certificate status fetched successfully",
      data,
    });
  } catch (err: any) {
    next(err);
  }
};

export const issueMyCertificateService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const userId = stringifyId(req.userId || req.user?._id);
    const courseId = stringifyId(req.params.courseId);
    const certificate = await issueCertificateForCourse({ userId, courseId });

    return res.status(200).send({
      status: "success",
      message: "Certificate issued successfully",
      data: serializeIssuedCertificate(certificate),
    });
  } catch (err: any) {
    next(err);
  }
};

export const downloadMyCertificateService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const userId = stringifyId(req.userId || req.user?._id);
    const courseId = stringifyId(req.params.courseId);
    const certificate = await issueCertificateForCourse({ userId, courseId });
    const pdfBuffer = await renderIssuedCertificatePdfBuffer(certificate);
    const fileName = `${certificate.certificateNo || buildCertificateNumber()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", String(pdfBuffer.length));
    return res.send(pdfBuffer);
  } catch (err: any) {
    next(err);
  }
};

function resolveTemplateCompanyId(actor: any, requestedCompanyId?: string) {
  const actorRole = normalizeRole(actor?.role || actor?.userType);
  if (actorRole === "superadmin") {
    return requestedCompanyId && mongoose.Types.ObjectId.isValid(requestedCompanyId)
      ? requestedCompanyId
      : null;
  }

  const companyId = stringifyId(actor?.company || actor?.companyId);
  return companyId && mongoose.Types.ObjectId.isValid(companyId) ? companyId : null;
}

export const listCertificateTemplatesService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = req.bodyData || req.user;
    ensurePermission(actor, PERMISSION_KEYS.VIEW_ASSIGNED_COURSES, "You do not have permission to view certificate templates");
    const requestedCompanyId = stringifyId(req.query.companyId);
    const companyId = resolveTemplateCompanyId(actor, requestedCompanyId);
    const actorRole = normalizeRole(actor?.role || actor?.userType);
    const query =
      actorRole === "superadmin" && !companyId
        ? {}
        : {
            $or: [
              { companyId: companyId ? toObjectId(companyId) : null },
              { companyId: null },
              { companyId: { $exists: false } },
            ],
          };

    const templates = await CertificateTemplate.find(query).sort({ updatedAt: -1, createdAt: -1 }).lean();

    return res.status(200).send({
      status: "success",
      message: "Certificate templates fetched successfully",
      data: templates.map(serializeTemplate),
    });
  } catch (err: any) {
    next(err);
  }
};

export const createCertificateTemplateService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = req.bodyData || req.user;
    ensurePermission(actor, PERMISSION_KEYS.EDIT_COURSES, "You do not have permission to manage certificate templates");

    const html = String(req.file?.buffer?.toString("utf8") || req.body.html || "").trim();
    if (!html) {
      throw generateError("Template HTML is required", 422);
    }

    const requestedCompanyId = stringifyId(req.body.companyId);
    const companyId = resolveTemplateCompanyId(actor, requestedCompanyId);
    const template = await CertificateTemplate.create({
      name: String(req.body.name || req.file?.originalname || "Certificate Template").trim(),
      companyId: companyId ? toObjectId(companyId) : null,
      html,
      placeholders: normalizeTemplatePlaceholders(html),
      backgroundAssetUrl: extractBackgroundAssetUrl(html),
      status: req.body.status === "draft" ? "draft" : "active",
      version: 1,
      createdBy: req.userId ? toObjectId(req.userId) : null,
      updatedBy: req.userId ? toObjectId(req.userId) : null,
    });

    return res.status(201).send({
      status: "success",
      message: "Certificate template created successfully",
      data: serializeTemplate(template),
    });
  } catch (err: any) {
    next(err);
  }
};

export const updateCertificateTemplateService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = req.bodyData || req.user;
    ensurePermission(actor, PERMISSION_KEYS.EDIT_COURSES, "You do not have permission to manage certificate templates");

    const templateId = stringifyId(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      throw generateError("Invalid template id", 400);
    }

    const template = await CertificateTemplate.findById(templateId);
    if (!template) {
      throw generateError("Certificate template not found", 404);
    }

    if (!hasAnyCourseManagementPermission(actor) && stringifyId(template.companyId) !== stringifyId(actor?.company || actor?.companyId)) {
      throw generateError("You do not have permission to update this template", 403);
    }

    const nextHtml = req.file?.buffer?.toString("utf8") || req.body.html;
    if (req.body.name !== undefined) {
      template.name = String(req.body.name || "").trim() || template.name;
    }
    if (nextHtml !== undefined) {
      template.html = String(nextHtml || "").trim();
      template.placeholders = normalizeTemplatePlaceholders(template.html);
      template.backgroundAssetUrl = extractBackgroundAssetUrl(template.html);
      template.version = Number(template.version || 1) + 1;
    }
    if (["draft", "active", "archived"].includes(String(req.body.status))) {
      template.status = req.body.status;
    }
    template.updatedBy = req.userId ? toObjectId(req.userId) : null;

    await template.save();

    return res.status(200).send({
      status: "success",
      message: "Certificate template updated successfully",
      data: serializeTemplate(template),
    });
  } catch (err: any) {
    next(err);
  }
};

export const previewCertificateTemplateService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = req.bodyData || req.user;
    ensurePermission(actor, PERMISSION_KEYS.VIEW_ASSIGNED_COURSES, "You do not have permission to preview certificate templates");

    const templateId = stringifyId(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      throw generateError("Invalid template id", 400);
    }

    const template = await CertificateTemplate.findById(templateId).lean();
    if (!template) {
      throw generateError("Certificate template not found", 404);
    }

    return res.status(200).send({
      status: "success",
      message: "Certificate template preview generated successfully",
      data: {
        template: serializeTemplate(template),
        html: fillTemplateHtml(template.html, {
          student_name: "Sample Learner",
          course_name: "Sample Course",
          issued_on: formatIssueDate(new Date()),
        }),
      },
    });
  } catch (err: any) {
    next(err);
  }
};
