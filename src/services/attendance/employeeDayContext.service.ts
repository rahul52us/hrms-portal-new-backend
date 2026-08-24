import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import User from "../../schemas/User/User";
import { resolveEmployeePolicyData } from "../workforcePolicy/policyAssignment.service";
import {
  buildEmployeeDayContext,
  parseAttendanceDate,
} from "./employeeDayContext.utils";

const EMPLOYEE_CONTEXT_FIELDS =
  "_id company name username code role department team officeLocation designation reportingManager joiningDate confirmationDate employmentEndDate createdAt deletedAt";

function objectId(value: unknown, label: string) {
  const normalized = String((value as any)?._id || value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw generateError(`Invalid ${label}`, 400);
  }
  return new mongoose.Types.ObjectId(normalized);
}

export interface ResolveEmployeeDayContextOptions {
  companyId: string | mongoose.Types.ObjectId;
  employeeId: string | mongoose.Types.ObjectId;
  attendanceDate: string;
  versionCache?: Map<string, Promise<any>>;
}

export async function resolveEmployeeDayContext(options: ResolveEmployeeDayContextOptions) {
  const companyId = objectId(options.companyId, "company id");
  const employeeId = objectId(options.employeeId, "employee id");
  const parsedDate = parseAttendanceDate(options.attendanceDate);
  const employee = await User.findOne({
    _id: employeeId,
    company: companyId,
  })
    .select(EMPLOYEE_CONTEXT_FIELDS)
    .lean();

  if (!employee) throw generateError("Employee not found in this company", 404);

  const policyResolution = await resolveEmployeePolicyData({
    actor: null,
    employee,
    at: parsedDate.date,
    assertAccess: false,
    versionCache: options.versionCache,
  });

  return buildEmployeeDayContext({
    attendanceDate: parsedDate.dateKey,
    policyResolution,
  });
}
