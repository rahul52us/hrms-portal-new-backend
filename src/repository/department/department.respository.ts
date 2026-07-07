import Department from "../../schemas/Department/Department.schema";

// CREATE
export const create_department_repo = async (data: any) => {
  return Department.create(data);
};

// UPDATE
export const update_department_repo = async (id: string, data: any) => {
  return Department.findOneAndUpdate(
    { _id: id, deletedAt: null }, // ✅ ensures record exists & not deleted
    data,
    { new: true }
  );
};

// DELETE (soft delete)
export const delete_department_repo = async (id: string) => {
  return Department.findOneAndDelete({ _id: id, deletedAt: null });
};

// GET ALL
export const get_departments_repo = async (
  company: string,
  page: number,
  limit: number
) => {
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    Department.find({ company, deletedAt: null })
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 }),

    Department.countDocuments({ company, deletedAt: null }),
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
