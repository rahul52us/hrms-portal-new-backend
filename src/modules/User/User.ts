import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import User from "../../schemas/User/User";
import { generateError } from "../config/function";
import dotenv, { populate } from "dotenv";
import {
  UserValidation,
  forgotEmailValidation,
  resetPasswordValidation,
} from "./utils/validation";
import generateToken, {
  generateResetPasswordToken,
} from "../config/generateToken";
import Company from "../../schemas/company/Company";
import Token from "../../schemas/Token/Token";
import ProfileDetails from "../../schemas/User/ProfileDetails";
import SendMail from "../config/sendMail/sendMail";
import {
  FORGOT_PASSWORD_EMAIL_TOKEN_TYPE,
  REGISTER_NEW_USER_TOKEN_TYPE,
} from "../config/sendMail/utils";
import { baseURL } from "../../config/helper/urls";
import {
  convertIdsToObjects,
  createCatchError,
} from "../../config/helper/function";
import { statusCode } from "../../config/helper/statusCode";
import { createToken } from "../../services/token/token.service";

dotenv.config();
const MeUser = async (req: any, res: Response): Promise<any> => {

  const [profile_details, companyDetails, linkedCompanyDocuments] = await Promise.all([
    ProfileDetails.findById(req.bodyData.profile_details),
    req.bodyData?.company ? Company.findById(req.bodyData.company) : null,
    Company.find({
      type: "user",
      userId: req.userId,
      deletedAt: { $exists: false },
    })
      .populate("companyOrg", "company_name companyCode primaryThemeColor sidebarColors is_active")
      .sort({ lastActiveAt: -1, createdAt: -1 })
      .lean(),
  ]);

  const memberships = linkedCompanyDocuments.map((membership: any) => {
    const company = membership.companyOrg;
    return {
      _id: membership._id,
      userId: membership.userId,
      companyId: company?._id || membership.companyOrg,
      company,
      role: "user",
      status: "active",
      joinedThrough: "course_enrollment",
      courseIds: membership.courseIds || [],
      lastActiveAt: membership.lastActiveAt,
      createdAt: membership.createdAt,
    };
  });
  const legacyCompanyId = String(req.bodyData?.company || "");
  const activeMembership =
    memberships.find((membership: any) => String(membership.companyId || "") === legacyCompanyId) ||
    memberships[0] ||
    null;
  const activeCompany = activeMembership?.company || companyDetails || null;
  const identity = { ...req.bodyData, profile_details, companyDetails };

  return res.status(200).send({
    message: `get successfully data`,
    data: {
      ...identity,
      user: identity,
      memberships,
      activeMembership,
      activeCompany,
      effectiveRole: activeMembership?.role || identity.userType || identity.role,
    },
    statusCode: 200,
    success: true,
  });
};

