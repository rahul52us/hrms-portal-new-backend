import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import User from "../../schemas/User/User";
import Company from "../../schemas/company/Company";
import { generateError, handleErrorMessage } from "./function";
import { attachEffectivePermissions } from "../../services/permissions/permission.utils";
import { ensureUserAccountEnabled } from "../../services/company/utils/activityGuards";

dotenv.config();

const authenticate = async (req: any, res: Response, next: NextFunction) => {
  try {

    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      throw generateError("Unauthorized User", 401);
    }

    const secretKey = process.env.SECRET_KEY ?? "@#$4515Rahulkushwa_675@#";
    const decoded = jwt.verify(token, secretKey) as { userId: string };
    if (!decoded) {
      throw generateError("Unauthorized User", 401);
    }

    const user = await User.findById(decoded.userId).lean();
    if (!user) {
      throw generateError("Unauthorized User", 401);
    }
    ensureUserAccountEnabled(user);
    const company =
      user.company
        ? await Company.findById(user.company)
            .select("company_name companyCode managerLevels primaryThemeColor sidebarColors departments rolePermissions")
            .lean()
        : null;
    const userWithPermissions = attachEffectivePermissions({
      user,
      company,
    });
    const { password, ...userData } = userWithPermissions;

    req.userId = decoded.userId;
    req.user = userData;
    req.bodyData = userData;
    next();
  } catch (err: any) {
    const error = generateError(`Authentication Error: ${err.message}`, 401);
    const errorMessage = await handleErrorMessage(
      error.message,
      error.data,
      error.statusCode,
      false
    );
    return res.status(error.statusCode).json(errorMessage);
  }
};

export default authenticate;


