import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import LeaveType from "../../schemas/WorkforcePolicy/LeaveType.schema";
import User from "../../schemas/User/User";
import { resolveEmployeeDayContext } from "../attendance/employeeDayContext.service";
import {
  calculateLeaveRequest,
  enumerateDateKeys,
  LeavePortion,
} from "./leaveRequestCalculator.utils";
import { ensureEmployeeLeaveAccruals } from "./leaveAccrual.service";

function objectId(value: unknown, label: string) {
  const normalized = String((value as any)?._id || value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw generateError(`Invalid ${label}`, 400);
  }
  return new mongoose.Types.ObjectId(normalized);
}

export async function calculateEmployeeLeaveRequest(options: {
  companyId: unknown;
  employeeId: unknown;
  leaveTypeId: unknown;
  fromDate: string;
  toDate: string;
  startPortion?: LeavePortion;
  endPortion?: LeavePortion;
  requestedHours?: number | null;
  attachmentCount?: number;
  currentDate?: string;
}) {
  const companyId = objectId(options.companyId, "company id");
  const employeeId = objectId(options.employeeId, "employee id");
  const leaveTypeId = objectId(options.leaveTypeId, "leave type id");
  const [employee, leaveType] = await Promise.all([
    User.findOne({
      _id: employeeId,
      company: companyId,
      deletedAt: { $exists: false },
      is_enabled: { $ne: false },
    })
      .select("_id company name username code role joiningDate confirmationDate employmentEndDate reportingManager")
      .lean(),
    LeaveType.findOne({ _id: leaveTypeId, company: companyId, status: "active" }).lean(),
  ]);
  if (!employee) throw generateError("Employee not found or disabled", 404);
  if (!leaveType) throw generateError("Active leave type not found", 404);

  await ensureEmployeeLeaveAccruals({
    companyId,
    employee,
    asOf: options.currentDate || new Date().toISOString().slice(0, 10),
  });

  const dates = enumerateDateKeys(options.fromDate, options.toDate);
  const versionCache = new Map<string, Promise<any>>();
  const contexts = [];
  for (const attendanceDate of dates) {
    contexts.push(
      await resolveEmployeeDayContext({
        companyId,
        employeeId,
        attendanceDate,
        versionCache,
      })
    );
  }

  const calculation = calculateLeaveRequest({
    leaveTypeId: String(leaveType._id),
    leaveUnit: leaveType.unit,
    fromDate: options.fromDate,
    toDate: options.toDate,
    startPortion: options.startPortion,
    endPortion: options.endPortion,
    requestedHours: options.requestedHours,
    contexts,
    currentDate: options.currentDate,
    attachmentCount: options.attachmentCount,
    joiningDate: employee.joiningDate,
    confirmationDate: employee.confirmationDate,
    employmentEndDate: employee.employmentEndDate,
  });

  return { employee, leaveType, calculation };
}
