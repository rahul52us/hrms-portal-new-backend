import assert from "node:assert/strict";
import mongoose from "mongoose";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import AttendancePolicy from "../../schemas/WorkforcePolicy/AttendancePolicy.schema";
import AttendanceVersion from "../../schemas/WorkforcePolicy/AttendancePolicyVersion.schema";
import Assignment from "../../schemas/WorkforcePolicy/WorkforcePolicyAssignment.schema";
import Audit from "../../schemas/WorkforcePolicy/WorkforcePolicyAuditLog.schema";
import { createPolicyAssignmentService, listPolicyAssignmentEmployeesService } from "./policyAssignment.service";
import { WORKFORCE_ROLE_PATTERN } from "./workforcePolicy.utils";

async function main() {
  const company = new mongoose.Types.ObjectId(), foreignCompany = new mongoose.Types.ObjectId(), policy = new mongoose.Types.ObjectId();
  const actor = { _id: new mongoose.Types.ObjectId(), company: String(company), role: "hradmin", effectivePermissions: { manage_workforce_policies: true, view_workforce_policies: true } };
  const rows: any[] = Array.from({ length: 145 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), company, name: `Employee ${String(index).padStart(3, "0")}`, code: `QA-${index}`, username: `fixture${index}@example.invalid`, role: "user", password: "not-for-response" }));
  for (const role of ["hr", "hradmin", "admin", "departmenthead", "manager", "hr-admin", "head hr"]) rows.push({ _id: new mongoose.Types.ObjectId(), company, name: `Staff ${role}`, code: `ROLE-${role}`, username: `${role}@example.invalid`, role });
  const literal = { _id: new mongoose.Types.ObjectId(), company, name: "Literal .* employee", code: "LITERAL", username: "literal@example.invalid", role: "hr", deletedAt: null };
  const removed = { _id: new mongoose.Types.ObjectId(), company, name: "Removed employee", role: "hr", deletedAt: new Date() };
  const foreign = { _id: new mongoose.Types.ObjectId(), company: foreignCompany, name: "Foreign employee", role: "hr" };
  const platform = { _id: new mongoose.Types.ObjectId(), company, name: "Platform account", role: "superadmin" };
  rows.push(literal, removed, foreign, platform);
  const matches = (row: any, filter: any) => String(row.company) === String(filter.company)
    && !row.deletedAt && (!filter._id || String(row._id) === String(filter._id))
    && (!filter.role || filter.role.$regex.test(row.role))
    && (!filter.$or || filter.$or.some((term: any) => Object.entries(term).some(([key, pattern]: any) => pattern.test(row[key] || ""))));
  const original = { userFind: User.find, userCount: User.countDocuments, userOne: User.findOne, companyOne: Company.findOne, policyOne: AttendancePolicy.findOne, versionOne: AttendanceVersion.findOne, assignmentFind: Assignment.find, assignmentCreate: Assignment.create, auditCreate: Audit.create };
  const chain = (data: any) => ({ select() { return this; }, sort() { return this; }, session() { return this; }, lean: async () => data });
  let lookups = 0;
  const created: any[] = [];
  const auditEvents: any[] = [];
  // Query doubles exercise the actual handlers without connecting to any company database.
  Company.findOne = ((filter: any) => chain(String(filter._id) === String(company) ? { _id: company, company_name: "Fixture company", is_active: true } : null)) as any;
  User.find = ((filter: any) => {
    lookups++;
    assert.equal(String(filter.company), String(company)); assert.equal(filter.deletedAt, null);
    let offset = 0, limit = 0;
    return {
      select(fields: string) { assert.equal(fields, "_id name code username role"); return this; },
      sort(order: any) { assert.deepEqual(order, { name: 1, _id: 1 }); return this; },
      skip(value: number) { offset = value; return this; }, limit(value: number) { assert.ok(value >= 1 && value <= 50); limit = value; return this; },
      lean: async () => rows.filter((row) => matches(row, filter)).sort((left, right) => left.name.localeCompare(right.name) || String(left._id).localeCompare(String(right._id))).slice(offset, offset + limit).map(({ _id, name, code, username, role }) => ({ _id, name, code, username, role })),
    };
  }) as any;
  User.countDocuments = (async (filter: any) => rows.filter((row) => matches(row, filter)).length) as any;
  User.findOne = ((filter: any) => { assert.equal(filter.deletedAt, null); return chain(rows.find((row) => matches(row, filter)) || null); }) as any;
  AttendancePolicy.findOne = (() => chain({ _id: policy, company, status: "active" })) as any;
  AttendanceVersion.findOne = (() => chain({ _id: new mongoose.Types.ObjectId(), effectiveFrom: new Date("2026-01-01") })) as any;
  Assignment.find = (() => chain([])) as any;
  Assignment.create = (async ([input]: any[]) => {
    const stored = { ...input, _id: new mongoose.Types.ObjectId() }; created.push(stored);
    return [{ ...stored, populate: async () => undefined, toObject: () => stored }];
  }) as any;
  Audit.create = (async (input: any) => { auditEvents.push(input); return {}; }) as any;
  const call = async (handler: any, query: any = {}, user: any = actor, body: any = {}) => {
    let status = 0, response: any, failure: any;
    await handler({ user, query, body, params: {} }, { status(value: number) { status = value; return this; }, json(value: any) { response = value; return this; } }, (error: any) => { failure = error; });
    if (failure) throw failure;
    return { status, ...response };
  };
  try {
    const first = await call(listPolicyAssignmentEmployeesService);
    assert.equal(first.status, 200); assert.equal(first.data.length, 25);
    assert.equal(first.pagination.total, 153); assert.equal(first.pagination.totalPages, 7);
    const fifth = await call(listPolicyAssignmentEmployeesService, { page: "5", limit: "25" });
    assert.equal(fifth.data[0].name, "Employee 100", "Employees after the old 100-row cap are available");
    const all: string[] = [];
    for (let page = 1; page <= first.pagination.totalPages; page++) {
      const result = await call(listPolicyAssignmentEmployeesService, { page: String(page) });
      all.push(...result.data.map((row: any) => String(row._id)));
    }
    assert.equal(new Set(all).size, first.pagination.total);
    assert.ok(!all.includes(String(removed._id)) && !all.includes(String(foreign._id)) && !all.includes(String(platform._id)));
    for (const search of ["employee 129", "QA-129", "FIXTURE129@EXAMPLE.INVALID"]) {
      const result = await call(listPolicyAssignmentEmployeesService, { search });
      assert.equal(result.data.length, 1); assert.equal(result.data[0].name, "Employee 129");
    }
    const escaped = await call(listPolicyAssignmentEmployeesService, { search: ".*" });
    assert.equal(escaped.data.length, 1); assert.equal(String(escaped.data[0]._id), String(literal._id));
    assert.deepEqual(Object.keys(escaped.data[0]).sort(), ["_id", "name", "code", "username", "role"].sort());
    for (const role of ["hr", "hradmin", "admin", "departmenthead", "manager", "hr-admin", "head hr"]) assert.equal(WORKFORCE_ROLE_PATTERN.test(role), true);
    for (const role of ["superadmin", "learner", "unknown"]) assert.equal(WORKFORCE_ROLE_PATTERN.test(role), false);
    const countBefore = lookups;
    await assert.rejects(call(listPolicyAssignmentEmployeesService, {}, { ...actor, effectivePermissions: { manage_workforce_policies: false } }), (error: any) => error.statusCode === 403);
    await assert.rejects(call(listPolicyAssignmentEmployeesService, { companyId: String(foreignCompany) }), (error: any) => error.statusCode === 403);
    for (const query of [{ limit: "100" }, { page: "0" }, { page: "1.5" }, { limit: "bad" }, { search: "x".repeat(101) }, { search: ["x"] }]) {
      await assert.rejects(call(listPolicyAssignmentEmployeesService, query), (error: any) => error.statusCode === 400);
    }
    assert.equal(lookups, countBefore, "Rejected requests cannot enumerate users");
    for (const role of ["hr", "hradmin", "admin"]) {
      const employee = rows.find((row) => row.role === role);
      const result = await call(createPolicyAssignmentService, {}, actor, { companyId: String(company), resourceType: "attendance_policy", resourceId: String(policy), scopeType: "employee", scopeId: String(employee._id), effectiveFrom: "2026-11-20", changeReason: "Fixture assignment" });
      assert.equal(result.status, 201); assert.equal(String(created[created.length - 1].scopeId), String(employee._id));
    }
    for (const employee of [removed, foreign, platform]) {
      await assert.rejects(call(createPolicyAssignmentService, {}, actor, { companyId: String(company), resourceType: "attendance_policy", resourceId: String(policy), scopeType: "employee", scopeId: String(employee._id), effectiveFrom: "2026-11-20", changeReason: "Fixture rejection" }), (error: any) => error.statusCode === 404);
    }
    assert.equal(created.length, 3, "Invalid targets cannot create assignment records");
    assert.equal(auditEvents.length, 3);
    assert.ok(auditEvents.every((event) => event.details.changeReason === "Fixture assignment"), "Assignment audit retains the searchable supplied reason");
  } finally {
    User.find = original.userFind; User.countDocuments = original.userCount; User.findOne = original.userOne;
    Company.findOne = original.companyOne; AttendancePolicy.findOne = original.policyOne; AttendanceVersion.findOne = original.versionOne;
    Assignment.find = original.assignmentFind; Assignment.create = original.assignmentCreate; Audit.create = original.auditCreate;
  }
  console.log("Policy assignment employee tests passed: >100 pagination, name/code/username search, HR eligibility, minimal fields, permission/tenant guards and assignment acceptance. In-memory queries only; no database connection or writes.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
