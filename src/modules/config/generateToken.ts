import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const generateToken = (payload: object): string => {
  const secretKey = process.env.SECRET_KEY ?? "@#$4515Rahulkushwa_675@#";
  const expiresIn: any = (process.env.EXPIRES_TOKEN as any) ?? "1d";
  return jwt.sign(payload, secretKey, { expiresIn });
};

export default generateToken;

export const generateResetPasswordToken = (userId: string) => {
  const secretKey = process.env.SECRET_KEY ?? "@#$4515Rahulkushwa_675@#";
  return jwt.sign({ userId }, secretKey, { expiresIn: "24h" }); // ✅ direct string
};

export const verifyResetPasswordToken = (token: string): string | null => {
  const secretKey = process.env.SECRET_KEY ?? "@#$4515Rahulkushwa_675@#";
  try {
    const decoded = jwt.verify(token, secretKey) as { userId: string };
    return decoded.userId;
  } catch {
    return null;
  }
};
