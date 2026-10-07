import {
  StatutoryContributionInput,
  StatutoryContributionLine,
  StatutoryContributionResult,
} from "./statutoryProvider.types";
import { calculateIndiaIncomeTaxWithholding } from "./indiaIncomeTaxWithholdingCalculator";
import { calculateIndiaStateStatutoryContributions } from "./indiaStateStatutoryContributionCalculator";

type IndiaContributionRulePack = {
  version: string;
  effectiveFrom: string;
  providentFund: {
    wageCeilingMajor: number;
    epsWageCeilingMajor: number;
    employeeRateBps: number;
    employerRateBps: number;
    epsRateBps: number;
    edliRateBps: number;
  };
  employeeStateInsurance: {
    employeeRateBps: number;
    employerRateBps: number;
    employeeDailyWageExemptionMajor: number;
  };
};

const INDIA_CONTRIBUTION_RULES: IndiaContributionRulePack[] = [
  {
    version: "IN_SOCIAL_SECURITY_2019_07",
    effectiveFrom: "2019-07-01",
    providentFund: {
      wageCeilingMajor: 15000,
      epsWageCeilingMajor: 15000,
      employeeRateBps: 1200,
      employerRateBps: 1200,
      epsRateBps: 833,
      edliRateBps: 50,
    },
    employeeStateInsurance: {
      employeeRateBps: 75,
      employerRateBps: 325,
      employeeDailyWageExemptionMajor: 176,
    },
  },
  {
    version: "IN_SOCIAL_SECURITY_2025_11",
    effectiveFrom: "2025-11-21",
    providentFund: {
      wageCeilingMajor: 25000,
      epsWageCeilingMajor: 15000,
      employeeRateBps: 1200,
      employerRateBps: 1200,
      epsRateBps: 833,
      edliRateBps: 50,
    },
    employeeStateInsurance: {
      employeeRateBps: 75,
      employerRateBps: 325,
      employeeDailyWageExemptionMajor: 176,
    },
  },
];

function safeMinor(value: unknown, label: string) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return amount;
}

