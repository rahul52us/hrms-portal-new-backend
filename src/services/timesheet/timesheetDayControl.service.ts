import mongoose from "mongoose";
import { createHash } from "crypto";
import Control from "../../schemas/Timesheet/TimesheetDayControl.schema";
import Audit from "../../schemas/Timesheet/TimesheetAuditLog.schema";
import Timesheet from "../../schemas/Timesheet/Timesheet.schema";
import { generateError } from "../../config/Error/functions";
import { dateKey, objectId, shortText } from "../project/project.utils";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { loadTimesheetScopedEmployee, timesheetOperationsContext } from "./timesheetOperationsAccess.service";
import { applyExemption, controlSnapshot, extensionInstant, fenceTimesheetDay } from "./timesheetDayControl.utils";
import { resolveTimesheetDay } from "./timesheetContext.service";
import { ownContext } from "./timesheet.service";
import { dateInZone } from "./timesheet.utils";
import { timesheetPagination } from "./timesheetRules.utils";
import { createRequestNotifications } from "../notification/notification.service";

export function dayControlCapabilities(ctx: any, employeeId: any, sheet: any, control: any) {
  const authorized = ctx.scope === "organization" && hasPermission(ctx.actor, PERMISSION_KEYS.MANAGE_TIMESHEET_EXCEPTIONS);
  const blockedReason = !authorized ? "Timesheet exception permission is required"
    : String(ctx.actor._id) === String(employeeId) ? "Another authorized HR user must handle your own timesheet"
    : sheet?.payrollLockedAt || control?.payrollLockedAt ? "Payroll-locked timesheets cannot be changed"
    : ["submitted", "approved"].includes(sheet?.status) ? "Return or reopen this timesheet before changing its requirement or deadline" : "";
  return { authorized, canManage: !blockedReason, blockedReason };
}
const handler = (work: (req: any, res: any) => Promise<void>) => async (req: any, res: any, next: any) => { try { await work(req, res); } catch (error) { next(error); } };