const createUser = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> => {
  try {
    const result = UserValidation.validate(req.body);
    if (result.error) {
      throw generateError(result.error.details, 422);
    }
    const existUser = await User.findOne({
      username: new RegExp(req.body.username, "i"),
    });
    if (existUser) {
      throw generateError(`${existUser.username} user already exists`, 400);
    }

    if (req.body.role !== "superadmin") {
      const selectedCompany = await Company.findOne({
        _id: req.body.company?.trim(),
        is_active: true,
      });
      if (!selectedCompany) {
        throw generateError(`Company does not exist`, 400);
      }

      const user = new User({
        username: req.body.username,
        name: req.body.name,
        mobileNumber: req.body.mobileNumber,
        password: req.body.password,
        company: selectedCompany._id,
        role: req.body.role,
        refrenceBy:req.body.refrenceBy || undefined,
        is_active: selectedCompany.verified_email_allowed ? false : true,
      });
      const savedUser = await user.save();
      if (!savedUser) {
        throw generateError(`Cannot create the user`, 400);
      }

      const profileDetail = new ProfileDetails({ user: savedUser._id });
      const createdProfileDetail = await profileDetail.save();

      savedUser.profile_details = createdProfileDetail._id;
      await savedUser.save();

      if (selectedCompany.verified_email_allowed) {
        const token = generateResetPasswordToken(savedUser._id);

        await createToken({
          userId: savedUser._id,
          token: token,
          type: REGISTER_NEW_USER_TOKEN_TYPE,
        });
        const sendMail: any = await SendMail(
          savedUser.name,
          savedUser.username,
          `${baseURL}/verify-account/${token}`,
          "Register New User",
          "Register_email_templates.html"
        );

        if (!sendMail.success) {
          await savedUser.deleteOne();
          await profileDetail.deleteOne();
          throw generateError(
            `Failed to send mail to ${req.body.username} please try again later`,
            400
          );
        }

        return res.status(200).send({
          data: `Check your email and verify your ${user.username} account`,
          statusCode: 200,
          success: true,
          message: `Check your email and verify your ${user.username} account`,
        });
      } else {
        const { password, ...userData } = savedUser.toObject();
        const responseUser = {
          ...userData,
          authorization_token: generateToken({ userId: savedUser._id }),
        };
        return res.status(200).send({
          data: responseUser,
          statusCode: 200,
          success: true,
          message: `${user.username} account has been created for the ${selectedCompany.company_name} company`,
        });
      }
    } else {
      const user = new User({
        username: req.body.username,
        role: req.body.role,
        is_active: false,
      });
      const createdUser = await user.save();
      if (!createdUser) {
        throw generateError(`Cannot create the user`, 400);
      }

      const token = generateResetPasswordToken(createdUser._id);
      const storeToken = new Token({
        userId: createdUser._id,
        token: token,
        type: REGISTER_NEW_USER_TOKEN_TYPE,
      });

      const savedToken = await storeToken.save();
      const sendMail: any = await SendMail(
        createdUser.username,
        createdUser.username,
        `${baseURL}/verify-account/${token}`,
        "Verify Your Account",
        "Register_email_templates.html"
      );

      if (!sendMail.success) {
        await createdUser.deleteOne();
        await savedToken.deleteOne();
        throw generateError(
          `Failed to send mail to ${req.body.username} please try again later`,
          400
        );
      }

      return res.status(201).send({
        message: `${createdUser.username} account has been created. Please verify your account.`,
        data: `${createdUser.username} account has been created. Please verify your account.`,
        statusCode: 201,
        success: true,
      });
    }
  } catch (err) {
    next(err);
  }
};

const VerifyEmailToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> => {
  try {
    const token = await Token.findOne({
      token: req.params.token,
    });
    if (token && token?.type === REGISTER_NEW_USER_TOKEN_TYPE) {
      const updatedData = await User.findByIdAndUpdate(
        token.userId,
        { $set: { is_active: true } },
        { new: true }
      );
      if (updatedData) {
        if (updatedData.role !== "superadmin") {
          await token.deleteOne();
        }
        res.status(200).send({
          message: `Account has been verified succesfully`,
          success: true,
          data: updatedData,
          statusCode: 200,
        });
      } else {
        throw generateError(`Invalid token or token has been expired`, 400);
      }
    } else {
      throw generateError(`Invalid token or token has been expired`, 400);
    }
  } catch (err) {
    next(err);
  }
};

const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = forgotEmailValidation.validate(req.body);
    if (result.error) {
      throw generateError(result.error.details, 422);
    }

    const user = await User.findOne({ username: req.body.username });
    if (!user) {
      throw generateError(`${req.body.username} email does not exist`, 400);
    }

    const resetData = new Token({
      userId: user.id,
      token: generateResetPasswordToken(user.id),
      type: FORGOT_PASSWORD_EMAIL_TOKEN_TYPE,
    });
    const savedData = await resetData.save();
    if (!savedData) {
      throw generateError(`Cannot send the mail. Please try again later`, 400);
    }

    const sendMail: any = await SendMail(
      user.name,
      user.username,
      `${process.env.RESET_PASSWORD_LINK}/${resetData.token}`,
      "Reset Your Password",
      "forgot_email_templates.html"
    );
    if (!sendMail.success) {
      await resetData.deleteOne();
      throw generateError(`Cannot send the mail. Please try again later`, 400);
    }

    res.status(200).send({
      message: `Link has been sent to ${req.body.username} email`,
      data: `Link has been sent to ${req.body.username} email`,
      statusCode: 200,
      success: true,
    });
  } catch (err: any) {
    next(err);
  }
};

const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = resetPasswordValidation.validate(req.body);
    if (result.error) {
      throw generateError(result.error.details, 422);
    }

    const token: any = await Token.findOne({ token: req.body.token });
    if (!token && token?.type !== FORGOT_PASSWORD_EMAIL_TOKEN_TYPE) {
      throw generateError(`Invalid token or token has expired`, 400);
    }

    const user = await User.findByIdAndUpdate(token.userId, {
      $set: { password: req.body.password },
    });

    if (!user) {
      throw generateError(`Invalid token or token has expired`, 400);
    }

    await token.deleteOne();
    await SendMail(
      user.name,
      user.username,
      `${baseURL}`,
      "Password Changed Successfully!",
      "reset_email_templates.html"
    );

    res.status(200).send({
      message: `Password has been changed successfully`,
      data: `Password has been changed successfully`,
      statusCode: 200,
      success: true,
    });
  } catch (err: any) {
    next(err);
  }
};

