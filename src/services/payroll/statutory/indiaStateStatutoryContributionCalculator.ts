import {
  StatutoryContributionInput,
  StatutoryContributionLine,
  StatutoryContributionResult,
} from "./statutoryProvider.types";

type SupportedState = "delhi" | "karnataka" | "maharashtra";

type StateRulePack = {
  state: SupportedState;
  label: string;
  professionalTax: {
    version: string;
    effectiveFrom: string;
  };
  labourWelfareFund: {
    version: string;
    effectiveFrom: string;
    contributionMonths: number[];
    employeeAmountMinor: number;
    employerAmountMinor: number;
  };
};

const STATE_ALIASES: Record<string, SupportedState> = {
  delhi: "delhi",
  "nct delhi": "delhi",
  "nct of delhi": "delhi",
  "national capital territory of delhi": "delhi",
  "new delhi": "delhi",
  dl: "delhi",
  karnataka: "karnataka",
  ka: "karnataka",
  maharashtra: "maharashtra",
  mh: "maharashtra",
};

const STATE_RULES: StateRulePack[] = [
  {
    state: "delhi",
    label: "Delhi",
    professionalTax: {
      version: "IN_DL_PT_NOT_LEVIED_VERIFIED_2026_04",
      effectiveFrom: "2026-04-01",
    },
    labourWelfareFund: {
      version: "IN_DL_LWF_1997_11",
      effectiveFrom: "1997-11-18",
      contributionMonths: [6, 12],
      employeeAmountMinor: 75,
      employerAmountMinor: 225,
    },
  },
  {
    state: "karnataka",
    label: "Karnataka",
    professionalTax: {
      version: "IN_KA_PT_2023_04",
      effectiveFrom: "2023-04-01",
    },
    labourWelfareFund: {
      version: "IN_KA_LWF_2025_01",
      effectiveFrom: "2025-01-10",
      contributionMonths: [12],
      employeeAmountMinor: 5000,
      employerAmountMinor: 10000,
    },
  },
  {
    state: "maharashtra",
    label: "Maharashtra",
    professionalTax: {
      version: "IN_MH_PT_2023_04",
      effectiveFrom: "2023-04-01",
    },
    labourWelfareFund: {
      version: "IN_MH_LWF_2024_03",
      effectiveFrom: "2024-03-18",
      contributionMonths: [6, 12],
      employeeAmountMinor: 2500,
      employerAmountMinor: 7500,
    },
  },
];

const text = (value: unknown) => String(value ?? "").trim();

function safeMinor(value: unknown, label: string) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return amount;
}

function safeSum(values: number[], label: string) {
  const total = values.reduce((sum, value) => sum + safeMinor(value, label), 0);
  if (!Number.isSafeInteger(total)) throw new Error(`${label} exceeds the supported currency range`);
  return total;
}

function grossPayableEarnings(input: StatutoryContributionInput) {
  return safeSum([
    ...input.recurringComponents
      .filter((component) => component.category === "earning")
      .map((component) => component.payableAmountMinor),
    ...input.oneTimeInputs
      .filter((component) => ["earning", "arrear"].includes(component.inputType))
      .map((component) => component.amountMinor),
  ], "State statutory gross earnings");
}

function normalizedState(value: unknown) {
  const normalized = text(value)
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ");
  return STATE_ALIASES[normalized] || null;
}

function isIndiaCountry(value: unknown) {
  const normalized = text(value).toLowerCase();
  return !normalized || ["in", "india", "bharat"].includes(normalized);
}

function hasManualDeduction(input: StatutoryContributionInput, aliases: string[]) {
  const normalized = new Set(aliases.map((value) => value.toUpperCase()));
  return input.recurringComponents.some(
    (component) => component.category === "deduction" && normalized.has(text(component.componentCode).toUpperCase())
  ) || input.oneTimeInputs.some(
    (component) => ["deduction", "recovery"].includes(component.inputType)
      && normalized.has(text(component.componentCode).toUpperCase())
  );
}

function professionalTaxAmountMinor(rule: StateRulePack, grossMinor: number, gender: number | undefined, month: number) {
  if (rule.state === "delhi") return 0;
  if (rule.state === "karnataka") return grossMinor >= 2500000 ? 20000 : 0;
  if (gender === 2) return grossMinor > 2500000 ? (month === 2 ? 30000 : 20000) : 0;
  if (grossMinor <= 750000) return 0;
  if (grossMinor <= 1000000) return 17500;
  return month === 2 ? 30000 : 20000;
}