function safeSum(values: number[], label: string) {
  const result = values.reduce((total, value) => total + safeMinor(value, label), 0);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the supported currency range`);
  return result;
}

function ruleForDate(cycleEndDate: string) {
  return [...INDIA_CONTRIBUTION_RULES]
    .reverse()
    .find((rule) => rule.effectiveFrom <= cycleEndDate) || null;
}

function roundedContribution(
  wageBaseMinor: number,
  rateBps: number,
  currencyMinorUnits: number,
  mode: "nearest_major_unit" | "ceil_major_unit"
) {
  const minorPerMajor = 10 ** currencyMinorUnits;
  const denominator = 10000 * minorPerMajor;
  const wholeMajor = Math.floor(wageBaseMinor / denominator) * rateBps;
  const fractionNumerator = (wageBaseMinor % denominator) * rateBps;
  const roundedFraction = mode === "ceil_major_unit"
    ? Math.ceil(fractionNumerator / denominator)
    : Math.floor((fractionNumerator + denominator / 2) / denominator);
  const amountMinor = (wholeMajor + roundedFraction) * minorPerMajor;
  if (!Number.isSafeInteger(amountMinor)) throw new Error("Statutory contribution exceeds the supported currency range");
  return amountMinor;
}

function wageBase(input: StatutoryContributionInput, wageBaseKey: string) {
  return safeSum([
    ...input.recurringComponents
      .filter((component) => component.category === "earning" && component.statutoryWageBases?.includes(wageBaseKey))
      .map((component) => component.payableAmountMinor),
    ...input.oneTimeInputs
      .filter((component) => ["earning", "arrear"].includes(component.inputType) && component.statutoryWageBases?.includes(wageBaseKey))
      .map((component) => component.amountMinor),
  ], `${wageBaseKey} wage base`);
}

function hasManualDeduction(input: StatutoryContributionInput, aliases: string[]) {
  const normalized = new Set(aliases.map((value) => value.toUpperCase()));
  return input.recurringComponents.some(
    (component) => component.category === "deduction" && normalized.has(String(component.componentCode || "").toUpperCase())
  ) || input.oneTimeInputs.some(
    (component) => ["deduction", "recovery"].includes(component.inputType)
      && normalized.has(String(component.componentCode || "").toUpperCase())
  );
}

export function calculateIndiaStatutoryContributions(
  input: StatutoryContributionInput,
  providerImplementationVersion: string
): StatutoryContributionResult {
  const result: StatutoryContributionResult = {
    providerKey: "india_standard",
    providerImplementationVersion,
    lines: [],
    issues: [],
  };
  if (input.currency !== "INR" || input.currencyMinorUnits !== 2) {
    result.issues.push({
      code: "india_statutory_currency_mismatch",
      severity: "error",
      message: "India statutory contributions require an INR payroll run with two currency minor units",
    });
    return result;
  }
  const rule = ruleForDate(input.cycleEndDate);
  if (!rule) {
    result.issues.push({
      code: "missing_india_contribution_rule",
      severity: "error",
      message: `No India statutory contribution rule is available for ${input.cycleEndDate}`,
    });
    return result;
  }
  result.ruleVersion = rule.version;
  const enabled = new Set(input.enabledModules || []);
  const majorUnitMinor = 10 ** input.currencyMinorUnits;
  const configuredPfRateBps = input.configuration?.providentFundContributionRate === "10" ? 1000 : 1200;
  const line = (value: Omit<StatutoryContributionLine, "providerKey" | "providerImplementationVersion" | "ruleVersion" | "ruleEffectiveFrom">) => {
    result.lines.push({
      ...value,
      providerKey: result.providerKey,
      providerImplementationVersion,
      ruleVersion: rule.version,
      ruleEffectiveFrom: rule.effectiveFrom,
    });
  };

  if (enabled.has("provident_fund") && input.applicability.providentFund === true) {
    const base = wageBase(input, "provident_fund");
    if (base === 0) {
      result.issues.push({
        code: "missing_provident_fund_wage_base",
        severity: "error",
        message: "Provident fund applies, but no payable earning is marked as a provident-fund wage base",
      });
    } else if (hasManualDeduction(input, ["PF", "EPF", "PF_EMPLOYEE", "EPF_EMPLOYEE"])) {
      result.issues.push({
        code: "duplicate_manual_provident_fund_deduction",
        severity: "error",
        message: "Remove the manual PF deduction component before using generated provident-fund contributions",
      });
    } else {
      const higherWages = input.applicability.providentFundHigherWages === true;
      const statutoryBase = higherWages ? base : Math.min(base, rule.providentFund.wageCeilingMajor * majorUnitMinor);
      const employeeAmount = roundedContribution(statutoryBase, configuredPfRateBps, input.currencyMinorUnits, "nearest_major_unit");
      const totalEmployerAmount = roundedContribution(statutoryBase, configuredPfRateBps, input.currencyMinorUnits, "nearest_major_unit");
      const epsApplies = input.applicability.employeesPensionScheme === true;
      const epsWageBase = epsApplies
        ? Math.min(statutoryBase, rule.providentFund.epsWageCeilingMajor * majorUnitMinor)
        : 0;
      const epsAmount = epsApplies
        ? roundedContribution(epsWageBase, rule.providentFund.epsRateBps, input.currencyMinorUnits, "nearest_major_unit")
        : 0;
      const employerPfAmount = totalEmployerAmount - epsAmount;
      const edliAmount = roundedContribution(statutoryBase, rule.providentFund.edliRateBps, input.currencyMinorUnits, "nearest_major_unit");
      const metadata = {
        sourceWageBaseMinor: base,
        wageCeilingMinor: rule.providentFund.wageCeilingMajor * majorUnitMinor,
        higherWages,
        epsApplies,
        epsWageCeilingMinor: rule.providentFund.epsWageCeilingMajor * majorUnitMinor,
        epsWageBaseMinor: epsWageBase,
        contributionRateVariant: configuredPfRateBps === 1000 ? "eligible_reduced" : "standard",
      };
      line({ moduleKey: "provident_fund", code: "EPF_EMPLOYEE", name: "Employee provident fund", side: "employee_deduction", wageBaseMinor: statutoryBase, rateBps: configuredPfRateBps, amountMinor: employeeAmount, roundingMode: "nearest_major_unit", metadata });
      line({ moduleKey: "provident_fund", code: "EPS_EMPLOYER", name: "Employer pension contribution", side: "employer_contribution", wageBaseMinor: epsWageBase, rateBps: rule.providentFund.epsRateBps, amountMinor: epsAmount, roundingMode: "nearest_major_unit", metadata });
      line({ moduleKey: "provident_fund", code: "EPF_EMPLOYER", name: "Employer provident fund", side: "employer_contribution", wageBaseMinor: statutoryBase, rateBps: Math.max(0, configuredPfRateBps - (epsApplies ? rule.providentFund.epsRateBps : 0)), amountMinor: employerPfAmount, roundingMode: "nearest_major_unit", metadata });
      line({ moduleKey: "provident_fund", code: "EDLI_EMPLOYER", name: "Employer deposit-linked insurance", side: "employer_contribution", wageBaseMinor: statutoryBase, rateBps: rule.providentFund.edliRateBps, amountMinor: edliAmount, roundingMode: "nearest_major_unit", metadata });
    }
  }

  if (enabled.has("employee_state_insurance") && input.applicability.employeeStateInsurance === true) {
    const base = wageBase(input, "employee_state_insurance");
    if (base === 0) {
      result.issues.push({
        code: "missing_employee_state_insurance_wage_base",
        severity: "error",
        message: "Employee State Insurance applies, but no payable earning is marked as an ESI wage base",
      });
    } else if (hasManualDeduction(input, ["ESI", "ESIC", "ESI_EMPLOYEE", "ESIC_EMPLOYEE"])) {
      result.issues.push({
        code: "duplicate_manual_esi_deduction",
        severity: "error",
        message: "Remove the manual ESI deduction component before using generated ESI contributions",
      });
    } else {
      const wageDays = Number(input.payrollDays.paidDays || input.payrollDays.totalDays || 0);
      const exemptEmployeeShare = wageDays > 0
        && base / wageDays <= rule.employeeStateInsurance.employeeDailyWageExemptionMajor * majorUnitMinor;
      const employeeAmount = exemptEmployeeShare
        ? 0
        : roundedContribution(base, rule.employeeStateInsurance.employeeRateBps, input.currencyMinorUnits, "ceil_major_unit");
      const employerAmount = roundedContribution(base, rule.employeeStateInsurance.employerRateBps, input.currencyMinorUnits, "ceil_major_unit");
      line({ moduleKey: "employee_state_insurance", code: "ESI_EMPLOYEE", name: "Employee State Insurance", side: "employee_deduction", wageBaseMinor: base, rateBps: rule.employeeStateInsurance.employeeRateBps, amountMinor: employeeAmount, roundingMode: "ceil_major_unit", metadata: { employeeDailyWageExempt: exemptEmployeeShare } });
      line({ moduleKey: "employee_state_insurance", code: "ESI_EMPLOYER", name: "Employer State Insurance", side: "employer_contribution", wageBaseMinor: base, rateBps: rule.employeeStateInsurance.employerRateBps, amountMinor: employerAmount, roundingMode: "ceil_major_unit" });
    }
  }
  const incomeTax = calculateIndiaIncomeTaxWithholding(input, providerImplementationVersion);
  result.lines.push(...incomeTax.lines);
  result.issues.push(...incomeTax.issues);
  if (incomeTax.ruleVersion) {
    result.ruleVersion = [result.ruleVersion, incomeTax.ruleVersion].filter(Boolean).join("+");
  }
  const stateContributions = calculateIndiaStateStatutoryContributions(input, providerImplementationVersion);
  result.lines.push(...stateContributions.lines);
  result.issues.push(...stateContributions.issues);
  if (stateContributions.ruleVersion) {
    result.ruleVersion = [result.ruleVersion, stateContributions.ruleVersion].filter(Boolean).join("+");
  }
  return result;
}