// get company of the companys

const getUsersByCompany = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
      const { searchValue, type, companyId, role } = req.query;

    try {
      const matchConditions: any = {};
      const requesterRole = String(req.bodyData?.role || req.bodyData?.userType || "").toLowerCase();

      if (searchValue) {
        matchConditions.$or = [
          { name: { $regex: searchValue, $options: "i" } },
          { email: { $regex: searchValue, $options: "i" } },
          { username: { $regex: searchValue, $options: "i" } },
          { code: { $regex: searchValue, $options: "i" } },
          { department: { $regex: searchValue, $options: "i" } },
        ];
      }

      if (type) {
        matchConditions.userType = type;
      }

      if (role) {
        matchConditions.role = String(role).toLowerCase();
      }

      const effectiveCompanyId =
        requesterRole === "superadmin" && companyId
          ? String(companyId)
          : String(req.bodyData.company || "");

      if (effectiveCompanyId && mongoose.Types.ObjectId.isValid(effectiveCompanyId)) {
        matchConditions.company = new mongoose.Types.ObjectId(effectiveCompanyId);
      }

      matchConditions.deletedAt = { $exists: false };

      if (requesterRole === "admin" && !role) {
        matchConditions.role = { $nin: ["admin", "superadmin"] };
      } else if (requesterRole === "admin" && ["admin", "superadmin"].includes(String(role).toLowerCase())) {
        matchConditions.role = { $nin: ["admin", "superadmin"] };
      }

      const users = await User.aggregate([
        { $match: matchConditions },
        {
          $lookup: {
            from: "companies",
            localField: "company",
            foreignField: "_id",
            as: "company",
          },
        },
        {
          $unwind: {
            path: "$company",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "createdBy",
            foreignField: "_id",
            as: "createdBy",
          },
        },
        {
          $unwind: {
            path: "$createdBy",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            _id: 1,
            name: 1,
            email: { $ifNull: ["$email", "$username"] },
            username: 1,
            code: 1,
            role: 1,
            userType: 1,
            department: 1,
            company: {
              _id: "$company._id",
              name: "$company.company_name",
              company_name: "$company.company_name",
            },
            createdBy: {
              _id: "$createdBy._id",
              name: "$createdBy.name",
              email: { $ifNull: ["$createdBy.email", "$createdBy.username"] },
              username: "$createdBy.username",
            },
          },
        },
      ]);

      res.status(statusCode.success).send({
        message: "Fetch Users Successfully",
        data: users,
        status: "success",
      });
    } catch (err) {
      return createCatchError(err);
    }
  } catch (err) {
    next(err);
  }
};

const updateUserProfile = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userDataToUpdate = {
      name: req.body.firstName + " " + req.body.lastName,
      username: req.body.username,
      pic: req.body.pic,
      bio: req.body.bio,
    };

    const updatedUser = await User.findByIdAndUpdate(
      req.userId,
      userDataToUpdate,
      { new: true }
    )
      .populate("profile_details")
      .session(session);

    if (!updatedUser) {
      throw generateError("User does not exist", 400);
    }

    const profileDetailsId = updatedUser.profile_details;
    const profileDetailsDataToUpdate = {
      addressInfo: req.body.addressInfo,
      motherName: req.body.motherName,
      fatherName: req.body.fatherName,
      sibling: req.body.sibling,
      nickName: req.body.nickName,
      phoneNo: req.body.phoneNo,
      mobileNo: req.body.mobileNo,
      emergencyNo: req.body.emergencyNo,
    };

    const updatedProfileDetails = await ProfileDetails.findByIdAndUpdate(
      profileDetailsId,
      profileDetailsDataToUpdate,
      { new: true }
    ).session(session);

    if (!updatedProfileDetails) {
      throw generateError("Profile details not found", 400);
    }

    await session.commitTransaction();
    session.endSession();

    res.status(200).send({
      message: "User and profile details updated successfully",
      data: {
        ...updatedUser.toObject(),
        profile_details: updatedProfileDetails.toObject(),
      },
      statusCode: 200,
      status: "success",
    });
  } catch (error: any) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
};

export {
  createUser,
  MeUser,
  forgotPassword,
  resetPassword,
  updateUserProfile,
  VerifyEmailToken,
  getUsersByCompany,
};
