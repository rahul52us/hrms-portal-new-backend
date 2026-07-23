import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import {
  create_office_location_repo,
  delete_office_location_repo,
  get_office_locations_repo,
  update_office_location_repo,
} from "../../repository/officeLocation/officeLocation.repository";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";
import User from "../../schemas/User/User";
import { ensureCompanyManagementAccess } from "../company/utils/activityGuards";
import { ensurePermission, PERMISSION_KEYS } from "../permissions/permission.utils";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const getRequesterRole = (req: any) =>
  String(
    req.bodyData?.role ||
      req.bodyData?.userType ||
      req.user?.role ||
      req.user?.userType ||
      ""
  )
    .trim()
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, "departmenthead")
    .replace(/^head[-\s]?hr$/i, "hradmin")
    .replace(/^hr[-\s]?admin$/i, "hradmin")
    .replace(/^hr[-\s]?executive$/i, "hr");

const getActor = (req: any) => req.bodyData || req.user;

const normalizeObjectIdList = (value: any) => {
  const source = Array.isArray(value)
    ? value
    : value
      ? [value]
      : [];
  const seen = new Set<string>();
  const output: string[] = [];

  source.forEach((item: any) => {
    const normalized = String(item?._id || item || "").trim();
    if (!normalized || seen.has(normalized) || !mongoose.Types.ObjectId.isValid(normalized)) {
      return;
    }

    seen.add(normalized);
    output.push(normalized);
  });

  return output;
};

const getActorHrScopeLocations = (req: any) => {
  const scope = (getActor(req) || {})?.hrScope || {};
  return normalizeObjectIdList(scope.officeLocations || scope.officeLocationIds || scope.locations || scope.locationIds);
};

const getScopedCompanyId = (req: any) => {
  const role = getRequesterRole(req);
  if (role === "superadmin") {
    return String(
      req.body?.companyId || req.body?.company || req.query?.companyId || ""
    ).trim();
  }

  return String(req.bodyData?.company || req.user?.company || "").trim();
};

const ensureLocationViewAllowed = (req: any) => {
  const role = getRequesterRole(req);
  if (!["superadmin", "admin", "departmenthead", "hradmin", "hr"].includes(role)) {
    throw generateError("Only superadmin, admin, department head, or HR can view locations", 403);
  }

  ensurePermission(getActor(req), PERMISSION_KEYS.VIEW_LOCATIONS, "You do not have permission to view locations");
};

const ensureLocationMutationAllowed = (req: any) => {
  const role = getRequesterRole(req);
  if (!["superadmin", "admin"].includes(role)) {
    throw generateError("Only superadmin or admin can manage locations", 403);
  }

  ensurePermission(getActor(req), PERMISSION_KEYS.MANAGE_LOCATIONS, "You do not have permission to manage locations");
};

const normalizeLocationPayload = (body: any) => ({
  name: String(body?.name || "").trim(),
  code: String(body?.code || "").trim().toUpperCase(),
  address: String(body?.address || "").trim(),
  city: String(body?.city || "").trim(),
  state: String(body?.state || "").trim(),
  country: String(body?.country || "").trim(),
  pinCode: String(body?.pinCode || body?.postalCode || "").trim(),
  ...(typeof body?.is_active === "boolean" ? { is_active: body.is_active } : {}),
});

const ensureNoDuplicateLocation = async ({
  company,
  name,
  code,
  excludeId,
}: {
  company: string;
  name: string;
  code: string;
  excludeId?: string;
}) => {
  const duplicateQuery: any = {
    company: new mongoose.Types.ObjectId(company),
    deletedAt: null,
    $or: [
      { code: { $regex: new RegExp(`^${escapeRegex(code)}$`, "i") } },
      { name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") } },
    ],
  };

  if (excludeId) {
    duplicateQuery._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
  }

  const duplicate = await OfficeLocation.findOne(duplicateQuery).lean();
  if (duplicate) {
    throw generateError("A location with this name or code already exists for this company", 400);
  }
};

export const createOfficeLocationService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureLocationMutationAllowed(req);
    const company = getScopedCompanyId(req);
    const payload = normalizeLocationPayload(req.body);

    if (!company) {
      throw generateError("companyId is required", 422);
    }

    if (!mongoose.Types.ObjectId.isValid(company)) {
      throw generateError("Invalid companyId", 400);
    }

    if (!payload.name || !payload.code || !payload.city) {
      throw generateError("Location name, code, and city are required", 400);
    }

    await ensureCompanyManagementAccess({
      actor: getActor(req),
      requestedCompanyId: company,
      actionLabel: "manage locations for this company",
      allowSuperadminWithoutCompany: false,
    });

    await ensureNoDuplicateLocation({
      company,
      name: payload.name,
      code: payload.code,
    });

    const location = await create_office_location_repo({
      ...payload,
      company,
    });

    return res.status(201).send({
      status: "success",
      data: location,
      message: "Location created successfully",
    });
  } catch (err) {
    next(err);
  }
};

