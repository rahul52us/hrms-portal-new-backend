import assert from "node:assert/strict";
import mongoose from "mongoose";
import AttendancePeriod from "../../schemas/Attendance/AttendancePeriod.schema";
import AttendancePeriodRevision from "../../schemas/Attendance/AttendancePeriodRevision.schema";
import { getDefaultPermissionsForRole, PERMISSION_KEYS } from "../permissions/permission.utils";
import {
  attendanceCycleRange,
  attendancePeriodBlockers,
  attendancePeriodKeyForDate,
  parseAttendancePeriodKey,
} from "./attendancePeriod.service";

function readyCounts(overrides: Record<string, unknown> = {}) {
  return {
    periodEnded: true,
    totalRecords: 31,
    finalizedRecords: 31,
    unfinalizedRecords: 0,
    openRecords: 0,
    pendingRecords: 0,
    missingPunchRecords: 0,
    pendingRegularizations: 0,
    pendingOvertimeReviews: 0,
    pendingLeaveRequests: 0,
    pendingLeaveCancellations: 0,
    pendingRemoteWorkRequests: 0,
    activeProcessorRuns: 0,
    activeImportBatches: 0,
    calendarDays: 31,
    closedCalendarDays: 31,
    upcomingDays: 0,
    processedDays: 31,
    missingProcessorDays: 0,
    problemProcessorDays: 0,
    missingProcessorDates: [],
    problemProcessorDates: [],
    upcomingDates: [],
    ...overrides,
  };
}

function testPeriodParsing() {
  assert.deepEqual(parseAttendancePeriodKey("2024-02"), {
    periodKey: "2024-02",
    startDate: "2024-02-01",
    endDate: "2024-02-29",
  });
  assert.equal(attendancePeriodKeyForDate("2026-08-31"), "2026-08");
  assert.throws(() => parseAttendancePeriodKey("2026-13"), /YYYY-MM/);
}

function testAttendanceCycleRanges() {
  assert.deepEqual(attendanceCycleRange("2026-09", 31), {
    periodKey: "2026-09",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    attendanceCutoffDay: 31,
  });
  assert.deepEqual(attendanceCycleRange("2026-09", 25), {
    periodKey: "2026-09",
    startDate: "2026-08-26",
    endDate: "2026-09-25",
    attendanceCutoffDay: 25,
  });
  assert.deepEqual(attendanceCycleRange("2024-02", 31), {
    periodKey: "2024-02",
    startDate: "2024-02-01",
    endDate: "2024-02-29",
    attendanceCutoffDay: 31,
  });
  assert.deepEqual(attendanceCycleRange("2026-10", 25, "2026-09-30"), {
    periodKey: "2026-10",
    startDate: "2026-10-01",
    endDate: "2026-10-25",
    attendanceCutoffDay: 25,
  });
}

function testReadinessBlockers() {
  assert.deepEqual(attendancePeriodBlockers(readyCounts()), []);
  const blockers = attendancePeriodBlockers(readyCounts({
    unfinalizedRecords: 3,
    pendingRegularizations: 1,
    pendingOvertimeReviews: 1,
    pendingLeaveRequests: 2,
  }));
  assert.equal(blockers.length, 4);
  assert.match(blockers[0], /3 attendance record/);
}

function testPeriodSchemas() {
  const company = new mongoose.Types.ObjectId();
  const actor = new mongoose.Types.ObjectId();
  const period = new AttendancePeriod({
    company,
    periodKey: "2026-08",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    attendanceCutoffDay: 25,
    status: "locked",
    version: 1,
    lockedAt: new Date(),
    lockedBy: actor,
    lockReason: "Attendance review completed",
    createdBy: actor,
    updatedBy: actor,
  });
  assert.equal(period.validateSync(), undefined);

  const revision = new AttendancePeriodRevision({
    company,
    attendancePeriod: period._id,
    periodKey: "2026-08",
    version: 1,
    action: "locked",
    previousStatus: "open",
    nextStatus: "locked",
    reason: "Attendance review completed",
    actor,
  });
  assert.equal(revision.validateSync(), undefined);
}

function testPermissions() {
  const admin = getDefaultPermissionsForRole("admin");
  const hrAdmin = getDefaultPermissionsForRole("hradmin");
  const hr = getDefaultPermissionsForRole("hr");
  assert.equal(admin[PERMISSION_KEYS.LOCK_ATTENDANCE_PERIOD], true);
  assert.equal(admin[PERMISSION_KEYS.REOPEN_ATTENDANCE_PERIOD], true);
  assert.equal(hrAdmin[PERMISSION_KEYS.LOCK_ATTENDANCE_PERIOD], true);
  assert.equal(hrAdmin[PERMISSION_KEYS.REOPEN_ATTENDANCE_PERIOD], true);
  assert.equal(hr[PERMISSION_KEYS.LOCK_ATTENDANCE_PERIOD], false);
}

[testPeriodParsing, testAttendanceCycleRanges, testReadinessBlockers, testPeriodSchemas, testPermissions].forEach((test) => test());

console.log("Attendance period tests passed (5 tests)");
