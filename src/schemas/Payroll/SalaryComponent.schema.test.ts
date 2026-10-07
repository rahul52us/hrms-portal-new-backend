import assert from "node:assert/strict";
import mongoose from "mongoose";
import SalaryComponent from "./SalaryComponent.schema";
import { normalizeSalaryComponentPayload, validateSalaryComponentPayload } from "../../services/payroll/salaryComponent.service";
import { getDefaultPermissionsForRole } from "../../services/permissions/permission.utils";

const actorId = new mongoose.Types.ObjectId();

function validComponent() {
  return new SalaryComponent({
    company: new mongoose.Types.ObjectId(),
    name: "Basic Salary",
    code: "basic",
    category: "earning",
    taxable: true,
    prorateOnUnpaidDays: true,
    createdBy: actorId,
    updatedBy: actorId,
  });
}

function testValidComponent() {
  const component = validComponent();
  assert.equal(component.validateSync(), undefined);
  assert.equal(component.code, "BASIC");
  assert.equal(component.status, "active");
}

function testInvalidCategoryAndCode() {
  const component = validComponent();
  component.category = "benefit" as any;
  component.code = "bad-code";
  const validation = component.validateSync();
  assert.ok(validation?.errors.category);
  assert.ok(validation?.errors.code);
}

function testPayloadNormalization() {
  const payload = normalizeSalaryComponentPayload({
    name: " House Rent Allowance ",
    code: " hra ",
    category: "EARNING",
    taxable: true,
    prorateOnUnpaidDays: false,
    displayOrder: "2",
  });
  validateSalaryComponentPayload(payload);
  assert.deepEqual(payload, {
    name: "House Rent Allowance",
    code: "HRA",
    description: "",
    category: "earning",
    taxable: true,
    prorateOnUnpaidDays: false,
    statutoryWageBases: [],
    displayOrder: 2,
  });
}

function testCategoryNormalizationAndPermissions() {
  const deduction = normalizeSalaryComponentPayload({
    name: "Provident Fund",
    code: "PF_EMPLOYEE",
    category: "deduction",
    taxable: true,
  });
  assert.equal(deduction.taxable, false);
  assert.deepEqual(deduction.statutoryWageBases, []);
  assert.equal(getDefaultPermissionsForRole("admin").view_payroll, true);
  assert.equal(getDefaultPermissionsForRole("hradmin").manage_payroll_configuration, true);
  assert.equal(getDefaultPermissionsForRole("hr").view_payroll, false);
}

testValidComponent();
testInvalidCategoryAndCode();
testPayloadNormalization();
testCategoryNormalizationAndPermissions();

console.log("SalaryComponent schema and payload tests passed");
