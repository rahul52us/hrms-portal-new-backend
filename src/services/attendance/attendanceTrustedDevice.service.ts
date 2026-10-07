import { createHash } from "node:crypto";
import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import AttendanceTrustedDevice from "../../schemas/Attendance/AttendanceTrustedDevice.schema";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { requestClientIp } from "./attendancePunchAccess.utils";

function text(value: unknown) {
  return String(value || "").trim();
}

function actor(req: any) {
  return req?.user || req?.bodyData || {};
}

function objectId(value: unknown, label: string) {
  const normalized = text((value as any)?._id || value);
  if (!mongoose.Types.ObjectId.isValid(normalized)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(normalized);
}

function employeeActor(req: any) {
  const source = actor(req);
  return {
    employeeId: objectId(req?.userId || source?._id, "authenticated user"),
    companyId: objectId(source?.company || source?.companyId, "company"),
  };
}

function managementActor(req: any) {
  const source = actor(req);
  ensurePermission(
    source,
    PERMISSION_KEYS.MANAGE_WORKFORCE_POLICIES,
    "You do not have permission to manage trusted attendance devices"
  );
  const role = text(source?.role).toLowerCase();
  const requestedCompany = role === "superadmin"
    ? req.query?.companyId || req.body?.companyId
    : source?.company || source?.companyId;
  return {
    actorId: objectId(req?.userId || source?._id, "authenticated user"),
    companyId: objectId(requestedCompany, "company"),
  };
}

export function normalizeAttendanceDeviceId(value: unknown) {
  const normalized = text(value);
  if (normalized.length < 16 || normalized.length > 200 || !/^[A-Za-z0-9:_-]+$/.test(normalized)) {
    throw generateError("A valid attendance device identifier is required", 422);
  }
  return normalized;
}

export function attendanceDeviceHash(value: unknown) {
  return createHash("sha256").update(normalizeAttendanceDeviceId(value)).digest("hex");
}

function requestDeviceId(req: any) {
  return req?.body?.deviceId || req?.headers?.["x-attendance-device-id"];
}

function serializeDevice(device: any) {
  const value = device?.toObject ? device.toObject() : { ...(device || {}) };
  delete value.deviceHash;
  return value;
}

export async function resolveAttendanceTrustedDevice(options: {
  companyId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  deviceId: unknown;
}) {
  if (!text(options.deviceId)) return { status: "missing" as const, device: null };
  let deviceHash: string;
  try {
    deviceHash = attendanceDeviceHash(options.deviceId);
  } catch {
    return { status: "invalid" as const, device: null };
  }
  const device = await AttendanceTrustedDevice.findOne({
    company: options.companyId,
    employee: options.employeeId,
    deviceHash,
  }).lean();
  return {
    status: (device?.status || "unregistered") as "pending" | "trusted" | "revoked" | "unregistered",
    device,
  };
}

export async function touchAttendanceTrustedDevice(deviceId: unknown, clientIp: string) {
  if (!deviceId) return;
  await AttendanceTrustedDevice.updateOne(
    { _id: deviceId },
    { $set: { lastSeenAt: new Date(), lastSeenIp: clientIp } }
  );
}

export async function registerAttendanceTrustedDeviceService(req: any, res: Response, next: NextFunction) {
  try {
    const identity = employeeActor(req);
    const deviceId = normalizeAttendanceDeviceId(requestDeviceId(req));
    const deviceHash = attendanceDeviceHash(deviceId);
    const now = new Date();
    const device = await AttendanceTrustedDevice.findOneAndUpdate(
      {
        company: identity.companyId,
        employee: identity.employeeId,
        deviceHash,
      },
      {
        $setOnInsert: {
          deviceIdSuffix: deviceId.slice(-8),
          status: "pending",
          firstSeenAt: now,
        },
        $set: {
          deviceName: text(req.body?.deviceName || "Browser").slice(0, 120),
          platform: text(req.body?.platform).slice(0, 120),
          userAgent: text(req.body?.userAgent || req.headers?.["user-agent"]).slice(0, 500),
          lastSeenAt: now,
          lastSeenIp: requestClientIp(req),
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    return res.status(200).json({
      success: true,
      data: serializeDevice(device),
      message: device.status === "trusted"
        ? "This browser is already trusted"
        : device.status === "revoked"
          ? "This browser was revoked. Contact HR to trust it again."
          : "Browser registration is pending approval",
    });
  } catch (error) {
    next(error);
  }
}

export async function listAttendanceTrustedDevicesService(req: any, res: Response, next: NextFunction) {
  try {
    const identity = managementActor(req);
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 25)));
    const status = text(req.query?.status || "all").toLowerCase();
    if (!["all", "pending", "trusted", "revoked"].includes(status)) {
      throw generateError("Invalid trusted-device status", 400);
    }
    const match: any = { company: identity.companyId };
    if (status !== "all") match.status = status;
    if (text(req.query?.employeeId)) match.employee = objectId(req.query.employeeId, "employee id");
    const [items, total] = await Promise.all([
      AttendanceTrustedDevice.find(match)
        .populate("employee", "name username code designation")
        .populate("trustedBy revokedBy", "name username")
        .sort({ status: 1, lastSeenAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AttendanceTrustedDevice.countDocuments(match),
    ]);
    return res.status(200).json({
      success: true,
      data: items.map(serializeDevice),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
}

export async function updateAttendanceTrustedDeviceStatusService(req: any, res: Response, next: NextFunction) {
  try {
    const identity = managementActor(req);
    const deviceId = objectId(req.params.deviceId, "trusted device id");
    const status = text(req.body?.status).toLowerCase();
    const reason = text(req.body?.reason);
    if (!["trusted", "revoked"].includes(status)) throw generateError("Status must be trusted or revoked", 422);
    if (reason.length < 3) throw generateError("Decision reason must contain at least 3 characters", 422);
    const existing = await AttendanceTrustedDevice.findOne({ _id: deviceId, company: identity.companyId })
      .select("employee")
      .lean();
    if (!existing) throw generateError("Trusted device was not found", 404);
    if (status === "trusted" && String(existing.employee) === String(identity.actorId)) {
      throw generateError("You cannot trust your own attendance browser", 409);
    }
    const now = new Date();
    const set: any = { status };
    const update: any = {
      $set: set,
      $push: {
        decisions: { status, actor: identity.actorId, reason: reason.slice(0, 500), decidedAt: now },
      },
    };
    if (status === "trusted") {
      set.trustedAt = now;
      set.trustedBy = identity.actorId;
      set.revokedAt = null;
      set.revokedBy = null;
    } else {
      set.revokedAt = now;
      set.revokedBy = identity.actorId;
    }
    const device = await AttendanceTrustedDevice.findOneAndUpdate(
      { _id: deviceId, company: identity.companyId },
      update,
      { new: true, runValidators: true }
    );
    if (!device) throw generateError("Trusted device changed while applying the decision", 409);
    return res.status(200).json({
      success: true,
      data: serializeDevice(device),
      message: status === "trusted" ? "Browser trusted" : "Browser revoked",
    });
  } catch (error) {
    next(error);
  }
}
