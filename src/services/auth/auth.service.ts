import { NextFunction, Request, Response } from "express";
import {
  adminRegistrationValidation,
  changePasswordValidation,
  forgotEmailValidation,
  learnerRegistrationValidation,
  loginValidation,
  otpRequestValidation,
  otpVerifyValidation,
  resetPasswordValidation,
} from "./utils/validation";
import { generateError } from "../../config/Error/functions";
import {
  changePassword,
  findUserByPhone,
  findUserByUserName,
  getRoleUsers,
  loginUser,
  registerAdmin,
  registerLearner,
  updateUserRole,
} from "../../repository/auth/auth.repository";
import SendMail from "../../config/sendMail/sendMail";
import { generateResetPasswordToken } from "../../config/helper/generateToken";
import { FORGOT_PASSWORD_EMAIL_TOKEN_TYPE } from "../../config/sendMail/utils";
import Token from "../../schemas/Token/Token";
import { baseURL } from "../../config/helper/urls";
import { setPasswordFromSetupToken } from "../adminUsers/adminUsers.service";
import {
  assertRegistrationOtpVerification,
  consumeRegistrationOtpVerification,
  getDummyOtpCode,
  isDevelopmentOtpMode,
  requestOtpChallenge,
  verifyOtpChallenge,
} from "./otp.service";

const loginUserService = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> => {
  try {
    const result = loginValidation.validate(req.body);
    if (result.error) {
      throw generateError(result.error.details, 422);
    }

    await verifyOtpChallenge({
      phone: result.value.phone,
      otp: result.value.otp,
      purpose: "login",
      token: result.value.token,
    });

    const { status, data, message } = await loginUser(result.value);
    if (status === "success") {
      res.status(200).send({
        message: message,
        data: data,
        statusCode: 200,
        success: true,
      });
    } else {
      next(data);
    }
  } catch (err) {
    next(err);
  }
};

const registerLearnerService = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> => {
  try {
    const result = learnerRegistrationValidation.validate(req.body);
    if (result.error) {
      throw generateError(
        result.error.details.map((detail) => detail.message).join(", "),
        422
      );
    }

    await assertRegistrationOtpVerification(result.value.verificationToken, result.value.phone);
    const data = await registerLearner(result.value);
    await consumeRegistrationOtpVerification(result.value.verificationToken);
    return res.status(201).send({
      message: "Learner account created successfully",
      data,
      statusCode: 201,
      success: true,
    });
  } catch (err) {
    next(err);
  }
};

const registerAdminService = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> => {
  try {
    const result = adminRegistrationValidation.validate(req.body);
    if (result.error) {
      throw generateError(
        result.error.details.map((detail) => detail.message).join(", "),
        422
      );
    }

    await assertRegistrationOtpVerification(result.value.verificationToken, result.value.phone);
    const data = await registerAdmin(result.value);
    await consumeRegistrationOtpVerification(result.value.verificationToken);
    return res.status(201).send({
      message: "Admin account created successfully",
      data,
      statusCode: 201,
      success: true,
    });
  } catch (err) {
    next(err);
  }
};

const requestOtpService = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> => {
  try {
    const result = otpRequestValidation.validate(req.body);
    if (result.error) {
      throw generateError(
        result.error.details.map((detail) => detail.message).join(", "),
        422
      );
    }

    const { phone, purpose } = result.value;
    const existingUser = await findUserByPhone(phone);

    if (purpose === "login" && !existingUser) {
      throw generateError("User does not exist.", 404);
    }

    if (purpose === "register" && existingUser) {
      throw generateError("User already exists.", 409);
    }

    const otpSession = await requestOtpChallenge({ phone, purpose });

    return res.status(200).send({
      message: "OTP sent successfully",
      data: {
        ...otpSession,
        ...(isDevelopmentOtpMode()
          ? { otpHint: `Use ${getDummyOtpCode()} for the current dummy flow.` }
          : {}),
      },
      success: true,
    });
  } catch (err) {
    next(err);
  }
};

