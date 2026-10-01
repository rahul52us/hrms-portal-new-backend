import { SalaryComponentCategory } from "../../schemas/Payroll/SalaryComponent.schema";

export type SalaryRuleCalculationType = "fixed" | "percentage" | "variable";
export type PayrollRoundingMode = "nearest" | "floor" | "ceil";

export type SalaryCalculationRule = {
  salaryComponent: unknown;
  componentCodeSnapshot: string;
  componentNameSnapshot: string;
  categorySnapshot: SalaryComponentCategory;
  calculationType: SalaryRuleCalculationType;
  monthlyAmountMinor?: number | null;
  percentageBps?: number | null;
  percentageOfComponent?: unknown | null;
};

export type SalaryStructurePreview = {
  componentAmounts: Array<{
    salaryComponent: string;
    code: string;
    name: string;
    category: SalaryComponentCategory;
    monthlyAmountMinor: number;
    annualAmountMinor: number;
  }>;
  monthlyGrossMinor: number;
  monthlyDeductionsMinor: number;
  monthlyReimbursementsMinor: number;
  monthlyEmployerContributionsMinor: number;
  monthlyNetMinor: number;
  monthlyEmployerCostMinor: number;
  annualGrossMinor: number;
  annualDeductionsMinor: number;
  annualReimbursementsMinor: number;
  annualEmployerContributionsMinor: number;
  annualNetMinor: number;
  annualEmployerCostMinor: number;
};

function id(value: unknown) {
  return String(value || "").trim();
}

function ensureMinorAmount(value: unknown, label: string) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`${label} must be a non-negative safe integer in minor currency units`);
  }
  return amount;
}

function roundedPercentage(amountMinor: number, percentageBps: number, roundingMode: PayrollRoundingMode) {
  if (amountMinor > Math.floor((Number.MAX_SAFE_INTEGER - 10000) / percentageBps)) {
    throw new Error("Calculated salary amount exceeds the supported range");
  }
  const numerator = amountMinor * percentageBps;
  const denominator = 10000;
  let result: number;
  if (roundingMode === "floor") {
    result = Math.floor(numerator / denominator);
  } else if (roundingMode === "ceil") {
    result = Math.ceil(numerator / denominator);
  } else {
    result = Math.floor((numerator + denominator / 2) / denominator);
  }
  if (!Number.isSafeInteger(result)) throw new Error("Calculated salary amount exceeds the supported range");
  return result;
}

function annual(monthly: number) {
  const value = monthly * 12;
  if (!Number.isSafeInteger(value)) throw new Error("Annual salary amount exceeds the supported range");
  return value;
}

export function calculateSalaryStructurePreview(
  rules: SalaryCalculationRule[],
  roundingMode: PayrollRoundingMode = "nearest",
  overrides: Record<string, number> = {}
): SalaryStructurePreview {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 100) {
    throw new Error("A salary structure needs between 1 and 100 component rules");
  }
  if (!["nearest", "floor", "ceil"].includes(roundingMode)) {
    throw new Error("Invalid salary rounding mode");
  }

  const byId = new Map<string, SalaryCalculationRule>();
  for (const rule of rules) {
    const componentId = id(rule.salaryComponent);
    if (!componentId) throw new Error("Every salary rule needs a component");
    if (byId.has(componentId)) throw new Error("A salary component can appear only once");
    byId.set(componentId, rule);
  }
  if (!rules.some((rule) => rule.categorySnapshot === "earning")) {
    throw new Error("A salary structure needs at least one earning component");
  }

  const amounts = new Map<string, number>();
  const visiting = new Set<string>();

  for (const [componentId, amount] of Object.entries(overrides)) {
    if (!byId.has(componentId)) throw new Error("An employee override references a component outside this salary structure");
    ensureMinorAmount(amount, "Employee override");
  }

  const resolveAmount = (componentId: string): number => {
    const cached = amounts.get(componentId);
    if (cached !== undefined) return cached;
    if (visiting.has(componentId)) throw new Error("Salary component percentage rules contain a circular dependency");

    const rule = byId.get(componentId);
    if (!rule) throw new Error("A percentage rule references a component outside this salary structure");
    visiting.add(componentId);

    let amount: number;
    if (overrides[componentId] !== undefined) {
      amount = ensureMinorAmount(overrides[componentId], `${rule.componentNameSnapshot || rule.componentCodeSnapshot} override`);
    } else if (rule.calculationType === "fixed" || rule.calculationType === "variable") {
      amount = ensureMinorAmount(
        rule.monthlyAmountMinor,
        `${rule.componentNameSnapshot || rule.componentCodeSnapshot} monthly amount`
      );
    } else if (rule.calculationType === "percentage") {
      const percentageBps = Number(rule.percentageBps);
      if (!Number.isInteger(percentageBps) || percentageBps < 1 || percentageBps > 10000) {
        throw new Error(`${rule.componentNameSnapshot || rule.componentCodeSnapshot} percentage must be between 0.01 and 100`);
      }
      const basisId = id(rule.percentageOfComponent);
      if (!basisId || !byId.has(basisId)) {
        throw new Error(`${rule.componentNameSnapshot || rule.componentCodeSnapshot} needs a valid basis component`);
      }
      if (basisId === componentId) throw new Error("A salary component cannot be a percentage of itself");
      amount = roundedPercentage(resolveAmount(basisId), percentageBps, roundingMode);
    } else {
      throw new Error("Invalid salary rule calculation type");
    }

    visiting.delete(componentId);
    amounts.set(componentId, amount);
    return amount;
  };

  const componentAmounts = rules.map((rule) => {
    const salaryComponent = id(rule.salaryComponent);
    const monthlyAmountMinor = resolveAmount(salaryComponent);
    return {
      salaryComponent,
      code: rule.componentCodeSnapshot,
      name: rule.componentNameSnapshot,
      category: rule.categorySnapshot,
      monthlyAmountMinor,
      annualAmountMinor: annual(monthlyAmountMinor),
    };
  });

  const sumCategory = (category: SalaryComponentCategory) =>
    componentAmounts
      .filter((item) => item.category === category)
      .reduce((total, item) => total + item.monthlyAmountMinor, 0);

  const monthlyGrossMinor = sumCategory("earning");
  const monthlyDeductionsMinor = sumCategory("deduction");
  const monthlyReimbursementsMinor = sumCategory("reimbursement");
  const monthlyEmployerContributionsMinor = sumCategory("employer_contribution");
  const monthlyNetMinor = monthlyGrossMinor - monthlyDeductionsMinor + monthlyReimbursementsMinor;
  const monthlyEmployerCostMinor = monthlyGrossMinor + monthlyEmployerContributionsMinor + monthlyReimbursementsMinor;

  return {
    componentAmounts,
    monthlyGrossMinor,
    monthlyDeductionsMinor,
    monthlyReimbursementsMinor,
    monthlyEmployerContributionsMinor,
    monthlyNetMinor,
    monthlyEmployerCostMinor,
    annualGrossMinor: annual(monthlyGrossMinor),
    annualDeductionsMinor: annual(monthlyDeductionsMinor),
    annualReimbursementsMinor: annual(monthlyReimbursementsMinor),
    annualEmployerContributionsMinor: annual(monthlyEmployerContributionsMinor),
    annualNetMinor: annual(monthlyNetMinor),
    annualEmployerCostMinor: annual(monthlyEmployerCostMinor),
  };
}

