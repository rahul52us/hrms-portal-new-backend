import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import Company from "../../schemas/company/Company";
import EmployeeCompensationAssignment from "../../schemas/Payroll/EmployeeCompensationAssignment.schema";
import SalaryStructure from "../../schemas/Payroll/SalaryStructure.schema";
import SalaryStructureVersion from "../../schemas/Payroll/SalaryStructureVersion.schema";
import User from "../../schemas/User/User";
import {
  ensureEmployeeCompensationManager,
  getPayrollActor,
  getPayrollActorId,
  normalizePayrollRole,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";
import { calculateSalaryStructurePreview } from "./salaryStructureCalculator";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const payrollTimezone = process.env.PAYROLL_TIMEZONE || "Asia/Kolkata";

function dateKey(value: Date | string | null | undefined) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function todayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: payrollTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const SELF_VISIBLE_TOTALS = [
  "monthlyGrossMinor",
  "monthlyDeductionsMinor",
  "monthlyReimbursementsMinor",
  "monthlyEmployerContributionsMinor",
  "monthlyNetMinor",
  "monthlyEmployerCostMinor",
  "annualGrossMinor",
  "annualDeductionsMinor",
  "annualReimbursementsMinor",
  "annualEmployerContributionsMinor",
  "annualNetMinor",
  "annualEmployerCostMinor",
] as const;

export function serializeEmployeeCompensationAssignment(assignment: any) {
  const totals = Object.fromEntries(
    SELF_VISIBLE_TOTALS.map((key) => [key, Number(assignment?.totals?.[key] || 0)])
  );
  return {
    structureName: String(assignment?.structureNameSnapshot || ""),
    structureCode: String(assignment?.structureCodeSnapshot || ""),
    versionNumber: Number(assignment?.structureVersionNumber || 0),
    currency: String(assignment?.currency || "INR"),
    currencyMinorUnits: Number(assignment?.currencyMinorUnits ?? 2),
    payFrequency: "monthly" as const,
    effectiveFrom: dateKey(assignment?.effectiveFrom),
    effectiveTo: assignment?.effectiveTo ? dateKey(assignment.effectiveTo) : null,
    components: (Array.isArray(assignment?.componentAmounts) ? assignment.componentAmounts : []).map((component: any) => ({
      code: String(component?.componentCodeSnapshot || ""),
      name: String(component?.componentNameSnapshot || ""),
      category: String(component?.categorySnapshot || ""),
      monthlyAmountMinor: Number(component?.monthlyAmountMinor || 0),
      annualAmountMinor: Number(component?.annualAmountMinor || 0),
      overridden: component?.overridden === true,
    })),
    totals,
  };
}

export function buildEmployeeCompensationProfile(
  assignments: any[],
  visibility: "hidden" | "current" | "history",
  asOf: string
) {
  if (visibility === "hidden") return { currentAssignment: null, history: [] };
  const eligibleAssignments = assignments.filter((assignment) =>
    assignment?.status === "assigned" && dateKey(assignment?.effectiveFrom) <= asOf
  );
  const effectiveAssignments = deriveCompensationAssignmentRanges(eligibleAssignments, asOf);
  const current = effectiveAssignments.find((assignment) => assignment.isCurrent) || null;
  const history = visibility === "history"
    ? effectiveAssignments
        .filter((assignment) => !assignment.isCurrent)
        .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))
        .map(serializeEmployeeCompensationAssignment)
    : [];
  return {
    currentAssignment: current ? serializeEmployeeCompensationAssignment(current) : null,
    history,
  };
}

export function parseCompensationDate(value: unknown, label: string) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw generateError(`${label} must use YYYY-MM-DD`, 422);
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || dateKey(date) !== raw) throw generateError(`Invalid ${label}`, 422);
  return date;
}

function priorDateKey(value: Date | string) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() - 1);
  return dateKey(date);
}

