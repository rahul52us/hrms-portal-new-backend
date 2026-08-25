import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import CompOffClaim from "../../schemas/CompOff/CompOffClaim.schema";
import CompOffCreditLot from "../../schemas/CompOff/CompOffCreditLot.schema";
import User from "../../schemas/User/User";
import LeavePolicyVersion from "../../schemas/WorkforcePolicy/LeavePolicyVersion.schema";
import LeaveType from "../../schemas/WorkforcePolicy/LeaveType.schema";
import { resolveEmployeeDayContext } from "../attendance/employeeDayContext.service";
import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";
import {
  buildLeaveRequestScope,
  getLeaveActor,
  isEmployeeInActorScope,
  resolveLeaveCompanyId,
} from "../leave/leaveAccess.utils";
import { postLeaveBalanceTransaction } from "../leave/leaveBalance.service";
import { resolveLeaveYear } from "../leave/leaveRequestCalculator.utils";
import { PERMISSION_KEYS, hasPermission } from "../permissions/permission.utils";
import { expireCompOffCredits } from "./compOffCredit.service";
import {
  calculateCompOffEligibleUnits,
  calculateCompOffExpiryDate,
} from "./compOffClaim.utils";

function text(value: unknown) {
  return String(value || "").trim();
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function pagination(query: any) {
  const page = Math.max(1, Number(query?.page || 1));
  const limit = Math.max(1, Math.min(50, Number(query?.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

function claimEvent(actor: any, action: string, comment?: string) {
  return {
    action,
    actor: actor._id,
    actorRole: actor.role,
    comment: text(comment) || undefined,
    at: new Date(),
  };
}

function populateClaim(query: any) {
  return query
    .populate("employee", "name username code role department team officeLocation designation reportingManager")
    .populate("leaveType", "name code color unit paid balanceTracked")
    .populate("approver", "name username code role designation")
    .populate("history.actor", "name username role");
}

async function loadEmployee(company: mongoose.Types.ObjectId, employeeId: mongoose.Types.ObjectId) {
  const employee = await User.findOne({
    _id: employeeId,
    company,
    deletedAt: { $exists: false },
    is_enabled: { $ne: false },
  })
    .select("_id company name username code role department team officeLocation reportingManager")
    .lean();
  if (!employee) throw generateError("Employee not found or disabled", 404);
  return employee;
}

async function resolveEligibility(options: {
  company: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  attendanceDate: string;
  leaveTypeId?: mongoose.Types.ObjectId;
}) {
  const attendanceDate = parseAttendanceDate(options.attendanceDate).dateKey;
  if (attendanceDate > currentDateKey()) {
    throw generateError("Comp-off cannot be claimed for a future attendance date", 422);
  }
  const [employee, context, record] = await Promise.all([
    loadEmployee(options.company, options.employeeId),
    resolveEmployeeDayContext({
      companyId: options.company,
      employeeId: options.employeeId,
      attendanceDate,
    }),
    AttendanceRecord.findOne({
      company: options.company,
      employee: options.employeeId,
      attendanceDate,
    }).lean(),
  ]);
  const leaveResolution = context.policies?.leavePolicy;
  if (!leaveResolution?.version || !leaveResolution?.assignment) {
    throw generateError("No leave policy is effective for the attendance date", 422);
  }
  const earnedRules = (leaveResolution.version.rules || []).filter(
    (rule: any) =>
      rule.entitlementMode === "earned" &&
      (!options.leaveTypeId || String(rule.leaveType) === String(options.leaveTypeId))
  );
  if (!earnedRules.length) {
    throw generateError("No earned comp-off leave type is configured for this employee and date", 422);
  }
  if (!record) throw generateError("No attendance record exists for the selected date", 422);
  const dayType = record.dayTypeSnapshot || context.dayType;
  if (!["weekly_off", "mandatory_holiday"].includes(dayType)) {
    throw generateError("Comp-off can be earned only for work on a weekly off or mandatory holiday", 422);
  }
  if (record.state === "open" || record.hasMissingPunch) {
    throw generateError("Complete the punch session before claiming comp-off", 422);
  }

  const leaveTypes = await LeaveType.find({
    company: options.company,
    _id: { $in: earnedRules.map((rule: any) => rule.leaveType) },
    status: "active",
  }).lean();
  const leaveTypeById = new Map(leaveTypes.map((item) => [String(item._id), item]));
  const existingClaims = await CompOffClaim.find({
    company: options.company,
    employee: options.employeeId,
    attendanceDate,
    leaveType: { $in: earnedRules.map((rule: any) => rule.leaveType) },
    status: { $in: ["submitted", "approved"] },
  })
    .select("leaveType status requestedUnits approvedUnits")
    .lean();
  const claimByType = new Map(existingClaims.map((claim) => [String(claim.leaveType), claim]));
  const workedMinutes = Number(record.workedMinutes || 0);
  const items = earnedRules.map((rule: any) => {
    const fullThreshold = Number(rule.compOffFullDayMinutes || 480);
    const halfThreshold = Number(rule.compOffHalfDayMinutes || 240);
    const eligibleUnits = calculateCompOffEligibleUnits({
      workedMinutes,
      fullDayMinutes: fullThreshold,
      halfDayMinutes: halfThreshold,
    });
    return {
      leaveType: leaveTypeById.get(String(rule.leaveType)) || {
        _id: rule.leaveType,
        name: rule.leaveTypeNameSnapshot,
        code: rule.leaveTypeCodeSnapshot,
        unit: "days",
      },
      rule,
      eligibleUnits,
      existingClaim: claimByType.get(String(rule.leaveType)) || null,
    };
  });
  return { employee, attendanceDate, context, record, dayType, items };
}

function ensureCanApproveClaim(actor: any, claim: any) {
  if (String(claim.employee?._id || claim.employee) === String(actor._id)) {
    throw generateError("You cannot approve your own comp-off claim", 403);
  }
  if (String(claim.approver?._id || claim.approver || "") === String(actor._id)) return;
  const employee = {
    _id: claim.employee?._id || claim.employee,
    department: claim.departmentNameSnapshot,
    team: claim.teamNameSnapshot,
    officeLocation: claim.officeLocation,
  };
  if (
    !hasPermission(actor, PERMISSION_KEYS.APPROVE_LEAVE_REQUESTS) ||
    !isEmployeeInActorScope(actor, employee, PERMISSION_KEYS.APPROVE_LEAVE_REQUESTS)
  ) {
    throw generateError("You cannot approve comp-off for this employee", 403);
  }
}

export async function getCompOffEligibilityService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const employeeId = objectId(req.query?.employeeId || actor._id, "employee id");
    if (String(employeeId) !== String(actor._id)) {
      const employee = await loadEmployee(company, employeeId);
      if (!isEmployeeInActorScope(actor, employee, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS)) {
        throw generateError("You cannot view comp-off eligibility for this employee", 403);
      }
    }
    const result = await resolveEligibility({
      company,
      employeeId,
      attendanceDate: text(req.query?.attendanceDate),
      leaveTypeId: req.query?.leaveTypeId ? objectId(req.query.leaveTypeId, "leave type id") : undefined,
    });
    return res.status(200).json({
      success: true,
      data: {
        employee: result.employee,
        attendanceDate: result.attendanceDate,
        dayType: result.dayType,
        workedMinutes: result.record.workedMinutes,
        attendanceState: result.record.state,
        items: result.items,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function createCompOffClaimService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId);
    const employeeId = objectId(req.body?.employeeId || actor._id, "employee id");
    if (String(employeeId) !== String(actor._id)) {
      throw generateError("Employees must submit their own comp-off claims", 403);
    }
    const leaveTypeId = objectId(req.body?.leaveTypeId, "leave type id");
    const reason = text(req.body?.reason);
    if (reason.length < 3) throw generateError("Comp-off claim reason must be at least 3 characters", 422);
    const requestedUnits = Number(req.body?.requestedUnits);
    if (![0.5, 1].includes(requestedUnits)) {
      throw generateError("Comp-off claim units must be 0.5 or 1 day", 422);
    }
    const result = await resolveEligibility({
      company,
      employeeId,
      attendanceDate: text(req.body?.attendanceDate),
      leaveTypeId,
    });
    const eligible = result.items[0];
    if (!eligible || eligible.eligibleUnits !== requestedUnits) {
      throw generateError(`This attendance record earns exactly ${eligible?.eligibleUnits || 0} comp-off day`, 422);
    }
    if (eligible.existingClaim) throw generateError("An active comp-off claim already exists for this date", 409);
    const manager = result.employee.reportingManager
      ? await User.findOne({
          _id: result.employee.reportingManager,
          company,
          deletedAt: { $exists: false },
          is_enabled: { $ne: false },
        }).select("_id name").lean()
      : null;
    const assignment = result.context.organizationAssignment || {};
    const reference = result.context.policyReferences.leavePolicy;
    const claim = await CompOffClaim.create({
      company,
      employee: employeeId,
      leaveType: leaveTypeId,
      attendanceDate: result.attendanceDate,
      attendanceRecord: result.record._id,
      dayTypeSnapshot: result.dayType,
      workedMinutesSnapshot: Number(result.record.workedMinutes || 0),
      requestedUnits,
      eligibleUnitsSnapshot: eligible.eligibleUnits,
      approvedUnits: 0,
      reason,
      status: "submitted",
      approver: manager?._id || null,
      approverNameSnapshot: manager?.name || "",
      departmentNameSnapshot: assignment.departmentNameSnapshot || result.employee.department || "",
      teamNameSnapshot: assignment.teamNameSnapshot || result.employee.team || "",
      officeLocation: assignment.officeLocation || result.employee.officeLocation || null,
      officeLocationNameSnapshot: assignment.officeLocationNameSnapshot || "",
      leavePolicyAssignment: objectId(reference?.assignmentId, "leave policy assignment id"),
      leavePolicy: objectId(reference?.resourceId, "leave policy id"),
      leavePolicyVersion: objectId(reference?.versionId, "leave policy version id"),
      leavePolicyVersionNumber: Number(reference?.versionNumber || 1),
      policyScopeNameSnapshot:
        result.context.policies.leavePolicy?.assignment?.scopeNameSnapshot || "",
      history: [claimEvent(actor, "submitted")],
      submittedAt: new Date(),
      createdBy: actor._id,
    });
    const populated = await populateClaim(CompOffClaim.findById(claim._id));
    return res.status(201).json({ success: true, data: populated, message: "Comp-off claim submitted" });
  } catch (error: any) {
    if (error?.code === 11000) {
      next(generateError("An active comp-off claim already exists for this date", 409));
      return;
    }
    next(error);
  }
}

export async function listCompOffClaimsService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const { page, limit, skip } = pagination(req.query);
    const scope = text(req.query?.scope || "self");
    const match: any = { company };
    if (scope === "self") match.employee = actor._id;
    else if (scope === "approvals") match.approver = actor._id;
    else Object.assign(match, buildLeaveRequestScope(actor, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS));
    const status = text(req.query?.status);
    if (["submitted", "approved", "rejected", "withdrawn", "revoked"].includes(status)) match.status = status;
    const [items, total] = await Promise.all([
      populateClaim(CompOffClaim.find(match).sort({ submittedAt: -1 }).skip(skip).limit(limit)),
      CompOffClaim.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    next(error);
  }
}

export async function getCompOffClaimService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const claim = await populateClaim(CompOffClaim.findOne({
      _id: objectId(req.params.claimId, "comp-off claim id"),
      company,
    }));
    if (!claim) throw generateError("Comp-off claim not found", 404);
    const employee = {
      _id: claim.employee?._id || claim.employee,
      department: claim.departmentNameSnapshot,
      team: claim.teamNameSnapshot,
      officeLocation: claim.officeLocation,
    };
    if (
      String(claim.approver?._id || claim.approver || "") !== String(actor._id) &&
      !isEmployeeInActorScope(actor, employee, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS)
    ) {
      throw generateError("You cannot view this comp-off claim", 403);
    }
    return res.status(200).json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
}

export async function approveCompOffClaimService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const claimId = objectId(req.params.claimId, "comp-off claim id");
    const candidate = await CompOffClaim.findOne({ _id: claimId, company }).lean();
    if (!candidate) throw generateError("Comp-off claim not found", 404);
    ensureCanApproveClaim(actor, candidate);

    await mongoose.connection.transaction(async (session) => {
      const claim = await CompOffClaim.findOne({ _id: claimId, company, status: "submitted" }).session(session);
      if (!claim) throw generateError("Only a submitted comp-off claim can be approved", 409);
      const [record, version] = await Promise.all([
        AttendanceRecord.findOne({
          _id: claim.attendanceRecord,
          company,
          employee: claim.employee,
          attendanceDate: claim.attendanceDate,
        }).session(session),
        LeavePolicyVersion.findOne({
          _id: claim.leavePolicyVersion,
          company,
          policy: claim.leavePolicy,
          status: "published",
        }).session(session),
      ]);
      if (!record || record.state === "open" || record.hasMissingPunch) {
        throw generateError("Attendance evidence is missing or incomplete", 409);
      }
      const rule: any = version?.rules?.find((item: any) => String(item.leaveType) === String(claim.leaveType));
      if (!version || !rule || rule.entitlementMode !== "earned") {
        throw generateError("The historical comp-off policy rule is unavailable", 409);
      }
      const workedMinutes = Number(record.workedMinutes || 0);
      const eligibleUnits = calculateCompOffEligibleUnits({
        workedMinutes,
        fullDayMinutes: Number(rule.compOffFullDayMinutes || 480),
        halfDayMinutes: Number(rule.compOffHalfDayMinutes || 240),
      });
      if (eligibleUnits !== claim.requestedUnits) {
        throw generateError("Current attendance evidence no longer supports the claimed units", 409);
      }
      const leaveYear = resolveLeaveYear(
        claim.attendanceDate,
        Number(version.leaveYearStartMonth || 1),
        Number(version.leaveYearStartDay || 1)
      );
      const expiresOn = calculateCompOffExpiryDate({
        earnedDate: claim.attendanceDate,
        validityDays: Number(rule.compOffValidityDays || 90),
        leaveYearEnd: leaveYear.leaveYearEnd,
      });
      if (expiresOn < currentDateKey()) throw generateError("This comp-off earning claim has already expired", 409);

      const [lot] = await CompOffCreditLot.create([
        {
          company,
          employee: claim.employee,
          leaveType: claim.leaveType,
          claim: claim._id,
          attendanceRecord: claim.attendanceRecord,
          earnedDate: claim.attendanceDate,
          expiresOn,
          ...leaveYear,
          originalUnits: claim.requestedUnits,
          availableUnits: claim.requestedUnits,
          reservedUnits: 0,
          consumedUnits: 0,
          expiredUnits: 0,
          status: "active",
          leavePolicyAssignment: claim.leavePolicyAssignment,
          leavePolicy: claim.leavePolicy,
          leavePolicyVersion: claim.leavePolicyVersion,
          createdBy: actor._id,
        },
      ], { session });
      const transaction = await postLeaveBalanceTransaction({
        key: {
          company,
          employee: claim.employee,
          leaveType: claim.leaveType,
          ...leaveYear,
        },
        units: claim.requestedUnits,
        transactionType: "comp_off_credit",
        sourceType: "comp_off_claim",
        sourceId: claim._id,
        effectiveDate: claim.attendanceDate,
        idempotencyKey: `comp-off-claim:${claim._id}:credit`,
        reason: `Approved comp-off earned on ${claim.attendanceDate}`,
        leavePolicyAssignment: claim.leavePolicyAssignment,
        leavePolicy: claim.leavePolicy,
        leavePolicyVersion: claim.leavePolicyVersion,
        compOffCreditLot: lot._id as mongoose.Types.ObjectId,
        createdBy: actor._id,
        session,
      });
      lot.creditTransaction = transaction._id as mongoose.Types.ObjectId;
      await lot.save({ session });
      claim.status = "approved";
      claim.approvedUnits = claim.requestedUnits;
      claim.expiresOn = expiresOn;
      claim.decidedAt = new Date();
      claim.decidedBy = actor._id;
      claim.decisionComment = text(req.body?.comment);
      claim.history.push(claimEvent(actor, "approved", req.body?.comment) as any);
      await claim.save({ session });
    });
    const updated = await populateClaim(CompOffClaim.findById(claimId));
    return res.status(200).json({ success: true, data: updated, message: "Comp-off claim approved and credited" });
  } catch (error) {
    next(error);
  }
}

export async function rejectCompOffClaimService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const claimId = objectId(req.params.claimId, "comp-off claim id");
    const candidate = await CompOffClaim.findOne({ _id: claimId, company }).lean();
    if (!candidate) throw generateError("Comp-off claim not found", 404);
    ensureCanApproveClaim(actor, candidate);
    const comment = text(req.body?.comment);
    if (comment.length < 3) throw generateError("A rejection reason is required", 422);
    const claim = await CompOffClaim.findOneAndUpdate(
      { _id: claimId, company, status: "submitted" },
      {
        $set: { status: "rejected", decidedAt: new Date(), decidedBy: actor._id, decisionComment: comment },
        $push: { history: claimEvent(actor, "rejected", comment) },
      },
      { new: true, runValidators: true }
    );
    if (!claim) throw generateError("Only a submitted comp-off claim can be rejected", 409);
    const updated = await populateClaim(CompOffClaim.findById(claimId));
    return res.status(200).json({ success: true, data: updated, message: "Comp-off claim rejected" });
  } catch (error) {
    next(error);
  }
}

