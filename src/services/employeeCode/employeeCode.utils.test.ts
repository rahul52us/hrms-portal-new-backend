import assert from "node:assert/strict";
import {
  MAX_COMPANY_CODE_LENGTH,
  MAX_EMPLOYEE_NUMBER_LENGTH,
  buildEmployeeIdentifier,
  isValidCompanyCode,
  isValidEmployeeNumber,
  normalizeCompanyCode,
  normalizeEmployeeNumber,
} from "./employeeCode.utils";

function testNormalizeCompanyCodeTrimsAndUppercases() {
  assert.equal(normalizeCompanyCode("  acme "), "ACME");
  assert.equal(normalizeCompanyCode("Acme-Hr"), "ACME-HR");
  assert.equal(normalizeCompanyCode(null), "");
  assert.equal(normalizeCompanyCode(undefined), "");
  assert.equal(normalizeCompanyCode(123), "123");
}

function testNormalizeEmployeeNumberStripsCompanyPrefix() {
  assert.equal(normalizeEmployeeNumber("acme-0042", "acme"), "0042");
  assert.equal(normalizeEmployeeNumber("ACME-0042", " Acme "), "0042");
  assert.equal(normalizeEmployeeNumber("0042", "ACME"), "0042");
}

function testNormalizeEmployeeNumberWithoutCompanyOnlyNormalizesCase() {
  assert.equal(normalizeEmployeeNumber(" emp-7 "), "EMP-7");
  assert.equal(normalizeEmployeeNumber("acme-0042", ""), "ACME-0042");
  assert.equal(normalizeEmployeeNumber(null, "ACME"), "");
}

function testNormalizeEmployeeNumberStripsOnlyOnePrefix() {
  assert.equal(normalizeEmployeeNumber("ACME-ACME-5", "ACME"), "ACME-5");
}

function testNormalizeEmployeeNumberDoesNotStripPartialPrefix() {
  // "ACMEX-1" starts with "ACME" but not with "ACME-", so it must be kept intact.
  assert.equal(normalizeEmployeeNumber("ACMEX-1", "ACME"), "ACMEX-1");
}

function testCompanyCodeValidation() {
  assert.equal(isValidCompanyCode("AB"), true);
  assert.equal(isValidCompanyCode("acme"), true, "lowercase input is normalized");
  assert.equal(isValidCompanyCode("AB-CD"), true);
  assert.equal(isValidCompanyCode("A"), false, "too short");
  assert.equal(isValidCompanyCode(""), false);
  assert.equal(isValidCompanyCode(null), false);
  assert.equal(isValidCompanyCode("AB--CD"), false, "double hyphen");
  assert.equal(isValidCompanyCode("-AB"), false, "leading hyphen");
  assert.equal(isValidCompanyCode("AB-"), false, "trailing hyphen");
  assert.equal(isValidCompanyCode("AB_CD"), false, "underscore not allowed");
  assert.equal(isValidCompanyCode("AB CD"), false, "space not allowed");
}

function testCompanyCodeLengthBoundary() {
  assert.equal(isValidCompanyCode("A".repeat(MAX_COMPANY_CODE_LENGTH)), true);
  assert.equal(isValidCompanyCode("A".repeat(MAX_COMPANY_CODE_LENGTH + 1)), false);
}

function testEmployeeNumberValidation() {
  assert.equal(isValidEmployeeNumber("1"), true);
  assert.equal(isValidEmployeeNumber("emp-001"), true);
  assert.equal(isValidEmployeeNumber(""), false);
  assert.equal(isValidEmployeeNumber("   "), false);
  assert.equal(isValidEmployeeNumber(undefined), false);
  assert.equal(isValidEmployeeNumber("EMP 001"), false);
  assert.equal(isValidEmployeeNumber("EMP/001"), false);
  assert.equal(isValidEmployeeNumber("EMP--001"), false);
}

function testEmployeeNumberLengthBoundary() {
  assert.equal(isValidEmployeeNumber("9".repeat(MAX_EMPLOYEE_NUMBER_LENGTH)), true);
  assert.equal(isValidEmployeeNumber("9".repeat(MAX_EMPLOYEE_NUMBER_LENGTH + 1)), false);
}

function testBuildEmployeeIdentifierFromPlainNumber() {
  assert.deepEqual(buildEmployeeIdentifier("acme", "42"), {
    companyCode: "ACME",
    employeeNumber: "42",
    code: "ACME-42",
  });
}

function testBuildEmployeeIdentifierFromFullCodeIsIdempotent() {
  const fromNumber = buildEmployeeIdentifier("acme", "0042");
  const fromFullCode = buildEmployeeIdentifier("acme", "acme-0042");

  assert.deepEqual(fromFullCode, fromNumber);
  assert.equal(fromFullCode?.code, "ACME-0042");
}

function testBuildEmployeeIdentifierRejectsInvalidInput() {
  assert.equal(buildEmployeeIdentifier("A", "42"), null, "company code too short");
  assert.equal(buildEmployeeIdentifier("", "42"), null, "missing company code");
  assert.equal(buildEmployeeIdentifier("ACME", ""), null, "missing employee number");
  assert.equal(
    buildEmployeeIdentifier("ACME", "ACME-"),
    null,
    "prefix with no number leaves nothing"
  );
  assert.equal(buildEmployeeIdentifier("ACME", "EMP_1"), null, "invalid characters");
  assert.equal(buildEmployeeIdentifier(null, null), null);
}

testNormalizeCompanyCodeTrimsAndUppercases();
testNormalizeEmployeeNumberStripsCompanyPrefix();
testNormalizeEmployeeNumberWithoutCompanyOnlyNormalizesCase();
testNormalizeEmployeeNumberStripsOnlyOnePrefix();
testNormalizeEmployeeNumberDoesNotStripPartialPrefix();
testCompanyCodeValidation();
testCompanyCodeLengthBoundary();
testEmployeeNumberValidation();
testEmployeeNumberLengthBoundary();
testBuildEmployeeIdentifierFromPlainNumber();
testBuildEmployeeIdentifierFromFullCodeIsIdempotent();
testBuildEmployeeIdentifierRejectsInvalidInput();

console.log("Employee code utility tests passed");
