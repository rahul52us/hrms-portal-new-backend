import * as crypto from "crypto";
import Token from "../../schemas/Token/Token";
import { generateError } from "../../config/Error/functions";

export type OtpPurpose = "login" | "register";

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

const IS_DEVELOPMENT = String(process.env.NODE_ENV || "").trim().toLowerCase() !== "production";
const USE_DUMMY_OTP = parseBooleanEnv(process.env.USE_DUMMY_OTP, IS_DEVELOPMENT);
const DEVELOPMENT_OTP = "123456";
const CONFIGURED_DUMMY_OTP = String(process.env.DUMMY_OTP || "").trim();
const OTP_TTL_MS = 5 * 60 * 1000;
const REGISTRATION_VERIFICATION_TTL_MS = 30 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const OTP_TOKEN_TYPES: Record<OtpPurpose, string> = {
  login: "otp_login",
  register: "otp_register",
};

function normalizePhone(value: string) {
  return String(value || "").trim();
}

function resolveOtpValue() {
  return CONFIGURED_DUMMY_OTP || DEVELOPMENT_OTP;
}

function getOtpHashSecret() {
  return (
    String(process.env.OTP_HASH_SECRET || "").trim() ||
    String(process.env.SECRET_KEY || "").trim() ||
    "@#$4515Rahulkushwa_675@#"
  );
}

function hashOtp(otp: string) {
  return crypto
    .createHmac("sha256", getOtpHashSecret())
    .update(String(otp || "").trim())
    .digest("hex");
}

function verifyOtpHash(otp: string, expectedHash: string) {
  const normalizedExpectedHash = String(expectedHash || "").trim();
  if (!normalizedExpectedHash) {
    return false;
  }

  const computedHash = hashOtp(otp);
  return crypto.timingSafeEqual(
    Buffer.from(computedHash, "utf8"),
    Buffer.from(normalizedExpectedHash, "utf8")
  );
}

async function markOtpTokensInactive(filter: Record<string, any>) {
  await Token.updateMany(filter, {
    $set: {
      isActive: false,
      is_active: false,
    },
  });
}

async function findActiveOtpToken(options: {
  phone: string;
  purpose: OtpPurpose;
  token?: string;
  requireVerified?: boolean;
}) {
  const query: Record<string, any> = {
    type: OTP_TOKEN_TYPES[options.purpose],
    isActive: true,
    expiresAt: { $gt: new Date() },
    deletedAt: { $exists: false },
    "metaData.phone": normalizePhone(options.phone),
    "metaData.purpose": options.purpose,
  };

  if (options.token) {
    query.token = String(options.token).trim();
  }

  if (options.requireVerified) {
    query["metaData.verified"] = true;
  }

  return Token.findOne(query).sort({ createdAt: -1 });
}

export function getDummyOtpCode() {
  return USE_DUMMY_OTP ? resolveOtpValue() : "";
}

export function isDevelopmentOtpMode() {
  return USE_DUMMY_OTP;
}

export async function requestOtpChallenge({
  phone,
  purpose,
}: {
  phone: string;
  purpose: OtpPurpose;
}) {
  const normalizedPhone = normalizePhone(phone);
  const otp = USE_DUMMY_OTP ? resolveOtpValue() : crypto.randomInt(100000, 1000000).toString();
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await markOtpTokensInactive({
    type: OTP_TOKEN_TYPES[purpose],
    isActive: true,
    "metaData.phone": normalizedPhone,
    "metaData.purpose": purpose,
  });

  await new Token({
    token,
    type: OTP_TOKEN_TYPES[purpose],
    otpHash: hashOtp(otp),
    expiresAt,
    isActive: true,
    is_active: true,
    metaData: {
      phone: normalizedPhone,
      purpose,
      attempts: 0,
      verified: false,
      channel: "phone_otp",
    },
  }).save();

  return {
    phone: normalizedPhone,
    purpose,
    token,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
  };
}

export async function verifyOtpChallenge({
  phone,
  otp,
  purpose,
  token,
}: {
  phone: string;
  otp: string;
  purpose: OtpPurpose;
  token?: string;
}) {
  const otpToken = await findActiveOtpToken({
    phone,
    purpose,
    token,
  });

  if (!otpToken) {
    throw generateError("OTP session not found or expired. Request a new OTP.", 400);
  }

  const metaData = {
    ...(otpToken.metaData && typeof otpToken.metaData === "object" ? otpToken.metaData : {}),
  } as Record<string, any>;

  if (!verifyOtpHash(otp, otpToken.otpHash || "")) {
    const attempts = Number(metaData.attempts || 0) + 1;
    otpToken.metaData = {
      ...metaData,
      attempts,
      lastFailedAt: new Date(),
    } as any;

    if (attempts >= MAX_OTP_ATTEMPTS) {
      otpToken.isActive = false;
      otpToken.is_active = false;
    }

    await otpToken.save();
    throw generateError(
      USE_DUMMY_OTP
        ? `Invalid OTP. Use ${resolveOtpValue()} for the current dummy flow.`
        : "Invalid OTP.",
      400
    );
  }

  if (purpose === "register") {
    otpToken.metaData = {
      ...metaData,
      attempts: Number(metaData.attempts || 0),
      verified: true,
      verifiedAt: new Date(),
    } as any;
    otpToken.expiresAt = new Date(Date.now() + REGISTRATION_VERIFICATION_TTL_MS);
    await otpToken.save();

    return {
      purpose,
      verificationToken: otpToken.token,
      expiresInSeconds: Math.floor(REGISTRATION_VERIFICATION_TTL_MS / 1000),
    };
  }

  otpToken.metaData = {
    ...metaData,
    attempts: Number(metaData.attempts || 0),
    verified: true,
    verifiedAt: new Date(),
  } as any;
  otpToken.isActive = false;
  otpToken.is_active = false;
  await otpToken.save();

  return {
    purpose,
    verified: true,
  };
}

export async function assertRegistrationOtpVerification(verificationToken: string, phone: string) {
  const normalizedToken = String(verificationToken || "").trim();
  const verification = await findActiveOtpToken({
    phone,
    purpose: "register",
    token: normalizedToken,
    requireVerified: true,
  });

  if (!verification) {
    throw generateError("OTP verification expired. Start registration again.", 401);
  }
}

export async function consumeRegistrationOtpVerification(verificationToken: string) {
  const normalizedToken = String(verificationToken || "").trim();
  if (!normalizedToken) {
    return;
  }

  await markOtpTokensInactive({
    token: normalizedToken,
    type: OTP_TOKEN_TYPES.register,
    isActive: true,
  });
}
