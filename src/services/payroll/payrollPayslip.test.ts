import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import mongoose from "mongoose";
import { PDFDocument } from "pdf-lib";
import PayrollPayslip, { PAYSLIP_TEMPLATE_VERSION } from "../../schemas/Payroll/PayrollPayslip.schema";
import {
  buildPayrollPayslipDocuments,
  payrollPayslipNumber,
  payslipContentHash,
  renderPayrollPayslipPdf,
} from "./payrollPayslip.service";

const objectId = () => new mongoose.Types.ObjectId();

async function testPayslipDocumentsAndPdf() {
  const company = objectId();
  const employee = objectId();
  const run = {
    _id: objectId(),
    company,
    companyNameSnapshot: "Acme Technologies",
    companyCodeSnapshot: "ACME",
    periodKey: "2026-09",
    cycleStartDate: "2026-08-26",
    cycleEndDate: "2026-09-25",
    finalizationVersion: 2,
    currency: "INR",
    currencyMinorUnits: 2,
  };
  const result = {
    _id: objectId(),
    employee,
    identity: { name: "Asha Sharma", code: "ACME-101", username: "asha@example.com" },
    organization: {
      designation: "Software Engineer",
      departmentName: "Engineering",
      teamName: "Platform",
      officeLocationName: "Delhi",
    },
    payrollDays: { paidDays: 29, unpaidDays: 1, totalDays: 30, approvedOvertimeMinutes: 60 },
    recurringComponents: [
      { componentName: "Basic salary", componentCode: "BASIC", category: "earning", payableAmountMinor: 5000000 },
      { componentName: "Provident fund", componentCode: "PF_MANUAL", category: "deduction", payableAmountMinor: 0 },
    ],
    oneTimeInputs: [
      { componentName: "Performance bonus", componentCode: "BONUS", inputType: "earning", amountMinor: 250000 },
      { componentName: "Travel reimbursement", componentCode: "TRAVEL", inputType: "reimbursement", amountMinor: 50000 },
    ],
    statutoryContributions: [
      { name: "Employee provident fund", code: "EPF_EMPLOYEE", side: "employee_deduction", amountMinor: 180000 },
      { name: "Employer provident fund", code: "EPF_EMPLOYER", side: "employer_contribution", amountMinor: 180000 },
    ],
    totals: {
      grossEarningsMinor: 5250000,
      totalDeductionsMinor: 180000,
      totalReimbursementsMinor: 50000,
      employerContributionsMinor: 180000,
      netPayMinor: 5120000,
    },
    currency: "INR",
    currencyMinorUnits: 2,
    snapshotHash: "a".repeat(64),
  };
  const issuedAt = new Date("2026-10-06T05:30:00.000Z");
  const [document] = buildPayrollPayslipDocuments({
    run,
    results: [result],
    company: {
      company_name: "Acme Technologies",
      companyCode: "ACME",
      logo: {
        name: "acme.png",
        type: "image/png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAAA8CAYAAADha7EVAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAJ4SURBVHhe7ZjNTQMxEEZphpoogEKQKIQLTaSANJAWOCEhIXHggHIw4i8h+33etVcRIzxvpHdZ2c5hX74Z78Xl9VMBiOJi+gDgL0FACAUBIRQEhFAQEEJBQAgFASEUBIRQEBBCQUAIBQEhFASEUBAQQkFACAUBIRQEhFAQEEJBQAglpYA3u+Jr9yJre7na7KenHuph8yzrs5NQwJeynZpxqLdyI+vbqErt6gyij0I+Ae/epjqc1PbO7JllTuiZenwtV3JWPtIJuJhUXWKslO+nSMJkAt6+locTA/Zlu5vObPtyf2v2Cs/l/nGy9bvcrFcTvz9xxyKVgHJB+Eg7kdILJNhWvjBDuj1diTseiQTUxPoSTZ8vS2H2NCanJmHbvlHJI6Ak3fHFSzIuSSFndcxzhxRc+I0kpBFQJPudcr1CmVaafZZbSxIB9bZ6Oue5llqf50Rm0mw1OQSUxDJyyZp6qjHHnY8UAoowtr1qSvp15jwEXE0CAVWs9mQzSWnXIeBahhdQ5zUv1SemDbtvgnpmXWqYZ3AB3eWis9w3wUZRPcdERtrRBXSfV7rLtFd3bmVeFIy8mUUcWkDXKteUpptLViOq4PbNjAQJGFhAvXysrsY2vCSTXl46knNQxhXQCNLa6pwoutel2Vfp2tqfoSU1x2ZYAVWi+XQ6wchrk8rNgh2lrT0fgwqoidP3snV/VeC1EjqhEzKkgHr56G91mqCutf5Qb8eu6ufkY0ABjQzuErGES7aGc1T+YyGeMqCA8J9AQAgFASEUBIRQEBBCQUAIBQEhFASEUBAQQkFACAUBIRQEhFAQEEJBQAgFASEUBIRQEBBCQUAI5R0sQHpIZYdC4gAAAABJRU5ErkJggg==",
      },
      registeredAddress: {
        addressLine1: "12 Connaught Place",
        addressLine2: "Block A",
        city: "New Delhi",
        state: "Delhi",
        postalCode: "110001",
        country: "India",
      },
    },
    actorId: objectId(),
    issuedAt,
  });

  assert.equal(document.payslipNumber, "ACME-202609-ACME-101-F2");
  assert.equal(document.templateVersion, PAYSLIP_TEMPLATE_VERSION);
  assert.equal(document.contentHash.length, 64);
  assert.deepEqual(document.companySnapshot.registeredAddress, {
    addressLine1: "12 Connaught Place",
    addressLine2: "Block A",
    city: "New Delhi",
    state: "Delhi",
    postalCode: "110001",
    country: "India",
  });
  assert.equal(document.companySnapshot.logo?.type, "image/png");
  assert.equal(document.contentHash, payslipContentHash({
    payslipNumber: document.payslipNumber,
    templateVersion: document.templateVersion,
    periodKey: document.periodKey,
    finalizationVersion: document.finalizationVersion,
    currency: document.currency,
    currencyMinorUnits: document.currencyMinorUnits,
    companySnapshot: document.companySnapshot,
    employeeSnapshot: document.employeeSnapshot,
    amountsSnapshot: document.amountsSnapshot,
    sourceSnapshotHash: document.sourceSnapshotHash,
    issuedAt: document.issuedAt,
  }));

  const model = new PayrollPayslip(document);
  await model.validate();
  const pdf = await renderPayrollPayslipPdf({ payslip: document, run, result });
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  const loaded = await PDFDocument.load(pdf);
  assert.ok(loaded.getPageCount() >= 1);
  if (process.env.PAYSLIP_SAMPLE_PATH) {
    await mkdir(dirname(process.env.PAYSLIP_SAMPLE_PATH), { recursive: true });
    await writeFile(process.env.PAYSLIP_SAMPLE_PATH, pdf);
  }
}

function testNumberNormalizationAndIndexes() {
  assert.equal(payrollPayslipNumber({
    companyCode: "ac me",
    periodKey: "2026-09",
    employeeCode: "emp / 7",
    finalizationVersion: 1,
  }), "AC-ME-202609-EMP-7-F1");
  const indexes = PayrollPayslip.schema.indexes();
  assert.ok(indexes.some(([fields, options]) =>
    fields.company === 1
    && fields.payrollRun === 1
    && fields.finalizationVersion === 1
    && fields.employee === 1
    && options.unique
  ));
}

Promise.resolve()
  .then(testPayslipDocumentsAndPdf)
  .then(testNumberNormalizationAndIndexes)
  .then(() => console.log("Versioned payroll payslip schema, integrity, and PDF tests passed"));
