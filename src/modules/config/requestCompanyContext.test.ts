import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import authenticate from "./authenticate";
import { getAuthenticatedCompany, setAuthenticatedCompany } from "./requestCompanyContext";
import { resolvePolicyCompany } from "../../services/workforcePolicy/workforcePolicy.utils";
import { resolvePayrollCompany } from "../../services/payroll/payroll.utils";

async function main() {
  const companyId = new mongoose.Types.ObjectId(), otherId = new mongoose.Types.ObjectId(), userId = new mongoose.Types.ObjectId();
  let user: any = { _id: userId, role: "hradmin", company: companyId, password: "fixture-hash", is_enabled: true };
  let company: any = { _id: companyId, company_name: "Fixture", companyCode: "FIX", is_active: true, payrollSettings: { attendanceCutoffDay: 25 } };
  let authUserReads = 0, authCompanyReads = 0, companyReads = 0;
  const original = { user: User.findById, company: Company.findById, find: Company.findOne };
  const query = (getValue: () => any): any => ({ select() { return this; }, lean: async () => getValue() });
  (User as any).findById = () => { authUserReads++; return query(() => user ? { ...user } : null); };
  (Company as any).findById = () => { authCompanyReads++; return query(() => company ? { ...company } : null); };
  (Company as any).findOne = (match: any) => { companyReads++; return query(() => String(match._id) === String(company?._id) && company?.deletedAt === undefined ? { ...company } : null); };
  const token = jwt.sign({ userId: String(userId) }, process.env.SECRET_KEY ?? "@#$4515Rahulkushwa_675@#");
  async function auth() {
    const req: any = { headers: { authorization: `Bearer ${token}` } }; let passed = false, status = 0;
    await authenticate(req, { status(code: number) { status = code; return this; }, json() { return this; } } as any, () => { passed = true; });
    return { req, passed, status };
  }
  try {
    const first = await auth(); assert.equal(first.passed, true);
    assert.equal(authUserReads, 1); assert.equal(authCompanyReads, 1);
    const policy = await resolvePolicyCompany(first.req, String(companyId));
    assert.equal("payrollSettings" in policy.company, false, "Policy consumers keep the existing narrow company projection");
    const payroll = await resolvePayrollCompany(first.req, String(companyId));
    assert.equal(payroll.company.payrollSettings.attendanceCutoffDay, 25);
    assert.equal(companyReads, 0, 'Read handlers reuse the authenticated company without another query');
    assert.equal(getAuthenticatedCompany({ ...first.req }, String(companyId)), null, 'Context cannot be transferred through user-controlled request fields');
    assert.equal(getAuthenticatedCompany(first.req, String(otherId)), null);
    await assert.rejects(resolvePolicyCompany(first.req, String(otherId)), /only access policies/);
    await assert.rejects(resolvePayrollCompany(first.req, String(otherId)), /only access payroll/);
    const uncached = { user: { ...user } }; await resolvePolicyCompany(uncached, String(companyId)); assert.equal(companyReads, 1);
    company = { ...company, is_active: false };
    await assert.rejects(resolvePolicyCompany(first.req, String(companyId), true), /inactive/);
    await assert.rejects(resolvePayrollCompany(first.req, String(companyId), true), /inactive/);
    assert.equal(companyReads, 3, 'Mutations still perform a fresh active-company check');
    const second = await auth(); assert.equal(second.passed, true); assert.equal(authUserReads, 2); assert.equal(authCompanyReads, 2);
    assert.equal(getAuthenticatedCompany(second.req, String(companyId)).is_active, false, 'Every request re-reads company state');
    user = { ...user, is_enabled: false };
    const disabled = await auth(); assert.equal(disabled.passed, false); assert.equal(disabled.status, 401);
    assert.equal(getAuthenticatedCompany(disabled.req, String(companyId)), null);
    const arbitrary = {}; setAuthenticatedCompany(arbitrary, { _id: companyId, deletedAt: null });
    assert.equal(getAuthenticatedCompany(arbitrary, String(companyId)), null, 'Deleted-field semantics must match existing non-deleted queries');
    console.log('Request company context passed: real authentication, request-local reuse, tenant guards, uncached fallback, fresh mutation checks, current user/company status and no cross-request cache. In-memory query doubles; no database connection.');
  } finally { (User as any).findById = original.user; (Company as any).findById = original.company; (Company as any).findOne = original.find; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