export function deriveCompensationAssignmentRanges(assignments: any[], asOf = todayKey()) {
  const assigned = assignments
    .filter((item) => item.status === "assigned")
    .sort((left, right) => dateKey(left.effectiveFrom).localeCompare(dateKey(right.effectiveFrom)));
  const endById = new Map<string, string | null>();
  assigned.forEach((item, index) => {
    const next = assigned[index + 1];
    endById.set(String(item._id), next ? priorDateKey(next.effectiveFrom) : null);
  });

  return assignments.map((item) => {
    const effectiveFrom = dateKey(item.effectiveFrom);
    const effectiveTo = item.status === "assigned" ? endById.get(String(item._id)) || null : null;
    return {
      ...item,
      effectiveFrom,
      effectiveTo,
      isCurrent: item.status === "assigned" && effectiveFrom <= asOf && (!effectiveTo || effectiveTo >= asOf),
      isUpcoming: item.status === "assigned" && effectiveFrom > asOf,
    };
  });
}

async function findEmployee(company: mongoose.Types.ObjectId, employeeIdInput: unknown) {
  const employeeId = String(employeeIdInput || "").trim();
  if (!mongoose.Types.ObjectId.isValid(employeeId)) throw generateError("Invalid employee id", 400);
  const employee = await User.findOne({
    _id: new mongoose.Types.ObjectId(employeeId),
    company,
    deletedAt: null,
  })
    .select("_id name username code employeeNumber designation role joiningDate employmentEndDate is_enabled pic")
    .lean();
  if (!employee) throw generateError("Employee not found", 404);
  return employee;
}

async function findPublishedVersion(company: mongoose.Types.ObjectId, versionIdInput: unknown) {
  const versionId = String(versionIdInput || "").trim();
  if (!mongoose.Types.ObjectId.isValid(versionId)) throw generateError("Invalid salary structure version id", 400);
  const version = await SalaryStructureVersion.findOne({
    _id: new mongoose.Types.ObjectId(versionId),
    company,
    status: "published",
  }).lean();
  if (!version) throw generateError("Published salary structure version not found", 404);
  const structure = await SalaryStructure.findOne({
    _id: version.salaryStructure,
    company,
  }).lean();
  if (!structure) throw generateError("Salary structure not found", 404);
  return { structure, version };
}

export function validateCompensationVersionEffectiveOn(version: any, effectiveFrom: Date) {
  const requested = dateKey(effectiveFrom);
  const starts = dateKey(version.effectiveFrom);
  const ends = dateKey(version.effectiveTo);
  if (!starts || requested < starts || (ends && requested > ends)) {
    throw generateError(
      `Salary structure version ${version.versionNumber} is not effective on ${requested}`,
      409
    );
  }
}

export function validateCompensationEmployeeDates(employee: any, effectiveFrom: Date) {
  const requested = dateKey(effectiveFrom);
  const joining = dateKey(employee.joiningDate);
  const ending = dateKey(employee.employmentEndDate);
  if (joining && requested < joining) throw generateError("Compensation cannot start before the employee joining date", 409);
  if (ending && requested > ending) throw generateError("Compensation cannot start after the employee employment end date", 409);
}

function normalizeOverrides(version: any, input: any) {
  const items = Array.isArray(input) ? input : [];
  if (items.length > version.rules.length) throw generateError("Too many employee compensation overrides", 422);
  const ruleById = new Map(version.rules.map((rule: any) => [String(rule.salaryComponent), rule]));
  const seen = new Set<string>();
  const overrideMap: Record<string, number> = {};
  const overrides = items.map((item: any) => {
    const componentId = String(item?.salaryComponent || item?.salaryComponentId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(componentId)) throw generateError("Invalid override salary component", 422);
    if (seen.has(componentId)) throw generateError("A salary component can be overridden only once", 422);
    seen.add(componentId);
    const rule: any = ruleById.get(componentId);
    if (!rule) throw generateError("An override references a component outside this salary structure", 422);
    if (!rule.allowEmployeeOverride) throw generateError(`${rule.componentNameSnapshot} does not allow employee-specific overrides`, 409);
    const monthlyAmountMinor = Number(item?.monthlyAmountMinor);
    if (!Number.isSafeInteger(monthlyAmountMinor) || monthlyAmountMinor < 0) {
      throw generateError(`${rule.componentNameSnapshot} override must be a non-negative minor-unit integer`, 422);
    }
    overrideMap[componentId] = monthlyAmountMinor;
    return {
      salaryComponent: new mongoose.Types.ObjectId(componentId),
      componentCodeSnapshot: rule.componentCodeSnapshot,
      componentNameSnapshot: rule.componentNameSnapshot,
      monthlyAmountMinor,
    };
  });
  return { overrides, overrideMap };
}

