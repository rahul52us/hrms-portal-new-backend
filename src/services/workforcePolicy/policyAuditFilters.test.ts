import assert from "node:assert/strict";
import mongoose from "mongoose";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import Department from "../../schemas/Department/Department.schema";
import Assignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import Audit from "../../schemas/WorkforcePolicy/WorkforcePolicyAuditLog.schema";
import { applyPolicyAuditFilters } from "./policyAuditFilters";
import { listPolicyAuditLogService } from "./policyAssignment.service";

const id = () => new mongoose.Types.ObjectId();
const equal = (a: any, b: any) => a == null && b == null || String(a) === String(b);
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]: any) => {
    if (key === "$and") return value.every((term: any) => matches(row, term));
    if (key === "$or") return value.some((term: any) => matches(row, term));
    const actual = key.split(".").reduce((part: any, name: string) => part?.[name], row);
    if (value instanceof RegExp) return value.test(String(actual || ""));
    if (value && typeof value === "object" && !(value instanceof mongoose.Types.ObjectId) && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, expected]: any) => {
        if (operator === "$in") return expected.some((item: any) => equal(actual, item));
        if (operator === "$regex") return expected.test(String(actual || ""));
        if (operator === "$gte") return actual >= expected;
        if (operator === "$lt") return actual < expected;
        throw new Error(`Unhandled fixture operator ${operator}`);
      });
    }
    return equal(actual, value);
  });
}

