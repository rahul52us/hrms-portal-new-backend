import CompanyPolicy from "../../schemas/company/CompanyPolicy";
import Company from "../../schemas/company/Company";
import User from "../../schemas/User/User";
import { statusCode } from "../../config/helper/statusCode";
import mongoose from "mongoose";
import { createCatchError } from "../../config/helper/function";
import companyDetails from "../../schemas/company/companyDetails";
import { uploadFile } from "../uploadDoc.repository";

const DEFAULT_THEME_COLOR = "#2563EB";

const normalizeTenantSlug = (value: string) => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
};

const normalizeDomain = (value?: string) => {
  if (!value?.trim()) {
    return "";
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
};

const buildTenantUrl = (tenantSlug: string, customDomain?: string) => {
  const normalizedDomain = normalizeDomain(customDomain);
  if (normalizedDomain) {
    return `https://${normalizedDomain}`;
  }

  const baseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:3000";

  try {
    const parsedUrl = new URL(baseUrl);
    const hostname = parsedUrl.hostname.replace(/^www\./, "");
    const port = parsedUrl.port ? `:${parsedUrl.port}` : "";

    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return `${parsedUrl.protocol}//${tenantSlug}.localhost${port}`;
    }

    return `${parsedUrl.protocol}//${tenantSlug}.${hostname}${port}`;
  } catch {
    return `https://${tenantSlug}.localhost`;
  }
};

const normalizeThemeColor = (value?: string) => {
  const trimmedValue = String(value || "").trim();
  return /^#(?:[0-9A-Fa-f]{3}){1,2}$/.test(trimmedValue)
    ? trimmedValue.toUpperCase()
    : DEFAULT_THEME_COLOR;
};

export const updatedCompanyDetails = async(data : any) => {
  try
  {
     await companyDetails.findByIdAndUpdate(data.company,{$set : {...data}})
     return {
      status : 'success',
      data : 'Update Company Details Successfully',
      statusCode : statusCode.success,
      message : 'Update Company Details Successfully'
    }
  }
  catch(err : any)
  {
    return createCatchError(err)
  }
}


export const getCompanyPolicies = async (data : any) => {
  try
  {
    const pipeline : any = []
    pipeline.push({
      $match : {
        company : data.company,
        deletedAt : {$exists: false}
      }
    })
    const result = await CompanyPolicy.aggregate(pipeline)
    return {
      status : 'success',
      data : result,
      statusCode : statusCode.success,
      message : 'Retrived Policies Successfully'
    }
  }
  catch(err : any)
  {
    return createCatchError(err)
  }
}

export const getIndividualPolicy = async (data : any) => {
  try
  {
    const result = await CompanyPolicy.findOne({_id : data.policy, company : data.company})
    if(result){
      return {
        status : 'success',
        data : result,
        statusCode : statusCode.success,
        message : 'Retrived Policies Successfully'
      }
    }
    else
    {
      return {
        status : 'error',
        data : 'No Such Policy Exists',
        statusCode : statusCode.info,
        message : 'No Such Policy Exists'
      }
    }
  }
  catch(err : any)
  {
    return createCatchError(err)
  }
}

export const updateCompanyPolicy = async (data : any) => {
  try
  {
    const companyPolicy : any = await CompanyPolicy.findOneAndUpdate({_id : data.policy, company : data.company},{$set : {...data},new : true})
    if(companyPolicy){
      return {
        data : companyPolicy,
        message : 'Policy has been updated successfully',
        status : 'success',
        statusCode:statusCode.success
      }
    }
    else
    {
      return {
        status : 'error',
        data : 'Policy does not exists',
        statusCode : statusCode.info,
        message : 'Policy does not exists'
      }
    }
  }
  catch(err : any)
  {
    return createCatchError(err)
  }
}


export const getCompanyCount = async (data: any) => {
  try {
    const pipeline: any = [
      {
        $match: {
          companyOrg: data.companyOrg,
          deletedAt: { $exists: false },
          type: { $ne: "user" },
        }
      },
      {
        $count: "companyCount"
      }
    ];

    const result = await Company.aggregate(pipeline);

    return {
      status: 'success',
      data: result.length > 0 ? result[0].companyCount : 0,
      statusCode: statusCode.success,
      message: 'Retrieved Company Count Successfully'
    };
  } catch (err: any) {
    return createCatchError(err);
  }
};




