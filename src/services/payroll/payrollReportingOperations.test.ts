import assert from "node:assert/strict";
import mongoose from "mongoose";
import PayrollAccessLog from "../../schemas/Payroll/PayrollAccessLog.schema";
import PayrollOperationalJob from "../../schemas/Payroll/PayrollOperationalJob.schema";
import payrollRouting from "../../routing/payroll.routing";
import {
  reportCsv,
  serializePayrollRegisterRow,
  serializePayrollVarianceRow,
} from "./payrollReport.service";
import { normalizeSettings } from "./salaryStructure.service";

const objectId = () => new mongoose.Types.ObjectId();

function finalizedResult(index = 1, overrides: Record<string, any> = {}) {
  return {
    employee: objectId(),
    identity: { name: `Employee ${index}`, code: `ACME-${index}`, username: `employee${index}@example.com` },
    organization: { designation: "Engineer", departmentName: "Engineering", teamName: "Platform", officeLocationName: "Delhi" },
    payrollDays: { paidDays: 29, unpaidDays: 1 },
    totals: {
      grossEarningsMinor: 500_000 + index,
      totalDeductionsMinor: 50_000,
      totalReimbursementsMinor: 5_000,
      netPayMinor: 455_000 + index,
      employerCostMinor: 550_000 + index,
    },
    snapshotHash: "a".repeat(64),
    ...overrides,
  };
}

function testFinalizedHistorySerialization() {
  const snapshot = finalizedResult(1);
  const row = serializePayrollRegisterRow(snapshot);
  const currentEmployeeProfile = { name: "Renamed employee", departmentName: "Sales" };
  currentEmployeeProfile.name = "Changed again";
  assert.equal(row.employeeName, "Employee 1");
  assert.equal(row.department, "Engineering");
  assert.equal(Object.prototype.hasOwnProperty.call(row, "username"), false, "reports must not expose login identifiers");

  const prior = finalizedResult(1, { employee: snapshot.employee, totals: { ...snapshot.totals, netPayMinor: 400_000 } });
  const variance = serializePayrollVarianceRow(snapshot, prior);
  assert.equal(variance.netVarianceMinor, 55_001);
  assert.equal(variance.comparisonAvailable, true);
}

function testSensitiveCsvControls() {
  const csv = reportCsv({ items: [{ employeeCode: "=HYPERLINK(\"https://invalid\")", employeeName: "+formula", netPayMinor: 1000, snapshotHash: "secret" }] });
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'\+formula/);
  assert.doesNotMatch(csv, /snapshotHash/);
}

function testOperationalSchemasAndIndexes() {
  const company = objectId();
  const actor = objectId();
  const job = new PayrollOperationalJob({
    company,
    jobType: "scheduled_reminders",
    idempotencyKey: "scheduled-reminders:2026-10-16",
    trigger: "scheduler",
    expiresAt: new Date("2027-01-16T00:00:00.000Z"),
  });
  assert.equal(job.validateSync(), undefined);
  assert.ok(PayrollOperationalJob.schema.indexes().some(([fields, options]) =>
    fields.company === 1 && fields.jobType === 1 && fields.idempotencyKey === 1 && options.unique
  ), "operational jobs need a tenant-scoped idempotency index");

  const accessLog = new PayrollAccessLog({
    company,
    actor,
    action: "report_exported",
    resourceType: "payroll_report",
    resourceId: "register:run:v1",
    requestFingerprint: "b".repeat(64),
    metadata: { rowCount: 10 },
    expiresAt: new Date("2027-10-16T00:00:00.000Z"),
  });
  assert.equal(accessLog.validateSync(), undefined);
  assert.equal(PayrollAccessLog.schema.path("ipAddress"), undefined, "raw network addresses must not be stored");
  assert.ok(PayrollAccessLog.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
}

function testLargeSnapshotSerialization() {
  const startedAt = Date.now();
  const rows = Array.from({ length: 10_000 }, (_, index) => serializePayrollRegisterRow(finalizedResult(index + 1)));
  assert.equal(rows.length, 10_000);
  assert.equal(rows[9_999].employeeCode, "ACME-10000");
  assert.ok(Date.now() - startedAt < 5_000, "10,000 finalized rows should serialize within five seconds");
}

function testSettingsMigrationCompatibilityAndRoutes() {
  const settings = normalizeSettings({
    currency: "INR",
    currencyMinorUnits: 2,
    payDay: 31,
    roundingMode: "nearest",
    employeeCompensationVisibility: "current",
  });
  assert.equal(settings.payrollReminderDay, 20);
  assert.equal(settings.payrollNotificationsEnabled, true);
  assert.equal(settings.accessLogRetentionDays, 365);
  assert.equal(settings.operationalJobRetentionDays, 90);
  assert.equal(settings.finalizedPayrollRetentionYears, 8);

  const routes = (payrollRouting as any).stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.ok(routes.includes("GET /reports/:reportType"));
  assert.ok(routes.includes("GET /reports/:reportType/export"));
  assert.ok(routes.includes("POST /operations/reminders/run"));
  assert.ok(routes.includes("POST /operations/jobs/:jobId/retry"));
}

testFinalizedHistorySerialization();
testSensitiveCsvControls();
testOperationalSchemasAndIndexes();
testLargeSnapshotSerialization();
testSettingsMigrationCompatibilityAndRoutes();

console.log("Payroll reporting, API integration, migration defaults, sensitive export, operational schema, finalized-history, and load tests passed");
