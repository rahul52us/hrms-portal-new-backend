export type LeaveAccrualFrequency = "upfront" | "monthly" | "quarterly" | "none";
export type LeaveCreditComponentFrequency = Exclude<LeaveAccrualFrequency, "none">;
export type LeaveUpfrontCreditTiming = "leave_year_start" | "first_eligibility";

export interface LeaveCreditComponentInput {
  componentId: string;
  frequency: LeaveCreditComponentFrequency;
  amount: number;
  upfrontTiming?: LeaveUpfrontCreditTiming;
  prorateOnJoining: boolean;
  prorateOnExit: boolean;
}

export interface LeaveAccrualRuleInput {
  balanceTracked: boolean;
  annualEntitlement: number;
  accrualFrequency: LeaveAccrualFrequency;
  accrualAmount: number;
  prorateOnJoining: boolean;
  prorateOnExit: boolean;
  upfrontTiming?: LeaveUpfrontCreditTiming;
  creditComponents?: LeaveCreditComponentInput[];
}

export interface PlanLeaveAccrualCreditsInput {
  asOf: unknown;
  leaveYearStart: string;
  leaveYearEnd: string;
  assignmentEffectiveFrom?: unknown;
  versionEffectiveFrom?: unknown;
  joiningDate?: unknown;
  employmentEndDate?: unknown;
  rule: LeaveAccrualRuleInput;
}

export interface PlannedLeaveCredit {
  units: number;
  effectiveDate: string;
  periodKey: string;
  transactionType: "entitlement_credit" | "accrual_credit";
}

