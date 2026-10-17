import { createHash } from "node:crypto";
import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import PayrollAccessLog, {
  PAYROLL_ACCESS_ACTIONS,
} from "../../schemas/Payroll/PayrollAccessLog.schema";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
} from "./payroll.utils";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

export function payrollRequestFingerprint(req: any) {
  const forwarded = text(req.headers?.["x-forwarded-for"]).split(",")[0].trim();
  const ip = forwarded || text(req.ip || req.socket?.remoteAddress);
  const userAgent = text(req.headers?.["user-agent"]);
  const salt = process.env.PAYROLL_ACCESS_LOG_SALT || "hrms-payroll-access";
  return createHash("sha256").update(`${salt}|${ip}|${userAgent}`).digest("hex");
}

export async function writePayrollAccessLog(options: {
  req: any;
  company: mongoose.Types.ObjectId;
  actor: mongoose.Types.ObjectId;
  action: (typeof PAYROLL_ACCESS_ACTIONS)[number];
  resourceType: "payroll_report" | "payslip" | "payroll_operations";
  resourceId: string;
  payrollRun?: mongoose.Types.ObjectId | null;
  employee?: mongoose.Types.ObjectId | null;
  purpose?: string;
  metadata?: Record<string, unknown>;
  retentionDays?: number;
}) {
  const retentionDays = boundedInteger(options.retentionDays, 365, 30, 3650);
  const expiresAt = new Date(Date.now() + retentionDays * 86_400_000);
  return PayrollAccessLog.create({
    company: options.company,
    actor: options.actor,
    action: options.action,
    resourceType: options.resourceType,
    resourceId: text(options.resourceId),
    payrollRun: options.payrollRun || null,
    employee: options.employee || null,
    purpose: text(options.purpose) || undefined,
    requestFingerprint: payrollRequestFingerprint(options.req),
    metadata: options.metadata || {},
    expiresAt,
  });
}

export async function listPayrollAccessLogsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId, company } = await resolvePayrollCompany(req, req.query?.companyId);
    const page = boundedInteger(req.query?.page, 1, 1, 100_000);
    const limit = boundedInteger(req.query?.limit, 25, 1, 100);
    const action = text(req.query?.action);
    if (action && !PAYROLL_ACCESS_ACTIONS.includes(action as any)) {
      return res.status(422).json({ success: false, message: "Invalid payroll access action" });
    }
    const match = { company: companyObjectId, ...(action ? { action } : {}) };
    const [items, total] = await Promise.all([
      PayrollAccessLog.find(match)
        .select("-requestFingerprint")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("actor", "name username code role")
        .lean(),
      PayrollAccessLog.countDocuments(match),
    ]);
    await writePayrollAccessLog({
      req,
      company: companyObjectId,
      actor: getPayrollActorId(req),
      action: "operations_viewed",
      resourceType: "payroll_operations",
      resourceId: "access-logs",
      metadata: { page, action: action || "all" },
      retentionDays: Number((company as any)?.payrollSettings?.accessLogRetentionDays || 365),
    });
    return res.status(200).json({
      success: true,
      data: items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}