export async function withdrawCompOffClaimService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const claimId = objectId(req.params.claimId, "comp-off claim id");
    const claim = await CompOffClaim.findOneAndUpdate(
      { _id: claimId, company, employee: actor._id, status: "submitted" },
      {
        $set: { status: "withdrawn" },
        $push: { history: claimEvent(actor, "withdrawn", req.body?.comment) },
      },
      { new: true, runValidators: true }
    );
    if (!claim) throw generateError("Only your submitted comp-off claim can be withdrawn", 409);
    const updated = await populateClaim(CompOffClaim.findById(claimId));
    return res.status(200).json({ success: true, data: updated, message: "Comp-off claim withdrawn" });
  } catch (error) {
    next(error);
  }
}

export async function revokeCompOffClaimService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.body?.companyId || req.query?.companyId);
    const claimId = objectId(req.params.claimId, "comp-off claim id");
    const comment = text(req.body?.comment);
    if (comment.length < 3) throw generateError("A revocation reason is required", 422);
    const candidate = await CompOffClaim.findOne({ _id: claimId, company }).lean();
    if (!candidate) throw generateError("Comp-off claim not found", 404);
    ensureCanApproveClaim(actor, candidate);

    await mongoose.connection.transaction(async (session) => {
      const claim = await CompOffClaim.findOne({ _id: claimId, company, status: "approved" }).session(session);
      if (!claim) throw generateError("Only an approved comp-off claim can be revoked", 409);
      const lot = await CompOffCreditLot.findOne({ company, claim: claim._id }).session(session);
      if (!lot) throw generateError("The approved comp-off credit lot is missing", 409);
      if (Number(lot.reservedUnits || 0) > 0) {
        throw generateError("Reject or withdraw submitted leave using this credit before revoking the claim", 409);
      }
      if (Number(lot.consumedUnits || 0) > 0) {
        throw generateError("Cancel approved leave using this credit before revoking the claim", 409);
      }
      const availableUnits = Number(lot.availableUnits || 0);
      if (availableUnits > 0) {
        await postLeaveBalanceTransaction({
          key: {
            company,
            employee: claim.employee,
            leaveType: claim.leaveType,
            leaveYearKey: lot.leaveYearKey,
            leaveYearStart: lot.leaveYearStart,
            leaveYearEnd: lot.leaveYearEnd,
          },
          units: -availableUnits,
          transactionType: "comp_off_reversal",
          sourceType: "comp_off_claim",
          sourceId: claim._id,
          effectiveDate: currentDateKey(),
          idempotencyKey: `comp-off-claim:${claim._id}:revoke`,
          reason: comment,
          leavePolicyAssignment: claim.leavePolicyAssignment,
          leavePolicy: claim.leavePolicy,
          leavePolicyVersion: claim.leavePolicyVersion,
          compOffCreditLot: lot._id as mongoose.Types.ObjectId,
          createdBy: actor._id,
          session,
        });
      }
      lot.availableUnits = 0;
      lot.revokedUnits = availableUnits;
      lot.status = "revoked";
      await lot.save({ session });
      claim.status = "revoked";
      claim.decidedAt = new Date();
      claim.decidedBy = actor._id;
      claim.decisionComment = comment;
      claim.history.push(claimEvent(actor, "revoked", comment) as any);
      await claim.save({ session });
    });
    const updated = await populateClaim(CompOffClaim.findById(claimId));
    return res.status(200).json({ success: true, data: updated, message: "Comp-off claim and unused credit revoked" });
  } catch (error) {
    next(error);
  }
}