export const getTimesheetDayControls = (own = false) => handler(async (req, res) => {
  const ctx: any = own ? ownContext(req) : await timesheetOperationsContext(req);
  const employeeId = own ? ctx.employee : objectId(req.params.employeeId, "employee id"), date = dateKey(req.params.date, "Work date")!;
  if (!own) await loadTimesheetScopedEmployee(ctx, employeeId, date);
  const match = { company: ctx.company, employee: employeeId, attendanceDate: date }, { page, limit, skip } = timesheetPagination(req.query, 50);
  const [control, sheet, data, total] = await Promise.all([
    Control.findOne(match).lean(), Timesheet.findOne(match).select("status payrollLockedAt").lean(),
    Audit.find(match).select("-requestHash -requestId").sort({ revision: -1 }).skip(skip).limit(limit).lean(), Audit.countDocuments(match),
  ]);
  res.json({ success: true, control: controlSnapshot(control), capabilities: dayControlCapabilities(ctx, employeeId, sheet, control), data,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
});

export function controlRequest(body: any) {
  const action = String(body.action || "");
  if (!["grant_exemption", "extend_deadline", "revoke_exemption", "revoke_extension"].includes(action)) throw generateError("Choose a valid timesheet control action", 400);
  const allowed = ["action", "revision", "requestId", "reason", ...(action === "grant_exemption" ? ["mode", "minutes"] : action === "extend_deadline" ? ["untilDate", "untilTime"] : [])];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw generateError("Unexpected fields in timesheet control request", 400);
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw generateError("Latest control revision is required (0 for a new day)", 400);
  const requestId = shortText(body.requestId, "Request id", 8, 100), reason = shortText(body.reason, "Reason", 3, 500);
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw generateError("Invalid request id", 400);
  const values: any = { action, revision: body.revision, reason, requestId };
  if (action === "grant_exemption") {
    if (!["full_day", "minutes"].includes(body.mode)) throw generateError("Choose full day or minutes", 422);
    if (body.mode === "minutes" && (!Number.isSafeInteger(body.minutes) || body.minutes < 1 || body.minutes > 1440)) throw generateError("Exempt minutes must be an integer from 1 to 1440", 422);
    if (body.mode === "full_day" && body.minutes !== undefined) throw generateError("Full-day exemption does not accept minutes", 400);
    values.mode = body.mode; if (body.mode === "minutes") values.minutes = body.minutes;
  }
  if (action === "extend_deadline") { values.untilDate = dateKey(body.untilDate, "Extension date"); values.untilTime = shortText(body.untilTime, "Extension time", 5, 5); }
  return values;
}
export const changeTimesheetDayControls = handler(async (req, res) => {
  const ctx = await timesheetOperationsContext(req), employeeId = objectId(req.params.employeeId, "employee id"), date = dateKey(req.params.date, "Work date")!;
  const { employee } = await loadTimesheetScopedEmployee(ctx, employeeId, date);
  const initial = dayControlCapabilities(ctx, employeeId, null, null);
  if (!initial.canManage) throw generateError(initial.blockedReason, 403);
  await ensureCompanyManagementAccess({ actor: ctx.actor, requestedCompanyId: String(ctx.company), actionLabel: "manage timesheet exceptions" });
  const values = controlRequest(req.body), hash = createHash("sha256").update(JSON.stringify(values)).digest("hex");
  const match = { company: ctx.company, employee: employeeId, attendanceDate: date }, retryMatch = { ...match, requestId: values.requestId };
  const replay = (prior: any) => { if (prior.requestHash !== hash || String(prior.actor) !== String(ctx.actor._id)) throw generateError("Request id was already used for another action", 409); return { data: prior.after, replayed: true, eventId: prior._id }; };
  const session = await mongoose.startSession(); let result: any;
  try {
    await session.withTransaction(async () => {
      const prior: any = await Audit.findOne(retryMatch).session(session).lean(); if (prior) { result = replay(prior); return; }
      const control = await fenceTimesheetDay(match, session), sheet: any = await Timesheet.findOne(match).session(session).lean();
      const capabilities = dayControlCapabilities(ctx, employeeId, sheet, control);
      if (!capabilities.canManage) throw generateError(capabilities.blockedReason, 409);
      if (control.revision !== values.revision) throw generateError("Day controls changed. Reload before trying again.", 409);
      const now = new Date(), day = await resolveTimesheetDay(ctx.company, employeeId, date, now, undefined, true, control);
      if (!day.context.timezone || day.eligibility.setupIssues.some((i) => i.code !== "NO_PROJECT_ASSIGNMENT")) throw generateError("Fix timesheet policy, schedule, calendar and assignment-history setup before granting an exception", 422);
      if (date > dateInZone(now, day.context.timezone) || day.eligibility.saveIssues.some((i) => i.code === "OUTSIDE_EMPLOYMENT")) throw generateError("Choose a current or past date within the employee's employment", 422);
      const before = controlSnapshot(control), eventId = new mongoose.Types.ObjectId();
      const evidence = { eventId, reason: values.reason, actor: ctx.actor._id, actorNameSnapshot: ctx.actor.name || ctx.actor.username || "HR", at: now };
      const changes: any = {};
      if (values.action === "grant_exemption") {
        const baseline = day.eligibility.baselineRequiredMinutes;
        if (!baseline || values.mode === "minutes" && values.minutes > baseline) throw generateError("Exemption must fit the remaining timesheet target after approved leave", 422);
        changes.exemption = { ...evidence, mode: values.mode, minutes: values.mode === "minutes" ? values.minutes : null };
      } else if (values.action === "extend_deadline") {
        changes.extension = { ...evidence, timezone: day.context.timezone, until: extensionInstant(values.untilDate, values.untilTime, day.context.timezone, now, day.eligibility.deadlineAt) };
      } else if (values.action === "revoke_exemption") {
        if (!control.exemption) throw generateError("No exemption is active for this day", 409); changes.exemption = null;
      } else {
        if (!control.extension) throw generateError("No extension exists for this day", 409); changes.extension = null;
      }
      const saved: any = await Control.findOneAndUpdate({ ...match, revision: values.revision, payrollLockedAt: null }, { $set: changes, $inc: { revision: 1 } }, { new: true, session, runValidators: true }).lean();
      if (!saved) throw generateError("Day controls changed. Reload before trying again.", 409);
      const after = controlSnapshot(saved);
      const afterRequirement = { requiredMinutes: day.eligibility.baselineRequiredMinutes };
      const effect = applyExemption(afterRequirement, saved);
      const contextSnapshot = { timezone: day.context.timezone, policyReferences: day.context.policyReferences, organizationAssignment: day.context.organizationAssignment,
        baselineRequiredMinutes: day.eligibility.baselineRequiredMinutes, requiredBefore: day.requirement.requiredMinutes, requiredAfter: afterRequirement.requiredMinutes,
        exemptMinutesBefore: day.eligibility.exemptMinutes, exemptMinutesAfter: effect.exemptMinutes, deadlineBefore: day.eligibility.deadlineAt, editableBefore: day.eligibility.editableUntilAt };
      await Audit.create([{ _id: eventId, ...retryMatch, control: saved._id, revision: saved.revision, action: values.action, actor: ctx.actor._id, actorNameSnapshot: evidence.actorNameSnapshot, reason: values.reason, requestHash: hash, before, after, contextSnapshot }], { session });
      await createRequestNotifications({ company: ctx.company, recipients: [employeeId], actor: ctx.actor._id, entityType: "timesheet_day_control", entityId: saved._id,
        eventType: `timesheet.${values.action}`, title: "Timesheet requirement or deadline updated", message: `${date}: ${values.action.replace(/_/g, " ")}. ${values.reason}`,
        actionUrl: `/dashboard/calendar?workDate=${date}`, category: "request", metadata: { attendanceDate: date, controlRevision: saved.revision, employeeName: employee.name }, dedupeEventKey: `control:${saved.revision}` }, session);
      result = { data: after, replayed: false, eventId };
    });
  } catch (error: any) {
    if (error?.code === 11000) { const prior: any = await Audit.findOne(retryMatch).lean(); if (prior) result = replay(prior); else throw generateError("Day changed. Reload before trying again.", 409); }
    else throw error;
  } finally { await session.endSession(); }
  res.json({ success: true, ...result });
});
