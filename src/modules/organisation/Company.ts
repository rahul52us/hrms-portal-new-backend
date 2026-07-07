import { Response, NextFunction } from "express";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import ProfileDetails from "../../schemas/User/ProfileDetails";
import QualificationDetails from "../../schemas/User/Qualifications";
import { createValidation } from "./utils/validation";
import { generateError } from "../config/function";
import generateToken from "../config/generateToken";
import Token from "../../schemas/Token/Token";
import WorkExperience from "../../schemas/User/WorkExperience";
import BankDetails from "../../schemas/User/BankDetails";
import DocumentDetails from "../../schemas/User/Document";
import CompanyPolicy from "../../schemas/company/CompanyPolicy";
import FamilyDetails from "../../schemas/User/FamilyDetails";
import { deleteFile, uploadFile } from "../../repository/uploadDoc.repository";
import { statusCode } from "../../config/helper/statusCode";
import mongoose from "mongoose";
import companyDetails from "../../schemas/company/companyDetails";
import { createManagedCompanyValidation } from "../../services/company/utils/validations";

const DEFAULT_THEME_COLOR = "#2563EB";

const normalizeTenantSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

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

const createCompany = async (req: any, res: Response, next: NextFunction): Promise<any> => {
  try {
    const result = createValidation.validate(req.body);
    if (result.error) {
      throw generateError(result.error.details, 422);
    }

    const token = await Token.findOne({ token: req.query.token });
    if (!token) {
      throw generateError("Invalid token or token has expired", 400);
    }

    const user = await User.findById(token.userId);
    if (!user || user?.role !== "superadmin") {
      throw generateError("Invalid token or token has expired", 400);
    }

    const existsComp = await Company.findOne({
      company_name: new RegExp(
        req.body.companyDetails?.company_name?.trim(),
        "i"
      ),
    });
    if (existsComp) {
      throw generateError(
        `${existsComp.company_name} company already exists`,
        400
      );
    }

    const existingCompanyCode = await Company.findOne({
      company_name: new RegExp(
        req.body.companyDetails?.companyCode?.trim(),
        "i"
      ),
    });
    if (existingCompanyCode) {
      throw generateError(
        `${existingCompanyCode?.companyCode} code is alredy existing with ${existingCompanyCode.company_name} company`,
        400
      );
    }


    const comp: any = new Company({
      company_name: req.body.companyDetails?.company_name?.trim(),
      companyType: "organisation",
      companyCode: req.body.companyDetails?.companyCode,
      primaryThemeColor: normalizeThemeColor(req.body.companyDetails?.primaryThemeColor),
      is_active: true,
      activeUser: token.userId,
      createdBy: token.userId,
      ...req.body.companyDetails,
    });

    const createdComp: any = await comp.save();

    const compPolicy = new CompanyPolicy({
      company: createdComp._id,
      createdBy: user._id,
    });

    const createdCompPolicy: any = await compPolicy.save();

    createdComp.policy = createdCompPolicy._id;
    createdComp.companyOrg = createdComp._id;
    await createdComp.save();

    const profileDetail = new ProfileDetails({
      user: user._id,
    });
    const createdProfileDetails = await profileDetail.save();

    const BankDetail = new BankDetails({
      user: user._id,
    });
    const savedBank = await BankDetail.save();

    const WorkExperienceDetail = new WorkExperience({
      user: user._id,
    });

    const savedWorkExperience = await WorkExperienceDetail.save();

    const documentDetails = new DocumentDetails({
      user: user._id,
    });

    const savedDocument = await documentDetails.save();

    const familyDetails = new FamilyDetails({
      user: user._id,
    });

    const savedFamilyDetails = await familyDetails.save();



    const qualifications = new QualificationDetails({
      user: user._id,
    });

    const savedQualifications = await qualifications.save()

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      {
        $set: {
          name: req.body.name,
          code: req.body.code,
          profile_details: createdProfileDetails._id,
          companyOrg: createdComp._id,
          password: req.body.password,
        },
      },
      { new: true }
    )
      .populate("profile_details")
      .populate("companyDetail");

    if (!updatedUser) {
      throw generateError("Something went wrong, contact administration", 400);
    }

    await token.deleteOne();

    if (req.body.companyDetails.logo && req.body.companyDetails.logo !== "") {
      try {
        let url = await uploadFile(req.body.companyDetails.logo);
        comp.logo = {
          name: req.body.companyDetails.logo.filename,
          url: url,
          type: req.body.companyDetails.logo.type,
        };
        await comp.save();
      }
      catch { }
    }

    const { password, ...rest } = updatedUser.toObject();
    return res.status(201).send({
      message: `${comp.company_name} company has been created successfully`,
      data: {
        ...rest,
        bankDetails: savedBank._id,
        documentDetails: savedDocument._id,
        workExperience: savedWorkExperience._id,
        companyPolicy: createdCompPolicy._id,
        familyDetails: savedFamilyDetails._id,
        qualifications: savedQualifications?._id,
        authorization_token: generateToken({ userId: updatedUser._id }),
      },
      statusCode: 201,
      success: true,
    });
  } catch (err: any) {
    next(err);
  }
};