export const getOrganisationCompanies = async (data: any) => {
  try {
    const pipeline: any = [];
    pipeline.push(
      {
        $match: {
          companyOrg: data.companyOrg,
          deletedAt: { $exists: false },
          is_active: true,
          type: { $ne: "user" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "createdBy",
          foreignField: "_id",
          as: "createdBy",
          pipeline: [
            {
              $project: {
                username: 1,
                code: 1,
                role: 1,
                _id: 1,
                name: 1,
              },
            },
          ],
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "activeUser",
          foreignField: "_id",
          as: "activeUser",
          pipeline: [
            {
              $project: {
                username: 1,
                code: 1,
                role: 1,
                _id: 1,
                name: 1,
              },
            },
          ],
        },
      },
      {
        $sort: {
          createdAt: -1,
        },
      }
    );

    const companies = await Company.aggregate(pipeline);
    return {
      data: companies,
      message: "Retrieved Company successfully",
      statusCode: statusCode.success,
      status: "success",
    };
  } catch (err: any) {
    return createCatchError(err);
  }
};

export const getCompanyDetailsByName = async (data: any) => {
  try {
    const company = await Company.findOne({
      company_name: new RegExp(data.company, "i"),
      is_active: true,
      deletedAt: { $exists: false },
      type: { $ne: "user" },
    });
    if (company) {
      return {
        status: "success",
        data: company,
        statusCode: 200,
      };
    } else {
      return {
        status: "error",
        data: `${data.company} No Such Are Found`,
        statusCode: 400,
      };
    }
  } catch (err: any) {
    return {
      status: "error",
      data: err,
      statusCode: err.statusCode,
    };
  }
};

export const getCompanyById = async (id: any): Promise<any | null> => {
  try {
    const company = await Company.findOne({
      _id: id,
      is_active: true,
      deletedAt: { $exists: false },
      type: { $ne: "user" },
    });
    if (company) {
      return company;
    } else {
      return null;
    }
  } catch (err: any) {
    return null;
  }
};

export const createManagedCompany = async (data: any) => {
  try {
    const tenantSlug = normalizeTenantSlug(data.tenantSlug || data.company_name);
    if (!tenantSlug) {
      return {
        status: "error",
        data: "Tenant slug is required",
        statusCode: statusCode.info,
        message: "Tenant slug is required",
      };
    }

    const companyName = data.company_name.trim();
    const companyCode = data.companyCode.trim().toUpperCase();
    const customDomain = normalizeDomain(data.customDomain);
    const primaryThemeColor = normalizeThemeColor(data.primaryThemeColor);

    const [existingCompany, existingCode, existingTenant, existingDomain] =
      await Promise.all([
        Company.findOne({
          company_name: { $regex: new RegExp(`^${companyName}$`, "i") },
        }),
        Company.findOne({
          companyCode: { $regex: new RegExp(`^${companyCode}$`, "i") },
        }),
        Company.findOne({
          tenantSlug: { $regex: new RegExp(`^${tenantSlug}$`, "i") },
        }),
        customDomain
          ? Company.findOne({
              customDomain: { $regex: new RegExp(`^${customDomain}$`, "i") },
            })
          : Promise.resolve(null),
      ]);

    if (existingCompany) {
      return {
        status: "error",
        data: `${existingCompany.company_name} company already exists`,
        statusCode: statusCode.info,
        message: `${existingCompany.company_name} company already exists`,
      };
    }

    if (existingCode) {
      return {
        status: "error",
        data: `${existingCode.companyCode} code is already mapped to ${existingCode.company_name}`,
        statusCode: statusCode.info,
        message: `${existingCode.companyCode} code is already mapped to ${existingCode.company_name}`,
      };
    }

    if (existingTenant) {
      return {
        status: "error",
        data: `${tenantSlug} tenant slug is already in use`,
        statusCode: statusCode.info,
        message: `${tenantSlug} tenant slug is already in use`,
      };
    }

    if (existingDomain) {
      return {
        status: "error",
        data: `${customDomain} custom domain is already in use`,
        statusCode: statusCode.info,
        message: `${customDomain} custom domain is already in use`,
      };
    }

    const tenantUrl = buildTenantUrl(tenantSlug, customDomain);

    const createdBy = data.createdBy || data.activeUser;

    const company = new Company({
      company_name: companyName,
      companyCode,
      companyType: data.companyType || "company",
      companyOrg: data.companyOrg,
      createdBy,
      activeUser: data.activeUser,
      is_active: true,
      verified_email_allowed: Boolean(data.verified_email_allowed),
      managerLevels: Number(data.managerLevels) || 3,
      tenantSlug,
      tenantUrl,
      customDomain: customDomain || undefined,
      companyEmail: data.companyEmail || undefined,
      mobileNo: data.mobileNo || undefined,
      workNo: data.workNo || undefined,
      webLink: data.webLink || undefined,
      bio: data.bio || undefined,
      primaryThemeColor,
      facebookLink: data.facebookLink || undefined,
      instagramLink: data.instagramLink || undefined,
      linkedInLink: data.linkedInLink || undefined,
      twitterLink: data.twitterLink || undefined,
      githubLink: data.githubLink || undefined,
      telegramLink: data.telegramLink || undefined,
      otherLinks: data.otherLinks || [],
      addressInfo: data.addressInfo || [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    if (data.logo?.filename && data.logo?.buffer) {
      const url = await uploadFile(data.logo);
      company.logo = {
        name: data.logo.filename,
        url,
        type: data.logo.type,
      };
    }

    const savedCompany = await company.save();

    try {
      await Promise.all([
        new CompanyPolicy({
          company: savedCompany._id,
          createdBy,
        }).save(),
        new companyDetails({
          company: savedCompany._id,
          details: [],
          faq: [],
          homeFaq: [],
        }).save(),
      ]);
    } catch (setupError) {
      await Promise.allSettled([
        Company.deleteOne({ _id: savedCompany._id }),
        CompanyPolicy.deleteMany({ company: savedCompany._id }),
        companyDetails.deleteMany({ company: savedCompany._id }),
      ]);
      throw setupError;
    }

    return {
      status: "success",
      data: savedCompany,
      statusCode: statusCode.create,
      message: `${savedCompany.company_name} company has been created successfully`,
    };
  } catch (err: any) {
    return createCatchError(err);
  }
};

export const deleteManagedCompanyArtifacts = async (companyId: string) => {
  if (!mongoose.Types.ObjectId.isValid(String(companyId))) {
    return;
  }

  const companyObjectId = new mongoose.Types.ObjectId(String(companyId));
  await Promise.allSettled([
    User.deleteMany({ company: companyObjectId }),
    Company.deleteOne({ _id: companyObjectId }),
    CompanyPolicy.deleteMany({ company: companyObjectId }),
    companyDetails.deleteMany({ company: companyObjectId }),
  ]);
};

export const getManagedCompanies = async (data: any) => {
  try {
    const match: any = {
      deletedAt: { $exists: false },
      companyType: { $ne: "organisation" },
      type: { $ne: "user" },
    };

    if (data.companyId) {
      match._id = data.companyId;
    } else if (!data.isSuperAdmin && data.companyOrg) {
      match.companyOrg = data.companyOrg;
    }

    if (data.search?.trim()) {
      const searchRegex = new RegExp(data.search.trim(), "i");
      match.$or = [
        { company_name: { $regex: searchRegex } },
        { companyCode: { $regex: searchRegex } },
        { tenantSlug: { $regex: searchRegex } },
        { companyEmail: { $regex: searchRegex } },
      ];
    }

    const companies = await Company.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "users",
          let: { companyId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$company", "$$companyId"] },
                role: "admin",
                deletedAt: { $exists: false },
              },
            },
            {
              $project: {
                _id: 1,
                name: 1,
                username: 1,
                is_active: 1,
                is_enabled: 1,
                createdAt: 1,
              },
            },
            { $sort: { createdAt: -1 } },
          ],
          as: "admins",
        },
      },
      {
        $lookup: {
          from: "users",
          let: { companyId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$company", "$$companyId"] },
                deletedAt: { $exists: false },
              },
            },
            {
              $project: {
                _id: 1,
                role: 1,
                is_active: 1,
                is_enabled: 1,
              },
            },
          ],
          as: "directUsers",
        },
      },
      {
        $lookup: {
          from: "companies",
          let: { companyId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$type", "user"] },
                    { $eq: ["$companyOrg", "$$companyId"] },
                  ],
                },
                deletedAt: { $exists: false },
              },
            },
            {
              $project: {
                _id: 0,
                userId: 1,
              },
            },
          ],
          as: "learnerMemberships",
        },
      },
      {
        $lookup: {
          from: "users",
          let: {
            membershipUserIds: {
              $map: {
                input: "$learnerMemberships",
                as: "membership",
                in: "$$membership.userId",
              },
            },
          },
          pipeline: [
            {
              $match: {
                $expr: { $in: ["$_id", "$$membershipUserIds"] },
                deletedAt: { $exists: false },
              },
            },
            {
              $project: {
                _id: 1,
                role: 1,
                is_active: 1,
                is_enabled: 1,
              },
            },
          ],
          as: "membershipUsers",
        },
      },
      {
        $addFields: {
          adminCount: { $size: "$admins" },
          activeAdminCount: {
            $size: {
              $filter: {
                input: "$admins",
                as: "admin",
                cond: {
                  $and: [
                    { $eq: ["$$admin.is_active", true] },
                    { $ne: ["$$admin.is_enabled", false] },
                  ],
                },
              },
            },
          },
          directUserIds: {
            $map: {
              input: "$directUsers",
              as: "user",
              in: "$$user._id",
            },
          },
          membershipUserIds: {
            $map: {
              input: "$membershipUsers",
              as: "user",
              in: "$$user._id",
            },
          },
          activeDirectUserIds: {
            $map: {
              input: {
                $filter: {
                  input: "$directUsers",
                  as: "user",
                  cond: {
                    $and: [
                      { $eq: ["$$user.is_active", true] },
                      { $ne: ["$$user.is_enabled", false] },
                    ],
                  },
                },
              },
              as: "user",
              in: "$$user._id",
            },
          },
          activeMembershipUserIds: {
            $map: {
              input: {
                $filter: {
                  input: "$membershipUsers",
                  as: "user",
                  cond: {
                    $and: [
                      { $eq: ["$$user.is_active", true] },
                      { $ne: ["$$user.is_enabled", false] },
                    ],
                  },
                },
              },
              as: "user",
              in: "$$user._id",
            },
          },
        },
      },
      {
        $addFields: {
          userCount: {
            $size: {
              $setUnion: ["$directUserIds", "$membershipUserIds"],
            },
          },
          activeUserCount: {
            $size: {
              $setUnion: ["$activeDirectUserIds", "$activeMembershipUserIds"],
            },
          },
        },
      },
      {
        $project: {
          company_name: 1,
          companyCode: 1,
          companyOrg: 1,
          companyType: 1,
          tenantSlug: 1,
          tenantUrl: 1,
          customDomain: 1,
          companyEmail: 1,
          managerLevels: 1,
          mobileNo: 1,
          workNo: 1,
          webLink: 1,
          primaryThemeColor: 1,
          verified_email_allowed: 1,
          logo: 1,
          bio: 1,
          addressInfo: 1,
          createdBy: 1,
          activeUser: 1,
          is_active: 1,
          createdAt: 1,
          updatedAt: 1,
          adminCount: 1,
          activeAdminCount: 1,
          userCount: 1,
          activeUserCount: 1,
          departments: 1,
          admins: { $slice: ["$admins", 3] },
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    return {
      status: "success",
      data: companies,
      statusCode: statusCode.success,
      message: "Companies fetched successfully",
    };
  } catch (err: any) {
    return createCatchError(err);
  }
};

