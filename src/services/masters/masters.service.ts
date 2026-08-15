import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import MasterData from "../../schemas/masterData/masterData.schema";

export const createOrUpdateMasterData = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { masters, company } = req.body;
    const createdBy = req.userId;

    if (!masters || !company) {
      return res.status(400).send({
        status: "error",
        message: "masters and company are required",
      });
    }

    // Check if master data exists for the company
    let masterData = await MasterData.findOne({
      company: new mongoose.Types.ObjectId(company),
      isActive: true,
    });

    if (masterData) {
      // Update existing
      Object.assign(masterData, masters);
      masterData.createdBy = new mongoose.Types.ObjectId(createdBy);
      await masterData.save();
      return res.status(200).send({
        status: "success",
        message: "Master data updated successfully",
        data: masterData,
      });
    } else {
      // Create new
      const newMasterData = new MasterData({
        ...masters,
        company: new mongoose.Types.ObjectId(company),
        createdBy: new mongoose.Types.ObjectId(createdBy),
      });
      const savedData = await newMasterData.save();
      return res.status(200).send({
        status: "success",
        message: "Master data created successfully",
        data: savedData,
      });
    }
  } catch (err: any) {
    next(err);
  }
};

export const updateMasterCategory = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const category = req.params.category;
    const { items, company } = req.body;
    const createdBy = req.userId;

    if (!category || !items || !company) {
      return res.status(400).send({
        status: "error",
        message: "category, items, and company are required",
      });
    }

    const validCategories = ["documentTypes", "employmentTypes", "skills", "tdsSections", "coreDomains", "domainSkills"];
    if (!validCategories.includes(category)) {
      return res.status(400).send({
        status: "error",
        message: "Invalid master data category",
      });
    }

    let masterData = await MasterData.findOne({
      company: new mongoose.Types.ObjectId(company),
      isActive: true,
    });

    if (!masterData) {
      masterData = new MasterData({
        company: new mongoose.Types.ObjectId(company),
        createdBy: new mongoose.Types.ObjectId(createdBy),
        documentTypes: [],
        employmentTypes: [],
        coreDomains: [],
        skills: [],
        tdsSections: []
      });
    }

    masterData[category] = items;
    masterData.createdBy = new mongoose.Types.ObjectId(createdBy);
    
    await masterData.save();

    return res.status(200).send({
      status: "success",
      message: `${category} updated successfully`,
      data: masterData,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getMasterData = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const companyId = req.body.company as string;

    if (!companyId) {
      return res.status(400).send({
        status: "error",
        message: "companyId is required",
      });
    }

    const masterData = await MasterData.findOne({
      company: new mongoose.Types.ObjectId(companyId),
      isActive: true,
    });

    return res.status(200).send({
      status: "success",
      message: "Master data fetched successfully",
      data: masterData || {},
    });
  } catch (err: any) {
    next(err);
  }
};

export const deleteMasterData = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const companyId = req.query.companyId as string;

    if (!companyId) {
      return res.status(400).send({
        status: "error",
        message: "companyId is required",
      });
    }

    const deleted = await MasterData.findOneAndUpdate(
      { company: new mongoose.Types.ObjectId(companyId), isActive: true },
      { $set: { isActive: false, deletedAt: new Date() } },
      { new: true }
    );

    return res.status(200).send({
      status: "success",
      message: "Master data deleted successfully",
      data: deleted,
    });
  } catch (err: any) {
    next(err);
  }
};
