import assert from "node:assert/strict";
import mongoose from "mongoose";
import Company from "../../schemas/company/Company";
import PayrollRun from "../../schemas/Payroll/PayrollRun.schema";
import EmployeePayrollResult from "../../schemas/Payroll/EmployeePayrollResult.schema";
import PayrollValidationDecision from "../../schemas/Payroll/PayrollValidationDecision.schema";
import PayrollAuditLog from "../../schemas/Payroll/PayrollAuditLog.schema";
import { acknowledgeOpenPayrollWarningsService } from "./payrollValidation.service";

const id = () => new mongoose.Types.ObjectId();
const company = id(), runId = id(), actorId = id(), foreignCompany = id();
const eq = (a: any, b: any) => String(a) === String(b);
const originals: Array<() => void> = [];
function mock(object: any, key: string, value: any) { const previous = object[key]; originals.push(() => { object[key] = previous; }); object[key] = value; }
function query(value: any): any { return { session() { return this; }, select() { return this; }, populate() { return this; }, lean: async () => value }; }

async function main() {
  let run: any, results: any[] = [], decisions: any[] = [], audits: any[] = [], failAudit = false, failUpdate = false, active = true;
  const session = {};
  const reset = (count = 3) => {
    run = { _id: runId, company, status: "draft", version: 4, calculationVersion: 2, calculationStatus: "calculated" };
    results = Array.from({ length: count }, (_, index) => ({ _id: id(), employee: id(), company, payrollRun: runId, calculationVersion: 2, issues: [{ severity: "warning", category: "bank", code: `bank_${index}` }] }));
    results.push({ ...results[0], _id: id(), issues: [{ severity: "error", category: "compensation", code: "missing_salary" }] });
    results.push({ ...results[0], _id: id(), company: foreignCompany });
    results.push({ ...results[0], _id: id(), calculationVersion: 1 });
    decisions = []; audits = []; failAudit = false; failUpdate = false; active = true;
  };
  reset();
  mock(Company, "findOne", (filter: any) => query(eq(filter._id, company) ? { _id: company, is_active: active } : null));
  mock(PayrollRun, "findOne", (filter: any) => query(eq(filter._id, runId) && eq(filter.company, company) ? { ...run } : null));
  mock(PayrollRun, "updateOne", async (filter: any, update: any, options: any) => {
    assert.equal(options.session, session); assert.equal(filter.version, run.version); assert.equal(filter.calculationVersion, 2);
    if (failUpdate) return { modifiedCount: 0 };
    run.version += update.$inc.version; return { modifiedCount: 1 };
  });
  mock(EmployeePayrollResult, "aggregate", (pipeline: any[]) => ({ session: async (value: any) => {
    assert.equal(value, session);
    const match = pipeline[0].$match;
    assert.ok(eq(match.company, company)); assert.ok(eq(match.payrollRun, runId)); assert.equal(match.calculationVersion, 2);
    assert.ok(pipeline.some((stage) => stage.$match?.["issues.severity"] === "warning"));
    assert.ok(pipeline.some((stage) => stage.$match?.resolutionStatus === "open"));
    assert.equal(pipeline.find((stage) => stage.$limit).$limit, 101);
    const warningRows = results.filter((item) => eq(item.company, match.company) && eq(item.payrollRun, match.payrollRun) && item.calculationVersion === match.calculationVersion)
      .flatMap((result) => result.issues.map((issue: any) => ({ ...result, issues: issue })))
      .filter((row) => row.issues.severity === "warning" && !decisions.some((decision) => eq(decision.employeePayrollResult, row._id) && decision.issueCode === row.issues.code && decision.issueCategory === row.issues.category));
    return warningRows.slice(0, 101);
  } }));
  mock(PayrollValidationDecision, "create", async (rows: any[], options: any) => {
    assert.equal(options.session, session);
    assert.equal(options.ordered, true, "Transaction writes must not save warning documents in parallel");
    for (const row of rows) { assert.equal(new PayrollValidationDecision(row).validateSync(), undefined); decisions.push(row); }
    return rows;
  });
  mock(PayrollAuditLog, "create", async (rows: any[], options: any) => { assert.equal(options.session, session); if (failAudit) throw new Error("Fixture audit failure"); audits.push(...rows); return rows; });
  mock(mongoose.connection, "transaction", async (callback: any) => {
    const before = { run: { ...run }, decisions: [...decisions], audits: [...audits] };
    try { return await callback(session); }
    catch (error) { run = before.run; decisions = before.decisions; audits = before.audits; throw error; }
  });
  async function call(body: any = {}, actor: any = {}, params: any = {}) {
    let status = 0, payload: any, error: any;
    await acknowledgeOpenPayrollWarningsService({
      user: { _id: actorId, company, role: "hradmin", name: "Payroll HR", code: "TEST-HR", effectivePermissions: { view_payroll: true, manage_payroll_runs: true }, ...actor },
      params: { runId: String(runId), ...params },
      body: { companyId: String(company), reason: "Reviewed all warnings for this calculation", expectedVersion: run.version, expectedCalculationVersion: 2, ...body },
    }, { status(code: number) { status = code; return this; }, json(value: any) { payload = value; return this; } } as any, (value: any) => { error = value; });
    return { status, payload, error };
  }
  try {
    let response = await call(); assert.equal(response.error, undefined); assert.equal(response.status, 201);
    assert.equal(response.payload.acknowledgedCount, 3); assert.equal(response.payload.hasMore, false); assert.equal(run.version, 5);
    assert.equal(decisions.length, 3); assert.equal(audits.length, 1);
    assert.ok(decisions.every((row) => row.issueSeverity === "warning" && eq(row.company, company) && eq(row.actor, actorId) && row.calculationVersion === 2));
    response = await call(); assert.equal(response.status, 200); assert.equal(response.payload.acknowledgedCount, 0); assert.equal(decisions.length, 3); assert.equal(run.version, 5);
    reset(125); response = await call(); assert.equal(response.payload.acknowledgedCount, 100); assert.equal(response.payload.hasMore, true);
    response = await call(); assert.equal(response.payload.acknowledgedCount, 25); assert.equal(response.payload.hasMore, false); assert.equal(decisions.length, 125); assert.equal(run.version, 6);
    for (const [body, actor, params, pattern] of [
      [{ expectedVersion: 3 }, {}, {}, /changed/], [{ expectedCalculationVersion: 1 }, {}, {}, /changed/],
      [{ expectedVersion: 0 }, {}, {}, /versions/], [{ expectedCalculationVersion: null }, {}, {}, /versions/],
      [{ reason: "x" }, {}, {}, /3 to 500/], [{ reason: "x".repeat(501) }, {}, {}, /3 to 500/],
      [{ companyId: String(foreignCompany) }, {}, {}, /only access payroll/],
      [{}, { role: "user", effectivePermissions: {} }, {}, /access has not been assigned/],
      [{}, { effectivePermissions: { view_payroll: true, manage_payroll_runs: false } }, {}, /permission/],
      [{}, {}, { runId: "invalid" }, /Invalid/], [{}, {}, { runId: String(id()) }, /not found/],
    ] as any[]) {
      reset(); response = await call(body, actor, params); assert.match(response.error?.message || "", pattern); assert.equal(decisions.length, 0);
    }
    for (const status of ["review", "approved", "finalized"]) { reset(); run.status = status; response = await call(); assert.match(response.error?.message || "", /calculated draft/); assert.equal(decisions.length, 0); }
    reset(); run.calculationStatus = "stale"; response = await call(); assert.match(response.error?.message || "", /calculated draft/);
    reset(); active = false; response = await call(); assert.match(response.error?.message || "", /inactive/);
    reset(); failAudit = true; response = await call(); assert.match(response.error?.message || "", /audit failure/); assert.equal(decisions.length, 0); assert.equal(run.version, 4);
    reset(); failUpdate = true; response = await call(); assert.match(response.error?.message || "", /changed/); assert.equal(decisions.length, 0); assert.equal(run.version, 4);
    console.log("Payroll bulk-warning handler checks passed: permission/tenant/active-company guards, versions, draft/current calculation, warning-only batches, per-issue evidence, 125-row continuation, retry/no-op, audit/concurrency rollback doubles. No HTTP or database connection.");
  } finally { for (const restore of originals.reverse()) restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
