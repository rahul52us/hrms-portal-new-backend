import mongoose from "mongoose";
import OfficeLocation from "../../schemas/OfficeLocation/OfficeLocation.schema";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLocationMatch(company: string, search?: string) {
  const match: any = {
    company: new mongoose.Types.ObjectId(company),
    deletedAt: null,
  };

  const trimmedSearch = String(search || "").trim();
  if (trimmedSearch) {
    const searchRegex = new RegExp(escapeRegex(trimmedSearch), "i");
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

  return match;
}

export const create_office_location_repo = async (data: any) => {
  return OfficeLocation.create(data);
};

export const update_office_location_repo = async (id: string, data: any) => {
  return OfficeLocation.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { ...data, updatedAt: new Date() },
    { new: true }
  );
};

export const delete_office_location_repo = async (id: string) => {
  return OfficeLocation.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { deletedAt: new Date(), updatedAt: new Date(), is_active: false },
    { new: true }
  );
};

export const get_office_locations_repo = async (
  company: string,
  page: number,
  limit: number,
  search?: string
) => {
  const skip = (page - 1) * limit;
  const match = buildLocationMatch(company, search);

  const [data, total] = await Promise.all([
    OfficeLocation.find(match)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 }),
    OfficeLocation.countDocuments(match),
  ]);

  return {
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};
