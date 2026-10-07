import assert from "node:assert/strict";
import { calculateIndiaStateStatutoryContributions } from "./indiaStateStatutoryContributionCalculator";

function input(overrides: Record<string, unknown> = {}) {
  return {
    cycleEndDate: "2026-09-25",
    currency: "INR",
    currencyMinorUnits: 2,
    enabledModules: ["professional_tax", "labour_welfare_fund"],
    configuration: {},
    applicability: { professionalTax: true, labourWelfareFund: true },
    recurringComponents: [{
      componentCode: "BASIC",
      category: "earning",
      payableAmountMinor: 3000000,
      statutoryWageBases: [],
    }],
    oneTimeInputs: [],
    payrollDays: { paidDays: 30, unpaidDays: 0, totalDays: 30 },
    employee: { gender: 1, officeState: "Maharashtra", officeCountry: "India" },
    ...overrides,
  };
}

function byCode(result: ReturnType<typeof calculateIndiaStateStatutoryContributions>, code: string) {
  return result.lines.find((line) => line.code === code);
}

function testMaharashtraProfessionalTaxSlabsAndFebruaryAdjustment() {
  const regular = calculateIndiaStateStatutoryContributions(input() as any, "1.4.0");
  assert.equal(byCode(regular, "IN_PT_EMPLOYEE")?.amountMinor, 20000);
  assert.equal(byCode(regular, "IN_PT_EMPLOYEE")?.ruleVersion, "IN_MH_PT_2023_04");

  const february = calculateIndiaStateStatutoryContributions(input({ cycleEndDate: "2027-02-25" }) as any, "1.4.0");
  assert.equal(byCode(february, "IN_PT_EMPLOYEE")?.amountMinor, 30000);

  const femaleExempt = calculateIndiaStateStatutoryContributions(input({
    employee: { gender: 2, officeState: "mh", officeCountry: "IN" },
    recurringComponents: [{ componentCode: "BASIC", category: "earning", payableAmountMinor: 2500000 }],
  }) as any, "1.4.0");
  assert.equal(byCode(femaleExempt, "IN_PT_EMPLOYEE")?.amountMinor, 0);
}

function testPeriodicLabourWelfareFundRules() {
  const maharashtraJune = calculateIndiaStateStatutoryContributions(input({ cycleEndDate: "2026-06-25" }) as any, "1.4.0");
  assert.equal(byCode(maharashtraJune, "IN_LWF_EMPLOYEE")?.amountMinor, 2500);
  assert.equal(byCode(maharashtraJune, "IN_LWF_EMPLOYER")?.amountMinor, 7500);

  const karnatakaDecember = calculateIndiaStateStatutoryContributions(input({
    cycleEndDate: "2026-12-25",
    employee: { gender: 1, officeState: "Karnataka", officeCountry: "India" },
  }) as any, "1.4.0");
  assert.equal(byCode(karnatakaDecember, "IN_PT_EMPLOYEE")?.amountMinor, 20000);
  assert.equal(byCode(karnatakaDecember, "IN_LWF_EMPLOYEE")?.amountMinor, 5000);
  assert.equal(byCode(karnatakaDecember, "IN_LWF_EMPLOYER")?.amountMinor, 10000);

  const noSeptemberLwf = calculateIndiaStateStatutoryContributions(input() as any, "1.4.0");
  assert.equal(byCode(noSeptemberLwf, "IN_LWF_EMPLOYEE"), undefined);
}

function testDelhiZeroProfessionalTaxAndLwf() {
  const result = calculateIndiaStateStatutoryContributions(input({
    cycleEndDate: "2026-12-25",
    employee: { gender: 2, officeState: "NCT of Delhi", officeCountry: "India" },
  }) as any, "1.4.0");
  assert.equal(byCode(result, "IN_PT_EMPLOYEE")?.amountMinor, 0);
  assert.equal(byCode(result, "IN_PT_EMPLOYEE")?.metadata?.notLevied, true);
  assert.equal(byCode(result, "IN_LWF_EMPLOYEE")?.amountMinor, 75);
  assert.equal(byCode(result, "IN_LWF_EMPLOYER")?.amountMinor, 225);
}

function testConfigurationGuards() {
  const missing = calculateIndiaStateStatutoryContributions(input({ employee: { gender: 1 } }) as any, "1.4.0");
  assert.ok(missing.issues.some((issue) => issue.code === "missing_office_state_for_state_statutory"));

  const unsupported = calculateIndiaStateStatutoryContributions(input({
    employee: { gender: 1, officeState: "Tamil Nadu", officeCountry: "India" },
  }) as any, "1.4.0");
  assert.ok(unsupported.issues.some((issue) => issue.code === "unsupported_india_state_statutory_rule"));

  const duplicate = calculateIndiaStateStatutoryContributions(input({
    enabledModules: ["professional_tax"],
    applicability: { professionalTax: true },
    recurringComponents: [
      { componentCode: "BASIC", category: "earning", payableAmountMinor: 3000000 },
      { componentCode: "PT", category: "deduction", payableAmountMinor: 20000 },
    ],
  }) as any, "1.4.0");
  assert.ok(duplicate.issues.some((issue) => issue.code === "duplicate_manual_professional_tax_deduction"));
  assert.equal(duplicate.lines.length, 0);
}

testMaharashtraProfessionalTaxSlabsAndFebruaryAdjustment();
testPeriodicLabourWelfareFundRules();
testDelhiZeroProfessionalTaxAndLwf();
testConfigurationGuards();

console.log("India state professional-tax and labour-welfare-fund calculation tests passed");