const createOrganisationCompany = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.userId;
    const companyOrg = req.bodyData.companyOrg;
    let user: any = null;

    // Check the Company
    const checkExistsCompany = await Company.findOne({ company_name: { $regex: new RegExp(req.body.companyDetails?.company_name?.trim(), 'i') } })
    if (checkExistsCompany) {
      return res.status(statusCode.info).send({
        status: "error",
        data: `${checkExistsCompany.company_name} Company is already exists`,
        message: `${checkExistsCompany.company_name} Company is already exists`,
      });
    }

    const codeCompany = await Company.findOne({ companyCode: { $regex: new RegExp(req.body.companyDetails?.companyCode?.trim(), 'i') } });
    if (codeCompany) {
      return res.status(statusCode.info).send({
        status: "error",
        data: `${codeCompany.companyCode} Code is already exists with ${codeCompany.company_name}`,
        message: `${codeCompany.companyCode} Code is already exists with ${codeCompany.company_name}`,
      });
    }

    // Check the User
    user = await User.findOne({ username: { $regex: new RegExp(req.body.username?.trim(), 'i') } });
    if (user) {
      return res.status(statusCode.info).send({
        status: "error",
        data: `${user.username} user is already exists`,
        message: `${user.username} user is already exists`,
      });
    } else {
      const codeUser = await User.findOne({ code: req.body.code?.trim() });
      if (codeUser) {
        return res.status(statusCode.info).send({
          status: "error",
          data: `${codeUser.code} Code is already exists with ${user.username}`,
          message: `${codeUser.code} Code is already exists with ${user.username}`,
        });
      }
      else {
        const userData = new User({
          name: req.body.name,
          username: req.body.username,
          password: req.body.password,
          code: req.body.code,
          role: "admin",
        });
        user = await userData.save();
      }
    }

    // Create the Company
    const comp: any = new Company({
      company_name: req.body.companyDetails?.company_name?.trim(),
      companyType: "company",
      primaryThemeColor: normalizeThemeColor(req.body.companyDetails?.primaryThemeColor),
      is_active: true,
      ...req.body.companyDetails,
      companyOrg: companyOrg,
      activeUser: user._id,
      createdBy: userId,
    });

    const createdComp: any = await comp.save();

    const compPolicy = new CompanyPolicy({
      company: createdComp._id,
      createdBy: userId,
    });

    const createdCompPolicy: any = await compPolicy.save();

    createdComp.policy = createdCompPolicy._id;
    await createdComp.save();

    if (req.body.companyDetails.logo && req.body.companyDetails.logo !== "") {
      try {
        let url = await uploadFile(req.body.companyDetails.logo);
        comp.logo = {
          name: req.body.companyDetails.logo.filename,
          url: url,
          type: req.body.companyDetails.logo.type,
        };
        await comp.save();
      } catch { }
    }

    const profileDetail = new ProfileDetails({
      user: user._id,
    });
    const createdProfileDetails = await profileDetail.save();

    const BankDetail = new BankDetails({
      user: user._id,
    });
    await BankDetail.save();

    const WorkExperienceDetail = new WorkExperience({
      user: user._id,
    });

    await WorkExperienceDetail.save();

    const documentDetails = new DocumentDetails({
      user: user._id,
    });

    await documentDetails.save();

    const familyDetails = new FamilyDetails({
      user: user._id,
    });

    await familyDetails.save();

    const qualifications = new QualificationDetails({
      user: user._id,
    });

    await qualifications.save()



    await User.findByIdAndUpdate(
      user._id,
      {
        $set: {
          profile_details: createdProfileDetails._id,
          companyOrg: companyOrg,
          password: req.body.password,
        },
      },
      { new: true }
    )
      .populate("profile_details")
      .populate("companyDetail");

    res.status(statusCode.success).send({
      status: "success",
      data: `${createdComp.company_name} company has been created successfully`,
      message: `${createdComp.company_name} company has been created successfully`,
    });
  } catch (err: any) {
    return res.status(statusCode.serverError).send({
      status: "error",
      message: err?.message,
      data: err?.message,
    });
  }
};