export const updateManagedCompanyStatus = async (data: {
  companyId: string;
  isActive: boolean;
  scope?: "company_admin" | "all_users";
}) => {
  try {
    const scope = data.scope === "all_users" ? "all_users" : "company_admin";
    const company = await Company.findOne({
      _id: data.companyId,
      deletedAt: { $exists: false },
      type: { $ne: "user" },
    });

    if (!company) {
      return {
        status: "error",
        data: "Company not found",
        statusCode: statusCode.info,
        message: "Company not found",
      };
    }

    company.is_active = Boolean(data.isActive);
    company.updatedAt = new Date();
    await company.save();

    let affectedUsersCount = 0;
    if (scope === "all_users") {
      const updateResult = await User.updateMany(
        {
          company: new mongoose.Types.ObjectId(data.companyId),
          deletedAt: { $exists: false },
        },
        {
          $set: {
            is_enabled: Boolean(data.isActive),
            updatedAt: new Date(),
          },
        }
      );
      affectedUsersCount = Number(updateResult.modifiedCount || 0);
    }

    const userLabel = affectedUsersCount === 1 ? "user" : "users";

    return {
      status: "success",
      data: {
        company: company.toObject(),
        scope,
        affectedUsersCount,
      },
      statusCode: statusCode.success,
      message:
        scope === "all_users"
          ? company.is_active
            ? `Company activated successfully. ${affectedUsersCount} ${userLabel} were activated for this company.`
            : `Company deactivated successfully. ${affectedUsersCount} ${userLabel} were deactivated for this company.`
          : company.is_active
            ? "Company admin access activated successfully. User account statuses were not changed."
            : "Company admin access deactivated successfully. User account statuses were not changed.",
    };
  } catch (err: any) {
    return createCatchError(err);
  }
};

