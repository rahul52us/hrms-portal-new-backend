import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";

export async function applyApprovedRemoteWorkToAttendance(options: {
  request: any;
  actor: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  for (const day of options.request.dates || []) {
    const conflicting = await AttendanceRecord.findOne({
      company: options.request.company,
      employee: options.request.employee,
      attendanceDate: day.attendanceDate,
      $or: [{ state: "finalized" }, { leaveRequest: { $ne: null } }],
    }).session(options.session);
    if (conflicting) {
      throw generateError(
        `Attendance for ${day.attendanceDate} is finalized or linked to leave`,
        409
      );
    }
    await AttendanceRecord.updateMany(
      {
        company: options.request.company,
        employee: options.request.employee,
        attendanceDate: day.attendanceDate,
        state: { $ne: "finalized" },
        leaveRequest: null,
        workModeSource: { $in: ["default", "remote_work_request"] },
      },
      {
        $set: {
          workMode: day.portion === "full" ? "remote" : "hybrid",
          workModeSource: "remote_work_request",
          remoteWorkRequest: options.request._id,
          remoteWorkPortion: day.portion,
          remoteWorkPolicyAssignment: options.request.remoteWorkPolicyAssignment,
          remoteWorkPolicy: options.request.remoteWorkPolicy,
          remoteWorkPolicyVersion: options.request.remoteWorkPolicyVersion,
          updatedBy: options.actor,
        },
      },
      { session: options.session }
    );
  }
}

export async function removeCancelledRemoteWorkFromAttendance(options: {
  request: any;
  actor: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  const finalized = await AttendanceRecord.exists({
    company: options.request.company,
    remoteWorkRequest: options.request._id,
    state: "finalized",
  }).session(options.session);
  if (finalized) {
    throw generateError("Finalized attendance exists. Reopen it before cancelling WFH", 409);
  }
  await AttendanceRecord.updateMany(
    {
      company: options.request.company,
      remoteWorkRequest: options.request._id,
      state: { $ne: "finalized" },
    },
    {
      $set: {
        workMode: "office",
        workModeSource: "default",
        remoteWorkRequest: null,
        remoteWorkPortion: null,
        remoteWorkPolicyAssignment: null,
        remoteWorkPolicy: null,
        remoteWorkPolicyVersion: null,
        updatedBy: options.actor,
      },
    },
    { session: options.session }
  );
}
