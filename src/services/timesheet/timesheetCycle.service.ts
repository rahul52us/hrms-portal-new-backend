import Company from "../../schemas/company/Company";
import AttendancePeriod from "../../schemas/Attendance/AttendancePeriod.schema";
import { generateError } from "../../config/Error/functions";
import { shiftMonth, timesheetCyclesForDates, TimesheetCycle } from "./timesheetDeadline.utils";

export async function loadTimesheetCycles(company: any, from: string, to: string, session?: import("mongoose").ClientSession) {
  const companyQuery = Company.findById(company).select("payrollSettings.attendanceCutoffDay");
  if (session) companyQuery.session(session);
  const document: any = await companyQuery.lean();
  if (!document) throw generateError("Company not found", 404);
  const periodQuery = AttendancePeriod.find({ company, periodKey: { $gte: shiftMonth(from.slice(0, 7), -1), $lte: shiftMonth(to.slice(0, 7), 1) } }).select("periodKey startDate endDate attendanceCutoffDay");
  if (session) periodQuery.session(session);
  const periods = await periodQuery.lean();
  return timesheetCyclesForDates(from, to, document.payrollSettings?.attendanceCutoffDay ?? 31, periods as TimesheetCycle[]);
}

export function loadTimesheetCycle(company: any, date: string, cache?: Map<string, Promise<any>>) {
  const month = date.slice(0, 7), key = `timesheet-cycle:${company}:${month}`;
  const promise = cache?.get(key) || loadTimesheetCycles(company, `${month}-01`, new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10));
  cache?.set(key, promise);
  return promise.then((dates) => dates.get(date));
}
