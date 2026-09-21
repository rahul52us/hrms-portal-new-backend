import express from "express";
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

const attendanceRouting = express.Router();

attendanceRouting.use(authenticate);
attendanceRouting.get("/today", getTodayAttendanceService);
attendanceRouting.get("/statements/monthly", downloadMyAttendanceStatementService);
attendanceRouting.get("/records", listMyAttendanceService);
attendanceRouting.get("/records/:attendanceDate", getMyAttendanceDayService);
attendanceRouting.get("/overview/options", getAttendanceOverviewOptionsService);
attendanceRouting.get("/overview", getAttendanceOverviewService);
attendanceRouting.get("/employee-day/:employeeId", getAttendanceEmployeeDayService);
attendanceRouting.post("/punch-in", punchInService);
attendanceRouting.post("/punch-out", punchOutService);

export default attendanceRouting;

