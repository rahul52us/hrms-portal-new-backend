import assert from "node:assert/strict";
import mongoose from "mongoose";
import AttendanceRecord from "../../schemas/Attendance/AttendanceRecord.schema";
import Department from "../../schemas/Department/Department.schema";
import EmployeeAssignmentHistory from "../../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import LeaveRequest from "../../schemas/Leave/LeaveRequest.schema";
import RemoteWorkRequest from "../../schemas/Request/RemoteWorkRequest.schema";
import User from "../../schemas/User/User";
import HolidayCalendarVersion from "../../schemas/WorkforcePolicy/HolidayCalendarVersion.schema";
import AttendancePolicyVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import WorkforcePolicyAssignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import WorkScheduleVersion from "../../schemas/WorkforcePolicy/WorkScheduleVersion.schema";
import { getAttendanceOverviewService } from "./attendanceOverview.service";

const company = new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const department = new mongoose.Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");
const schedule = new mongoose.Types.ObjectId("cccccccccccccccccccccccc");
const attendancePolicy = new mongoose.Types.ObjectId("eeeeeeeeeeeeeeeeeeeeeeee");
const employees = Array.from({ length: 10000 }, (_, index) => ({
  _id: new mongoose.Types.ObjectId((index + 1).toString(16).padStart(24, "0")),
  company,
  role: "user",
  name: `Employee ${index}`,
  code: `SS-${index}`,
  joiningDate: "2020-01-01",
}));

let queries = 0;
const originals: Array<() => void> = [];

function query(items: any[]) {
  let limit = items.length;
  const builder: any = {
    select: () => builder,
    sort: () => builder,
    limit: (value: number) => {
      limit = value;
      return builder;
    },
    lean: async () => items.slice(0, limit),
  };
  return builder;
}

function mock(model: any, method: string, implementation: (match: any) => any) {
  const original = model[method];
  originals.push(() => {
    model[method] = original;
  });
  model[method] = (...args: any[]) => {
    queries += 1;
    return implementation(args[0]);
  };
}

function selected(match: any) {
  const ids = new Set((match.employee?.$in || []).map((id: any) => String(id)));
  return employees.filter((employee) => ids.has(String(employee._id)));
}

async function main() {
  mock(User, "find", (match) => {
    if (match._id?.$in) return query([]);
    return query(
      employees.filter(
        (employee) => !match._id?.$gt || String(employee._id) > String(match._id.$gt)
      )
    );
  });
  mock(Department, "find", () =>
    query([{ _id: department, departmentName: "Engineering", teams: [] }])
  );
  mock(WorkforcePolicyAssignment, "find", () =>
    query([
      {
        resourceType: "attendance_policy",
        scopeType: "company",
        scopeId: null,
        resource: attendancePolicy,
        effectiveFrom: "2020-01-01",
      },
      {
        resourceType: "work_schedule",
        scopeType: "company",
        scopeId: null,
        resource: schedule,
        effectiveFrom: "2020-01-01",
      },
    ])
  );
  mock(WorkScheduleVersion, "find", () =>
    query([
      {
        _id: schedule,
        schedule,
        status: "published",
        effectiveFrom: "2020-01-01",
        versionNumber: 1,
        rules: {
          workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
          saturdayRule: "all_off",
          startTime: "09:00",
          endTime: "18:00",
          timezone: "Asia/Kolkata",
        },
      },
    ])
  );
  mock(AttendancePolicyVersion, "find", () =>
    query([{
      _id: new mongoose.Types.ObjectId(),
      policy: attendancePolicy,
      status: "published",
      effectiveFrom: "2020-01-01",
      versionNumber: 1,
    }])
  );
  mock(HolidayCalendarVersion, "find", () => query([]));
  mock(EmployeeAssignmentHistory, "find", (match) =>
    query(
      selected(match).map((employee) => ({
        employee: employee._id,
        department,
        departmentNameSnapshot: "Engineering",
        effectiveFrom: "2020-01-01",
      }))
    )
  );
  const originalDistinct = EmployeeAssignmentHistory.distinct;
  originals.push(() => {
    EmployeeAssignmentHistory.distinct = originalDistinct;
  });
  (EmployeeAssignmentHistory as any).distinct = async (_field: string, match: any) => {
    queries += 1;
    return selected(match).map((employee) => employee._id);
  };

  mock(AttendanceRecord, "find", (match) => {
    if (!match.employee.$in.some((id: any) => String(id) === String(employees[0]._id))) {
      return query([]);
    }
    return query([
      {
        _id: new mongoose.Types.ObjectId(),
        company,
        employee: employees[0]._id,
        attendanceDate: "2026-09-14",
        timezone: "Asia/Kolkata",
        status: "present",
        state: "calculated",
        workMode: "office",
        punchSessions: [
          {
            punchIn: "2026-09-14T03:30:00.000Z",
            punchOut: "2026-09-14T12:30:00.000Z",
          },
        ],
        workedMinutes: 540,
      },
    ]);
  });

  const leaveRequest = {
    _id: new mongoose.Types.ObjectId(),
    employee: employees[1]._id,
    status: "approved",
    leaveTypeNameSnapshot: "Casual Leave",
    leaveTypeCodeSnapshot: "CL",
    leaveUnit: "days",
    dayBreakdown: [
      { attendanceDate: "2026-09-14", chargedUnits: 1, portion: "full" },
    ],
  };
  mock(LeaveRequest, "find", (match) =>
    query(
      match.employee.$in.some((id: any) => String(id) === String(leaveRequest.employee))
        ? [leaveRequest]
        : []
    )
  );
  const remoteRequest = {
    _id: new mongoose.Types.ObjectId(),
    employee: employees[2]._id,
    status: "approved",
    dates: [{ attendanceDate: "2026-09-14", portion: "full", units: 1 }],
  };
  mock(RemoteWorkRequest, "find", (match) =>
    query(
      match.employee.$in.some((id: any) => String(id) === String(remoteRequest.employee))
        ? [remoteRequest]
        : []
    )
  );

  const started = Date.now();
  let result: any;
  let error: any;
  try {
    await getAttendanceOverviewService(
      {
        user: {
          _id: new mongoose.Types.ObjectId("dddddddddddddddddddddddd"),
          role: "hradmin",
          company,
          effectivePermissions: { view_attendance: true },
        },
        query: { date: "2026-09-14", page: "1", limit: "25" },
      },
      {
        status: () => ({
          json: (value: any) => {
            result = value;
          },
        }),
      } as any,
      (value: any) => {
        error = value;
      }
    );
    assert.equal(error, undefined);
    assert.equal(result.data.summary.employees, 10000);
    assert.equal(result.data.summary.expected, 10000);
    assert.equal(result.data.summary.present, 1);
    assert.equal(result.data.summary.onLeave, 1);
    assert.equal(result.data.summary.wfh, 1);
    assert.equal(result.data.summary.notMarked, 9998);
    assert.equal(result.data.items.length, 25);
    assert.equal(
      result.data.items[0].setupGaps.includes("attendance_policy"),
      false,
      "Published attendance policy assignments must resolve in the batched overview"
    );
    assert.equal(result.pagination.total, 10000);
    assert.equal(queries, 246, "Queries scale by 250-employee batches, not per employee");
    console.log(
      `10,000-employee attendance batching test passed (246 mocked queries, ${Date.now() - started}ms)`
    );
  } finally {
    originals.reverse().forEach((restore) => restore());
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
