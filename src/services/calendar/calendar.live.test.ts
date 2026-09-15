import assert from "node:assert/strict";
import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import calendarRouting from "../../routing/calendar.routing";
import User from "../../schemas/User/User";

dotenv.config();

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required for this read-only integration test");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const app = express();
  app.use("/api/calendar", calendarRouting);
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  const users: any[] = await User.find({ deletedAt: null, is_enabled: { $ne: false }, password: { $exists: true, $nin: [null, ""] } }).select("_id role company reportingManager hrScope").lean();
  const employee = users.find((item) => item.role === "user" && item.company);
  const admin = users.find((item) => ["admin", "hradmin"].includes(item.role) && String(item.company) === String(employee?.company));
  assert.ok(employee && admin, "Existing employee and company admin fixtures are required; this test creates no data");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;
  const date = "2026-09-14";
  let assertions = 0;
  const request = async (actor: any, query: string, endpoint = "summary") => {
    const token = jwt.sign({ userId: String(actor._id) }, process.env.SECRET_KEY || "@#$4515Rahulkushwa_675@#", { expiresIn: "5m" });
    const response = await fetch(`http://127.0.0.1:${port}/api/calendar/${endpoint}?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const base = `fromDate=2026-09-01&toDate=2026-09-30`;
    const mine = await request(employee, base);
    assert.equal(mine.status, 200); assertions++;
    assert.equal(mine.body.data.days.length, 30); assertions++;
    assert.ok(mine.body.data.days.every((day: any) => day.employees <= 1)); assertions++;
    const options = await request(employee, base, "options");
    assert.equal(options.status, 200); assertions++;
    assert.ok(!options.body.data.scopes.includes("organization")); assertions++;
    const forbidden = await request(employee, `${base}&scope=organization`);
    assert.equal(forbidden.status, 403); assertions++;
    const company = await request(admin, `${base}&scope=organization&includePending=true`);
    assert.equal(company.status, 200); assertions++;
    assert.ok(company.body.data.days.every((day: any) => day.events.length === 0)); assertions++;
    for (const [category, field] of [["leave", "onLeave"], ["wfh", "wfh"], ["weekly_off", "weeklyOff"]] as const) {
      const sampleDay = company.body.data.days.find((day: any) => day[field] > 0);
      if (sampleDay) {
        const detail = await request(admin, `date=${sampleDay.date}&scope=organization&category=${category}&includePending=false&limit=50`, "day");
        assert.equal(detail.status, 200); assertions++;
        assert.equal(detail.body.pagination.total, sampleDay[field]); assertions++;
      }
    }
    const first = await request(admin, `date=${date}&scope=organization&page=1&limit=1`, "day");
    assert.equal(first.status, 200); assertions++;
    assert.ok(first.body.data.length <= 1); assertions++;
    if (first.body.pagination.total > 1) {
      const second = await request(admin, `date=${date}&scope=organization&page=2&limit=1`, "day");
      assert.notEqual(first.body.data[0].employee.id, second.body.data[0].employee.id); assertions++;
    }
    const day = await request(admin, `date=${date}&scope=organization&includePending=true&limit=50`, "day");
    const employeeIds = day.body.data.map((row: any) => new mongoose.Types.ObjectId(row.employee.id));
    const companies: any[] = await User.find({ _id: { $in: employeeIds } }).select("company").lean();
    assert.ok(companies.every((item) => String(item.company) === String(admin.company))); assertions++;
    const otherCompany = users.find((item) => item.company && String(item.company) !== String(employee.company));
    if (otherCompany) {
      const crossCompany = await request(admin, `${base}&companyId=${otherCompany.company}&scope=organization`);
      assert.equal(crossCompany.status, 403); assertions++;
      const crossEmployee = await request(admin, `${base}&employeeId=${otherCompany._id}&scope=organization`);
      assert.equal(crossEmployee.status, 200); assertions++;
      assert.ok(crossEmployee.body.data.days.every((day: any) => day.employees === 0)); assertions++;
    }
    const outOfRange = await request(admin, "fromDate=2026-01-01&toDate=2026-12-31");
    assert.equal(outOfRange.status, 400); assertions++;
    const badPage = await request(admin, `date=${date}&page=1.5`, "day");
    assert.equal(badPage.status, 400); assertions++;
    const superadmin = users.find((item) => item.role === "superadmin");
    if (superadmin) {
      assert.equal((await request(superadmin, `${base}&companyId=${employee.company}`)).status, 403); assertions++;
    }
    const manager = users.find((item) => users.some((reportee) => String(reportee.reportingManager) === String(item._id)));
    if (manager) {
      const reports = await request(manager, `${base}&scope=reportees`);
      assert.equal(reports.status, 200); assertions++;
      const reportOptions = await request(manager, base, "options");
      assert.ok(reportOptions.body.data.scopes.includes("reportees")); assertions++;
    }
    console.log(`Read-only calendar integration tests passed (${assertions} assertions)`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await mongoose.disconnect();
  }
}
main().catch(async (error) => { console.error(error.message); await mongoose.disconnect(); process.exitCode = 1; });
