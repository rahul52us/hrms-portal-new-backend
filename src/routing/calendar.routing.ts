import express from "express";
import authenticate from "../modules/config/authenticate";
import { getCalendarSummaryService, getCalendarDayService, getCalendarOptionsService, listCalendarEmployeesService } from "../services/calendar/calendar.service";

const calendarRouting = express.Router();
calendarRouting.use(authenticate);
calendarRouting.get("/options", getCalendarOptionsService);
calendarRouting.get("/summary", getCalendarSummaryService);
calendarRouting.get("/day", getCalendarDayService);
calendarRouting.get("/employees", listCalendarEmployeesService);
export default calendarRouting;