export function buildCompensationSnapshot(version: any, overrideInput: any) {
  const { overrides, overrideMap } = normalizeOverrides(version, overrideInput);
  let preview;
  try {
    preview = calculateSalaryStructurePreview(version.rules as any, version.roundingMode, overrideMap);
  } catch (error: any) {
    throw generateError(error?.message || "Invalid employee compensation calculation", 422);
  }
  const ruleById = new Map(version.rules.map((rule: any) => [String(rule.salaryComponent), rule]));
  const componentAmounts = preview.componentAmounts.map((amount) => {
    const rule: any = ruleById.get(amount.salaryComponent);
    return {
      salaryComponent: new mongoose.Types.ObjectId(amount.salaryComponent),
      componentCodeSnapshot: amount.code,
      componentNameSnapshot: amount.name,
      categorySnapshot: amount.category,
      taxableSnapshot: Boolean(rule.taxableSnapshot),
      prorateOnUnpaidDaysSnapshot: Boolean(rule.prorateOnUnpaidDaysSnapshot),
      monthlyAmountMinor: amount.monthlyAmountMinor,
      annualAmountMinor: amount.annualAmountMinor,
      overridden: overrideMap[amount.salaryComponent] !== undefined,
    };
  });
  const { componentAmounts: _calculatedComponents, ...totals } = preview;
  return { overrides, componentAmounts, totals };
}

export async function listCompensationEmployeesService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query.companyId);
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "20"), 10) || 20));
    const search = String(req.query.search || "").trim();
    const assignmentStatus = String(req.query.assignmentStatus || "all").trim().toLowerCase();
    if (!['all', 'assigned', 'unassigned', 'scheduled'].includes(assignmentStatus)) {
      throw generateError("Invalid compensation assignment status filter", 422);
    }

    const match: any = { company: companyObjectId, deletedAt: null, role: { $ne: "superadmin" } };
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      match.$or = [{ name: regex }, { code: regex }, { username: regex }, { designation: regex }];
    }

    const asOf = todayKey();
    const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
    const statusMatch: any = assignmentStatus === "assigned"
      ? { "currentAssignments.0": { $exists: true } }
      : assignmentStatus === "scheduled"
        ? { "upcomingAssignments.0": { $exists: true } }
        : assignmentStatus === "unassigned"
          ? {
              "currentAssignments.0": { $exists: false },
              "upcomingAssignments.0": { $exists: false },
            }
          : null;
    const pipeline: mongoose.PipelineStage[] = [
      { $match: match },
      {
        $project: {
          name: 1,
          username: 1,
          code: 1,
          designation: 1,
          role: 1,
          is_enabled: 1,
          pic: 1,
          joiningDate: 1,
          employmentEndDate: 1,
          company: 1,
        },
      },
      {
        $lookup: {
          from: EmployeeCompensationAssignment.collection.name,
          let: { employeeId: "$_id", companyId: "$company" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$employee", "$$employeeId"] },
                    { $eq: ["$company", "$$companyId"] },
                    { $eq: ["$status", "assigned"] },
                  ],
                },
              },
            },
            { $sort: { effectiveFrom: 1 } },
          ],
          as: "compensationAssignments",
        },
      },
      {
        $addFields: {
          currentAssignments: {
            $filter: {
              input: "$compensationAssignments",
              as: "assignment",
              cond: { $lte: ["$$assignment.effectiveFrom", asOfDate] },
            },
          },
          upcomingAssignments: {
            $filter: {
              input: "$compensationAssignments",
              as: "assignment",
              cond: { $gt: ["$$assignment.effectiveFrom", asOfDate] },
            },
          },
        },
      },
      ...(statusMatch ? [{ $match: statusMatch } as mongoose.PipelineStage.Match] : []),
      {
        $facet: {
          data: [
            { $sort: { name: 1, _id: 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
          ],
          metadata: [{ $count: "total" }],
        },
      },
    ];
    const [result] = await User.aggregate(pipeline);
    const employees = result?.data || [];
    const total = result?.metadata?.[0]?.total || 0;
    const rows = employees.map((employee: any) => {
      const history = deriveCompensationAssignmentRanges(employee.compensationAssignments || [], asOf);
      const { compensationAssignments: _assignments, currentAssignments: _current, upcomingAssignments: _upcoming, ...employeeData } = employee;
      return {
        ...employeeData,
        currentAssignment: history.find((item) => item.isCurrent) || null,
        upcomingAssignment: history.filter((item) => item.isUpcoming).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0] || null,
      };
    });
    return res.status(200).json({
      success: true,
      data: rows,
      asOf,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
}

export async function getEmployeeCompensationHistoryService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query.companyId);
    const employee = await findEmployee(companyObjectId, req.params.employeeId);
    const assignments = await EmployeeCompensationAssignment.find({ company: companyObjectId, employee: employee._id })
      .sort({ effectiveFrom: -1, createdAt: -1 })
      .populate("createdBy cancelledBy", "name username code")
      .lean();
    return res.status(200).json({ success: true, data: { employee, assignments: deriveCompensationAssignmentRanges(assignments) } });
  } catch (error) {
    next(error);
  }
}

