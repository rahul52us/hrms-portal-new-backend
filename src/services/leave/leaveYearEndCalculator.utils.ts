import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";

export function roundLeaveUnits(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;
}

export function nextDateKey(dateKey: string) {
  const date = parseAttendanceDate(dateKey).date;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function calculateCarryForwardExpiry(
  destinationLeaveYearStart: string,
  destinationLeaveYearEnd: string,
  expiryMonths: number
) {
  const months = Math.max(0, Math.floor(Number(expiryMonths || 0)));
  if (months === 0) return null;
  const start = parseAttendanceDate(destinationLeaveYearStart).date;
  const targetMonth = start.getUTCMonth() + months;
  const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const anniversary = new Date(
    Date.UTC(targetYear, normalizedMonth, Math.min(start.getUTCDate(), lastDay))
  );
  anniversary.setUTCDate(anniversary.getUTCDate() - 1);
  const expiry = anniversary.toISOString().slice(0, 10);
  return expiry > destinationLeaveYearEnd ? destinationLeaveYearEnd : expiry;
}

export function planLeaveYearEndAmounts(options: {
  availableUnits: number;
  carryForwardEnabled: boolean;
  maxCarryForward: number;
  alreadyCarriedUnits?: number;
}) {
  const availableUnits = Math.max(0, roundLeaveUnits(options.availableUnits));
  const remainingCarryLimit = options.carryForwardEnabled
    ? Math.max(
        0,
        roundLeaveUnits(
          Number(options.maxCarryForward || 0) - Number(options.alreadyCarriedUnits || 0)
        )
      )
    : 0;
  const carryUnits = roundLeaveUnits(Math.min(availableUnits, remainingCarryLimit));
  return {
    carryUnits,
    lapseUnits: roundLeaveUnits(availableUnits - carryUnits),
  };
}

export function planCarryForwardExpiryUnits(lotAvailableUnits: number, balanceAvailableUnits: number) {
  return roundLeaveUnits(
    Math.min(
      Math.max(0, Number(lotAvailableUnits || 0)),
      Math.max(0, Number(balanceAvailableUnits || 0))
    )
  );
}
