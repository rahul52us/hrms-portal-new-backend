import assert from "node:assert/strict";
import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import attendanceRouting from "../../routing/attendance.routing";
import User from "../../schemas/User/User";

dotenv.config();

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required for this read-only integration test");
  }
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const app = express();
  app.use(express.json());
  app.use("/api/attendance", attendanceRouting);
  app.use((error: any, _req: any, res: any, _next: any) =>
    res.status(error.statusCode || 500).json({ success: false, message: error.message })
  );

  const users: any[] = await User.find({
    deletedAt: null,
    is_enabled: { $ne: false },
    password: { $exists: true, $nin: [null, ""] },
  })
    .select("_id role company department hrScope")
    .lean();
  const employee = users.find(
    (item) =>
      item.role === "user" &&
      item.company &&
      users.some(
        (candidate) =>
          ["admin", "hradmin"].includes(candidate.role) &&
          String(candidate.company) === String(item.company)
      )
  );
  const admin = users.find(
    (item) =>
      ["admin", "hradmin"].includes(item.role) &&
      String(item.company) === String(employee?.company)
  );
  assert.ok(admin && employee, "Existing company admin and employee fixtures are required");

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;
  const token = (actor: any) =>
    jwt.sign(
      { userId: String(actor._id) },
      process.env.SECRET_KEY || "@#$4515Rahulkushwa_675@#",
      { expiresIn: "5m" }
    );
  const request = async (actor: any, path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/attendance${path}`, {
      headers: { Authorization: `Bearer ${token(actor)}` },
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  let assertions = 0;
  try {
    const date = "2026-09-18";
    const overview = await request(admin, `/overview?date=${date}&page=1&limit=2`);
    assert.equal(overview.status, 200); assertions++;
    assert.equal(overview.body.data.attendanceDate, date); assertions++;
    assert.ok(overview.body.data.items.length <= 2); assertions++;
    assert.ok(overview.body.data.summary.employees >= overview.body.pagination.total); assertions++;
    assert.equal(
      overview.body.data.summary.notMarked + overview.body.data.summary.absent >= 0,
      true
    ); assertions++;
    if (overview.body.data.items[0]) {
      const sample = overview.body.data.items[0];
      const filtered = await request(
        admin,
        `/overview?date=${date}&status=${sample.status}&workMode=${sample.workMode}&limit=100`
      );
      assert.equal(filtered.status, 200); assertions++;
      assert.ok(
        filtered.body.data.items.every(
          (row: any) => row.status === sample.status && row.workMode === sample.workMode
        )
      ); assertions++;
    }

    const options = await request(admin, `/overview/options?date=${date}`);
    assert.equal(options.status, 200); assertions++;
    assert.ok(Array.isArray(options.body.data.departments)); assertions++;
    assert.ok(Array.isArray(options.body.data.locations)); assertions++;
    assert.ok(Array.isArray(options.body.data.managers)); assertions++;

    if (overview.body.data.items[0]) {
      const row = overview.body.data.items[0];
      const detail = await request(
        admin,
        `/employee-day/${row.employee.id}?date=${date}`
      );
      assert.equal(detail.status, 200); assertions++;
      assert.equal(detail.body.data.employee.id, row.employee.id); assertions++;
      assert.equal(detail.body.data.attendanceDate, date); assertions++;
    }

    const forbidden = await request(employee, `/overview?date=${date}`);
    assert.equal(forbidden.status, 403); assertions++;
    const crossCompany = users.find(
      (item) => item.company && String(item.company) !== String(admin.company)
    );
    if (crossCompany) {
      const crossTenant = await request(
        admin,
        `/overview?date=${date}&companyId=${crossCompany.company}`
      );
      assert.equal(crossTenant.status, 403); assertions++;
    }
    assert.equal((await request(admin, "/overview?date=not-a-date")).status, 400); assertions++;
    assert.equal((await request(admin, `/overview?date=${date}&page=1.5`)).status, 400); assertions++;

    const departmentHead = users.find(
      (item) =>
        item.role === "departmenthead" && String(item.company) === String(admin.company)
    );
    if (departmentHead) {
      const scoped = await request(departmentHead, `/overview?date=${date}&limit=100`);
      assert.equal(scoped.status, 200); assertions++;
      assert.ok(
        scoped.body.data.items.every(
          (row: any) =>
            String(row.organization.department || "").toLowerCase() ===
            String(departmentHead.department || "").toLowerCase()
        )
      ); assertions++;
      const all = await request(admin, `/overview?date=${date}&limit=100`);
      const outside = all.body.data.items.find(
        (row: any) =>
          String(row.organization.department || "").toLowerCase() !==
          String(departmentHead.department || "").toLowerCase()
      );
      if (outside) {
        assert.equal(
          (
            await request(
              departmentHead,
              `/employee-day/${outside.employee.id}?date=${date}`
            )
          ).status,
          403
        ); assertions++;
      }
    }

    const scopedHr = users.find(
      (item) => item.role === "hr" && String(item.company) === String(admin.company)
    );
    if (scopedHr) {
      const scoped = await request(scopedHr, `/overview?date=${date}&limit=100`);
      assert.equal(scoped.status, 200); assertions++;
      const departments = (scopedHr.hrScope?.departments || []).map((value: any) =>
        String(value).toLowerCase()
      );
      assert.ok(
        scoped.body.data.items.every((row: any) =>
          departments.includes(String(row.organization.department || "").toLowerCase())
        )
      ); assertions++;
    }

    const superadmin = users.find((item) => item.role === "superadmin");
    if (superadmin) {
      assert.equal(
        (await request(superadmin, `/overview?date=${date}&companyId=${admin.company}`)).status,
        403
      ); assertions++;
    }

    console.log(`Read-only attendance overview integration tests passed (${assertions} assertions)`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