const verifyOtpService = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> => {
  try {
    const result = otpVerifyValidation.validate(req.body);
    if (result.error) {
      throw generateError(
        result.error.details.map((detail) => detail.message).join(", "),
        422
      );
    }

    const { phone, otp, purpose } = result.value;

    if (purpose === "login") {
      const existingUser = await findUserByPhone(phone);
      if (!existingUser) {
        throw generateError("User does not exist.", 404);
      }
    }

    const verification = await verifyOtpChallenge({
      phone,
      otp,
      purpose,
      token: result.value.token,
    });

    if (purpose === "login") {
      const { status, data, message } = await loginUser({ phone });
      if (status !== "success") {
        throw data;
      }

      return res.status(200).send({
        message,
        data,
        success: true,
      });
    }

    return res.status(200).send({
      message: "OTP verified successfully",
      data: verification,
      success: true,
    });
  } catch (err) {
    next(err);
  }
};

const changePasswordService = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = changePasswordValidation.validate(req.body);

    if (result.error) {
      throw generateError(result.error.details, 422);
    }

    const { status, data } = await changePassword({
      ...req.body,
      user: req.userId,
    });

    if (status === "success") {
      res.status(200).send({
        message: "Password Change Successfully",
        data: "Password Change Successfully",
        success: true,
      });
    } else {
      throw generateError(data, 400);
    }
  } catch (err) {
    next(err);
  }
};

const forgotPasswordService = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = forgotEmailValidation.validate(req.body);
    if (result.error) {
      throw generateError(result.error.details, 422);
    }

    const user = await findUserByUserName({username : req.body.username})

    if(!user){
      throw generateError(`${req.body.username} email does not exist`, 400);
    }

    const resetData = new Token({
      userId: user.id,
      token: generateResetPasswordToken(user.id),
      type:FORGOT_PASSWORD_EMAIL_TOKEN_TYPE
    });

    const savedData = await resetData.save();
    if (!savedData) {
      throw generateError(`Cannot send the mail. Please try again later`, 400);
    }

    const mailData = {
      name : user?.name,
      message : "We received a request to reset your password. If you didn't initiate this request, please disregard this email for security.",
      link :  `${baseURL}/reset-password/${resetData.token}`,
      subject : 'Reset Your Password'
    };

      const sendMail: any = await SendMail(
      user.username,
      'Reset Your Password',
      'forgot_email_templates.html',
        mailData
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

const setPasswordService = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = resetPasswordValidation.validate(req.body);
    if (result.error) {
      throw generateError(result.error.details, 422);
    }

    const user = await setPasswordFromSetupToken(req.body.token, req.body.password);

    return res.status(200).send({
      message: "Password set successfully",
      data: user,
      success: true,
    });
  } catch (err) {
    next(err);
  }
};

export const updateUserRoleService = async(id : string, role : string) => {
  try
  {
    const {status, data} = await updateUserRole(id, role)
    return {
      status : status,
      data : data
    }
  }
  catch(err : any)
  {
    return {
      status : 'error',
      data : err?.message
    }
  }
}

const getRoleUsersService = async(company : any) => {
  try
  {
    const {statusCode, status, data} = await getRoleUsers(company)
    return {
      statusCode,
      status,
      data
    }
  }
  catch(err : any)
  {
    return {
      status : 'error',
      statusCode : 500,
      data : err?.message
    }
  }
}

const handleContactServiceMail = (req : any , res : Response) => {
  try
  {
     SendMail(process.env.WEBSITE_EMAIL!!,'User Information Submission Alert','contact/userInfo.html',{...req.body,reciever_mail : process.env.WEBSITE_EMAIL})
     SendMail(req.body.email,'Your Information Has Been Successfully Submitted','contact/customerMail.html',{...req.body})
     res.status(200).send({
        message : 'Mail Send Successfully',
        data : req.body,
        status : 'success'
      })
  }
  catch(err : any)
  {
    res.status(500).send({
      message : err?.message,
      data : err?.message,
      status : 'error'
    })
  }
}

export {
  registerLearnerService,
  registerAdminService,
  requestOtpService,
  verifyOtpService,
  loginUserService,
  changePasswordService,
  forgotPasswordService,
  setPasswordService,
  getRoleUsersService,
  handleContactServiceMail,
};
