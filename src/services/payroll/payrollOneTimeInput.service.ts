import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import PayrollEmployeeInput from "../../schemas/Payroll/PayrollEmployeeInput.schema";
import PayrollOneTimeInput, {
  PAYROLL_ONE_TIME_INPUT_TYPES,
  PayrollOneTimeInputType,
} from "../../schemas/Payroll/PayrollOneTimeInput.schema";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import SalaryComponent, { SalaryComponentCategory } from "../../schemas/Payroll/SalaryComponent.schema";
import {
  ensurePayrollRunManager,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

const text = (value: unknown) => String(value ?? "").trim();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pageNumber(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(text(value), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function objectId(value: unknown, label: string) {
  const normalized = text(value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function requiredReason(value: unknown, label: string) {
  const reason = text(value);
  if (reason.length < 3 || reason.length > 500) {
    throw generateError(`${label} must contain 3 to 500 characters`, 422);
  }
  return reason;
}

export function parsePayrollAmountToMinor(value: unknown, minorUnits: number) {
  const normalized = text(value).replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw generateError("Amount must be a positive number", 422);
  }
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > minorUnits) {
    throw generateError(`Amount supports at most ${minorUnits} decimal places`, 422);
  }
  const amount = Number(whole) * 10 ** minorUnits + Number(fraction.padEnd(minorUnits, "0") || "0");
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw generateError("Amount must be greater than zero and within the supported range", 422);
  }
  return amount;
}

export function oneTimeInputComponentCategory(inputType: PayrollOneTimeInputType): SalaryComponentCategory {
  if (["earning", "arrear"].includes(inputType)) return "earning";
  if (["deduction", "recovery"].includes(inputType)) return "deduction";
  return "reimbursement";
}

export function oneTimeInputRunDelta(inputType: PayrollOneTimeInputType, amountMinor: number, direction = 1) {
  const amount = amountMinor * direction;
  const delta: Record<string, number> = {
    earningsMinor: 0,
    deductionsMinor: 0,
    reimbursementsMinor: 0,
    arrearsMinor: 0,
    recoveriesMinor: 0,
    netImpactMinor: 0,
  };
  if (inputType === "earning") {
    delta.earningsMinor = amount;
    delta.netImpactMinor = amount;
  } else if (inputType === "deduction") {
    delta.deductionsMinor = amount;
    delta.netImpactMinor = -amount;
  } else if (inputType === "reimbursement") {
    delta.reimbursementsMinor = amount;
    delta.netImpactMinor = amount;
  } else if (inputType === "arrear") {
    delta.arrearsMinor = amount;
    delta.netImpactMinor = amount;
  } else {
    delta.recoveriesMinor = amount;
    delta.netImpactMinor = -amount;
  }
  return delta;
}

export function buildPayrollOneTimeInputDocument(options: {
  run: any;
  employeeInput: any;
  component: any;
  actorId: mongoose.Types.ObjectId;
  inputType: PayrollOneTimeInputType;
  amountMinor: number;
  reason: string;
  reference: string;
  idempotencyKey: string;
}) {
  return {
    company: options.run.company,
    payrollRun: options.run._id,
    periodKey: options.run.periodKey,
    employee: options.employeeInput.employee,
    employeeNameSnapshot: options.employeeInput.employeeNameSnapshot,
    employeeCodeSnapshot: options.employeeInput.employeeCodeSnapshot,
    salaryComponent: options.component._id,
    componentNameSnapshot: options.component.name,
    componentCodeSnapshot: options.component.code,
    componentCategorySnapshot: options.component.category,
    componentTaxableSnapshot: Boolean(options.component.taxable),
    inputType: options.inputType,
    amountMinor: options.amountMinor,
    currency: options.run.currency,
    currencyMinorUnits: options.run.currencyMinorUnits,
    reason: options.reason,
    reference: options.reference,
    idempotencyKey: options.idempotencyKey,
    status: "active" as const,
    createdBy: options.actorId,
  };
}

function sameIdempotentPayload(existing: any, payload: {
  employeeId: mongoose.Types.ObjectId;
  componentId: mongoose.Types.ObjectId;
  inputType: PayrollOneTimeInputType;
  amountMinor: number;
  reason: string;
  reference: string;
}) {
  return String(existing.employee) === String(payload.employeeId)
    && String(existing.salaryComponent) === String(payload.componentId)
    && existing.inputType === payload.inputType
    && Number(existing.amountMinor) === payload.amountMinor
    && text(existing.reason) === payload.reason
    && text(existing.reference) === payload.reference;
}

async function populatedRun(company: mongoose.Types.ObjectId, runId: mongoose.Types.ObjectId | string) {
  return PayrollRun.findOne({ _id: runId, company })
    .populate("createdBy attendanceLockedBy attendanceInputsPreparedBy", "name username code role")
    .lean();
}

async function populatedInput(company: mongoose.Types.ObjectId, inputId: mongoose.Types.ObjectId | string) {
  return PayrollOneTimeInput.findOne({ _id: inputId, company })
    .populate("createdBy cancelledBy", "name username code role")
    .lean();
}

export async function listPayrollOneTimeInputsService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query?.companyId);
    const runId = objectId(req.params.runId, "payroll run id");
    const page = pageNumber(req.query?.page, 1, 100_000);
    const limit = pageNumber(req.query?.limit, 20, 100);
    const status = text(req.query?.status || "active").toLowerCase();
    const inputType = text(req.query?.inputType || "all").toLowerCase();
    const search = text(req.query?.search);
    if (!["active", "cancelled", "all"].includes(status)) throw generateError("Invalid one-time input status filter", 422);
    if (inputType !== "all" && !PAYROLL_ONE_TIME_INPUT_TYPES.includes(inputType as PayrollOneTimeInputType)) {
      throw generateError("Invalid one-time payroll input type", 422);
    }
    const run = await populatedRun(companyObjectId, runId);
    if (!run) throw generateError("Payroll run not found", 404);
    const regex = search ? new RegExp(escapeRegex(search), "i") : null;
    const match: any = {
      company: companyObjectId,
      payrollRun: runId,
      ...(status === "all" ? {} : { status }),
      ...(inputType === "all" ? {} : { inputType }),
      ...(regex ? {
        $or: [
          { employeeNameSnapshot: regex },
          { employeeCodeSnapshot: regex },
          { componentNameSnapshot: regex },
          { componentCodeSnapshot: regex },
          { reason: regex },
          { reference: regex },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      PayrollOneTimeInput.find(match)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("createdBy cancelledBy", "name username code role")
        .lean(),
      PayrollOneTimeInput.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: { run, items },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

export async function createPayrollOneTimeInputService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "add one-time inputs to this payroll run"
    );
    const actorId = getPayrollActorId(req);
    const runId = objectId(req.params.runId, "payroll run id");
    const employeeId = objectId(req.body?.employeeId, "employee id");
    const componentId = objectId(req.body?.salaryComponentId, "salary component id");
    const inputType = text(req.body?.inputType).toLowerCase() as PayrollOneTimeInputType;
    if (!PAYROLL_ONE_TIME_INPUT_TYPES.includes(inputType)) throw generateError("Invalid one-time payroll input type", 422);
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw generateError("Expected payroll run version is required", 422);
    const reason = requiredReason(req.body?.reason, "Input reason");
    const reference = text(req.body?.reference);
    if (reference.length > 100) throw generateError("Reference cannot exceed 100 characters", 422);
    const idempotencyKey = text(req.body?.idempotencyKey);
    if (idempotencyKey.length < 8 || idempotencyKey.length > 100) {
      throw generateError("Idempotency key must contain 8 to 100 characters", 422);
    }

    let inputId: mongoose.Types.ObjectId | null = null;
    let created = false;
    let normalizedPayload: any = null;

    try {
      await mongoose.connection.transaction(async (session) => {
        const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
        if (!run) throw generateError("Payroll run not found", 404);
        const amountMinor = parsePayrollAmountToMinor(req.body?.amount, Number(run.currencyMinorUnits));
        normalizedPayload = { employeeId, componentId, inputType, amountMinor, reason, reference };
        const existing: any = await PayrollOneTimeInput.findOne({
          company: companyObjectId,
          payrollRun: runId,
          idempotencyKey,
        }).session(session).lean();
        if (existing) {
          if (!sameIdempotentPayload(existing, normalizedPayload)) {
            throw generateError("Idempotency key was already used for a different payroll input", 409);
          }
          inputId = existing._id;
          return;
        }
        if (run.status !== "draft") throw generateError("One-time inputs can only be changed on a draft payroll run", 409);
        if (run.attendanceInputStatus !== "prepared") {
          throw generateError("Import employee attendance inputs before adding one-time payroll inputs", 409);
        }
        if (Number(run.version) !== expectedVersion) throw generateError("Payroll run changed. Refresh and try again", 409);

        const employeeInput: any = await PayrollEmployeeInput.findOne({
          company: companyObjectId,
          payrollRun: runId,
          employee: employeeId,
        }).session(session).lean();
        if (!employeeInput) throw generateError("Employee is not included in this payroll run", 409);
        const component: any = await SalaryComponent.findOne({
          _id: componentId,
          company: companyObjectId,
          status: "active",
        }).session(session).lean();
        if (!component) throw generateError("Active salary component not found", 404);
        const requiredCategory = oneTimeInputComponentCategory(inputType);
        if (component.category !== requiredCategory) {
          throw generateError(`${inputType} inputs require a ${requiredCategory.replace("_", " ")} component`, 422);
        }
        const [input]: any[] = await PayrollOneTimeInput.create([buildPayrollOneTimeInputDocument({
          run,
          employeeInput,
          component,
          actorId,
          inputType,
          amountMinor,
          reason,
          reference,
          idempotencyKey,
        })], { session });
        const delta = oneTimeInputRunDelta(inputType, amountMinor);
        const update = await PayrollRun.updateOne(
          { _id: runId, company: companyObjectId, status: "draft", version: expectedVersion },
          {
            $set: {
              calculationStatus: Number(run.calculationVersion || 0) > 0 ? "stale" : "pending",
            },
            $inc: {
              version: 1,
              oneTimeInputCount: 1,
              ...Object.fromEntries(Object.entries(delta).map(([key, value]) => [`oneTimeInputTotals.${key}`, value])),
            },
          },
          { session }
        );
        if (update.modifiedCount !== 1) throw generateError("Payroll run changed while the input was being added", 409);
        await writePayrollAudit({
          company: companyObjectId,
          entityType: "payroll_input",
          entityId: input._id,
          action: "created",
          actor: actorId,
          reason,
          details: {
            payrollRun: run._id,
            periodKey: run.periodKey,
            employee: employeeInput.employee,
            employeeCode: employeeInput.employeeCodeSnapshot,
            inputType,
            salaryComponent: component._id,
            componentCode: component.code,
            amountMinor,
            currency: run.currency,
            reference,
          },
        }, session);
        inputId = input._id;
        created = true;
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      const existing: any = await PayrollOneTimeInput.findOne({
        company: companyObjectId,
        payrollRun: runId,
        idempotencyKey,
      }).lean();
      if (!existing || !normalizedPayload || !sameIdempotentPayload(existing, normalizedPayload)) throw error;
      inputId = existing._id;
    }

    if (!inputId) throw generateError("One-time payroll input could not be created", 500);
    const [input, run] = await Promise.all([
      populatedInput(companyObjectId, inputId),
      populatedRun(companyObjectId, runId),
    ]);
    return res.status(created ? 201 : 200).json({
      success: true,
      message: created ? "One-time payroll input added" : "One-time payroll input already exists",
      data: { input, run },
    });
  } catch (error) {
    next(error);
  }
}

export async function cancelPayrollOneTimeInputService(req: any, res: Response, next: NextFunction) {
  try {
    ensurePayrollRunManager(req);
    const { companyObjectId } = await resolvePayrollCompany(
      req,
      req.body?.companyId,
      true,
      "cancel one-time inputs in this payroll run"
    );
    const actorId = getPayrollActorId(req);
    const runId = objectId(req.params.runId, "payroll run id");
    const inputId = objectId(req.params.inputId, "one-time payroll input id");
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw generateError("Expected payroll run version is required", 422);
    const cancellationReason = requiredReason(req.body?.reason, "Cancellation reason");
    let cancelled = false;

    await mongoose.connection.transaction(async (session) => {
      const run: any = await PayrollRun.findOne({ _id: runId, company: companyObjectId }).session(session).lean();
      const input: any = await PayrollOneTimeInput.findOne({
        _id: inputId,
        company: companyObjectId,
        payrollRun: runId,
      }).session(session).lean();
      if (!run) throw generateError("Payroll run not found", 404);
      if (!input) throw generateError("One-time payroll input not found", 404);
      if (input.status === "cancelled") return;
      if (run.status !== "draft") throw generateError("One-time inputs can only be changed on a draft payroll run", 409);
      if (Number(run.version) !== expectedVersion) throw generateError("Payroll run changed. Refresh and try again", 409);
      const cancelledAt = new Date();
      const inputUpdate = await PayrollOneTimeInput.updateOne(
        { _id: input._id, company: companyObjectId, status: "active" },
        { $set: { status: "cancelled", cancelledAt, cancelledBy: actorId, cancellationReason } },
        { session }
      );
      if (inputUpdate.modifiedCount !== 1) throw generateError("One-time payroll input changed. Refresh and try again", 409);
      const delta = oneTimeInputRunDelta(input.inputType, Number(input.amountMinor), -1);
      const runUpdate = await PayrollRun.updateOne(
        { _id: run._id, company: companyObjectId, status: "draft", version: expectedVersion },
        {
          $set: {
            calculationStatus: Number(run.calculationVersion || 0) > 0 ? "stale" : "pending",
          },
          $inc: {
            version: 1,
            oneTimeInputCount: -1,
            ...Object.fromEntries(Object.entries(delta).map(([key, value]) => [`oneTimeInputTotals.${key}`, value])),
          },
        },
        { session }
      );
      if (runUpdate.modifiedCount !== 1) throw generateError("Payroll run changed while the input was being cancelled", 409);
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "payroll_input",
        entityId: input._id,
        action: "cancelled",
        actor: actorId,
        reason: cancellationReason,
        details: {
          payrollRun: run._id,
          periodKey: run.periodKey,
          employee: input.employee,
          employeeCode: input.employeeCodeSnapshot,
          inputType: input.inputType,
          componentCode: input.componentCodeSnapshot,
          amountMinor: input.amountMinor,
          currency: input.currency,
        },
      }, session);
      cancelled = true;
    });

    const [input, run] = await Promise.all([
      populatedInput(companyObjectId, inputId),
      populatedRun(companyObjectId, runId),
    ]);
    return res.status(200).json({
      success: true,
      message: cancelled ? "One-time payroll input cancelled" : "One-time payroll input was already cancelled",
      data: { input, run },
    });
  } catch (error) {
    next(error);
  }
}
