import assert from "node:assert/strict";
import { attendanceCsvCell, buildAttendanceStatementCsv } from "./attendance.service";

assert.equal(attendanceCsvCell("plain"), "plain");
assert.equal(attendanceCsvCell('Office, "North"'), '"Office, ""North"""');

const csv = buildAttendanceStatementCsv([
  {
    attendanceDate: "2026-09-19",
    status: "present",
    dayTypeSnapshot: "working_day",
    workMode: "office",
    punchSessions: [
      {
        punchIn: "2026-09-19T03:30:00.000Z",
        punchOut: "2026-09-19T12:30:00.000Z",
      },
    ],
    workedMinutes: 540,
    lateMinutes: 0,
    earlyExitMinutes: 0,
    overtimeMinutes: 60,
    officeLocationNameSnapshot: "Delhi, North",
    state: "calculated",
  },
]);

assert.match(csv, /^Date,Day,Status,/);
assert.match(csv, /2026-09-19,Saturday,present,working_day,office/);
assert.match(csv, /"Delhi, North",calculated$/);

console.log("attendance history tests passed");
