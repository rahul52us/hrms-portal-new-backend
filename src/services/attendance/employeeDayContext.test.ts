import assert from "assert";
import {
  buildEmployeeDayContext,
  classifyEmployeeDay,
} from "./employeeDayContext.utils";

const DEFAULT_SCHEDULE = {
  _id: "64a000000000000000000101",
  versionNumber: 1,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  rules: {
    timezone: "Asia/Kolkata",
    workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    saturdayRule: "second_and_fourth_off" as const,
    customSaturdayOffWeeks: [],
    startTime: "09:30",
    endTime: "18:30",
    unpaidBreakMinutes: 60,
  },
};

function holidayVersion(holidays: any[]) {
  return {
    _id: "64a000000000000000000201",
    versionNumber: 1,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    timezone: "Asia/Kolkata",
    holidays,
  };
}

const tests: Array<{ name: string; run: () => void }> = [
  {
    name: "classifies a normal working day and scheduled minutes",
    run: () => {
      const result = classifyEmployeeDay({
        attendanceDate: "2026-08-03",
        workScheduleVersion: DEFAULT_SCHEDULE,
      });
      assert.equal(result.dayOfWeek, "Monday");
      assert.equal(result.dayType, "working_day");
      assert.equal(result.schedule.scheduledMinutes, 480);
      assert.equal(result.expectedWorkMinutes, 480);
      assert.equal(result.requiresAttendance, true);
    },
  },
  {
    name: "classifies a weekly off",
    run: () => {
      const result = classifyEmployeeDay({
        attendanceDate: "2026-08-02",
        workScheduleVersion: DEFAULT_SCHEDULE,
      });
      assert.equal(result.dayOfWeek, "Sunday");
      assert.equal(result.dayType, "weekly_off");
      assert.equal(result.defaultAttendanceStatus, "weekly_off");
      assert.equal(result.expectedWorkMinutes, 0);
    },
  },
  {
    name: "applies second and fourth Saturday rules",
    run: () => {
      const secondSaturday = classifyEmployeeDay({
        attendanceDate: "2026-08-08",
        workScheduleVersion: DEFAULT_SCHEDULE,
      });
      const thirdSaturday = classifyEmployeeDay({
        attendanceDate: "2026-08-15",
        workScheduleVersion: DEFAULT_SCHEDULE,
      });
      const fourthSaturday = classifyEmployeeDay({
        attendanceDate: "2026-08-22",
        workScheduleVersion: DEFAULT_SCHEDULE,
      });
      assert.equal(secondSaturday.dayType, "weekly_off");
      assert.equal(secondSaturday.schedule.weeklyOffReason, "second_or_fourth_saturday_off");
      assert.equal(thirdSaturday.dayType, "working_day");
      assert.equal(fourthSaturday.dayType, "weekly_off");
    },
  },
  {
    name: "supports working, all-off, first-third, and custom Saturday rules",
    run: () => {
      const classifySaturday = (
        attendanceDate: string,
        saturdayRule: typeof DEFAULT_SCHEDULE.rules.saturdayRule | "working" | "all_off" | "first_and_third_off" | "custom_weeks_off",
        customSaturdayOffWeeks: number[] = []
      ) =>
        classifyEmployeeDay({
          attendanceDate,
          workScheduleVersion: {
            ...DEFAULT_SCHEDULE,
            rules: { ...DEFAULT_SCHEDULE.rules, saturdayRule, customSaturdayOffWeeks },
          },
        });

      assert.equal(classifySaturday("2026-08-01", "working").dayType, "working_day");
      assert.equal(classifySaturday("2026-08-29", "all_off").dayType, "weekly_off");
      assert.equal(classifySaturday("2026-08-01", "first_and_third_off").dayType, "weekly_off");
      assert.equal(classifySaturday("2026-08-08", "first_and_third_off").dayType, "working_day");
      assert.equal(
        classifySaturday("2026-08-29", "custom_weeks_off", [2, 5]).dayType,
        "weekly_off"
      );
    },
  },
  {
    name: "makes a mandatory holiday non-working",
    run: () => {
      const result = classifyEmployeeDay({
        attendanceDate: "2026-08-15",
        workScheduleVersion: DEFAULT_SCHEDULE,
        holidayCalendarVersion: holidayVersion([
          {
            _id: "64a000000000000000000211",
            date: new Date("2026-08-15T00:00:00.000Z"),
            name: "Independence Day",
            type: "mandatory",
            isHalfDay: false,
          },
        ]),
      });
      assert.equal(result.dayType, "mandatory_holiday");
      assert.equal(result.defaultAttendanceStatus, "holiday");
      assert.equal(result.expectedWorkMinutes, 0);
      assert.equal(result.requiresAttendance, false);
    },
  },
  {
    name: "keeps an optional holiday as an attendance day until selected",
    run: () => {
      const result = classifyEmployeeDay({
        attendanceDate: "2026-08-17",
        workScheduleVersion: DEFAULT_SCHEDULE,
        holidayCalendarVersion: holidayVersion([
          {
            date: "2026-08-17",
            name: "Optional Festival",
            type: "optional",
            isHalfDay: false,
          },
        ]),
      });
      assert.equal(result.dayType, "optional_holiday");
      assert.equal(result.defaultAttendanceStatus, "pending");
      assert.equal(result.expectedWorkMinutes, 480);
      assert.equal(result.requiresAttendance, true);
    },
  },
  {
    name: "halves expected work for a mandatory half-day holiday",
    run: () => {
      const result = classifyEmployeeDay({
        attendanceDate: "2026-08-18",
        workScheduleVersion: DEFAULT_SCHEDULE,
        holidayCalendarVersion: holidayVersion([
          {
            date: "2026-08-18",
            name: "Company Foundation Day",
            type: "mandatory",
            isHalfDay: true,
          },
        ]),
      });
      assert.equal(result.dayType, "mandatory_half_day_holiday");
      assert.equal(result.schedule.scheduledMinutes, 480);
      assert.equal(result.expectedWorkMinutes, 240);
      assert.equal(result.requiresAttendance, true);
    },
  },
  {
    name: "calculates overnight scheduled minutes",
    run: () => {
      const result = classifyEmployeeDay({
        attendanceDate: "2026-08-03",
        workScheduleVersion: {
          ...DEFAULT_SCHEDULE,
          rules: {
            ...DEFAULT_SCHEDULE.rules,
            startTime: "22:00",
            endTime: "06:00",
          },
        },
      });
      assert.equal(result.schedule.grossMinutes, 480);
      assert.equal(result.schedule.scheduledMinutes, 420);
    },
  },
  {
    name: "preserves location assignment and historical version references",
    run: () => {
      const locationId = "64a000000000000000000301";
      const context = buildEmployeeDayContext({
        attendanceDate: "2026-08-03",
        policyResolution: {
          employee: { _id: "64a000000000000000000401", company: "64a000000000000000000501" },
          at: new Date("2026-08-03T00:00:00.000Z"),
          organizationAssignment: { officeLocation: locationId, officeLocationNameSnapshot: "Delhi" },
          attendancePolicy: null,
          leavePolicy: null,
          workSchedule: {
            assignment: {
              _id: "64a000000000000000000601",
              resource: "64a000000000000000000602",
              scopeType: "company",
              scopeId: null,
            },
            version: DEFAULT_SCHEDULE,
          },
          holidayCalendar: {
            assignment: {
              _id: "64a000000000000000000701",
              resource: "64a000000000000000000702",
              scopeType: "location",
              scopeId: locationId,
            },
            version: {
              ...holidayVersion([]),
              _id: "64a000000000000000000703",
              versionNumber: 3,
              effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
            },
          },
          warnings: [],
        },
      });
      assert.equal(context.organizationAssignment.officeLocationNameSnapshot, "Delhi");
      assert.equal(context.policyReferences.holidayCalendar?.scopeType, "location");
      assert.equal(context.policyReferences.holidayCalendar?.scopeId, locationId);
      assert.equal(context.policyReferences.holidayCalendar?.versionNumber, 3);
      assert.equal(context.policyReferences.holidayCalendar?.versionId, "64a000000000000000000703");
    },
  },
  {
    name: "rejects invalid calendar dates",
    run: () => {
      assert.throws(
        () => classifyEmployeeDay({ attendanceDate: "2026-02-30" }),
        (error: any) => error?.statusCode === 400 && error?.message === "Attendance date is invalid"
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  test.run();
  passed += 1;
  process.stdout.write(`PASS ${test.name}\n`);
}
process.stdout.write(`${passed} employee day context tests passed\n`);