export const softDeleteManagedCompany = async (companyId: string) => {
  try {
    const company = await Company.findOne({
      _id: companyId,
      deletedAt: { $exists: false },
      type: { $ne: "user" },
    });

    if (!company) {
      return {
        status: "error",
        data: "Company not found",
        statusCode: statusCode.info,
        message: "Company not found",
      };
    }

    if (company.companyType === "organisation") {
      return {
        status: "error",
        data: "Organisation records cannot be deleted",
        statusCode: statusCode.info,
        message: "Organisation records cannot be deleted",
      };
    }

    company.deletedAt = new Date();
    company.is_active = false;
    company.updatedAt = new Date();
    await company.save();

    return {
      status: "success",
      data: {
        _id: company._id,
        deletedAt: company.deletedAt,
      },
      statusCode: statusCode.success,
      message: "Company deleted successfully",
    };
  } catch (err: any) {
    return createCatchError(err);
  }
};

export const getHolidays = async (data: any) => {
  try {
   const policy =  await CompanyPolicy.findOne({_id : data.policy, company : data.company})
    if (policy) {
      return {
        status: "success",
        data: policy.holidays || [],
        message: "Successfully retrieved holidays",
        statusCode: statusCode.success,
      };
    } else {
      return {
        status: "error",
        message: "Policy not found",
        data: "Policy not found",
        statusCode: statusCode.info,
      };
    }
  } catch (err: any) {
    throw new Error(err);
  }
};

