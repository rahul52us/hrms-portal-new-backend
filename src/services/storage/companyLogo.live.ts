import assert from "node:assert/strict";
import mongoose from "mongoose";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import Company from "../../schemas/company/Company";
import File from "../../schemas/Storage/PrivateStoredFile.schema";
import Audit from "../../schemas/Storage/CompanyLogoAudit.schema";
import Policy from "../../schemas/company/CompanyPolicy";
import Details from "../../schemas/company/companyDetails";
import Master from "../../schemas/masterData/masterData.schema";
import { loadHistoricalCompanyLogo } from "./companyLogo.service";
import { cleanupPrivateStoredFile } from "./privateStoredFile.service";
import { buildPayrollPayslipDocuments, renderPayrollPayslipPdf } from "../payroll/payrollPayslip.service";

export async function testCompanyLogos(input: { company: mongoose.Types.ObjectId; admin: mongoose.Types.ObjectId; employee: mongoose.Types.ObjectId; other: mongoose.Types.ObjectId; platform: mongoose.Types.ObjectId; base: string; token: (who: mongoose.Types.ObjectId) => string }) {
  const { company, admin, employee, other, platform, base, token } = input;
  assert.match(mongoose.connection.name, /^hrms_onboarding_test_/);
  await Audit.init();
  const created: any[] = [], suffix = String(new mongoose.Types.ObjectId()).slice(-8);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=", "base64");
  const logo = (filename = "company-brand.png") => ({ filename, type: "image/png", buffer: `data:image/png;base64,${png.toString("base64")}` });
  const profile = { company_name: `Storage Logo ${suffix}`, companyCode: "ONBTEST", tenantSlug: `storage-logo-${suffix}`, companyEmail: "brand@example.test", mobileNo: "9999900001", bio: "Private company branding test" };
  await Company.collection.updateOne({ _id: company }, { $set: { ...profile, logo: { name: "legacy.png", type: "image/png", url: "https://res.cloudinary.com/example/legacy-logo.png" } } });
  const call = async (who: any, route: string, method: string, body?: any, expected = 200) => {
    const response = await fetch(`${base}/api${route}`, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${token(who)}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result: any = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`); return result;
  };
  const read = async (who: any, path: string, expected = 200) => {
    const response = await fetch(`${base}/api${path}`, { headers: who ? { Authorization: `Bearer ${token(who)}` } : {} });
    assert.equal(response.status, expected, `${path}: ${response.status}`);
    if (expected === 200) {
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.match(response.headers.get("content-disposition") || "", /^inline;/);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    } else assert.equal(response.headers.get("content-disposition"), null);
  };
  const update = (image: any, expectedLogoUrl?: string) => ({ companyDetails: { ...profile, isLogoEdit: true, logo: image, ...(expectedLogoUrl !== undefined ? { expectedLogoUrl } : {}) } });
  const rules = async (value: any) => assert.equal((await fetch(`${process.env.R2_TEST_ENDPOINT}/__control`, { method: "POST", body: JSON.stringify(value) })).status, 200);
  try {
    await call(employee, `/company/${company}`, "PUT", update(logo(), ""), 403);
    await call(admin, `/company/${company}`, "PUT", update(logo()), 422);
    let saved = (await call(admin, `/company/${company}`, "PUT", update(logo(), "https://res.cloudinary.com/example/legacy-logo.png"))).data;
    const firstLogo = saved.logo;
    assert.match(firstLogo.url, /^\/company\/logos\//);
    await read(employee, firstLogo.url); await read(platform, firstLogo.url);
    await read(other, firstLogo.url, 404); await read(null, firstLogo.url, 401);
    const count = await File.countDocuments({ company, purpose: "company_logo" });
    const auditCount = await Audit.countDocuments({ company });
    await call(admin, `/company/${company}`, "PUT", update(logo(), "https://res.cloudinary.com/example/legacy-logo.png"));
    assert.equal(await File.countDocuments({ company, purpose: "company_logo" }), count, "An exact retry must not upload again");
    assert.equal(await Audit.countDocuments({ company }), auditCount);
    await call(admin, `/company/${company}`, "PUT", update(logo("new-name.png"), "stale-source"), 409);
    assert.equal(await File.countDocuments({ company, purpose: "company_logo" }), count);
    await call(admin, `/company/${company}`, "PUT", update({ ...logo(), buffer: "data:image/png;base64,TVo=" }, firstLogo.url), 422);
    const responses = await Promise.all(["parallel-a.png", "parallel-b.png"].map(async (filename) => {
      const response = await fetch(`${base}/api/company/${company}`, { method: "PUT", headers: { Authorization: `Bearer ${token(admin)}`, "Content-Type": "application/json" }, body: JSON.stringify(update(logo(filename), firstLogo.url)) }); return response.status;
    }));
    assert.deepEqual(responses.sort(), [200, 409]);
    saved = await Company.findById(company).lean();
    await read(employee, firstLogo.url, 404);
    assert.deepEqual((await loadHistoricalCompanyLogo(company, firstLogo))?.bytes, png);
    assert.equal(await loadHistoricalCompanyLogo(new mongoose.Types.ObjectId(), firstLogo), null);
    const run = { _id: new mongoose.Types.ObjectId(), company, companyNameSnapshot: profile.company_name, companyCodeSnapshot: profile.companyCode, periodKey: "2026-10", finalizationVersion: 1, cycleStartDate: "2026-09-26", cycleEndDate: "2026-10-25", currency: "INR", currencyMinorUnits: 2 };
    const result = { _id: new mongoose.Types.ObjectId(), employee, identity: { name: "Storage fixture employee", code: "ONB-TEST", username: "fixture@example.test" }, organization: {}, payrollDays: { paidDays: 30, unpaidDays: 0, totalDays: 30 }, recurringComponents: [], oneTimeInputs: [], statutoryContributions: [], totals: { grossEarningsMinor: 0, totalDeductionsMinor: 0, totalReimbursementsMinor: 0, employerContributionsMinor: 0, netPayMinor: 0 }, currency: "INR", currencyMinorUnits: 2, snapshotHash: "a".repeat(64) };
    const [payslip] = buildPayrollPayslipDocuments({ run, results: [result], company: { ...profile, logo: firstLogo }, actorId: admin, issuedAt: new Date() });
    assert.equal(payslip.companySnapshot.logo?.privateFileId, String(firstLogo.privateFileId));
    const pdf = await PDFDocument.load(await renderPayrollPayslipPdf({ payslip, run, result }));
    const images = pdf.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
    assert.ok(images?.keys().length, "Historical private logo must be embedded in the payslip PDF");
    if (process.argv.includes("--r2")) {
      await rules({ GET: "503" }); await read(employee, saved.logo.url, 503);
      const withoutLogo = await PDFDocument.load(await renderPayrollPayslipPdf({ payslip, run, result }));
      assert.ok(withoutLogo.getPageCount(), "An optional branding outage cannot block salary-slip access");
      await rules({});
      await rules({ PUT: "after_store_503", DELETE: "503" });
      await call(admin, `/company/${company}`, "PUT", update(logo("failed-brand.png"), saved.logo.url), 503);
      assert.equal((await Company.findById(company).lean() as any).logo.url, saved.logo.url);
      await rules({});
    }
    await call(admin, `/company/${company}`, "PUT", update(null, saved.logo.url));
    await read(employee, saved.logo.url, 404);
    const afterRemovalAudit = await Audit.countDocuments({ company });
    await call(admin, `/company/${company}`, "PUT", update(null, saved.logo.url));
    assert.equal(await Audit.countDocuments({ company }), afterRemovalAudit);
    assert.deepEqual((await loadHistoricalCompanyLogo(company, firstLogo))?.bytes, png);
    const createBody = { ...profile, company_name: `Created Logo ${suffix}`, companyCode: `LOGO-${suffix}`, tenantSlug: `created-logo-${suffix}`, logo: logo("new-company.png"), companyAdmin: { create: false } };
    const createdCompany = (await call(platform, "/company/manage", "POST", createBody, 201)).data;
    created.push(createdCompany._id); await read(platform, createdCompany.logo.url);
    assert.equal((await File.findById(createdCompany.logo.privateFileId).lean() as any).storageStatus, "attached");
    await assert.rejects(Audit.deleteMany({ company }));
    for (const file of await File.find({ company, purpose: "company_logo", storageStatus: "cleanup_pending" }).lean() as any[]) await cleanupPrivateStoredFile(file._id);
    console.log("Company logo API passed: private creation/replacement/removal, exact retries, stale/concurrent guards, isolation, file validation, immutable audit, historical payslip embedding and branding-outage fallback.");
  } finally {
    if (process.argv.includes("--r2")) await rules({});
    const ids = created.map((value) => new mongoose.Types.ObjectId(value));
    for (const model of [File, Audit, Policy, Details, Master]) await model.collection.deleteMany({ company: { $in: ids } });
    await Company.collection.deleteMany({ _id: { $in: ids } });
  }
}
