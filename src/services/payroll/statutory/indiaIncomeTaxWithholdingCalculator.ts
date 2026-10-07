import {
  StatutoryContributionInput,
  StatutoryContributionLine,
  StatutoryContributionResult,
} from "./statutoryProvider.types";

type Slab = { upToMajor: number | null; rateBps: number };

type IndiaIncomeTaxRulePack = {
  version: string;
  effectiveFrom: string;
  newRegime: {
    slabs: Slab[];
    standardDeductionMajor: number;
    rebateIncomeLimitMajor: number;
    rebateLimitMajor: number;
  };
  oldRegime: {
    standardDeductionMajor: number;
    rebateIncomeLimitMajor: number;
    rebateLimitMajor: number;
  };
  cessRateBps: number;
};

const INDIA_INCOME_TAX_RULES: IndiaIncomeTaxRulePack[] = [
  {
    version: "IN_INCOME_TAX_2025_26",
    effectiveFrom: "2025-04-01",
    newRegime: {
      slabs: [
        { upToMajor: 400000, rateBps: 0 },
        { upToMajor: 800000, rateBps: 500 },
        { upToMajor: 1200000, rateBps: 1000 },
        { upToMajor: 1600000, rateBps: 1500 },
        { upToMajor: 2000000, rateBps: 2000 },
        { upToMajor: 2400000, rateBps: 2500 },
        { upToMajor: null, rateBps: 3000 },
      ],
      standardDeductionMajor: 75000,
      rebateIncomeLimitMajor: 1200000,
      rebateLimitMajor: 60000,
    },
    oldRegime: {
      standardDeductionMajor: 50000,
      rebateIncomeLimitMajor: 500000,
      rebateLimitMajor: 12500,
    },
    cessRateBps: 400,
  },
  {
    version: "IN_INCOME_TAX_2026_27",
    effectiveFrom: "2026-04-01",
    newRegime: {
      slabs: [
        { upToMajor: 400000, rateBps: 0 },
        { upToMajor: 800000, rateBps: 500 },
        { upToMajor: 1200000, rateBps: 1000 },
        { upToMajor: 1600000, rateBps: 1500 },
        { upToMajor: 2000000, rateBps: 2000 },
        { upToMajor: 2400000, rateBps: 2500 },
        { upToMajor: null, rateBps: 3000 },
      ],
      standardDeductionMajor: 75000,
      rebateIncomeLimitMajor: 1200000,
      rebateLimitMajor: 60000,
    },
    oldRegime: {
      standardDeductionMajor: 50000,
      rebateIncomeLimitMajor: 500000,
      rebateLimitMajor: 12500,
    },
    cessRateBps: 400,
  },
];

const rupees = (major: number, minorUnits: number) => major * 10 ** minorUnits;

function safeMinor(value: unknown, label: string) {
  const amount = Number(value || 0);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return amount;
}

function safeSum(values: number[], label: string) {
  const total = values.reduce((sum, value) => sum + safeMinor(value, label), 0);
  if (!Number.isSafeInteger(total)) throw new Error(`${label} exceeds the supported currency range`);
  return total;
}

function roundToMajorMultiple(amountMinor: number, minorUnits: number, multipleMajor: number) {
  const step = rupees(multipleMajor, minorUnits);
  const rounded = Math.floor((amountMinor + step / 2) / step) * step;
  if (!Number.isSafeInteger(rounded)) throw new Error("Income-tax amount exceeds the supported currency range");
  return rounded;
}

function percentage(amountMinor: number, rateBps: number) {
  const result = Math.round((amountMinor * rateBps) / 10000);
  if (!Number.isSafeInteger(result)) throw new Error("Income-tax percentage result exceeds the supported currency range");
  return result;
}

function taxBySlabs(taxableIncomeMinor: number, slabs: Slab[], minorUnits: number) {
  let lowerMinor = 0;
  let taxMinor = 0;
  for (const slab of slabs) {
    const upperMinor = slab.upToMajor === null ? taxableIncomeMinor : rupees(slab.upToMajor, minorUnits);
    const taxableInSlab = Math.max(0, Math.min(taxableIncomeMinor, upperMinor) - lowerMinor);
    taxMinor += percentage(taxableInSlab, slab.rateBps);
    if (taxableIncomeMinor <= upperMinor || slab.upToMajor === null) break;
    lowerMinor = upperMinor;
  }
  return taxMinor;
}

