import express from "express";
import authenticate from "../modules/config/authenticate";
import { getMyTimesheetDay, getMyTimesheetHistory, getMyTimesheetPlanner, getMyTimesheetSummary, listMyTimesheetProjects, listMyTimesheetWorkTypes, saveMyTimesheetDraft } from "../services/timesheet/timesheet.service";

const router = express.Router();
router.use(authenticate);
router.get("/summary", getMyTimesheetSummary);
router.get("/planner", getMyTimesheetPlanner);
router.get("/day/:date", getMyTimesheetDay);
router.put("/day/:date", saveMyTimesheetDraft);
router.get("/day/:date/projects", listMyTimesheetProjects);
router.get("/day/:date/work-types", listMyTimesheetWorkTypes);
router.get("/day/:date/history", getMyTimesheetHistory);
export default router;
