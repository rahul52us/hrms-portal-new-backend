import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import {
  createManagedCompany,
  getCompanyCount,
  getCompanyDetailsByName,
  getManagedCompanies,
  getCompanyPolicies,
  getHolidays,
  getIndividualPolicy,
  getOrganisationCompanies,
  getWorkLocations,
  getWorkTiming,
  softDeleteManagedCompany,
  updateManagedCompanyStatus,
  updateCompanyPolicy,
  updatedCompanyDetails,
  updateHolidayByExcel,
  updateHolidays,
  updateWorkLocations,
  updateWorkTiming,
  uploadWorkLocationsByExcel,
} from "../../repository/company/company.respository";
import { generateError } from "../../config/Error/functions";
import ExcelJS from "exceljs";
import { createManagedCompanyValidation } from "./utils/validations";

const ensureSuperAdmin = (req: any) => {
  const role = String(req.bodyData?.role || req.bodyData?.userType || "").toLowerCase();
  if (role !== "superadmin") {
    throw generateError("Only superadmin can manage companies", 403);
  }
};

export const createManagedCompanyService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureSuperAdmin(req);

    const { error, value } = createManagedCompanyValidation.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      throw generateError(
        error.details.map((detail) => detail.message).join(", "),
        422
      );
    }

    const companyOrg = req.bodyData?.companyOrg || req.bodyData?.company;
    const { status, data, statusCode, message } = await createManagedCompany({
      ...value,
      companyOrg,
      createdBy: req.userId,
      activeUser: req.userId,
    });

    return res.status(statusCode).send({
      status,
      data,
      message,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getManagedCompaniesService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureSuperAdmin(req);

    const { status, data, statusCode, message } = await getManagedCompanies({
      isSuperAdmin: true,
      companyOrg: req.bodyData?.companyOrg || req.bodyData?.company,
      search: req.query.search,
    });

    return res.status(statusCode).send({
      status,
      data,
      message,
    });
  } catch (err: any) {
    next(err);
  }
};