export const getWorkLocations = async (data: any) => {
  try {
    const policy: any = await CompanyPolicy.findOne({_id : data.policy, company : data.company});
    if (policy) {
      return {
        status: "success",
        data: policy.workLocations || [],
        message: "Successfully retrieved Locations",
        statusCode: statusCode.success,
      };
    } else {
      return {
        status: "error",
        message: "Policy not found",
        data: "Policy not found",
        statusCode: statusCode.info
      };
    }
  } catch (err: any) {
    throw new Error(err);
  }
};

export const updateWorkTiming = async (data: any) => {
  try {

    const policy: any = await CompanyPolicy.findOne({
      _id: data.policy,
      is_active: true,
    });

    // If the policy is not found, return a "policy not found" message
    if (!policy) {
      return {
        status: "error",
        message: "Policy not found",
        data: "Policy not found",
        statusCode: statusCode.info,
      };
    }

    if (data?.isAdd) {
      policy.workTiming.push({
        startTime: data.startTime,
        endTime: data.endTime,
        daysOfWeek: data.daysOfWeek
      });
      policy.markModified('workTiming')
      const savedPolicy = await policy.save();
      return {
        status: "success",
        data: savedPolicy.workTiming,
        message: "workTiming has been added successfully",
        statusCode: statusCode.success,
      };
    }

    if (data?.isEdit) {
      let filterIndex = policy.workTiming.findIndex(
        (item: any, index : number) => data.index === index
      );

      if (filterIndex !== -1) {
        // Only update the specific holiday found, keeping other fields intact
        policy.workTiming[filterIndex] = {
          ...policy.workTiming[filterIndex],
          startTime: data.startTime,
          endTime: data.endTime,
          daysOfWeek: data.daysOfWeek
        };

        policy.markModified('workTiming');

        const savedPolicy = await policy.save();
        return {
          status: "success",
          data: savedPolicy.workTiming,
          message: "WorkTiming has been updated successfully",
          statusCode: statusCode.success,
        };
      } else {
        return {
          status: "error",
          data: "No such WorkTiming exists",
          message: "No such WorkTiming exists",
          statusCode: statusCode.info,
        };
      }
    }
    if (data?.isDelete) {
      let filterIndex = policy.workTiming.findIndex(
        (_: any, index : number) => data.index === index
      );

      if (filterIndex !== -1) {
        // Remove the holiday at the found index
        policy.workTiming.splice(filterIndex, 1);
        policy.markModified('workTiming');
        const savedPolicy = await policy.save();

        return {
          status: "success",
          data: savedPolicy.workTiming,
          message: "workTiming has been deleted successfully",
          statusCode: statusCode.success,
        };
      } else {
        return {
          status: "error",
          data: "No such workTiming exists",
          message: "No such workTiming exists",
          statusCode: statusCode.info,
        };
      }
    }

    else {
      return {
        status: "error",
        data: "No such action exists",
        message: "No such action exists",
        statusCode: statusCode.success,
      };
    }
  } catch (err: any) {
    throw new Error(err);
  }
};

