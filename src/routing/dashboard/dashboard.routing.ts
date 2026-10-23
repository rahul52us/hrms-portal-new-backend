import express from "express";
import authenticate from "../../modules/config/authenticate";
import { getPlatformDashboardSummaryService } from "../../services/dashboard/platformDashboard.service";
import { getHrDashboardSummaryService, getHrEmployeeStatsService } from "../../services/dashboard/hrDashboard.service";

const dashboardRouting = express.Router();

dashboardRouting.get("/summary", authenticate, getPlatformDashboardSummaryService);
dashboardRouting.get("/hr-summary", authenticate, getHrDashboardSummaryService);
dashboardRouting.get("/hr-employee-stats", authenticate, getHrEmployeeStatsService);

export default dashboardRouting;