export interface PlannedLeaveRuleCredit extends PlannedLeaveCredit {
  componentId: string;
  frequency: LeaveCreditComponentFrequency;
  upfrontTiming: LeaveUpfrontCreditTiming;
  legacyIdempotency: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateKey(value: unknown, label: string): string {
  const raw = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const key = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
  const parsed = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
  return key;
}

function optionalDateKey(value: unknown, label: string) {
  return value === undefined || value === null || String(value).trim() === ""
    ? null
    : parseDateKey(value, label);
}

function dayNumber(value: string) {
  return Math.floor(new Date(`${value}T00:00:00.000Z`).getTime() / DAY_MS);
}

function daysInclusive(start: string, end: string) {
  return dayNumber(end) - dayNumber(start) + 1;
}

function addDays(value: string, days: number) {
  return new Date((dayNumber(value) + days) * DAY_MS).toISOString().slice(0, 10);
}

function shiftMonthsFromAnchor(anchor: string, months: number) {
  const [year, month, day] = anchor.split("-").map(Number);
  const monthIndex = year * 12 + month - 1 + months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}

function maxDate(...values: Array<string | null>) {
  const dates = values.filter((value): value is string => Boolean(value)).sort();
  return dates[dates.length - 1];
}

function minDate(...values: Array<string | null>) {
  const dates = values.filter((value): value is string => Boolean(value)).sort();
  return dates[0];
}

function roundUnits(value: number) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

export function scheduledAnnualCredit(components: LeaveCreditComponentInput[]) {
  return roundUnits(
    components.reduce((total, component) => {
      const periods = component.frequency === "monthly" ? 12 : component.frequency === "quarterly" ? 4 : 1;
      return total + Number(component.amount || 0) * periods;
    }, 0)
  );
}

function proratedUnits(
  units: number,
  periodStart: string,
  periodEnd: string,
  policyStart: string,
  joiningDate: string | null,
  employmentEndDate: string | null,
  rule: LeaveAccrualRuleInput
) {
  let activeStart = periodStart;
  let activeEnd = periodEnd;

  if (
    rule.prorateOnJoining &&
    joiningDate &&
    joiningDate >= policyStart &&
    joiningDate > periodStart &&
    joiningDate <= periodEnd
  ) {
    activeStart = joiningDate;
  }

  if (
    rule.prorateOnExit &&
    employmentEndDate &&
    employmentEndDate >= periodStart &&
    employmentEndDate < periodEnd
  ) {
    activeEnd = employmentEndDate;
  }

  if (activeEnd < activeStart) return 0;
  return roundUnits(
    units * (daysInclusive(activeStart, activeEnd) / daysInclusive(periodStart, periodEnd))
  );
}

export function planLeaveAccrualCredits(
  input: PlanLeaveAccrualCreditsInput
): PlannedLeaveCredit[] {
  const rule = input.rule;
  const annualEntitlement = roundUnits(Number(rule.annualEntitlement || 0));
  if (!rule.balanceTracked || rule.accrualFrequency === "none" || annualEntitlement <= 0) {
    return [];
  }

  const asOf = parseDateKey(input.asOf, "Accrual date");
  const leaveYearStart = parseDateKey(input.leaveYearStart, "Leave year start");
  const leaveYearEnd = parseDateKey(input.leaveYearEnd, "Leave year end");
  if (leaveYearEnd < leaveYearStart) {
    throw new Error("Leave year end must not be before leave year start");
  }

  const assignmentStart = optionalDateKey(
    input.assignmentEffectiveFrom,
    "Policy assignment effective date"
  );
  const versionStart = optionalDateKey(
    input.versionEffectiveFrom,
    "Policy version effective date"
  );
  const joiningDate = optionalDateKey(input.joiningDate, "Joining date");
  const employmentEndDate = optionalDateKey(input.employmentEndDate, "Employment end date");
  const firstEligibility = maxDate(assignmentStart, versionStart, joiningDate) || leaveYearStart;
  const policyStart = maxDate(leaveYearStart, assignmentStart, versionStart);
  const eligibilityStart = maxDate(policyStart, joiningDate);
  const eligibilityEnd = minDate(leaveYearEnd, employmentEndDate);
  const cutoff = minDate(asOf, eligibilityEnd);

  if (eligibilityStart > cutoff) return [];

  if (rule.accrualFrequency === "upfront") {
    if (rule.upfrontTiming === "first_eligibility") {
      if (
        firstEligibility < leaveYearStart ||
        firstEligibility > leaveYearEnd ||
        firstEligibility > cutoff
      ) {
        return [];
      }
      const units = proratedUnits(
        annualEntitlement,
        leaveYearStart,
        leaveYearEnd,
        maxDate(assignmentStart, versionStart) || leaveYearStart,
        joiningDate,
        employmentEndDate,
        rule
      );
      return units > 0
        ? [{
            units,
            effectiveDate: firstEligibility,
            periodKey: "first_eligibility",
            transactionType: "entitlement_credit",
          }]
        : [];
    }
    const units = proratedUnits(
      annualEntitlement,
      leaveYearStart,
      leaveYearEnd,
      policyStart,
      joiningDate,
      employmentEndDate,
      rule
    );
    return units > 0
      ? [{
          units,
          effectiveDate: eligibilityStart,
          periodKey: "upfront",
          transactionType: "entitlement_credit",
        }]
      : [];
  }

  const periodMonths = rule.accrualFrequency === "monthly" ? 1 : 3;
  const periodsPerYear = 12 / periodMonths;
  const configuredAmount = roundUnits(Number(rule.accrualAmount || 0));
  const regularAmount = configuredAmount > 0
    ? configuredAmount
    : roundUnits(annualEntitlement / periodsPerYear);
  if (regularAmount <= 0) return [];

  const credits: PlannedLeaveCredit[] = [];
  let plannedUnits = 0;
  for (let index = 0; index < periodsPerYear; index += 1) {
    const periodStart = shiftMonthsFromAnchor(leaveYearStart, index * periodMonths);
    const nextPeriodStart = shiftMonthsFromAnchor(leaveYearStart, (index + 1) * periodMonths);
    const periodEnd = minDate(addDays(nextPeriodStart, -1), leaveYearEnd);
    if (periodEnd < eligibilityStart || periodStart > cutoff) continue;

    const remainingEntitlement = roundUnits(annualEntitlement - plannedUnits);
    if (remainingEntitlement <= 0) break;
    const units = Math.min(
      proratedUnits(
        regularAmount,
        periodStart,
        periodEnd,
        policyStart,
        joiningDate,
        employmentEndDate,
        rule
      ),
      remainingEntitlement
    );
    if (units <= 0) continue;

    credits.push({
      units,
      effectiveDate: maxDate(periodStart, eligibilityStart),
      periodKey: `${rule.accrualFrequency}:${periodStart}`,
      transactionType: "accrual_credit",
    });
    plannedUnits = roundUnits(plannedUnits + units);
  }

  return credits;
}

export function planLeaveRuleAccrualCredits(
  input: PlanLeaveAccrualCreditsInput
): PlannedLeaveRuleCredit[] {
  const explicitComponents = Array.isArray(input.rule.creditComponents)
    ? input.rule.creditComponents
    : [];
  const components: LeaveCreditComponentInput[] = explicitComponents.length
    ? explicitComponents
    : input.rule.accrualFrequency === "none"
      ? []
      : [{
          componentId: `legacy-${input.rule.accrualFrequency}`,
          frequency: input.rule.accrualFrequency,
          amount: Number(input.rule.accrualAmount || input.rule.annualEntitlement || 0),
          upfrontTiming: "leave_year_start",
          prorateOnJoining: input.rule.prorateOnJoining,
          prorateOnExit: input.rule.prorateOnExit,
        }];

  return components.flatMap((component) => {
    const amount = roundUnits(Number(component.amount || 0));
    if (amount <= 0) return [];
    const periods = component.frequency === "monthly" ? 12 : component.frequency === "quarterly" ? 4 : 1;
    const componentAnnualEntitlement = explicitComponents.length
      ? roundUnits(amount * periods)
      : roundUnits(Number(input.rule.annualEntitlement || amount * periods));
    const upfrontTiming = component.frequency === "upfront"
      ? component.upfrontTiming || "leave_year_start"
      : "leave_year_start";

    return planLeaveAccrualCredits({
      ...input,
      rule: {
        balanceTracked: input.rule.balanceTracked,
        annualEntitlement: componentAnnualEntitlement,
        accrualFrequency: component.frequency,
        accrualAmount: amount,
        prorateOnJoining: component.prorateOnJoining,
        prorateOnExit: component.prorateOnExit,
        upfrontTiming,
      },
    }).map((credit) => ({
      ...credit,
      componentId: component.componentId,
      frequency: component.frequency,
      upfrontTiming,
      legacyIdempotency: component.componentId === `legacy-${component.frequency}`,
    }));
  });
}
