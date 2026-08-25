import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";

export function calculateCompOffEligibleUnits(options: {
  workedMinutes: number;
  fullDayMinutes: number;
  halfDayMinutes: number;
}) {
  const workedMinutes = Number(options.workedMinutes || 0);
  if (workedMinutes >= Number(options.fullDayMinutes || 0)) return 1;
  if (workedMinutes >= Number(options.halfDayMinutes || 0)) return 0.5;
  return 0;
}

export function calculateCompOffExpiryDate(options: {
  earnedDate: string;
  validityDays: number;
  leaveYearEnd: string;
}) {
  const validityEnd = parseAttendanceDate(options.earnedDate).date;
  validityEnd.setUTCDate(validityEnd.getUTCDate() + Number(options.validityDays || 0));
  return [validityEnd.toISOString().slice(0, 10), options.leaveYearEnd].sort()[0];
}