export const updateCompanyService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { message, data, status, statusCode } = await updatedCompanyDetails({
      ...req.body,
      company: new mongoose.Types.ObjectId(req.query.company)
    });
    return res.status(statusCode).send({
      message,
      data,
      status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const updateManagedCompanyStatusService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureSuperAdmin(req);
    const scope = req.body?.scope === "all_users" ? "all_users" : "company_admin";

    if (typeof req.body?.isActive !== "boolean") {
      throw generateError("isActive must be provided as a boolean", 422);
    }

    if (req.body?.scope && !["company_admin", "all_users"].includes(req.body.scope)) {
      throw generateError("scope must be either company_admin or all_users", 422);
    }

    const { message, data, status, statusCode } = await updateManagedCompanyStatus({
      companyId: req.params.id,
      isActive: req.body.isActive,
      scope,
    });

    return res.status(statusCode).send({
      message,
      data,
      status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const deleteManagedCompanyService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureSuperAdmin(req);

    const { message, data, status, statusCode } = await softDeleteManagedCompany(req.params.id);

    return res.status(statusCode).send({
      message,
      data,
      status,
    });
  } catch (err: any) {
    next(err);
  }
};


export const getCompanyPoliciesService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { message, data, status, statusCode } = await getCompanyPolicies({
      company: new mongoose.Types.ObjectId(req.query.company),
    });
    return res.status(statusCode).send({
      message,
      data,
      status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const updateCompanyPolicyService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, statusCode, message, data } = await updateCompanyPolicy({
      ...req.body,
      policy: new mongoose.Types.ObjectId(req.body.policy),
      company: new mongoose.Types.ObjectId(req.body.company),
    });
    return res.status(statusCode).send({
      message,
      data,
      status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getIndividualPolicyService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, statusCode, data, message } = await getIndividualPolicy({
      policy: new mongoose.Types.ObjectId(req.query.policy),
      company: new mongoose.Types.ObjectId(req.query.company),
    });
    res.status(statusCode).send({
      message,
      data,
      status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getCompanyCountService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    req.body.companyOrg = req.bodyData.companyOrg;
    const { status, statusCode, data, message } = await getCompanyCount(
      req.body
    );
    res.status(statusCode).send({
      message,
      data,
      status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getOrganisationsCompanyService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    req.body.companyOrg = req.bodyData.companyOrg;
    const { status, statusCode, data, message } =
      await getOrganisationCompanies(req.body);
    res.status(statusCode).send({
      message,
      data,
      status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getCompanyDetailsByNameService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, data, statusCode } = await getCompanyDetailsByName({
      company: req.query.company,
    });
    if (status === "success") {
      return res.status(200).send({
        message: "Company details retrieved successfully",
        data: data,
        status: "success",
      });
    } else {
      throw generateError(data, statusCode);
    }
  } catch (err: any) {
    next(err);
  }
};

export const getHolidayService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, data, statusCode, message } = await getHolidays({
      company: new mongoose.Types.ObjectId(req.query.company),
      policy: new mongoose.Types.ObjectId(req.query.policy),
    });
    return res.status(statusCode).send({
      message: message,
      data: data,
      status: status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getWorkLocationservice = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, data, statusCode, message } = await getWorkLocations({
      company: new mongoose.Types.ObjectId(req.query.company),
      policy: new mongoose.Types.ObjectId(req.query.policy),
    });
    return res.status(statusCode).send({
      message: message,
      data: data,
      status: status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getWorkTimingService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, data, statusCode, message }: any = await getWorkTiming({
      company: new mongoose.Types.ObjectId(req.query.company),
      policy: new mongoose.Types.ObjectId(req.query.policy),
    });
    return res.status(statusCode).send({
      message: message,
      data: data,
      status: status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const updateHolidayService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, data, statusCode, message } = await updateHolidays({
      ...req.body,
      company: new mongoose.Types.ObjectId(req.body.company),
      policy: new mongoose.Types.ObjectId(req.body.policy),
    });
    return res.status(statusCode).send({
      message: message,
      data: data,
      status: status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const updateHolidayExcelService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const base64String = req.body.file;
    const buffer = Buffer.from(base64String, "base64");

    const workbook: any = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet(1);
    let datas: any = [];

    worksheet.eachRow((row: any, rowNumber: number) => {
      if (rowNumber > 1) {
        let rowData: any = {};
        row.eachCell((cell: any, colNumber: number) => {
          if (colNumber === 1) rowData.date = cell.value;
          if (colNumber === 2) rowData.title = cell.value;
          if (colNumber === 3) rowData.description = cell.value;
        });
        datas.push(rowData);
      }
    });

    const { status, data, statusCode, message } = await updateHolidayByExcel({
      holidays: datas,
      company: new mongoose.Types.ObjectId(req.body.company),
    });
    return res.status(statusCode).send({
      message: message,
      data: data,
      status: status,
    });
  } catch (error) {
    next(error);
  }
};

export const updateWorkTimingService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, data, statusCode, message } = await updateWorkTiming({
      ...req.body,
      company: new mongoose.Types.ObjectId(req.body.company),
      policy: new mongoose.Types.ObjectId(req.body.policy),
    });
    return res.status(statusCode).send({
      message: message,
      data: data,
      status: status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const updateWorkLocationService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { status, data, statusCode, message } = await updateWorkLocations({
      ...req.body,
      policy: new mongoose.Types.ObjectId(req.body.policy),
      company: new mongoose.Types.ObjectId(req.body.company),
    });
    return res.status(statusCode).send({
      message: message,
      data: data,
      status: status,
    });
  } catch (err: any) {
    next(err);
  }
};

export const updateWorkLocationExcelService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const base64String = req.body.file;
    const buffer = Buffer.from(base64String, "base64");

    const workbook: any = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet(1);
    let datas: any = [];

    worksheet.eachRow((row: any, rowNumber: number) => {
      if (rowNumber > 1) {
        let rowData: any = {};
        row.eachCell((cell: any, colNumber: number) => {
          if (colNumber === 1) rowData.ipAddress = cell.value;
          if (colNumber === 2) rowData.locationName = cell.value;
        });
        datas.push(rowData);
      }
    });

    const { status, data, statusCode, message } =
      await uploadWorkLocationsByExcel({
        workLocations: datas,
        company: new mongoose.Types.ObjectId(req.body.company),
      });
    return res.status(statusCode).send({
      message: message,
      data: data,
      status: status,
    });
  } catch (err: any) {
    console.log(err?.message);
    next(err);
  }
};
