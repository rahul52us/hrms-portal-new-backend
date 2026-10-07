import express from "express";
import multer from "multer";
import authenticate from "../modules/config/authenticate";
import {
  downloadMyAttendanceStatementService,
  getTodayAttendanceService,
  listMyAttendanceService,
  punchInService,
  punchOutService,
} from "../services/attendance/attendance.service";
import {
  getAttendanceEmployeeDayService,
  getAttendanceOverviewOptionsService,
  getAttendanceOverviewService,
  getMyAttendanceDayService,
} from "../services/attendance/attendanceOverview.service";
import {
  approveAttendanceRegularizationRequestService,
  createAttendanceRegularizationRequestService,
  getAttendanceRegularizationEligibilityService,
  getAttendanceRegularizationRequestService,
  listAttendanceRegularizationRequestsService,
  rejectAttendanceRegularizationRequestService,
  withdrawAttendanceRegularizationRequestService,
} from "../services/attendance/attendanceRegularization.service";
import {
  applyAttendanceImportService,
  bulkAttendanceOperationsService,
  downloadAttendanceImportTemplateService,
  previewAttendanceImportService,
  reopenAttendanceEmployeeDayService,
  updateAttendanceEmployeeDayService,
} from "../services/attendance/attendanceOperations.service";
import {
  createAttendanceProcessorRunService,
  getAttendanceProcessorRunService,
  listAttendanceProcessorRunsService,
  prepareAttendanceCycleService,
  resumeAttendanceProcessorRunService,
} from "../services/attendance/attendanceProcessor.service";
import {
  getAttendancePeriodForDateService,
  getAttendancePeriodService,
  lockAttendancePeriodService,
  reopenAttendancePeriodService,
} from "../services/attendance/attendancePeriod.service";
import {
  approveAttendanceOvertimeReviewService,
  listAttendanceOvertimeReviewsService,
  rejectAttendanceOvertimeReviewService,
} from "../services/attendance/attendanceOvertime.service";
import {
  listAttendanceTrustedDevicesService,
  registerAttendanceTrustedDeviceService,
  updateAttendanceTrustedDeviceStatusService,
} from "../services/attendance/attendanceTrustedDevice.service";
import {
  exportAttendancePayrollService,
  exportAttendanceReportService,
  getAttendanceExceptionsReportService,
  getAttendancePayrollService,
  getAttendanceReportsDashboardService,
  getDailyAttendanceReportService,
  getMonthlyAttendanceReportService,
  lockAttendancePayrollService,
  updateAttendancePayrollSettingsService,
} from "../services/attendance/attendanceReports.service";

const attendanceRouting = express.Router();
const attendanceImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const name = String(file.originalname || "").toLowerCase();
    callback(null, name.endsWith(".csv") || name.endsWith(".xlsx"));
  },
});

attendanceRouting.use(authenticate);
attendanceRouting.get("/today", getTodayAttendanceService);
attendanceRouting.get("/statements/monthly", downloadMyAttendanceStatementService);
attendanceRouting.get("/records", listMyAttendanceService);
attendanceRouting.get("/records/:attendanceDate", getMyAttendanceDayService);
attendanceRouting.get("/overview/options", getAttendanceOverviewOptionsService);
attendanceRouting.get("/overview", getAttendanceOverviewService);
attendanceRouting.get("/employee-day/:employeeId", getAttendanceEmployeeDayService);
attendanceRouting.patch("/employee-day/:employeeId", updateAttendanceEmployeeDayService);
attendanceRouting.post("/employee-day/:employeeId/reopen", reopenAttendanceEmployeeDayService);
attendanceRouting.post("/operations/bulk", bulkAttendanceOperationsService);
attendanceRouting.get("/import/template", downloadAttendanceImportTemplateService);
attendanceRouting.post("/import/preview", attendanceImport.single("file"), previewAttendanceImportService);
attendanceRouting.post("/import/apply", attendanceImport.single("file"), applyAttendanceImportService);
attendanceRouting.get("/processor/runs", listAttendanceProcessorRunsService);
attendanceRouting.post("/processor/runs", createAttendanceProcessorRunService);
attendanceRouting.get("/processor/runs/:runId", getAttendanceProcessorRunService);
attendanceRouting.post("/processor/runs/:runId/resume", resumeAttendanceProcessorRunService);
attendanceRouting.get("/periods/date/:attendanceDate", getAttendancePeriodForDateService);
attendanceRouting.get("/periods/:periodKey", getAttendancePeriodService);
attendanceRouting.post("/periods/:periodKey/prepare", prepareAttendanceCycleService);
attendanceRouting.post("/periods/:periodKey/lock", lockAttendancePeriodService);
attendanceRouting.post("/periods/:periodKey/reopen", reopenAttendancePeriodService);
attendanceRouting.get("/reports/dashboard", getAttendanceReportsDashboardService);
attendanceRouting.get("/reports/daily", getDailyAttendanceReportService);
attendanceRouting.get("/reports/monthly", getMonthlyAttendanceReportService);
attendanceRouting.get("/reports/exceptions", getAttendanceExceptionsReportService);
attendanceRouting.get("/reports/export", exportAttendanceReportService);
attendanceRouting.patch("/payroll/settings", updateAttendancePayrollSettingsService);
attendanceRouting.get("/payroll/:periodKey", getAttendancePayrollService);
attendanceRouting.post("/payroll/:periodKey/lock", lockAttendancePayrollService);
attendanceRouting.get("/payroll/:periodKey/export", exportAttendancePayrollService);
attendanceRouting.get("/overtime/reviews", listAttendanceOvertimeReviewsService);
attendanceRouting.post("/overtime/reviews/:reviewId/approve", approveAttendanceOvertimeReviewService);
attendanceRouting.post("/overtime/reviews/:reviewId/reject", rejectAttendanceOvertimeReviewService);
attendanceRouting.get("/trusted-devices", listAttendanceTrustedDevicesService);
attendanceRouting.post("/trusted-devices/register", registerAttendanceTrustedDeviceService);
attendanceRouting.patch("/trusted-devices/:deviceId/status", updateAttendanceTrustedDeviceStatusService);
attendanceRouting.get("/regularization/eligibility", getAttendanceRegularizationEligibilityService);
attendanceRouting.post("/regularization/requests", createAttendanceRegularizationRequestService);
attendanceRouting.get("/regularization/requests", listAttendanceRegularizationRequestsService);
attendanceRouting.get("/regularization/requests/:requestId", getAttendanceRegularizationRequestService);
attendanceRouting.post("/regularization/requests/:requestId/approve", approveAttendanceRegularizationRequestService);
attendanceRouting.post("/regularization/requests/:requestId/reject", rejectAttendanceRegularizationRequestService);
attendanceRouting.post("/regularization/requests/:requestId/withdraw", withdrawAttendanceRegularizationRequestService);
attendanceRouting.post("/punch-in", punchInService);
attendanceRouting.post("/punch-out", punchOutService);

export default attendanceRouting;