export function calculateIndiaStateStatutoryContributions(
  input: StatutoryContributionInput,
  providerImplementationVersion: string
): StatutoryContributionResult {
  const result: StatutoryContributionResult = {
    providerKey: "india_standard",
    providerImplementationVersion,
    lines: [],
    issues: [],
  };
  const enabled = new Set(input.enabledModules || []);
  const professionalTaxApplies = enabled.has("professional_tax") && input.applicability.professionalTax === true;
  const labourWelfareFundApplies = enabled.has("labour_welfare_fund") && input.applicability.labourWelfareFund === true;
  if (!professionalTaxApplies && !labourWelfareFundApplies) return result;

  if (input.currency !== "INR" || input.currencyMinorUnits !== 2) {
    result.issues.push({
      code: "india_state_statutory_currency_mismatch",
      severity: "error",
      message: "India state statutory contributions require an INR payroll run with two currency minor units",
    });
    return result;
  }
  if (!isIndiaCountry(input.employee?.officeCountry)) {
    result.issues.push({
      code: "india_state_statutory_foreign_work_location",
      severity: "error",
      message: "India professional tax and labour welfare fund cannot be calculated for a non-India office location",
    });
    return result;
  }

  const state = normalizedState(input.employee?.officeState);
  if (!state) {
    result.issues.push({
      code: text(input.employee?.officeState) ? "unsupported_india_state_statutory_rule" : "missing_office_state_for_state_statutory",
      severity: "error",
      message: text(input.employee?.officeState)
        ? `No professional-tax or labour-welfare rule pack is installed for office state ${text(input.employee?.officeState)}`
        : "Office state is required when professional tax or labour welfare fund applies",
    });
    return result;
  }
  const rule = STATE_RULES.find((item) => item.state === state)!;
  const month = Number(input.cycleEndDate.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    result.issues.push({ code: "invalid_state_statutory_period", severity: "error", message: "Payroll cycle end date is invalid" });
    return result;
  }
  const grossMinor = grossPayableEarnings(input);
  const line = (
    value: Omit<StatutoryContributionLine, "providerKey" | "providerImplementationVersion" | "roundingMode">
  ) => {
    result.lines.push({
      ...value,
      providerKey: result.providerKey,
      providerImplementationVersion,
      roundingMode: "nearest_major_unit",
    });
  };

  if (professionalTaxApplies) {
    if (input.cycleEndDate < rule.professionalTax.effectiveFrom) {
      result.issues.push({
        code: "missing_professional_tax_rule_for_period",
        severity: "error",
        message: `No ${rule.label} professional-tax rule is available for ${input.cycleEndDate}`,
      });
    } else if (hasManualDeduction(input, ["PT", "PROFESSIONAL_TAX", "PROFESSIONALTAX", "IN_PT_EMPLOYEE"])) {
      result.issues.push({
        code: "duplicate_manual_professional_tax_deduction",
        severity: "error",
        message: "Remove the manual professional-tax deduction before using generated professional tax",
      });
    } else {
      const amountMinor = professionalTaxAmountMinor(rule, grossMinor, input.employee?.gender, month);
      line({
        moduleKey: "professional_tax",
        code: "IN_PT_EMPLOYEE",
        name: `${rule.label} professional tax`,
        side: "employee_deduction",
        wageBaseMinor: grossMinor,
        rateBps: 0,
        amountMinor,
        ruleVersion: rule.professionalTax.version,
        ruleEffectiveFrom: rule.professionalTax.effectiveFrom,
        metadata: {
          officeState: rule.label,
          calculationType: "state_salary_slab",
          payrollMonth: month,
          genderCode: Number(input.employee?.gender || 0),
          notLevied: rule.state === "delhi",
        },
      });
    }
  }

  if (labourWelfareFundApplies) {
    if (input.cycleEndDate < rule.labourWelfareFund.effectiveFrom) {
      result.issues.push({
        code: "missing_labour_welfare_fund_rule_for_period",
        severity: "error",
        message: `No ${rule.label} labour-welfare-fund rule is available for ${input.cycleEndDate}`,
      });
    } else if (hasManualDeduction(input, ["LWF", "LABOUR_WELFARE_FUND", "LABOR_WELFARE_FUND", "IN_LWF_EMPLOYEE"])) {
      result.issues.push({
        code: "duplicate_manual_labour_welfare_fund_deduction",
        severity: "error",
        message: "Remove the manual labour-welfare-fund deduction before using generated LWF contributions",
      });
    } else if (rule.labourWelfareFund.contributionMonths.includes(month)) {
      const metadata = {
        officeState: rule.label,
        calculationType: "fixed_periodic_amount",
        payrollMonth: month,
        contributionMonths: rule.labourWelfareFund.contributionMonths.join(","),
      };
      line({
        moduleKey: "labour_welfare_fund",
        code: "IN_LWF_EMPLOYEE",
        name: `${rule.label} labour welfare fund - employee`,
        side: "employee_deduction",
        wageBaseMinor: grossMinor,
        rateBps: 0,
        amountMinor: rule.labourWelfareFund.employeeAmountMinor,
        ruleVersion: rule.labourWelfareFund.version,
        ruleEffectiveFrom: rule.labourWelfareFund.effectiveFrom,
        metadata,
      });
      line({
        moduleKey: "labour_welfare_fund",
        code: "IN_LWF_EMPLOYER",
        name: `${rule.label} labour welfare fund - employer`,
        side: "employer_contribution",
        wageBaseMinor: grossMinor,
        rateBps: 0,
        amountMinor: rule.labourWelfareFund.employerAmountMinor,
        ruleVersion: rule.labourWelfareFund.version,
        ruleEffectiveFrom: rule.labourWelfareFund.effectiveFrom,
        metadata,
      });
    }
  }

  const versions = [...new Set(result.lines.map((item) => item.ruleVersion))];
  result.ruleVersion = versions.join("+") || undefined;
  return result;
}
