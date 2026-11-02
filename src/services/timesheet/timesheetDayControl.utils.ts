import mongoose from "mongoose";
import Control from "../../schemas/Timesheet/TimesheetDayControl.schema";
import { generateError } from "../../config/Error/functions";
import { dateInZone, localInstant, addDateDays } from "./timesheet.utils";

export function controlSnapshot(control: any) {
  return { revision: control?.revision || 0, exemption: control?.exemption || null, extension: control?.extension || null, payrollLockedAt: control?.payrollLockedAt || null };
}

// All day writes share this transaction fence, including days without a draft.
export async function fenceTimesheetDay(match: any, session: mongoose.ClientSession) {
  const control: any = await Control.findOneAndUpdate(match, { $inc: { writeVersion: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true, session }).lean();
  if (control.payrollLockedAt) throw generateError("Payroll-locked timesheets cannot be changed", 409);
  return control;
}

export function applyExemption(requirement: any, control: any) {
  const original = requirement.requiredMinutes;
  const exemptMinutes = original == null || !control?.exemption ? 0 : Math.min(original, control.exemption.mode === "full_day" ? original : control.exemption.minutes);
  requirement.requiredMinutes = original == null ? null : Math.max(0, original - exemptMinutes);
  return { baselineRequiredMinutes: original, exemptMinutes };
}

export function effectiveEditEnd(date: string | null, timezone: string | null, extension: any) {
  const base = date && timezone ? new Date(localInstant(addDateDays(date, 1), "00:00", timezone).getTime() - 1) : null;
  const extended = extension?.until ? new Date(extension.until) : null;
  return extended && (!base || extended > base) ? extended : base;
}

export function extensionInstant(date: string, time: string, timezone: string, now: Date, currentDeadline: Date | null) {
  const until = localInstant(date, time, timezone);
  if (until <= now || currentDeadline && until <= currentDeadline) throw generateError("Choose a future time after the current submission deadline", 422);
  if (date > addDateDays(dateInZone(now, timezone), 90)) throw generateError("Extensions are limited to 90 days ahead", 422);
  return until;
}
