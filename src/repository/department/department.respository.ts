import Department from "../../schemas/Department/Department.schema";

const departmentHeadPopulate = "name email username role userType department";

export const create_department_repo = async (data: any) => {
  return Department.create(data);
};

export const update_department_repo = async (id: string, data: any) => {
  return Department.findOneAndUpdate(
    { _id: id, deletedAt: null },
    data,
    { new: true }
  ).populate("departmentHead", departmentHeadPopulate);
};

export const delete_department_repo = async (id: string) => {
  return Department.findOneAndDelete({ _id: id, deletedAt: null });
};

export const get_departments_repo = async (
  company: string,
  page: number,
  limit: number
) => {
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    Department.find({ company, deletedAt: null })
      .populate("departmentHead", departmentHeadPopulate)
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