export async function listCompOffCreditsService(req: any, res: Response, next: NextFunction) {
  try {
    const actor = getLeaveActor(req);
    const company = resolveLeaveCompanyId(actor, req.query?.companyId);
    const employeeId = objectId(req.query?.employeeId || actor._id, "employee id");
    if (String(employeeId) !== String(actor._id)) {
      const employee = await loadEmployee(company, employeeId);
      if (!isEmployeeInActorScope(actor, employee, PERMISSION_KEYS.VIEW_LEAVE_REQUESTS)) {
        throw generateError("You cannot view comp-off credits for this employee", 403);
      }
    }
    const asOf = currentDateKey();
    await mongoose.connection.transaction(async (session) => {
      await expireCompOffCredits({ company, employee: employeeId, asOf, actorId: actor._id, session });
    });
    const leaveTypeId = req.query?.leaveTypeId ? objectId(req.query.leaveTypeId, "leave type id") : null;
    const match: any = { company, employee: employeeId };
    if (leaveTypeId) match.leaveType = leaveTypeId;
    const lots = await CompOffCreditLot.find(match)
      .populate("leaveType", "name code color unit")
      .populate("claim", "attendanceDate reason status")
      .sort({ status: 1, expiresOn: 1, earnedDate: 1 })
      .lean();
    const summary = lots.reduce(
      (total, lot) => ({
        availableUnits: total.availableUnits + Number(lot.availableUnits || 0),
        reservedUnits: total.reservedUnits + Number(lot.reservedUnits || 0),
        consumedUnits: total.consumedUnits + Number(lot.consumedUnits || 0),
        expiredUnits: total.expiredUnits + Number(lot.expiredUnits || 0),
        revokedUnits: total.revokedUnits + Number(lot.revokedUnits || 0),
      }),
      { availableUnits: 0, reservedUnits: 0, consumedUnits: 0, expiredUnits: 0, revokedUnits: 0 }
    );
    return res.status(200).json({ success: true, data: { summary, lots } });
  } catch (error) {
    next(error);
  }
}