export async function getMyCompensationService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getPayrollActor(req);
    if (normalizePayrollRole(actor?.role) === "superadmin") {
      throw generateError("Superadmin does not have an employee compensation profile", 403);
    }
    const actorId = getPayrollActorId(req);
    const { companyObjectId } = await resolvePayrollCompany(req);
    const company = await Company.findById(companyObjectId)
      .select("payrollSettings.employeeCompensationVisibility")
      .lean();
    if (!company) throw generateError("Company not found", 404);

    const configuredVisibility = String(company?.payrollSettings?.employeeCompensationVisibility || "hidden");
    const visibility = (["current", "history"].includes(configuredVisibility)
      ? configuredVisibility
      : "hidden") as "hidden" | "current" | "history";
    const asOf = todayKey();

    if (visibility === "hidden") {
      return res.status(200).json({
        success: true,
        data: { visibility, asOf, currentAssignment: null, history: [] },
      });
    }

    const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
    const assignments = await EmployeeCompensationAssignment.find({
      company: companyObjectId,
      employee: actorId,
      status: "assigned",
      effectiveFrom: { $lte: asOfDate },
    })
      .sort({ effectiveFrom: 1 })
      .lean();
    const profile = buildEmployeeCompensationProfile(assignments, visibility, asOf);

    return res.status(200).json({
      success: true,
      data: {
        visibility,
        asOf,
        ...profile,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function previewEmployeeCompensationService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId);
    const { structure, version } = await findPublishedVersion(companyObjectId, req.body?.salaryStructureVersionId);
    const effectiveFrom = parseCompensationDate(req.body?.effectiveFrom, "Compensation effective-from date");
    validateCompensationVersionEffectiveOn(version, effectiveFrom);
    const snapshot = buildCompensationSnapshot(version, req.body?.overrides);
    return res.status(200).json({
      success: true,
      data: {
        structure: { _id: structure._id, name: structure.name, code: structure.code },
        version: { _id: version._id, versionNumber: version.versionNumber, currency: version.currency, currencyMinorUnits: version.currencyMinorUnits },
        ...snapshot,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function createEmployeeCompensationAssignmentService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const employee = await findEmployee(companyObjectId, req.body?.employeeId);
    const { structure, version } = await findPublishedVersion(companyObjectId, req.body?.salaryStructureVersionId);
    if (structure.status !== "active") throw generateError("Archived salary structures cannot be assigned", 409);
    const effectiveFrom = parseCompensationDate(req.body?.effectiveFrom, "Compensation effective-from date");
    validateCompensationVersionEffectiveOn(version, effectiveFrom);
    validateCompensationEmployeeDates(employee, effectiveFrom);
    const assignmentReason = String(req.body?.assignmentReason || "").trim();
    if (assignmentReason.length < 3 || assignmentReason.length > 500) {
      throw generateError("Assignment reason must be between 3 and 500 characters", 422);
    }
    const snapshot = buildCompensationSnapshot(version, req.body?.overrides);
    let assignment: any;

    await mongoose.connection.transaction(async (session) => {
      const duplicate = await EmployeeCompensationAssignment.exists({
        company: companyObjectId,
        employee: employee._id,
        effectiveFrom,
        status: "assigned",
      }).session(session);
      if (duplicate) throw generateError("This employee already has a compensation assignment starting on this date", 409);

      [assignment] = await EmployeeCompensationAssignment.create([{
        company: companyObjectId,
        employee: employee._id,
        employeeNameSnapshot: employee.name || employee.username,
        employeeCodeSnapshot: employee.code,
        salaryStructure: structure._id,
        salaryStructureVersion: version._id,
        structureNameSnapshot: structure.name,
        structureCodeSnapshot: structure.code,
        structureVersionNumber: version.versionNumber,
        structureEffectiveFromSnapshot: version.effectiveFrom,
        structureEffectiveToSnapshot: version.effectiveTo || null,
        currency: version.currency,
        currencyMinorUnits: version.currencyMinorUnits,
        payFrequency: version.payFrequency,
        roundingMode: version.roundingMode,
        effectiveFrom,
        status: "assigned",
        assignmentReason,
        ...snapshot,
        createdBy: actorId,
      }], { session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "employee_compensation",
        entityId: assignment._id,
        action: "assigned",
        actor: actorId,
        reason: assignmentReason,
        details: {
          employee: employee._id,
          employeeCode: employee.code,
          salaryStructure: structure._id,
          salaryStructureVersion: version._id,
          versionNumber: version.versionNumber,
          effectiveFrom,
          totals: snapshot.totals,
        },
      }, session);
    });

    return res.status(201).json({ success: true, data: assignment, message: "Employee compensation assigned" });
  } catch (error: any) {
    if (error?.code === 11000) return next(generateError("This employee already has a compensation assignment starting on this date", 409));
    next(error);
  }
}

export async function cancelFutureCompensationAssignmentService(req: any, res: Response, next: NextFunction) {
  try {
    ensureEmployeeCompensationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const assignmentId = String(req.params.assignmentId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) throw generateError("Invalid compensation assignment id", 400);
    const assignment = await EmployeeCompensationAssignment.findOne({
      _id: new mongoose.Types.ObjectId(assignmentId),
      company: companyObjectId,
      status: "assigned",
    });
    if (!assignment) throw generateError("Active compensation assignment not found", 404);
    if (dateKey(assignment.effectiveFrom) <= todayKey()) {
      throw generateError("Only a future compensation assignment can be cancelled. Create a new effective-dated assignment for active compensation changes.", 409);
    }
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 3 || reason.length > 500) throw generateError("Cancellation reason must be between 3 and 500 characters", 422);
    assignment.status = "cancelled";
    assignment.cancelledAt = new Date();
    assignment.cancelledBy = actorId;
    assignment.cancellationReason = reason;

    await mongoose.connection.transaction(async (session) => {
      await assignment.save({ session });
      await writePayrollAudit({
        company: companyObjectId,
        entityType: "employee_compensation",
        entityId: assignment._id as mongoose.Types.ObjectId,
        action: "future_assignment_cancelled",
        actor: actorId,
        reason,
        details: { employee: assignment.employee, effectiveFrom: assignment.effectiveFrom },
      }, session);
    });
    return res.status(200).json({ success: true, data: assignment, message: "Future compensation assignment cancelled" });
  } catch (error) {
    next(error);
  }
}
