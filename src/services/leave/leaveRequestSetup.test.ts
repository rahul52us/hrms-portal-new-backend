import assert from "node:assert/strict";
import mongoose from "mongoose";
import User from "../../schemas/User/User";
import * as dayContext from "../attendance/employeeDayContext.service";
import { getLeaveRequestSetupService } from "./leaveRequest.service";

async function main() {
  const company = new mongoose.Types.ObjectId(), foreignCompany = new mongoose.Types.ObjectId();
  const employee = { _id: new mongoose.Types.ObjectId(), company, name: "Own employee", department: "Python", role: "user" };
  const colleague = { ...employee, _id: new mongoose.Types.ObjectId(), department: "Sales" };
  const actor = { ...employee, company: String(company), effectivePermissions: { view_leave_requests: false } };
  const people = [employee, colleague], calls: any[] = [];
  const missing = new Set<string>();
  const originalFind = User.findOne, originalContext = dayContext.resolveEmployeeDayContext;
  User.findOne = ((filter: any) => ({ select() { return this; }, lean: async () => people.find((person) => String(person._id) === String(filter._id) && String(person.company) === String(filter.company)) || null })) as any;
  (dayContext as any).resolveEmployeeDayContext = async (options: any) => {
    calls.push(options);
    assert.equal(String(options.companyId), String(company));
    assert.ok(options.versionCache instanceof Map);
    return { attendanceDate: options.attendanceDate, dayType: missing.has(options.attendanceDate) ? "unconfigured" : options.attendanceDate.endsWith("28") ? "mandatory_holiday" : options.attendanceDate.endsWith("29") ? "weekly_off" : "working_day" };
  };
  const invoke = async (query: any, user: any = actor) => {
    let response: any, failure: any, status = 0;
    const headers: any = {};
    await getLeaveRequestSetupService({ user, query }, { setHeader(key: string, value: string) { headers[key] = value; }, status(value: number) { status = value; return this; }, json(body: any) { response = body; return this; } } as any, (error: any) => { failure = error; });
    if (failure) throw failure;
    assert.equal(status, 200); assert.equal(headers["Cache-Control"], "private, no-store");
    return response.data;
  };
  try {
    const dates = { fromDate: "2026-11-24", toDate: "2026-11-24" };
    assert.deepEqual(await invoke(dates), { ...dates, ready: true, issues: [] });
    missing.add("2026-11-24");
    assert.deepEqual((await invoke(dates)).issues, [{ date: "2026-11-24", code: "work_schedule_missing" }]);
    assert.equal((await invoke(dates)).ready, false, "A missing setup is a successful check with ready=false, not a submit error");
    missing.clear(); missing.add("2026-11-26");
    const offset = calls.length;
    const range = await invoke({ fromDate: "2026-11-24", toDate: "2026-11-29" });
    assert.equal(range.ready, false); assert.deepEqual(range.issues, [{ date: "2026-11-26", code: "work_schedule_missing" }]);
    assert.equal(calls.length - offset, 6, "Every date, not just endpoints, is checked");
    assert.equal(new Set(calls.slice(offset).map((call) => call.versionCache)).size, 1, "Versions are cached across the range");
    missing.clear(); assert.equal((await invoke({ fromDate: "2026-11-24", toDate: "2026-11-29" })).ready, true, "Rechecking sees fixed setup; holiday/off-day behavior remains unchanged");
    const beforeMaximum = calls.length;
    assert.equal((await invoke({ fromDate: "2026-01-01", toDate: "2027-01-01" })).ready, true);
    assert.equal(calls.length - beforeMaximum, 366, "The existing maximum valid range is still accepted");
    const deniedBefore = calls.length;
    for (const [query, user, code] of [
      [{ ...dates, employeeId: String(colleague._id) }, actor, 403],
      [{ ...dates, companyId: String(foreignCompany) }, actor, 403],
      [{ ...dates, employeeId: String(new mongoose.Types.ObjectId()) }, actor, 404],
      [dates, { ...actor, _id: "invalid" }, 401],
    ] as any[]) await assert.rejects(invoke(query, user), (error: any) => error.statusCode === code);
    assert.equal(calls.length, deniedBefore, "Unauthorized targets never reach policy resolution");
    for (const query of [{}, { fromDate: dates.fromDate }, { ...dates, fromDate: [dates.fromDate] }, { ...dates, toDate: { $ne: "" } }, { ...dates, fromDate: "2026-02-30" }, { fromDate: "2026-11-25", toDate: "2026-11-24" }, { fromDate: "2026-01-01", toDate: "2027-01-02" }]) {
      await assert.rejects(invoke(query), (error: any) => error.statusCode === 400);
    }
    assert.equal(calls.length, deniedBefore);
    const admin = { ...actor, role: "hradmin", effectivePermissions: { view_leave_requests: true } };
    assert.equal((await invoke({ ...dates, employeeId: String(colleague._id) }, admin)).ready, true);
    const head = { ...actor, role: "departmenthead", effectivePermissions: { view_leave_requests: true } };
    await assert.rejects(invoke({ ...dates, employeeId: String(colleague._id) }, head), (error: any) => error.statusCode === 403);
    const direct = { ...colleague, reportingManager: actor._id }; people[1] = direct;
    assert.equal((await invoke({ ...dates, employeeId: String(colleague._id) })).ready, true, "Existing direct-manager access is preserved");
  } finally { User.findOne = originalFind; (dayContext as any).resolveEmployeeDayContext = originalContext; }
  console.log("Leave request setup checks passed: missing/mid-range/fixed schedules, holidays/off days, shared version cache, malformed/bounded dates, self/manager/HR scope and tenant guards. Actual handler with query/context doubles; no HTTP or database writes.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
