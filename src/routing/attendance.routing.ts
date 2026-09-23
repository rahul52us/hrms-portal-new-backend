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

