import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import CompensationImportBatch from "../../schemas/Payroll/CompensationImportBatch.schema";
import CompensationImportRow from "../../schemas/Payroll/CompensationImportRow.schema";
import { parseCompensationAmountToMinor, parseCompensationImportFile } from "./employeeCompensationImport.service";

async function testWorkbookParsing() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Compensation Import");
  sheet.addRow(["Employee Code", "Salary Structure Code", "Effective From", "Assignment Reason", "Override BASIC"]);
  sheet.addRow([" acme-101 ", "standard-monthly", "2026-10-01", "Annual compensation revision", "60,000.25"]);
  const buffer = await workbook.xlsx.writeBuffer();
  const rows = await parseCompensationImportFile({ originalname: "compensation.xlsx", buffer: Buffer.from(buffer) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[0].employeeCode, "ACME-101");
  assert.equal(rows[0].salaryStructureCode, "STANDARD_MONTHLY");
  assert.deepEqual(rows[0].overrideInputs, [{ componentCode: "BASIC", amount: "60,000.25" }]);
}

function testExactMinorUnitConversion() {
  assert.equal(parseCompensationAmountToMinor("60,000.25", 2), 6000025);
  assert.equal(parseCompensationAmountToMinor("0", 2), 0);
  assert.throws(() => parseCompensationAmountToMinor("100.123", 2), /at most 2 decimal places/);
  assert.throws(() => parseCompensationAmountToMinor("-1", 2), /non-negative/);
}

function testImportSchemas() {
  const company = new mongoose.Types.ObjectId();
  const actor = new mongoose.Types.ObjectId();
  const batch = new CompensationImportBatch({
    company,
    fileName: "compensation.xlsx",
    fileHash: "a".repeat(64),
    status: "previewed",
    totalRows: 1,
    validRows: 0,
    invalidRows: 1,
    createdBy: actor,
  });
  assert.equal(batch.validateSync(), undefined);
  const row = new CompensationImportRow({
    company,
    batch: batch._id,
    rowNumber: 2,
    employeeCode: "",
    salaryStructureCode: "",
    effectiveFrom: "",
    assignmentReason: "",
    status: "invalid",
    validationErrors: ["Employee code is required"],
  });
  assert.equal(row.validateSync(), undefined);
}

async function main() {
  await testWorkbookParsing();
  testExactMinorUnitConversion();
  testImportSchemas();
  console.log("Employee compensation import parser and schema tests passed");
}

void main();
