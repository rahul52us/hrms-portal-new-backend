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
  getPolicyCoverageService,
  listPolicyAssignmentsService,
  listPolicyAuditLogService,
  resolveEmployeePolicyService,
} from "../services/workforcePolicy/policyAssignment.service";
import {
  archiveLeavePolicyService,
  archiveLeaveTypeService,
  createLeavePolicyService,
  createLeavePolicyVersionService,
  createLeaveTypeService,
  getLeavePolicyService,
  listLeavePoliciesService,
  listLeaveTypesService,
  publishLeavePolicyVersionService,
  updateLeavePolicyService,
  updateLeavePolicyVersionService,
  updateLeaveTypeService,
} from "../services/workforcePolicy/leavePolicy.service";

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

workforcePoliciesRouting.get("/leave-types", listLeaveTypesService);
workforcePoliciesRouting.post("/leave-types", createLeaveTypeService);
workforcePoliciesRouting.put("/leave-types/:leaveTypeId", updateLeaveTypeService);
workforcePoliciesRouting.post("/leave-types/:leaveTypeId/archive", archiveLeaveTypeService);

workforcePoliciesRouting.get("/leave-policies", listLeavePoliciesService);
workforcePoliciesRouting.post("/leave-policies", createLeavePolicyService);
workforcePoliciesRouting.get("/leave-policies/:policyId", getLeavePolicyService);
workforcePoliciesRouting.put("/leave-policies/:policyId", updateLeavePolicyService);
workforcePoliciesRouting.post("/leave-policies/:policyId/archive", archiveLeavePolicyService);
workforcePoliciesRouting.post(
  "/leave-policies/:policyId/versions",
  createLeavePolicyVersionService
);
workforcePoliciesRouting.put(
  "/leave-policies/:policyId/versions/:versionId",
  updateLeavePolicyVersionService
);
workforcePoliciesRouting.post(
  "/leave-policies/:policyId/versions/:versionId/publish",
  publishLeavePolicyVersionService
);

workforcePoliciesRouting.get("/assignments", listPolicyAssignmentsService);
workforcePoliciesRouting.post("/assignments", createPolicyAssignmentService);
workforcePoliciesRouting.post("/assignments/:assignmentId/end", endPolicyAssignmentService);
workforcePoliciesRouting.get("/coverage", getPolicyCoverageService);
workforcePoliciesRouting.get("/resolve/:employeeId", resolveEmployeePolicyService);
workforcePoliciesRouting.get("/audit", listPolicyAuditLogService);

export default workforcePoliciesRouting;
