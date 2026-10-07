import assert from "node:assert/strict";
import { calculateIndiaIncomeTaxWithholding } from "./indiaIncomeTaxWithholdingCalculator";

function input(overrides: Record<string, unknown> = {}) {
  return {
    cycleEndDate: "2026-04-25",
    currency: "INR",
    currencyMinorUnits: 2,
    enabledModules: ["income_tax_withholding"],
    configuration: { incomeTaxDefaultRegime: "new" },
    applicability: {},
    recurringComponents: [],
    oneTimeInputs: [],
    payrollDays: { paidDays: 30, unpaidDays: 0, totalDays: 30 },
    taxWithholding: {
      taxYear: "2026-27",
      taxRegime: "new",
      declarationVersion: 1,
      declarations: {},
      hasPan: true,
      employeeDateOfBirth: "1990-01-01",
      priorTaxableEarningsMinor: 0,
      priorTaxWithheldMinor: 0,
      currentTaxableEarningsMinor: 15000000,
      projectedFutureRecurringTaxableEarningsMinor: 165000000,
      remainingPayrollPeriods: 12,
    },
    ...overrides,
  };
}

function testNewRegimeProjectionAndMonthlySpread() {
  const result = calculateIndiaIncomeTaxWithholding(input() as any, "1.3.0");
  assert.equal(result.issues.length, 0);
  const line = result.lines[0];
  assert.equal(line.code, "IN_TDS_SALARY");
  assert.equal(line.ruleVersion, "IN_INCOME_TAX_2026_27");
  assert.equal(line.wageBaseMinor, 172500000);
  assert.equal(line.amountMinor, 1256700);
  assert.equal(line.metadata?.annualTaxLiabilityMinor, 15080000);
  assert.equal(line.metadata?.standardDeductionMinor, 7500000);
}

function testRebateAndPriorWithholding() {
  const rebated = calculateIndiaIncomeTaxWithholding(input({
    taxWithholding: {
      ...(input().taxWithholding as Record<string, unknown>),
      currentTaxableEarningsMinor: 10000000,
      projectedFutureRecurringTaxableEarningsMinor: 110000000,
    },
  }) as any, "1.3.0");
  assert.equal(rebated.lines[0].amountMinor, 0);
  assert.equal(rebated.lines[0].metadata?.annualTaxLiabilityMinor, 0);

  const withPrior = calculateIndiaIncomeTaxWithholding(input({
    taxWithholding: {
      ...(input().taxWithholding as Record<string, unknown>),
      priorTaxWithheldMinor: 3000000,
      remainingPayrollPeriods: 6,
    },
  }) as any, "1.3.0");
  assert.equal(withPrior.lines[0].amountMinor, 2013300);
}

function testOldRegimeVerifiedDeductions() {
  const result = calculateIndiaIncomeTaxWithholding(input({
    taxWithholding: {
      ...(input().taxWithholding as Record<string, unknown>),
      taxRegime: "old",
      declarations: {
        section80CMinor: 15000000,
        section80DMinor: 2500000,
        section80CCD1BMinor: 5000000,
        homeLoanInterestMinor: 20000000,
        annualRentPaidMinor: 24000000,
        hraExemptionMinor: 18000000,
      },
    },
  }) as any, "1.3.0");
  const line = result.lines[0];
  assert.equal(line.metadata?.taxRegime, "old");
  assert.equal(line.metadata?.hraExemptionMinor, 18000000);
  assert.equal(line.metadata?.oldRegimeDeductionsMinor, 42500000);
  assert.equal(result.issues.length, 0);
}

function testDefaultRegimeAndRequiredIdentityWarnings() {
  const result = calculateIndiaIncomeTaxWithholding(input({
    taxWithholding: {
      ...(input().taxWithholding as Record<string, unknown>),
      taxRegime: "",
      declarationVersion: undefined,
      hasPan: false,
    },
  }) as any, "1.3.0");
  assert.ok(result.issues.some((issue) => issue.code === "default_income_tax_regime_used"));
  assert.ok(result.issues.some((issue) => issue.code === "missing_pan_for_income_tax" && issue.severity === "error"));
}

function testManualTdsDeductionIsBlocked() {
  const result = calculateIndiaIncomeTaxWithholding(input({
    recurringComponents: [{ componentCode: "TDS", category: "deduction", payableAmountMinor: 100000 }],
  }) as any, "1.3.0");
  assert.equal(result.lines.length, 0);
  assert.ok(result.issues.some((issue) => issue.code === "duplicate_manual_income_tax_deduction"));
}

testNewRegimeProjectionAndMonthlySpread();
testRebateAndPriorWithholding();
testOldRegimeVerifiedDeductions();
testDefaultRegimeAndRequiredIdentityWarnings();
testManualTdsDeductionIsBlocked();

console.log("India salary income-tax withholding tests passed");
