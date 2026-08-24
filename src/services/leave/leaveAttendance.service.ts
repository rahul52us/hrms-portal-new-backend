import mongoose, { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import AttendanceRecordRevision from "../../schemas/Attendance/AttendanceRecordRevision.schema";

function id(value: unknown) {
  const normalized = String((value as any)?._id || value || "").trim();
  return mongoose.Types.ObjectId.isValid(normalized)
    ? new mongoose.Types.ObjectId(normalized)
    : null;
}

function snapshot(record: any) {
  return record.toObject ? record.toObject({ depopulate: true }) : { ...record };
}

async function writeRevision(options: {
  record: any;
  previous: any;
  actor: mongoose.Types.ObjectId;
  reason: string;
  session: ClientSession;
}) {
  await AttendanceRecordRevision.create(
    [
      {
        company: options.record.company,
        attendanceRecord: options.record._id,
        employee: options.record.employee,
        revisionNumber: options.record.calculationVersion,
        action: "leave_updated",
        reason: options.reason,
        changes: {
          previousStatus: options.previous?.status || null,
          status: options.record.status,
          previousLeaveRequest: options.previous?.leaveRequest || null,
          leaveRequest: options.record.leaveRequest || null,
          previousLeaveUnits: options.previous?.leaveUnits || 0,
          leaveUnits: options.record.leaveUnits || 0,
        },
        snapshot: snapshot(options.record),
        actor: options.actor,
        source: "system",
      },
    ],
    { session: options.session }
  );
}

export async function applyApprovedLeaveToAttendance(options: {
  request: any;
  actor: mongoose.Types.ObjectId;
  session: ClientSession;
}) {
  for (const day of options.request.dayBreakdown || []) {
    if (Number(day.chargedUnits || 0) <= 0 || day.chargeReason === "sandwich_rule") continue;

    let record = await AttendanceRecord.findOne({
      company: options.request.company,
      employee: options.request.employee,
      attendanceDate: day.attendanceDate,
    }).session(options.session);
    const previous = record ? snapshot(record) : null;
    if (record?.state === "finalized" && String(record.leaveRequest || "") !== String(options.request._id)) {
      throw generateError(`Attendance is finalized for ${day.attendanceDate}; reopen it before approving leave`, 409);
    }
    if (record?.leaveRequest && String(record.leaveRequest) !== String(options.request._id)) {
      throw generateError(`Another approved leave request already affects ${day.attendanceDate}`, 409);
    }
    if (
      options.request.leaveUnit === "days" &&
      Number(day.chargedUnits) >= 1 &&
      (Number(record?.workedMinutes || 0) > 0 || Number(record?.punchSessions?.length || 0) > 0)
    ) {
      throw generateError(`Attendance punches already exist for ${day.attendanceDate}`, 409);
    }

    if (!record) {
      record = new AttendanceRecord({
        company: options.request.company,
        employee: options.request.employee,
        attendanceDate: day.attendanceDate,
        timezone: day.timezone || "Asia/Kolkata",
        state: "open",
        status: "pending",
        punchSessions: [],
        source: "system",
        createdBy: options.actor,
        calculationVersion: 0,
      });
    }

    if (options.request.leaveUnit === "days") {
      record.status = Number(day.chargedUnits) >= 1 ? "leave" : "half_day";
    }
    record.leaveRequest = options.request._id;
    record.leaveType = options.request.leaveType;
    record.leaveUnits = Number(day.chargedUnits);
    record.leaveUnit = options.request.leaveUnit;
    record.employeeAssignmentHistory = id(day.employeeAssignmentHistory);
    record.department = id(day.department);
    record.departmentNameSnapshot = day.departmentNameSnapshot || "";
    record.teamId = id(day.teamId);
    record.teamNameSnapshot = day.teamNameSnapshot || "";
    record.officeLocation = id(day.officeLocation);
    record.officeLocationNameSnapshot = day.officeLocationNameSnapshot || "";
    record.reportingManager = id(day.reportingManager);
    record.reportingManagerNameSnapshot = day.reportingManagerNameSnapshot || "";
    record.attendancePolicyAssignment = id(day.attendancePolicyAssignment);
    record.attendancePolicy = id(day.attendancePolicy);
    record.attendancePolicyVersion = id(day.attendancePolicyVersion);
    record.workScheduleAssignment = id(day.workScheduleAssignment);
    record.workSchedule = id(day.workSchedule);
    record.workScheduleVersion = id(day.workScheduleVersion);
    record.holidayCalendarAssignment = id(day.holidayCalendarAssignment);
    record.holidayCalendar = id(day.holidayCalendar);
    record.holidayCalendarVersion = id(day.holidayCalendarVersion);
    record.policyResolvedAt = options.request.submittedAt;
    record.calculationVersion = Number(record.calculationVersion || 0) + 1;
    record.calculatedAt = new Date();
    record.calculatedBy = options.actor;
    record.calculationReason = `Approved leave request ${options.request._id}`;
    record.updatedBy = options.actor;
    await record.save({ session: options.session });
    await writeRevision({
      record,
      previous,
      actor: options.actor,
      reason: `Leave request ${options.request._id} approved`,
      session: options.session,
    });
  }
}

export async function removeCancelledLeaveFromAttendance(options: {
  request: any;
  actor: mongoose.Types.ObjectId;
  session: ClientSession;
}) {
  const records = await AttendanceRecord.find({
    company: options.request.company,
    employee: options.request.employee,
    leaveRequest: options.request._id,
  }).session(options.session);
  const dayByDate = new Map((options.request.dayBreakdown || []).map((day: any) => [day.attendanceDate, day]));

  for (const record of records) {
    if (record.state === "finalized") {
      throw generateError(`Attendance is finalized for ${record.attendanceDate}; reopen it before cancelling leave`, 409);
    }
    const previous = snapshot(record);
    const day: any = dayByDate.get(record.attendanceDate);
    record.status = day?.dayType === "weekly_off"
      ? "weekly_off"
      : day?.dayType === "mandatory_holiday"
        ? "holiday"
        : "pending";
    record.leaveRequest = null;
    record.leaveType = null;
    record.leaveUnits = 0;
    record.leaveUnit = null;
    record.calculationVersion = Number(record.calculationVersion || 0) + 1;
    record.calculatedAt = new Date();
    record.calculatedBy = options.actor;
    record.calculationReason = `Cancelled leave request ${options.request._id}`;
    record.updatedBy = options.actor;
    await record.save({ session: options.session });
    await writeRevision({
      record,
      previous,
      actor: options.actor,
      reason: `Leave request ${options.request._id} cancelled`,
      session: options.session,
    });
  }
}
