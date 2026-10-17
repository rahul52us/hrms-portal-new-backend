import { randomUUID } from "node:crypto";
import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import PayrollOperationalJob from "../../schemas/Payroll/PayrollOperationalJob.schema";
import PayrollPayslip from "../../schemas/Payroll/PayrollPayslip.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import {
  PERMISSION_KEYS,
} from "../permissions/permission.utils";
import { writePayrollAccessLog } from "./payrollAccess.service";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
} from "./payroll.utils";
import {
  resolvePayrollPermissionRecipients,
  upsertPayrollNotifications,
} from "./payrollNotification.service";

const DAY_MS = 86_400_000;
const LOCK_MS = 5 * 60_000;

const text = (value: unknown) => String(value ?? "").trim();

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

function asObjectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function normalizedDate(value?: unknown) {
  const raw = text(value) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00.000Z`).getTime())) {
    throw generateError("Reference date must use YYYY-MM-DD", 422);
  }
  return raw;
}

function retentionExpiry(days: unknown) {
  return new Date(Date.now() + boundedInteger(days, 90, 7, 730) * DAY_MS);
}

function retryDelay(attempts: number) {
  return Math.min(6 * 60 * 60_000, Math.max(60_000, 2 ** Math.max(0, attempts - 1) * 5 * 60_000));
}

function safeJobError(error: any) {
  const raw = text(error?.message || error || "Payroll operations job failed");
  return {
    code: text(error?.code || error?.name || "job_failed").slice(0, 80),
    message: raw.replace(/mongodb[^\s]*/gi, "database").slice(0, 500),
  };
}

async function payrollRecipients(company: any) {
  return resolvePayrollPermissionRecipients({ company, permission: PERMISSION_KEYS.MANAGE_PAYROLL_RUNS });
}

export async function processPayrollReminders(options: {
  company: any;
  referenceDate?: string;
  actor?: mongoose.Types.ObjectId | null;
}) {
  const date = normalizedDate(options.referenceDate);
  const day = Number(date.slice(8, 10));
  const periodKey = date.slice(0, 7);
  const settings = options.company.payrollSettings || {};
  if (settings.payrollNotificationsEnabled === false) {
    return { companiesChecked: 1, recipients: 0, remindersConsidered: 0, notificationsCreated: 0, disabled: 1 };
  }
  const recipients = await payrollRecipients(options.company);
  if (!recipients.length) {
    return { companiesChecked: 1, recipients: 0, remindersConsidered: 0, notificationsCreated: 0, disabled: 0 };
  }

  const currentRun: any = await PayrollRun.findOne({ company: options.company._id, periodKey }).lean();
  const actionableRun: any = currentRun || await PayrollRun.findOne({
    company: options.company._id,
    status: { $in: ["draft", "calculating", "review", "approved", "failed"] },
    periodKey: { $lte: periodKey },
  }).sort({ periodKey: -1 }).lean();
  const reminders: Array<{ eventType: string; title: string; message: string; priority: "medium" | "high"; entityId: any }> = [];
  const reminderDay = boundedInteger(settings.payrollReminderDay, 20, 1, 28);

  if (!currentRun && day >= reminderDay) {
    reminders.push({
      eventType: "payroll_run_not_started",
      title: "Payroll run not started",
      message: `The ${periodKey} payroll run has not been created.`,
      priority: "high",
      entityId: options.company._id,
    });
  }
  if (actionableRun?.status === "review") {
    reminders.push({
      eventType: "payroll_run_awaiting_approval",
      title: "Payroll awaiting approval",
      message: `${actionableRun.periodKey} payroll is waiting for an independent review decision.`,
      priority: "high",
      entityId: actionableRun._id,
    });
  } else if (actionableRun?.status === "approved") {
    reminders.push({
      eventType: "payroll_run_awaiting_finalization",
      title: "Payroll awaiting finalization",
      message: `${actionableRun.periodKey} payroll is approved and ready to finalize.`,
      priority: "high",
      entityId: actionableRun._id,
    });
  } else if (actionableRun && ["draft", "calculating", "failed"].includes(actionableRun.status) && day >= reminderDay) {
    reminders.push({
      eventType: "payroll_run_incomplete",
      title: "Payroll processing is incomplete",
      message: `${actionableRun.periodKey} payroll is still ${actionableRun.status}.`,
      priority: actionableRun.status === "failed" ? "high" : "medium",
      entityId: actionableRun._id,
    });
  }

  const finalizedRun: any = await PayrollRun.findOne({
    company: options.company._id,
    status: "finalized",
    periodKey: { $lte: periodKey },
  }).sort({ periodKey: -1 }).lean();
  if (finalizedRun) {
    const payslipCount = await PayrollPayslip.countDocuments({
      company: options.company._id,
      payrollRun: finalizedRun._id,
      finalizationVersion: finalizedRun.finalizationVersion,
    });
    if (payslipCount < Number(finalizedRun.finalizedResultCount || 0)) {
      reminders.push({
        eventType: "payroll_payslips_not_issued",
        title: "Payslips are not fully issued",
        message: `${finalizedRun.periodKey} payroll has ${Number(finalizedRun.finalizedResultCount || 0) - payslipCount} payslip(s) left to issue.`,
        priority: "medium",
        entityId: finalizedRun._id,
      });
    }
  }

  let notificationsCreated = 0;
  for (const reminder of reminders) {
    notificationsCreated += await upsertPayrollNotifications({
      company: options.company._id,
      recipients,
      actor: options.actor || undefined,
      eventType: reminder.eventType,
      entityType: "payroll_run",
      entityId: reminder.entityId,
      title: reminder.title,
      message: reminder.message,
      actionUrl: "/dashboard/payroll",
      priority: reminder.priority,
      category: "system",
      metadata: { periodKey: actionableRun?.periodKey || finalizedRun?.periodKey || periodKey, referenceDate: date },
      dedupeEventKey: `${reminder.eventType}:${date}`,
    });
  }
  return {
    companiesChecked: 1,
    recipients: recipients.length,
    remindersConsidered: reminders.length,
    notificationsCreated,
    disabled: 0,
  };
}

export async function createPayrollOperationalJob(options: {
  company: any;
  idempotencyKey: string;
  trigger: "manual" | "scheduler" | "recovery";
  requestedBy?: mongoose.Types.ObjectId | null;
}) {
  const key = text(options.idempotencyKey);
  if (key.length < 8 || key.length > 160) throw generateError("Idempotency key must contain 8 to 160 characters", 422);
  try {
    return await PayrollOperationalJob.create({
      company: options.company._id,
      jobType: "scheduled_reminders",
      idempotencyKey: key,
      trigger: options.trigger,
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      requestedBy: options.requestedBy || null,
      expiresAt: retentionExpiry(options.company?.payrollSettings?.operationalJobRetentionDays),
    });
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const existing = await PayrollOperationalJob.findOne({
      company: options.company._id,
      jobType: "scheduled_reminders",
      idempotencyKey: key,
    });
    if (!existing) throw error;
    return existing;
  }
}

export async function executePayrollOperationalJob(jobIdInput: unknown, company: any, referenceDate?: string) {
  const jobId = asObjectId(jobIdInput, "payroll operations job id");
  const existing: any = await PayrollOperationalJob.findOne({ _id: jobId, company: company._id }).lean();
  if (!existing) throw generateError("Payroll operations job not found", 404);
  if (existing.status === "succeeded" || existing.status === "exhausted") return existing;
  if (Number(existing.attempts || 0) >= Number(existing.maxAttempts || 3)) {
    return PayrollOperationalJob.findOneAndUpdate(
      { _id: jobId, company: company._id, status: { $ne: "succeeded" } },
      { $set: { status: "exhausted", lockToken: null, lockedAt: null, lockExpiresAt: null } },
      { new: true }
    ).lean();
  }

  const now = new Date();
  if (existing.status === "failed" && existing.nextRetryAt && new Date(existing.nextRetryAt) > now) return existing;
  const lockToken = randomUUID();
  const claimed: any = await PayrollOperationalJob.findOneAndUpdate(
    {
      _id: jobId,
      company: company._id,
      attempts: Number(existing.attempts || 0),
      status: { $in: ["queued", "failed", "running"] },
      $or: [{ lockExpiresAt: null }, { lockExpiresAt: { $lte: now } }],
    },
    {
      $set: {
        status: "running",
        lockToken,
        lockedAt: now,
        lockExpiresAt: new Date(now.getTime() + LOCK_MS),
        startedAt: now,
        completedAt: null,
        nextRetryAt: null,
        lastError: null,
      },
      $inc: { attempts: 1 },
    },
    { new: true }
  ).lean();
  if (!claimed) return PayrollOperationalJob.findById(jobId).lean();

  try {
    const metrics = await processPayrollReminders({
      company,
      referenceDate,
      actor: claimed.requestedBy || null,
    });
    const completedAt = new Date();
    return PayrollOperationalJob.findOneAndUpdate(
      { _id: jobId, company: company._id, status: "running", lockToken },
      {
        $set: {
          status: "succeeded",
          completedAt,
          durationMs: completedAt.getTime() - now.getTime(),
          metrics,
          lockToken: null,
          lockedAt: null,
          lockExpiresAt: null,
          nextRetryAt: null,
        },
      },
      { new: true }
    ).lean();
  } catch (error: any) {
    const attempts = Number(claimed.attempts || 1);
    const exhausted = attempts >= Number(claimed.maxAttempts || 3);
    const completedAt = new Date();
    await PayrollOperationalJob.updateOne(
      { _id: jobId, company: company._id, status: "running", lockToken },
      {
        $set: {
          status: exhausted ? "exhausted" : "failed",
          completedAt,
          durationMs: completedAt.getTime() - now.getTime(),
          lastError: safeJobError(error),
          nextRetryAt: exhausted ? null : new Date(completedAt.getTime() + retryDelay(attempts)),
          lockToken: null,
          lockedAt: null,
          lockExpiresAt: null,
        },
      }
    );
    throw error;
  }
}

export async function runPayrollRemindersService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId, company } = await resolvePayrollCompany(req, req.body?.companyId, true, "run payroll reminders for this company");
    const actorId = getPayrollActorId(req);
    const referenceDate = normalizedDate(req.body?.referenceDate);
    const idempotencyKey = text(req.headers?.["idempotency-key"] || req.body?.idempotencyKey);
    const job = await createPayrollOperationalJob({ company, idempotencyKey, trigger: "manual", requestedBy: actorId });
    const result = await executePayrollOperationalJob(job._id, company, referenceDate);
    await writePayrollAccessLog({
      req,
      company: companyObjectId,
      actor: actorId,
      action: "operations_viewed",
      resourceType: "payroll_operations",
      resourceId: `reminder-job:${job._id}`,
      metadata: { action: "run_reminders", status: result?.status, referenceDate },
      retentionDays: Number((company as any)?.payrollSettings?.accessLogRetentionDays || 365),
    });
    return res.status(result?.status === "succeeded" ? 200 : 202).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function retryPayrollOperationalJobService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { company } = await resolvePayrollCompany(req, req.body?.companyId, true, "retry payroll operations for this company");
    const jobId = asObjectId(req.params.jobId, "payroll operations job id");
    const job: any = await PayrollOperationalJob.findOne({ _id: jobId, company: company._id });
    if (!job) throw generateError("Payroll operations job not found", 404);
    if (!["failed", "exhausted"].includes(job.status)) throw generateError("Only failed payroll jobs can be retried", 409);
    job.status = "queued";
    job.attempts = 0;
    job.lastError = undefined;
    job.nextRetryAt = null;
    job.trigger = "recovery";
    job.expiresAt = retentionExpiry((company as any)?.payrollSettings?.operationalJobRetentionDays);
    await job.save();
    const result = await executePayrollOperationalJob(job._id, company, normalizedDate(req.body?.referenceDate));
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function listPayrollOperationalJobsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const page = boundedInteger(req.query?.page, 1, 1, 100_000);
    const limit = boundedInteger(req.query?.limit, 20, 1, 100);
    const [items, total] = await Promise.all([
      PayrollOperationalJob.find({ company: companyObjectId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("requestedBy", "name username code role")
        .lean(),
      PayrollOperationalJob.countDocuments({ company: companyObjectId }),
    ]);
    return res.status(200).json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    next(error);
  }
}

export async function getPayrollOperationalMetricsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId, company } = await resolvePayrollCompany(req, req.query?.companyId);
    const since = new Date(Date.now() - 30 * DAY_MS);
    const jobs: any[] = await PayrollOperationalJob.find({ company: companyObjectId, createdAt: { $gte: since } })
      .select("status attempts durationMs metrics lockExpiresAt")
      .lean();
    const counts = jobs.reduce<Record<string, number>>((acc, job) => {
      acc[job.status] = (acc[job.status] || 0) + 1;
      return acc;
    }, {});
    const completed = jobs.filter((job) => Number.isFinite(Number(job.durationMs)));
    const metrics = {
      windowDays: 30,
      totalJobs: jobs.length,
      statusCounts: counts,
      successRatePercent: jobs.length ? Math.round(((counts.succeeded || 0) / jobs.length) * 10_000) / 100 : 100,
      averageDurationMs: completed.length ? Math.round(completed.reduce((sum, job) => sum + Number(job.durationMs || 0), 0) / completed.length) : 0,
      retryCount: jobs.reduce((sum, job) => sum + Math.max(0, Number(job.attempts || 0) - 1), 0),
      notificationsCreated: jobs.reduce((sum, job) => sum + Number(job.metrics?.notificationsCreated || 0), 0),
      staleLocks: jobs.filter((job) => job.status === "running" && job.lockExpiresAt && new Date(job.lockExpiresAt) <= new Date()).length,
    };
    await writePayrollAccessLog({
      req,
      company: companyObjectId,
      actor: getPayrollActorId(req),
      action: "operations_viewed",
      resourceType: "payroll_operations",
      resourceId: "metrics",
      metadata: { windowDays: 30 },
      retentionDays: Number((company as any)?.payrollSettings?.accessLogRetentionDays || 365),
    });
    return res.status(200).json({ success: true, data: metrics });
  } catch (error) {
    next(error);
  }
}
