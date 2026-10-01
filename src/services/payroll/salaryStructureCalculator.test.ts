import assert from "node:assert/strict";
import { calculateSalaryStructurePreview } from "./salaryStructureCalculator";

const basic = "000000000000000000000001";
const hra = "000000000000000000000002";
const pf = "000000000000000000000003";
const bonus = "000000000000000000000004";

function rule(overrides: Record<string, unknown>) {
  return {
    salaryComponent: basic,
    componentCodeSnapshot: "BASIC",
    componentNameSnapshot: "Basic Salary",
    categorySnapshot: "earning" as const,
    calculationType: "fixed" as const,
    monthlyAmountMinor: 5000000,
    ...overrides,
  };
}

function testPreview() {
  const preview = calculateSalaryStructurePreview([
    rule({}),
    rule({
      salaryComponent: hra,
      componentCodeSnapshot: "HRA",
      componentNameSnapshot: "House Rent Allowance",
      calculationType: "percentage",
      percentageBps: 4000,
      percentageOfComponent: basic,
    }),
    rule({
      salaryComponent: pf,
      componentCodeSnapshot: "PF",
      componentNameSnapshot: "Provident Fund",
      categorySnapshot: "deduction",
      calculationType: "percentage",
      percentageBps: 1200,
      percentageOfComponent: basic,
    }),
    rule({
      salaryComponent: bonus,
      componentCodeSnapshot: "BONUS",
      componentNameSnapshot: "Variable Bonus",
      calculationType: "variable",
      monthlyAmountMinor: 0,
    }),
  ]);

  assert.equal(preview.monthlyGrossMinor, 7000000);
  assert.equal(preview.monthlyDeductionsMinor, 600000);
  assert.equal(preview.monthlyNetMinor, 6400000);
  assert.equal(preview.annualNetMinor, 76800000);
}

function testCircularDependency() {
  assert.throws(
    () => calculateSalaryStructurePreview([
      rule({ calculationType: "percentage", percentageBps: 5000, percentageOfComponent: hra }),
      rule({
        salaryComponent: hra,
        componentCodeSnapshot: "HRA",
        componentNameSnapshot: "House Rent Allowance",
        calculationType: "percentage",
        percentageBps: 4000,
        percentageOfComponent: basic,
      }),
    ]),
    /circular dependency/
  );
}

function testExactRounding() {
  const nearest = calculateSalaryStructurePreview([
    rule({ monthlyAmountMinor: 101 }),
    rule({
      salaryComponent: hra,
      componentCodeSnapshot: "HRA",
      componentNameSnapshot: "House Rent Allowance",
      calculationType: "percentage",
      percentageBps: 1250,
      percentageOfComponent: basic,
    }),
  ], "nearest");
  assert.equal(nearest.componentAmounts[1].monthlyAmountMinor, 13);
}

function testEmployeeOverrideRecalculatesDependents() {
  const preview = calculateSalaryStructurePreview([
    rule({ monthlyAmountMinor: 5000000 }),
    rule({
      salaryComponent: hra,
      componentCodeSnapshot: "HRA",
      componentNameSnapshot: "House Rent Allowance",
      calculationType: "percentage",
      percentageBps: 4000,
      percentageOfComponent: basic,
    }),
  ], "nearest", { [basic]: 6000000 });
  assert.equal(preview.componentAmounts[0].monthlyAmountMinor, 6000000);
  assert.equal(preview.componentAmounts[1].monthlyAmountMinor, 2400000);
  assert.equal(preview.monthlyGrossMinor, 8400000);
}

testPreview();
testCircularDependency();
testExactRounding();
testEmployeeOverrideRecalculatesDependents();

console.log("Salary structure calculator tests passed");
