import assert from "node:assert/strict";
import {
  buildFinalPunchSession,
  isPunchOutAllowedForAttendanceDay,
  previousAttendanceDate,
} from "./attendancePunch.utils";

const at = (time: string) => new Date(`2026-08-31T${time}:00+05:30`);

function testLatestPunchOutWins() {
  const firstPunchOut = buildFinalPunchSession(
    [{ punchIn: at("09:30"), punchOut: null, source: "web" }],
    at("15:00")
  );
  assert.ok(firstPunchOut);
  assert.equal(firstPunchOut.session.punchIn.getTime(), at("09:30").getTime());
  assert.equal(firstPunchOut.session.punchOut.getTime(), at("15:00").getTime());
  assert.equal(firstPunchOut.previousPunchOut, null);

  const finalPunchOut = buildFinalPunchSession(
    [firstPunchOut.session],
    at("18:00")
  );
  assert.ok(finalPunchOut);
  assert.equal(finalPunchOut.session.punchIn.getTime(), at("09:30").getTime());
  assert.equal(finalPunchOut.session.punchOut.getTime(), at("18:00").getTime());
  assert.equal(finalPunchOut.previousPunchOut?.getTime(), at("15:00").getTime());
}

function testLegacySessionsCollapseToFirstInAndLastOut() {
  const result = buildFinalPunchSession(
    [
      { punchIn: at("09:30"), punchOut: at("15:00"), source: "web" },
      { punchIn: at("16:00"), punchOut: at("17:00"), source: "web" },
    ],
    at("18:00")
  );
  assert.ok(result);
  assert.equal(result.session.punchIn.getTime(), at("09:30").getTime());
  assert.equal(result.session.punchOut.getTime(), at("18:00").getTime());
  assert.equal(result.previousPunchOut?.getTime(), at("17:00").getTime());
}

function testPunchOutRequiresPunchIn() {
  assert.equal(buildFinalPunchSession([], at("18:00")), null);
}

function testPunchOutAttendanceDayWindow() {
  assert.equal(previousAttendanceDate("2026-05-01"), "2026-04-30");
  assert.equal(
    isPunchOutAllowedForAttendanceDay({
      attendanceDate: "2026-04-25",
      currentAttendanceDate: "2026-04-25",
      scheduleStartTime: "09:30",
      scheduleEndTime: "18:30",
    }),
    true
  );
  assert.equal(
    isPunchOutAllowedForAttendanceDay({
      attendanceDate: "2026-04-25",
      currentAttendanceDate: "2026-04-29",
      scheduleStartTime: "09:30",
      scheduleEndTime: "18:30",
    }),
    false
  );
}

function testOvernightPunchOutWindow() {
  assert.equal(
    isPunchOutAllowedForAttendanceDay({
      attendanceDate: "2026-04-25",
      currentAttendanceDate: "2026-04-26",
      scheduleStartTime: "22:00",
      scheduleEndTime: "06:00",
    }),
    true
  );
  assert.equal(
    isPunchOutAllowedForAttendanceDay({
      attendanceDate: "2026-04-25",
      currentAttendanceDate: "2026-04-26",
      scheduleStartTime: "09:30",
      scheduleEndTime: "18:30",
    }),
    false
  );
}

[
  testLatestPunchOutWins,
  testLegacySessionsCollapseToFirstInAndLastOut,
  testPunchOutRequiresPunchIn,
  testPunchOutAttendanceDayWindow,
  testOvernightPunchOutWindow,
].forEach((test) => test());

console.log("Attendance punch tests passed (5 tests)");
