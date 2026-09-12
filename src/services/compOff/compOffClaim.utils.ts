import { parseAttendanceDate } from "../attendance/employeeDayContext.utils";

export type CompOffClaimNotificationEvent =
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "revoked";

export function buildCompOffClaimNotificationContent(
  event: CompOffClaimNotificationEvent,
  claim: {
    attendanceDate: string;
    requestedUnits: number;
    employeeName?: string;
    expiresOn?: string | null;
  }
) {
  const units = Number(claim.requestedUnits || 0);
  const unitLabel = `${units}-day`;
  if (event === "awaiting_approval") {
    return {
      eventType: "comp_off_claim.awaiting_approval",
      title: "Comp-off claim needs approval",
      message: `${claim.employeeName || "An employee"} submitted a ${unitLabel} comp-off claim for work on ${claim.attendanceDate}.`,
      actionUrl: "/employee",
    };
  }
  if (event === "approved") {
    return {
      eventType: "comp_off_claim.approved",
      title: "Comp-off claim approved",
      message: `Your ${unitLabel} comp-off claim for work on ${claim.attendanceDate} was approved.${claim.expiresOn ? ` The credit expires on ${claim.expiresOn}.` : ""}`,
      actionUrl: "/dashboard/requests",
    };
  }
  if (event === "rejected") {
    return {
      eventType: "comp_off_claim.rejected",
      title: "Comp-off claim rejected",
      message: `Your ${unitLabel} comp-off claim for work on ${claim.attendanceDate} was rejected.`,
      actionUrl: "/dashboard/requests",
    };
  }
  if (event === "withdrawn") {
    return {
      eventType: "comp_off_claim.withdrawn",
      title: "Comp-off claim withdrawn",
      message: `The ${unitLabel} comp-off claim for work on ${claim.attendanceDate} was withdrawn.`,
      actionUrl: "/employee",
    };
  }
  return {
    eventType: "comp_off_claim.revoked",
    title: "Comp-off credit revoked",
    message: `Your approved ${unitLabel} comp-off credit earned on ${claim.attendanceDate} was revoked. Any unused credit was removed.`,
    actionUrl: "/dashboard/requests",
  };
}

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