export const updateOfficeLocationService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureLocationMutationAllowed(req);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw generateError("Invalid location id", 400);
    }

    const existingLocation = await OfficeLocation.findOne({
      _id: id,
      deletedAt: null,
    });

    if (!existingLocation) {
      throw generateError("Location not found", 404);
    }

    await ensureCompanyManagementAccess({
      actor: getActor(req),
      requestedCompanyId: String(existingLocation.company || ""),
      actionLabel: "manage locations for this company",
      allowSuperadminWithoutCompany: false,
    });

    const payload = normalizeLocationPayload(req.body);
    const nextName = payload.name || existingLocation.name;
    const nextCode = payload.code || existingLocation.code;

    if (!nextName || !nextCode || !payload.city && !existingLocation.city) {
      throw generateError("Location name, code, and city are required", 400);
    }

    await ensureNoDuplicateLocation({
      company: String(existingLocation.company || ""),
      name: nextName,
      code: nextCode,
      excludeId: id,
    });

    const updatePayload = Object.entries(payload).reduce<Record<string, any>>(
      (acc, [key, value]) => {
        if (value !== "") {
          acc[key] = value;
        }
        return acc;
      },
      {}
    );

    const updated = await update_office_location_repo(id, updatePayload);

    return res.status(200).send({
      status: "success",
      data: updated,
      message: "Location updated successfully",
    });
  } catch (err) {
    next(err);
  }
};

export const deleteOfficeLocationService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureLocationMutationAllowed(req);
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw generateError("Invalid location id", 400);
    }

    const existingLocation = await OfficeLocation.findOne({
      _id: id,
      deletedAt: null,
    });

    if (!existingLocation) {
      throw generateError("Location not found", 404);
    }

    await ensureCompanyManagementAccess({
      actor: getActor(req),
      requestedCompanyId: String(existingLocation.company || ""),
      actionLabel: "manage locations for this company",
      allowSuperadminWithoutCompany: false,
    });

    const assignedUsers = await User.countDocuments({
      officeLocation: existingLocation._id,
      deletedAt: { $exists: false },
    });

    if (assignedUsers > 0) {
      throw generateError("This location is assigned to employees. Deactivate it instead of deleting it.", 400);
    }

    await delete_office_location_repo(id);

    return res.status(200).send({
      status: "success",
      message: "Location deleted successfully",
    });
  } catch (err) {
    next(err);
  }
};

export const getOfficeLocationsService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureLocationViewAllowed(req);
    const company = getScopedCompanyId(req);
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const search = String(req.query.search || "").trim();

    if (!company) {
      return res.status(200).send({
        status: "success",
        data: [],
        pagination: {
          total: 0,
          page,
          limit,
          totalPages: 0,
        },
      });
    }

    if (!mongoose.Types.ObjectId.isValid(company)) {
      throw generateError("Invalid companyId", 400);
    }

    await ensureCompanyManagementAccess({
      actor: getActor(req),
      requestedCompanyId: company,
      actionLabel: "view locations for this company",
      allowSuperadminWithoutCompany: false,
    });

    if (getRequesterRole(req) === "hr") {
      const scopedLocationIds = getActorHrScopeLocations(req);

      if (scopedLocationIds.length > 0) {
        const locationIds = scopedLocationIds.map((locationId) => new mongoose.Types.ObjectId(locationId));
        const match: any = {
          company: new mongoose.Types.ObjectId(company),
          deletedAt: null,
          _id: { $in: locationIds },
        };

        if (search) {
          const searchRegex = new RegExp(escapeRegex(search), "i");
          match.$or = [
            { name: searchRegex },
            { code: searchRegex },
            { address: searchRegex },
            { city: searchRegex },
            { state: searchRegex },
            { country: searchRegex },
            { pinCode: searchRegex },
          ];
        }

        const skip = (page - 1) * limit;
        const [locations, total] = await Promise.all([
          OfficeLocation.find(match)
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 }),
          OfficeLocation.countDocuments(match),
        ]);

        return res.status(200).send({
          status: "success",
          data: locations,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        });
      }
    }

    const data = await get_office_locations_repo(company, page, limit, search);

    return res.status(200).send({
      status: "success",
      ...data,
    });
  } catch (err) {
    next(err);
  }
};