async function main() {
  const company = id(), foreignCompany = id(), ownDepartment = id(), otherDepartment = id(), ownAssignment = id(), otherAssignment = id();
  const own = { _id: id(), company, name: "Asha Reviewer", username: "asha@example.invalid", code: "PY-001", department: "Python", role: "hr" };
  const other = { _id: id(), company, name: "Other colleague", username: "other@example.invalid", code: "SA-001", department: "Sales", role: "hr" };
  const people = [own, other, { ...own, _id: id(), company: foreignCompany }];
  const assignments = [{ _id: ownAssignment, company, scopeType: "department", scopeId: ownDepartment }, { _id: otherAssignment, company, scopeType: "department", scopeId: otherDepartment }];
  const row = (values: any = {}) => ({ _id: id(), company, entityType: "assignment", entityId: ownAssignment, actor: own._id, details: { reason: "Adjusted cutoff after review" }, createdAt: new Date("2026-11-19T18:30:00.000Z"), ...values });
  const batch = Array.from({ length: 27 }, () => row());
  const before = row({ createdAt: new Date("2026-11-19T18:29:59.999Z") });
  const after = row({ createdAt: new Date("2026-11-20T18:30:00.000Z") });
  const literal = row({ details: { changeReason: "Literal .* text" } });
  const nested = row({ details: { after: { cancellationReason: "Cancelled legacy draft" } } });
  const otherRow = row({ entityId: otherAssignment, actor: other._id });
  const rows = [...batch, before, after, literal, nested, otherRow, row({ company: foreignCompany })];
  const admin = { _id: id(), company: String(company), role: "hradmin" };
  const head = { ...admin, role: "departmenthead", department: "Python" };
  const originals = { company: Company.findOne, people: User.distinct, departments: Department.find, assignments: Assignment.distinct, audit: Audit.find, count: Audit.countDocuments };
  let finds = 0, actorSearches = 0;
  const chain = (data: any) => ({ select() { return this; }, lean: async () => data });
  Company.findOne = (() => chain({ _id: company, company_name: "Fixture" })) as any;
  User.distinct = (async (field: string, filter: any) => {
    if (filter.$or) actorSearches++;
    return people.filter((person) => matches(person, filter)).map((person: any) => person[field]).filter(Boolean);
  }) as any;
  Department.find = (() => chain([{ _id: ownDepartment, teams: [] }])) as any;
  Assignment.distinct = (async (field: string, filter: any) => assignments.filter((assignment) => matches(assignment, filter)).map((assignment: any) => assignment[field])) as any;
  Audit.find = ((filter: any) => {
    finds++;
    let offset = 0, limit = 50;
    return {
      populate() { return this; },
      sort(order: any) { assert.deepEqual(order, { createdAt: -1, _id: -1 }); return this; },
      skip(value: number) { offset = value; return this; }, limit(value: number) { limit = value; return this; },
      lean: async () => rows.filter((item) => matches(item, filter)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || String(b._id).localeCompare(String(a._id))).slice(offset, offset + limit),
    };
  }) as any;
  Audit.countDocuments = (async (filter: any) => rows.filter((item) => matches(item, filter)).length) as any;
  const call = async (query: any = {}, actor: any = admin) => {
    let body: any, error: any;
    await listPolicyAuditLogService({ user: actor, query, params: {} }, { status() { return this; }, json(value: any) { body = value; } } as any, (value: any) => { error = value; });
    if (error) throw error;
    return body;
  };
  try {
    const base = await call(); assert.equal(base.pagination.total, rows.length - 1); assert.equal(actorSearches, 0);
    const range = { fromDate: "2026-11-20", toDate: "2026-11-20", timezone: "Asia/Kolkata" };
    const result = await call({ ...range, search: "CUTOFF", entityType: "assignment", page: 2, limit: 20 });
    assert.equal(result.pagination.total, 28); assert.equal(result.data.length, 8);
    const scoped = await call({ ...range, search: "cutoff", limit: 100 }, head);
    assert.equal(scoped.pagination.total, 27); assert.ok(scoped.data.every((item: any) => equal(item.entityId, ownAssignment)));
    for (const search of ["ASHA REVIEWER", "asha@example.invalid", "py-001"]) {
      const found = await call({ ...range, search, limit: 100 });
      assert.equal(found.pagination.total, 29); assert.ok(found.data.every((item: any) => equal(item.actor, own._id)));
    }
    assert.equal((await call({ search: ".*" })).pagination.total, 1, "Regex metacharacters are literal");
    assert.equal((await call({ search: "Cancelled legacy" })).pagination.total, 1, "Legacy nested timesheet reasons remain searchable");
    assert.equal((await call({ search: "Other colleague" }, head)).pagination.total, 0, "Actor search cannot widen department scope");
    assert.equal((await call({ search: "cutoff", entityId: String(otherAssignment) }, head)).pagination.total, 0);
    assert.equal((await call({ fromDate: range.fromDate, timezone: range.timezone, limit: 100 })).data.some((item: any) => equal(item._id, before._id)), false);
    assert.equal((await call({ toDate: range.toDate, timezone: range.timezone, limit: 100 })).data.some((item: any) => equal(item._id, after._id)), false);
    const unchanged = { company, $and: [{ actor: own._id }] };
    await applyPolicyAuditFilters({ search: " " }, company, unchanged); assert.equal(unchanged.$and.length, 1);
    const dst: any = {}; await applyPolicyAuditFilters({ fromDate: "2026-03-08", toDate: "2026-03-08", timezone: "America/New_York" }, company, dst);
    assert.equal(dst.createdAt.$gte.toISOString(), "2026-03-08T05:00:00.000Z"); assert.equal(dst.createdAt.$lt.toISOString(), "2026-03-09T04:00:00.000Z");
    const utc: any = {}; await applyPolicyAuditFilters({ fromDate: "2026-11-20", toDate: "2026-11-20" }, company, utc);
    assert.equal(utc.createdAt.$gte.toISOString(), "2026-11-20T00:00:00.000Z");
    const beforeInvalid = finds;
    for (const query of [{ fromDate: "2026-02-30" }, { fromDate: "not-a-date" }, { fromDate: "2026-11-21", toDate: "2026-11-20" }, { search: ["Asha"] }, { search: "x".repeat(101) }, { timezone: "invalid/zone" }, { timezone: ["UTC"] }, { fromDate: ["2026-11-20"] }, { toDate: "2026-11-20T00:00:00Z" }]) {
      await assert.rejects(call(query), (error: any) => error.statusCode === 400);
    }
    assert.equal(finds, beforeInvalid, "Invalid filters cannot run the audit query");
  } finally {
    Company.findOne = originals.company; User.distinct = originals.people; Department.find = originals.departments;
    Assignment.distinct = originals.assignments; Audit.find = originals.audit; Audit.countDocuments = originals.count;
  }
  console.log("Policy audit filter tests passed: person/reason search, escaped input, local/DST/inclusive date boundaries, combined filters, pagination/totals, tenant/department scope and invalid query rejection. In-memory queries only; no database writes or HTTP requests.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