export const updateHolidayByExcel = async (data: any) => {
  try {
    const policy: any = await CompanyPolicy.findOne({
      company: new mongoose.Types.ObjectId(data.company),
    });
    if (policy) {
      const updatedHolidays: any = await CompanyPolicy.findByIdAndUpdate(
        policy._id,
        { holidays: data.holidays }
      );
      return {
        status: "success",
        data: updatedHolidays.holidays || [],
        message: "Successfully retrieved Timings",
        statusCode: statusCode.success,
      };
    } else {
      return {
        status: "error",
        message: "Policy not found",
        data: "Policy not found",
        statusCode: statusCode.info,
      };
    }
  } catch (err: any) {
    throw new Error(err);
  }
};

export const updateHolidays = async (data: any) => {
  try {
    // Find the active policy by its _id
    const policy: any = await CompanyPolicy.findOne({
      _id: data.policy,
      is_active: true,
    });

    // If the policy is not found, return a "policy not found" message
    if (!policy) {
      return {
        status: "error",
        message: "Policy not found",
        data: "Policy not found",
        statusCode: statusCode.info,
      };
    }

    // Add a new holiday to the policy's holidays array
    if (data?.isAdd) {
      policy.holidays.push({
        title: data.title,
        description: data.description,
        date: new Date(data.date),
        policy: policy._id,
        company: policy.company,
      });
      policy.markModified('holidays')
      const savedPolicy = await policy.save();
      return {
        status: "success",
        data: savedPolicy.holidays,
        message: "Holiday has been added successfully",
        statusCode: statusCode.success,
      };
    }

    // Edit an existing holiday based on the title
    if (data?.isEdit) {
      let filterIndex = policy.holidays.findIndex(
        (item: any) => data.oldTitle === item.title
      );

      if (filterIndex !== -1) {
        // Only update the specific holiday found, keeping other fields intact
        policy.holidays[filterIndex] = {
          ...policy.holidays[filterIndex],
          title: data.title,
          description: data.description,
          date: new Date(data.date)
        };

        policy.markModified('holidays');

        const savedPolicy = await policy.save();
        return {
          status: "success",
          data: savedPolicy.holidays,
          message: "Holiday has been updated successfully",
          statusCode: statusCode.success,
        };
      } else {
        return {
          status: "error",
          data: "No such holiday exists",
          message: "No such holiday exists",
          statusCode: statusCode.info,
        };
      }
    }

    // Delete an existing holiday based on the title
    if (data?.isDelete) {
      let filterIndex = policy.holidays.findIndex(
        (item: any) => data.title === item.title
      );

      if (filterIndex !== -1) {
        // Remove the holiday at the found index
        policy.holidays.splice(filterIndex, 1);
        policy.markModified('holidays');
        const savedPolicy = await policy.save();

        return {
          status: "success",
          data: savedPolicy.holidays,
          message: "Holiday has been deleted successfully",
          statusCode: statusCode.success,
        };
      } else {
        return {
          status: "error",
          data: "No such holiday exists",
          message: "No such holiday exists",
          statusCode: statusCode.info,
        };
      }
    }

    // If no valid action is provided, return an error
    return {
      status: "error",
      data: "No valid action provided",
      message: "No valid action provided",
      statusCode: statusCode.success,
    };
  } catch (err: any) {
    throw new Error(err);
  }
};

