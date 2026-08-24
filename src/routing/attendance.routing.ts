import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  getTodayAttendanceService,
  listMyAttendanceService,
  punchInService,
  punchOutService,
} from "../services/attendance/attendance.service";

const attendanceRouting = express.Router();

attendanceRouting.use(authenticate);
attendanceRouting.get("/today", getTodayAttendanceService);
attendanceRouting.get("/records", listMyAttendanceService);
attendanceRouting.post("/punch-in", punchInService);
attendanceRouting.post("/punch-out", punchOutService);

export default attendanceRouting;

