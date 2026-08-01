import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  archiveAttendancePolicyService,
  createAttendancePolicyService,
  createAttendancePolicyVersionService,
  getAttendancePolicyService,
  listAttendancePoliciesService,
  publishAttendancePolicyVersionService,
  updateAttendancePolicyService,
  updateAttendancePolicyVersionService,
} from "../services/workforcePolicy/attendancePolicy.service";
import {
  archiveHolidayCalendarService,
  createHolidayCalendarService,
  createHolidayCalendarVersionService,
  getHolidayCalendarService,
  listHolidayCalendarsService,
  publishHolidayCalendarVersionService,
  updateHolidayCalendarVersionService,
} from "../services/workforcePolicy/holidayCalendar.service";
import {
  archiveWorkScheduleService,
  createWorkScheduleService,
  createWorkScheduleVersionService,
  getWorkScheduleService,
  listWorkSchedulesService,
  publishWorkScheduleVersionService,
  updateWorkScheduleService,
  updateWorkScheduleVersionService,
} from "../services/workforcePolicy/workSchedule.service";
import {
  createPolicyAssignmentService,
  endPolicyAssignmentService,
  listPolicyAssignmentsService,
  listPolicyAuditLogService,
  resolveEmployeePolicyService,
} from "../services/workforcePolicy/policyAssignment.service";

const workforcePoliciesRouting = express.Router();

workforcePoliciesRouting.use(authenticate);

workforcePoliciesRouting.get("/attendance", listAttendancePoliciesService);
workforcePoliciesRouting.post("/attendance", createAttendancePolicyService);
workforcePoliciesRouting.get("/attendance/:policyId", getAttendancePolicyService);
workforcePoliciesRouting.put("/attendance/:policyId", updateAttendancePolicyService);
workforcePoliciesRouting.post("/attendance/:policyId/archive", archiveAttendancePolicyService);
workforcePoliciesRouting.post("/attendance/:policyId/versions", createAttendancePolicyVersionService);
workforcePoliciesRouting.put(
  "/attendance/:policyId/versions/:versionId",
  updateAttendancePolicyVersionService
);
workforcePoliciesRouting.post(
  "/attendance/:policyId/versions/:versionId/publish",
  publishAttendancePolicyVersionService
);

workforcePoliciesRouting.get("/work-schedules", listWorkSchedulesService);
workforcePoliciesRouting.post("/work-schedules", createWorkScheduleService);
workforcePoliciesRouting.get("/work-schedules/:scheduleId", getWorkScheduleService);
workforcePoliciesRouting.put("/work-schedules/:scheduleId", updateWorkScheduleService);
workforcePoliciesRouting.post("/work-schedules/:scheduleId/archive", archiveWorkScheduleService);
workforcePoliciesRouting.post(
  "/work-schedules/:scheduleId/versions",
  createWorkScheduleVersionService
);
workforcePoliciesRouting.put(
  "/work-schedules/:scheduleId/versions/:versionId",
  updateWorkScheduleVersionService
);
workforcePoliciesRouting.post(
  "/work-schedules/:scheduleId/versions/:versionId/publish",
  publishWorkScheduleVersionService
);

workforcePoliciesRouting.get("/holiday-calendars", listHolidayCalendarsService);
workforcePoliciesRouting.post("/holiday-calendars", createHolidayCalendarService);
workforcePoliciesRouting.get("/holiday-calendars/:calendarId", getHolidayCalendarService);
workforcePoliciesRouting.post("/holiday-calendars/:calendarId/archive", archiveHolidayCalendarService);
workforcePoliciesRouting.post(
  "/holiday-calendars/:calendarId/versions",
  createHolidayCalendarVersionService
);
workforcePoliciesRouting.put(
  "/holiday-calendars/:calendarId/versions/:versionId",
  updateHolidayCalendarVersionService
);
workforcePoliciesRouting.post(
  "/holiday-calendars/:calendarId/versions/:versionId/publish",
  publishHolidayCalendarVersionService
);

workforcePoliciesRouting.get("/assignments", listPolicyAssignmentsService);
workforcePoliciesRouting.post("/assignments", createPolicyAssignmentService);
workforcePoliciesRouting.post("/assignments/:assignmentId/end", endPolicyAssignmentService);
workforcePoliciesRouting.get("/resolve/:employeeId", resolveEmployeePolicyService);
workforcePoliciesRouting.get("/audit", listPolicyAuditLogService);

export default workforcePoliciesRouting;