export const getWorkTiming = async (data: any) => {
  try {
      const policy =  await CompanyPolicy.findOne({_id : data.policy, company : data.company})
       if (policy) {
         return {
           status: "success",
           data: policy.workTiming || [],
           message: "Successfully retrieved workTiming",
           statusCode: statusCode.success,
         };
       } else {
         return {
           status: "error",
           message: "Policy not found",
           data: "Policy not found",
           statusCode: statusCode.info,
         };
       }
  } catch (err: any) {
    return createCatchError(err);
  }
};

export const updateWorkLocations = async (data: any) => {
  try {
    // Find the active policy by its _id
    const policy: any = await CompanyPolicy.findOne({
      _id: data.policy,
      is_active: true,
    });

    // If the policy is not found, return a "policy not found" message
    if (!policy) {
      return {
        status: "error",
        message: "Policy not found",
        data: "Policy not found",
        statusCode: statusCode.info,
      };
    }

    // Add a new holiday to the policy's holidays array
    if (data?.isAdd) {
      policy.workLocations.push({
        ipAddress: data.ipAddress,
        locationName: data.locationName
      });
      policy.markModified('workLocations')
      const savedPolicy = await policy.save();
      return {
        status: "success",
        data: savedPolicy.workLocations,
        message: "locations has been added successfully",
        statusCode: statusCode.success,
      };
    }

    if (data?.isEdit) {
      let filterIndex = policy.workLocations.findIndex(
        (item: any) => data.oldLocation === item.locationName
      );

      if (filterIndex !== -1) {
        // Only update the specific holiday found, keeping other fields intact
        policy.workLocations[filterIndex] = {
          ...policy.workLocations[filterIndex],
          ipAddress: data.ipAddress,
          locationName: data.locationName
        };

        policy.markModified('workLocations');

        const savedPolicy = await policy.save();
        return {
          status: "success",
          data: savedPolicy.workLocations,
          message: "locations has been updated successfully",
          statusCode: statusCode.success,
        };
      } else {
        return {
          status: "error",
          data: "No such workLocations exists",
          message: "No such workLocations exists",
          statusCode: statusCode.info,
        };
      }
    }

    // Delete an existing holiday based on the title
    if (data?.isDelete) {
      let filterIndex = policy.workLocations.findIndex(
        (item: any) => data.locationName === item.locationName
      );

      if (filterIndex !== -1) {
        // Remove the holiday at the found index
        policy.workLocations.splice(filterIndex, 1);
        policy.markModified('workLocations');
        const savedPolicy = await policy.save();

        return {
          status: "success",
          data: savedPolicy.workLocations,
          message: "location has been deleted successfully",
          statusCode: statusCode.success,
        };
      } else {
        return {
          status: "error",
          data: "No such location exists",
          message: "No such location exists",
          statusCode: statusCode.info,
        };
      }
    }

    // If no valid action is provided, return an error
    return {
      status: "error",
      data: "No valid action provided",
      message: "No valid action provided",
      statusCode: statusCode.success,
    };
  } catch (err: any) {
    throw new Error(err);
  }
};

export const uploadWorkLocationsByExcel = async (data: any) => {
  try {
    const policy: any = await CompanyPolicy.findOne({ company: data.company });

    if (!policy) {
      return {
        status: "success",
        message: "Policy not found",
        data: null,
        statusCode: statusCode.info,
      };
    }

    policy.workLocations = data?.workLocations;

    const savedPolicy = await policy.save();
    return {
      status: "success",
      data: savedPolicy.workLocations,
      message: "Locations updated successfully",
      statusCode: statusCode.success,
    };
  } catch (err: any) {
    throw new Error(err);
  }
};