const updateOrganisationCompany = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { error, value } = createManagedCompanyValidation.validate(req.body.companyDetails, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      throw generateError(error.details, 422);
    }

    const _id = new mongoose.Types.ObjectId(req.params.id);
    const comp = await Company.findOne({
      _id: _id,
      deletedAt: { $exists: false },
    });
    if (comp) {
      const companyName = value.company_name.trim();
      const companyCode = value.companyCode.trim().toUpperCase();
      const tenantSlug = normalizeTenantSlug(value.tenantSlug || companyName);
      const customDomain = normalizeDomain(value.customDomain);
      const primaryThemeColor = normalizeThemeColor(value.primaryThemeColor);

      const [existingCompany, existingCode, existingTenant, existingDomain] =
        await Promise.all([
          Company.findOne({
            _id: { $ne: _id },
            company_name: { $regex: new RegExp(`^${companyName}$`, "i") },
          }),
          Company.findOne({
            _id: { $ne: _id },
            companyCode: { $regex: new RegExp(`^${companyCode}$`, "i") },
          }),
          Company.findOne({
            _id: { $ne: _id },
            tenantSlug: { $regex: new RegExp(`^${tenantSlug}$`, "i") },
          }),
          customDomain
            ? Company.findOne({
                _id: { $ne: _id },
                customDomain: { $regex: new RegExp(`^${customDomain}$`, "i") },
              })
            : Promise.resolve(null),
        ]);

      if (existingCompany) {
        throw generateError(`${existingCompany.company_name} company already exists`, 400);
      }

      if (existingCode) {
        throw generateError(
          `${existingCode.companyCode} code is already mapped to ${existingCode.company_name}`,
          400
        );
      }

      if (existingTenant) {
        throw generateError(`${tenantSlug} tenant slug is already in use`, 400);
      }

      if (existingDomain) {
        throw generateError(`${customDomain} custom domain is already in use`, 400);
      }

      const updatePayload: any = {
        ...value,
        company_name: companyName,
        companyCode,
        tenantSlug,
        tenantUrl: buildTenantUrl(tenantSlug, customDomain),
        customDomain: customDomain || undefined,
        primaryThemeColor,
        logo: value.logo,
        updatedAt: new Date(),
      };

      const updatedCompany: any = await Company.findByIdAndUpdate(
        _id,
        { $set: updatePayload },
        { new: true }
      );

      for (const file of req.body.companyDetails.deletedFiles || []) {
        await deleteFile(file);
      }

      if (req.body.companyDetails.logo && req.body.companyDetails.logo !== "" && req.body.companyDetails.isLogoEdit) {
        try {
          let url = await uploadFile(req.body.companyDetails.logo);
          updatedCompany.logo = {
            name: req.body.companyDetails.logo.filename,
            url: url,
            type: req.body.companyDetails.logo.type,
          };
          await updatedCompany.save();
        }
        catch { }
      } else if (req.body.companyDetails.logo === null) {
        updatedCompany.logo = undefined;
        await updatedCompany.save();
      }

      res.status(statusCode.success).send({
        message: "Company has been updated successfully",
        data: updatedCompany,
        status: "success",
      });
    } else {
      res.status(statusCode.info).send({
        message: "Record does not exists",
        data: "Record does not exists",
        status: "error",
      });
    }
  } catch (err: any) {
    return res.status(statusCode.serverError).send({
      status: "error",
      message: err?.message,
      data: err?.message,
    });
  }
};

const filterCompany = async (req: any, res: Response, next: NextFunction) => {
  try {
    const result = await Company.findOne({
      company_name: req.query?.company?.trim(),
    });
    if (result) {
      throw generateError(`${req.query.company} company is not allowed`, 400);
    }
    res.status(200).send({
      message: `${req.query.company} company is allowed`,
      data: `${req.query.company} company is allowed`,
      statusCode: 200,
      success: true,
    });
  } catch (err) {
    next(err);
  }
};

export {
  createCompany,
  filterCompany,
  createOrganisationCompany,
  updateOrganisationCompany,
};

// Update CompanyDetails

export const updatedCompanyDetails = async (req: any, res: Response, next: NextFunction) => {
  try {
    let dt = await companyDetails.findOneAndUpdate({ company: req.body.company }, { $set: { ...req.body } })
    res.status(200).send({
      message: `Details has been updated`,
      data: `Details has been updated`,
      statusCode: 200,
      success: true
    });
  }
  catch (err: any) {
    next(err)
  }
}

export const updateCompanyPreferences = async (req: any, res: Response, next: NextFunction) => {
  try {
    const updateData: any = {};
    if (req.body.operatingHours) updateData.operatingHours = req.body.operatingHours;
    if (req.body.sidebarColors) updateData.sidebarColors = req.body.sidebarColors;

    const dt = await Company.findOneAndUpdate(
      { _id: req.body.company },
      { $set: updateData },
      { new: true }
    );

    res.status(200).send({
      message: "Preferences updated",
      data: dt,
      statusCode: 200,
      success: true
    });
  }
  catch (err) {
    next(err);
  }
};



export const getCompanyDetails = async (req: any, res: Response, next: NextFunction) => {
  try {
    let dt = await companyDetails.findOne({ company: req.params.company })
    res.status(200).send({
      message: `Details has been updated`,
      data: dt,
      statusCode: 200,
      success: true
    });
  }
  catch (err: any) {
    next(err)
  }
}