function oldRegimeSlabs(ageAtTaxYearEnd: number): Slab[] {
  const basicExemption = ageAtTaxYearEnd >= 80 ? 500000 : ageAtTaxYearEnd >= 60 ? 300000 : 250000;
  return [
    { upToMajor: basicExemption, rateBps: 0 },
    { upToMajor: 500000, rateBps: 500 },
    { upToMajor: 1000000, rateBps: 2000 },
    { upToMajor: null, rateBps: 3000 },
  ];
}

function ageAtTaxYearEnd(dateOfBirth: string, taxYear: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) || !/^\d{4}-\d{2}$/.test(taxYear)) return null;
  const endYear = Number(taxYear.slice(0, 4)) + 1;
  const birth = new Date(`${dateOfBirth}T00:00:00.000Z`);
  const end = new Date(`${endYear}-03-31T00:00:00.000Z`);
  if (Number.isNaN(birth.getTime()) || birth > end) return null;
  let age = end.getUTCFullYear() - birth.getUTCFullYear();
  if (end.getUTCMonth() < birth.getUTCMonth() || (end.getUTCMonth() === birth.getUTCMonth() && end.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

function surchargeRateBps(taxableIncomeMinor: number, regime: string, minorUnits: number) {
  const major = taxableIncomeMinor / 10 ** minorUnits;
  if (major > 50000000) return regime === "new" ? 2500 : 3700;
  if (major > 20000000) return 2500;
  if (major > 10000000) return 1500;
  if (major > 5000000) return 1000;
  return 0;
}

function previousSurchargeRateBps(thresholdMajor: number, regime: string) {
  if (thresholdMajor === 5000000) return 0;
  if (thresholdMajor === 10000000) return 1000;
  if (thresholdMajor === 20000000) return 1500;
  if (thresholdMajor === 50000000) return 2500;
  return regime === "new" ? 2500 : 3700;
}

function surchargeThresholdMajor(taxableIncomeMinor: number, minorUnits: number) {
  const major = taxableIncomeMinor / 10 ** minorUnits;
  if (major > 50000000) return 50000000;
  if (major > 20000000) return 20000000;
  if (major > 10000000) return 10000000;
  if (major > 5000000) return 5000000;
  return null;
}

function ruleForDate(cycleEndDate: string) {
  return [...INDIA_INCOME_TAX_RULES].reverse().find((rule) => rule.effectiveFrom <= cycleEndDate) || null;
}

function declarationAmount(declarations: Record<string, number>, key: string) {
  return safeMinor(declarations[key], key);
}

function hasManualTaxDeduction(input: StatutoryContributionInput) {
  const aliases = new Set(["TDS", "INCOME_TAX", "INCOME_TAX_TDS", "IT_TDS", "SALARY_TDS"]);
  return input.recurringComponents.some((component) => component.category === "deduction" && aliases.has(component.componentCode.toUpperCase()))
    || input.oneTimeInputs.some((component) => ["deduction", "recovery"].includes(component.inputType) && aliases.has(component.componentCode.toUpperCase()));
}

export function calculateIndiaIncomeTaxWithholding(
  input: StatutoryContributionInput,
  providerImplementationVersion: string
): StatutoryContributionResult {
  const result: StatutoryContributionResult = {
    providerKey: "india_standard",
    providerImplementationVersion,
    lines: [],
    issues: [],
  };
  if (!input.enabledModules.includes("income_tax_withholding")) return result;
  if (input.currency !== "INR" || input.currencyMinorUnits !== 2) {
    result.issues.push({ code: "india_income_tax_currency_mismatch", severity: "error", message: "India income-tax withholding requires an INR payroll run with two currency minor units" });
    return result;
  }
  const rule = ruleForDate(input.cycleEndDate);
  if (!rule) {
    result.issues.push({ code: "missing_india_income_tax_rule", severity: "error", message: `No India income-tax rule is available for ${input.cycleEndDate}` });
    return result;
  }
  result.ruleVersion = rule.version;
  const tax = input.taxWithholding;
  if (!tax) {
    result.issues.push({ code: "missing_income_tax_projection", severity: "error", message: "Income-tax projection inputs are missing from this payroll calculation" });
    return result;
  }
  if (hasManualTaxDeduction(input)) {
    result.issues.push({ code: "duplicate_manual_income_tax_deduction", severity: "error", message: "Remove the manual TDS deduction component before using generated income-tax withholding" });
    return result;
  }
  const declarations = tax.declarations || {};
  const defaultRegime = input.configuration.incomeTaxDefaultRegime === "old" ? "old" : "new";
  const regime = tax.taxRegime === "old" || tax.taxRegime === "new" ? tax.taxRegime : defaultRegime;
  const declarationUsed = Boolean(tax.taxRegime && tax.declarationVersion);
  if (!declarationUsed) {
    result.issues.push({ code: "default_income_tax_regime_used", severity: "warning", message: `No verified tax declaration is available for ${tax.taxYear}; the ${defaultRegime} regime and zero optional deductions were used` });
  }
  if (!tax.hasPan) {
    result.issues.push({ code: "missing_pan_for_income_tax", severity: "error", message: "PAN is required before salary income-tax withholding can be calculated" });
  }
  const periods = Number(tax.remainingPayrollPeriods);
  if (!Number.isInteger(periods) || periods < 1 || periods > 12) {
    result.issues.push({ code: "invalid_remaining_payroll_periods", severity: "error", message: "Remaining payroll periods must be between 1 and 12" });
    return result;
  }
  const age = ageAtTaxYearEnd(String(tax.employeeDateOfBirth || ""), tax.taxYear);
  if (regime === "old" && age === null) {
    result.issues.push({ code: "missing_date_of_birth_for_old_regime", severity: "error", message: "Date of birth is required to select the old-regime exemption slab" });
  }

  const currentEmployerSalaryMinor = safeSum([
    tax.priorTaxableEarningsMinor,
    tax.currentTaxableEarningsMinor,
    tax.projectedFutureRecurringTaxableEarningsMinor,
  ], "Projected current-employer salary");
  const previousEmployerIncomeMinor = declarationAmount(declarations, "previousEmployerIncomeMinor");
  const otherIncomeMinor = declarationAmount(declarations, "otherIncomeMinor");
  const previousEmployerTaxWithheldMinor = declarationAmount(declarations, "previousEmployerTaxWithheldMinor");
  const hraExemptionMinor = regime === "old"
    ? Math.min(currentEmployerSalaryMinor, declarationAmount(declarations, "hraExemptionMinor"))
    : 0;
  const salaryAfterHraMinor = Math.max(0, currentEmployerSalaryMinor - hraExemptionMinor);
  const standardDeductionLimitMajor = regime === "new" ? rule.newRegime.standardDeductionMajor : rule.oldRegime.standardDeductionMajor;
  const standardDeductionMinor = Math.min(salaryAfterHraMinor, rupees(standardDeductionLimitMajor, input.currencyMinorUnits));
  const salaryAfterStandardDeductionMinor = Math.max(0, salaryAfterHraMinor - standardDeductionMinor);
  const oldRegimeDeductionsMinor = regime === "old" ? safeSum([
    Math.min(declarationAmount(declarations, "section80CMinor"), rupees(150000, input.currencyMinorUnits)),
    Math.min(declarationAmount(declarations, "section80DMinor"), rupees(100000, input.currencyMinorUnits)),
    Math.min(declarationAmount(declarations, "section80CCD1BMinor"), rupees(50000, input.currencyMinorUnits)),
    Math.min(declarationAmount(declarations, "homeLoanInterestMinor"), rupees(200000, input.currencyMinorUnits)),
  ], "Old-regime deductions") : 0;
  const ignoredOldRegimeDeclarations = regime === "new" && [
    "section80CMinor",
    "section80DMinor",
    "section80CCD1BMinor",
    "homeLoanInterestMinor",
    "annualRentPaidMinor",
    "hraExemptionMinor",
  ].some((key) => declarationAmount(declarations, key) > 0);
  if (ignoredOldRegimeDeclarations) {
    result.issues.push({ code: "new_regime_ignores_old_regime_declarations", severity: "warning", message: "Old-regime HRA, investment, insurance, NPS, home-loan, and rent declarations are not deducted under the selected new regime" });
  }
  if (regime === "old" && declarationAmount(declarations, "annualRentPaidMinor") > 0 && hraExemptionMinor === 0) {
    result.issues.push({ code: "rent_evidence_without_hra_exemption", severity: "warning", message: "Annual rent was declared, but no verified HRA exemption was supplied; rent was not deducted" });
  }

  const projectedGrossIncomeMinor = safeSum([salaryAfterStandardDeductionMinor, previousEmployerIncomeMinor, otherIncomeMinor], "Projected gross taxable income");
  const taxableIncomeMinor = roundToMajorMultiple(Math.max(0, projectedGrossIncomeMinor - oldRegimeDeductionsMinor), input.currencyMinorUnits, 10);
  const slabs = regime === "new" ? rule.newRegime.slabs : oldRegimeSlabs(age ?? 0);
  const taxBeforeRebateMinor = taxBySlabs(taxableIncomeMinor, slabs, input.currencyMinorUnits);
  const rebateIncomeLimitMinor = rupees(regime === "new" ? rule.newRegime.rebateIncomeLimitMajor : rule.oldRegime.rebateIncomeLimitMajor, input.currencyMinorUnits);
  const rebateLimitMinor = rupees(regime === "new" ? rule.newRegime.rebateLimitMajor : rule.oldRegime.rebateLimitMajor, input.currencyMinorUnits);
  let rebateMinor = taxableIncomeMinor <= rebateIncomeLimitMinor ? Math.min(taxBeforeRebateMinor, rebateLimitMinor) : 0;
  if (regime === "new" && taxableIncomeMinor > rebateIncomeLimitMinor) {
    const excessIncomeMinor = taxableIncomeMinor - rebateIncomeLimitMinor;
    rebateMinor = Math.max(0, taxBeforeRebateMinor - excessIncomeMinor);
  }
  const taxAfterRebateMinor = Math.max(0, taxBeforeRebateMinor - rebateMinor);
  const surchargeRate = surchargeRateBps(taxableIncomeMinor, regime, input.currencyMinorUnits);
  let surchargeMinor = percentage(taxAfterRebateMinor, surchargeRate);
  const thresholdMajor = surchargeThresholdMajor(taxableIncomeMinor, input.currencyMinorUnits);
  if (thresholdMajor !== null) {
    const thresholdIncomeMinor = rupees(thresholdMajor, input.currencyMinorUnits);
    const thresholdTaxMinor = taxBySlabs(thresholdIncomeMinor, slabs, input.currencyMinorUnits);
    const thresholdWithSurchargeMinor = thresholdTaxMinor + percentage(thresholdTaxMinor, previousSurchargeRateBps(thresholdMajor, regime));
    const marginalReliefCapMinor = thresholdWithSurchargeMinor + (taxableIncomeMinor - thresholdIncomeMinor);
    surchargeMinor = Math.max(0, Math.min(surchargeMinor, marginalReliefCapMinor - taxAfterRebateMinor));
  }
  const cessMinor = percentage(taxAfterRebateMinor + surchargeMinor, rule.cessRateBps);
  const annualTaxLiabilityMinor = roundToMajorMultiple(taxAfterRebateMinor + surchargeMinor + cessMinor, input.currencyMinorUnits, 10);
  const priorCurrentEmployerWithholdingMinor = safeMinor(tax.priorTaxWithheldMinor, "Prior current-employer withholding");
  const priorTotalWithholdingMinor = safeSum([priorCurrentEmployerWithholdingMinor, previousEmployerTaxWithheldMinor], "Prior tax withholding");
  const remainingAnnualTaxMinor = Math.max(0, annualTaxLiabilityMinor - priorTotalWithholdingMinor);
  const currentWithholdingMinor = roundToMajorMultiple(remainingAnnualTaxMinor / periods, input.currencyMinorUnits, 1);
  const effectiveRateBps = taxableIncomeMinor > 0 ? Math.round((annualTaxLiabilityMinor * 10000) / taxableIncomeMinor) : 0;

  const line: StatutoryContributionLine = {
    providerKey: result.providerKey,
    providerImplementationVersion,
    moduleKey: "income_tax_withholding",
    code: "IN_TDS_SALARY",
    name: "Salary income-tax withholding",
    side: "employee_deduction",
    wageBaseMinor: taxableIncomeMinor,
    rateBps: effectiveRateBps,
    amountMinor: currentWithholdingMinor,
    roundingMode: "nearest_major_unit",
    ruleVersion: rule.version,
    ruleEffectiveFrom: rule.effectiveFrom,
    metadata: {
      taxYear: tax.taxYear,
      taxRegime: regime,
      declarationVersion: Number(tax.declarationVersion || 0),
      defaultRegimeUsed: !declarationUsed,
      ageAtTaxYearEnd: age ?? -1,
      currentEmployerSalaryMinor,
      previousEmployerIncomeMinor,
      otherIncomeMinor,
      hraExemptionMinor,
      standardDeductionMinor,
      oldRegimeDeductionsMinor,
      projectedGrossIncomeMinor,
      taxableIncomeMinor,
      taxBeforeRebateMinor,
      rebateMinor,
      surchargeMinor,
      cessMinor,
      annualTaxLiabilityMinor,
      priorCurrentEmployerWithholdingMinor,
      previousEmployerTaxWithheldMinor,
      remainingAnnualTaxMinor,
      remainingPayrollPeriods: periods,
    },
  };
  result.lines.push(line);
  return result;
}
