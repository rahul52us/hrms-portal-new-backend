import assert from "node:assert/strict";
import {
  attendanceAutoFinalizeDecision,
  attendanceCycleFinalizeDecision,
  attendanceDayCloseAt,
} from "./attendanceProcessor.service";
import {
  attendanceProcessorRunIsComplete,
  scheduledAttendanceDate,
  scheduledAttendanceDates,
} from "./attendanceProcessorScheduler";

function testDayShiftClose() {
  const closeAt = attendanceDayCloseAt({
    attendanceDate: "2026-09-25",
    timezone: "Asia/Kolkata",
    startTime: "09:30",
    endTime: "18:30",
  });
  assert.equal(closeAt.toISOString(), "2026-09-25T13:00:00.000Z");
}

function testOvernightShiftClose() {
  const closeAt = attendanceDayCloseAt({
    attendanceDate: "2026-09-25",
    timezone: "Asia/Kolkata",
    startTime: "19:00",
    endTime: "02:00",
  });
  assert.equal(closeAt.toISOString(), "2026-09-25T20:30:00.000Z");
}

function testGracePeriod() {
  const closeAt = attendanceDayCloseAt({
    attendanceDate: "2026-09-25",
    timezone: "Asia/Kolkata",
    startTime: "09:30",
    endTime: "18:30",
    graceMinutes: 30,
  });
  assert.equal(closeAt.toISOString(), "2026-09-25T13:30:00.000Z");
}

function testScheduledDate() {
  assert.equal(
    scheduledAttendanceDate(new Date("2026-09-25T00:15:00.000Z")),
    "2026-09-24"
  );
  assert.deepEqual(
    scheduledAttendanceDates(new Date("2026-09-25T00:15:00.000Z")),
    ["2026-09-24", "2026-09-23", "2026-09-22"]
  );
  assert.deepEqual(
    scheduledAttendanceDates(new Date("2026-09-25T00:15:00.000Z"), 5),
    ["2026-09-24", "2026-09-23", "2026-09-22", "2026-09-21", "2026-09-20"]
  );
}

function testCompletedRunDetection() {
  assert.equal(attendanceProcessorRunIsComplete({
    status: "completed",
    counts: {},
  }), true);
  assert.equal(attendanceProcessorRunIsComplete({
    status: "completed_with_errors",
    counts: { setupGaps: 1 },
  }), false);
  assert.equal(attendanceProcessorRunIsComplete({
    status: "completed",
    counts: { awaitingFinalization: 1 },
  }), false);
  assert.equal(attendanceProcessorRunIsComplete({
    status: "completed",
    counts: { reviewRequired: 1 },
  }), false);
  assert.equal(attendanceProcessorRunIsComplete({
    status: "failed",
    counts: {},
  }), false);
}

function testCycleFinalizationDecisions() {
  assert.equal(attendanceCycleFinalizeDecision({
    state: "calculated",
    status: "present",
  }), true);
  assert.equal(attendanceCycleFinalizeDecision({
    state: "calculated",
    status: "absent",
  }), true);
  assert.equal(attendanceCycleFinalizeDecision({
    state: "calculated",
    status: "incomplete",
    hasMissingPunch: true,
  }), false);
  assert.equal(attendanceCycleFinalizeDecision({
    state: "open",
    status: "pending",
    hasOpenPunch: true,
  }), false);
}

function testAutoFinalizationDecisions() {
  const closeAt = new Date("2026-09-24T13:00:00.000Z");
  const cleanRules: any = {
    autoFinalize: { enabled: true, graceMinutes: 60, mode: "clean_only" },
  };
  assert.equal(attendanceAutoFinalizeDecision({
    state: "calculated",
    status: "present",
    rules: cleanRules,
    closeAt,
    now: new Date("2026-09-24T13:30:00.000Z"),
  }), "wait");
  assert.equal(attendanceAutoFinalizeDecision({
    state: "calculated",
    status: "present",
    rules: cleanRules,
    closeAt,
    now: new Date("2026-09-24T14:00:00.000Z"),
  }), "finalize");
  assert.equal(attendanceAutoFinalizeDecision({
    state: "calculated",
    status: "absent",
    rules: cleanRules,
    closeAt,
    now: new Date("2026-09-24T15:00:00.000Z"),
  }), "review");
  assert.equal(attendanceAutoFinalizeDecision({
    state: "calculated",
    status: "absent",
    rules: { autoFinalize: { enabled: true, graceMinutes: 60, mode: "all_calculated" } } as any,
    closeAt,
    now: new Date("2026-09-24T15:00:00.000Z"),
  }), "finalize");
}

[
  testDayShiftClose,
  testOvernightShiftClose,
  testGracePeriod,
  testScheduledDate,
  testCompletedRunDetection,
  testAutoFinalizationDecisions,
  testCycleFinalizationDecisions,
].forEach((test) => test());

console.log("Attendance processor tests passed (7 tests)");
