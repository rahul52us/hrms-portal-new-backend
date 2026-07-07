import express from "express";
import authenticate from "../../modules/config/authenticate";
import { getScopedDashboardSummaryService } from "../../services/dashboard/scopedDashboard.service";
import {
  getLearnerResultDetailService,
  getLearnerResultsService,
} from "../../services/dashboard/learnerResults.service";

const dashboardRouting = express.Router();

dashboardRouting.get("/summary", authenticate, getScopedDashboardSummaryService);
dashboardRouting.get("/learner-results", authenticate, getLearnerResultsService);
dashboardRouting.get(
  "/learner-results/:enrollmentId",
  authenticate,
  getLearnerResultDetailService
);

export default dashboardRouting;
