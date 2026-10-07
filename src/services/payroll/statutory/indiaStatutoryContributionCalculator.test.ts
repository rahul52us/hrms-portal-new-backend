import assert from "node:assert/strict";
import { calculateIndiaStatutoryContributions } from "./indiaStatutoryContributionCalculator";

function input(overrides: Record<string, unknown> = {}) {
  return {
    cycleEndDate: "2026-09-25",
    currency: "INR",
    currencyMinorUnits: 2,
    enabledModules: ["provident_fund", "employee_state_insurance"],
    configuration: { providentFundContributionRate: "12" },
    applicability: { providentFund: true, employeesPensionScheme: true, employeeStateInsurance: true },
    recurringComponents: [{
      componentCode: "BASIC",
      category: "earning",
      payableAmountMinor: 3000000,
      statutoryWageBases: ["provident_fund", "employee_state_insurance"],
    }],
    oneTimeInputs: [],
    payrollDays: { paidDays: 30, unpaidDays: 0, totalDays: 30 },
    ...overrides,
  };
}

function testCeilingRatesAndRounding() {
  const result = calculateIndiaStatutoryContributions(input() as any, "1.1.0");
  const byCode = new Map(result.lines.map((line) => [line.code, line]));
  assert.equal(result.ruleVersion, "IN_SOCIAL_SECURITY_2025_11");
  assert.equal(byCode.get("EPF_EMPLOYEE")?.wageBaseMinor, 2500000);
  assert.equal(byCode.get("EPF_EMPLOYEE")?.amountMinor, 300000);
  assert.equal(byCode.get("EPS_EMPLOYER")?.wageBaseMinor, 1500000);
  assert.equal(byCode.get("EPS_EMPLOYER")?.amountMinor, 125000);
  assert.equal(byCode.get("EPF_EMPLOYER")?.amountMinor, 175000);
  assert.equal(byCode.get("EDLI_EMPLOYER")?.amountMinor, 12500);
  assert.equal(byCode.get("ESI_EMPLOYEE")?.amountMinor, 22500);
  assert.equal(byCode.get("ESI_EMPLOYER")?.amountMinor, 97500);
}

function testHigherPfWagesAndDailyEsiExemption() {
  const higher = calculateIndiaStatutoryContributions(input({
    applicability: { providentFund: true, providentFundHigherWages: true, employeesPensionScheme: true, employeeStateInsurance: false },
  }) as any, "1.1.0");
  assert.equal(higher.lines.find((line) => line.code === "EPF_EMPLOYEE")?.amountMinor, 360000);
  assert.equal(higher.lines.find((line) => line.code === "EPS_EMPLOYER")?.wageBaseMinor, 1500000);
  assert.equal(higher.lines.find((line) => line.code === "EPF_EMPLOYER")?.amountMinor, 235000);

  const exempt = calculateIndiaStatutoryContributions(input({
    enabledModules: ["employee_state_insurance"],
    applicability: { employeeStateInsurance: true },
    recurringComponents: [{
      componentCode: "BASIC",
      category: "earning",
      payableAmountMinor: 500000,
      statutoryWageBases: ["employee_state_insurance"],
    }],
  }) as any, "1.1.0");
  assert.equal(exempt.lines.find((line) => line.code === "ESI_EMPLOYEE")?.amountMinor, 0);
  assert.equal(exempt.lines.find((line) => line.code === "ESI_EMPLOYER")?.amountMinor, 16300);
}

function testEligibleReducedPfRate() {
  const result = calculateIndiaStatutoryContributions(input({
    enabledModules: ["provident_fund"],
    configuration: { providentFundContributionRate: "10" },
    applicability: { providentFund: true, employeesPensionScheme: false },
  }) as any, "1.1.0");
  assert.equal(result.lines.find((line) => line.code === "EPF_EMPLOYEE")?.rateBps, 1000);
  assert.equal(result.lines.find((line) => line.code === "EPF_EMPLOYEE")?.amountMinor, 250000);
  assert.equal(result.lines.find((line) => line.code === "EPS_EMPLOYER")?.amountMinor, 0);
  assert.equal(result.lines.find((line) => line.code === "EPF_EMPLOYER")?.amountMinor, 250000);
}

function testMissingBasisAndManualDuplicateBlockCalculation() {
  const missing = calculateIndiaStatutoryContributions(input({ recurringComponents: [] }) as any, "1.1.0");
  assert.ok(missing.issues.some((issue) => issue.code === "missing_provident_fund_wage_base"));
  assert.ok(missing.issues.some((issue) => issue.code === "missing_employee_state_insurance_wage_base"));

  const duplicate = calculateIndiaStatutoryContributions(input({
    enabledModules: ["provident_fund"],
    applicability: { providentFund: true },
    recurringComponents: [
      ...(input().recurringComponents as any[]),
      { componentCode: "PF", category: "deduction", payableAmountMinor: 10000, statutoryWageBases: [] },
    ],
  }) as any, "1.1.0");
  assert.equal(duplicate.lines.length, 0);
  assert.ok(duplicate.issues.some((issue) => issue.code === "duplicate_manual_provident_fund_deduction"));
}

testCeilingRatesAndRounding();
testHigherPfWagesAndDailyEsiExemption();
testEligibleReducedPfRate();
testMissingBasisAndManualDuplicateBlockCalculation();

console.log("India PF and ESI statutory contribution calculation tests passed");
