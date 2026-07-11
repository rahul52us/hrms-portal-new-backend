import generateToken from "../../config/helper/generateToken";
import { generateError } from "../../config/Error/functions";
import User from "../../schemas/User/User";
import { compareBcrypt, hashBcrypt } from "../../config/helper/function";
import { ensureUserAccountEnabled } from "../../services/company/utils/activityGuards";
import ProfileDetails from "../../schemas/User/ProfileDetails";
import { randomBytes } from "crypto";
import Company from "../../schemas/company/Company";
import CompanyPolicy from "../../schemas/company/CompanyPolicy";
import companyDetails from "../../schemas/company/companyDetails";
import { createManagedCompany } from "../company/company.respository";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTenantSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

async function generateUniqueCompanyCode() {
  while (true) {
    const companyCode = `CMP-${randomBytes(3).toString("hex").toUpperCase()}`;
    const existingCompany = await Company.findOne({ companyCode });
    if (!existingCompany) {
      return companyCode;
    }
  }
}

async function generateUniqueTenantSlug(companyName: string) {
  const baseSlug = normalizeTenantSlug(companyName) || `company-${Date.now()}`;
  let candidate = baseSlug;
  let suffix = 1;

  while (true) {
    const existingCompany = await Company.findOne({ tenantSlug: candidate });
    if (!existingCompany) {
      return candidate;
    }

    suffix += 1;
    candidate = `${baseSlug}-${suffix}`;
  }
}

async function findExistingIdentity(phone: string, email?: string) {
  const identityQueries: any[] = [
    { mobileNumber: phone },
    { username: phone },
  ];

  if (email) {
    identityQueries.push({ email }, { username: email });
  }

  return User.findOne({
    $or: identityQueries,
    deletedAt: { $exists: false },
  })
    .select("mobileNumber email username")
    .lean();
}

function buildIdentityConflictError(existingUser: any, phone: string) {
  const matchingPhone =
    existingUser?.mobileNumber === phone || existingUser?.username === phone;

  return generateError(
    matchingPhone
      ? "An account already exists with this phone number. Please sign in."
      : "An account already exists with this email address. Please sign in.",
    409
  );
}

function normalizeLoginEmail(value: unknown) {
  return String(value || "").trim();
}

function buildAuthResponseUser(user: any) {
  return {
    authorization_token: generateToken({ userId: user._id }),
    userId: user._id,
    role: user.role,
    userType: user.userType,
    company: user.company || null,
  };
}

function requireValidSuperadminSetupKey(setupKey?: string) {
  const configuredSetupKey = String(process.env.SUPERADMIN_SETUP_KEY || "").trim();
  const providedSetupKey = String(setupKey || "").trim();
  const isProduction = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";

  if (!configuredSetupKey && isProduction) {
    throw generateError("SUPERADMIN_SETUP_KEY must be configured before bootstrapping in production.", 500);
  }

  if (configuredSetupKey && providedSetupKey !== configuredSetupKey) {
    throw generateError("Invalid superadmin setup key.", 403);
  }
}

async function findUserByLoginEmail(email: string) {
  const normalizedEmail = normalizeLoginEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  const emailRegex = new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i");

  return User.findOne({
    $or: [
      { username: emailRegex },
      { email: emailRegex },
    ],
    deletedAt: { $exists: false },
  });
}

const findUserByUserName = async (data: any) => {
  try {
    const normalizedEmail = String(data.username || "").trim().toLowerCase();
    const emailRegex = new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i");
    const user = await User.findOne({
      $or: [{ email: emailRegex }, { username: emailRegex }],
      deletedAt: { $exists: false },
    });
    if (user) {
      return user;
    }
    return null;
  } catch (err: any) {
    return null;
  }
};

const findUserById = async (id: any) => {
  try {
    const user = await User.findById(id).select('-password');
    if (user) {
      return user;
    }
    return null;
  } catch (err: any) {
    return null;
  }
};

const loginUserWithPassword = async (data: any): Promise<any> => {
  try {
    const email = normalizeLoginEmail(data.email);
    const existUser = await findUserByLoginEmail(email);
    if (!existUser) {
      throw generateError("Invalid credentials.", 401);
    }

    ensureUserAccountEnabled(existUser);

    if (!existUser.is_active) {
      throw generateError("Account is inactive. Please contact your administrator.", 403);
    }

    if (!existUser.password) {
      throw generateError("Password login is not enabled for this account.", 403);
    }

    const passwordMatches = await compareBcrypt(String(data.password || ""), existUser.password);
    if (!passwordMatches) {
      throw generateError("Invalid credentials.", 401);
    }

    return {
      status: "success",
      data: buildAuthResponseUser(existUser),
      message: `${existUser?.name || existUser?.username} has been logged in successfully`,
    };
  } catch (err) {
    return { status: "error", data: err };
  }
};

const bootstrapSuperadmin = async (data: any) => {
  requireValidSuperadminSetupKey(data.setupKey);

  const existingSuperadmin = await User.findOne({
    role: "superadmin",
    deletedAt: { $exists: false },
  }).select("_id username email");

  if (existingSuperadmin) {
    throw generateError("A superadmin account already exists.", 409);
  }

  const email = String(data.email || "").trim().toLowerCase();
  const phone = String(data.phone || "").trim();
  const identityQueries: any[] = [
    { email: new RegExp(`^${escapeRegex(email)}$`, "i") },
    { username: new RegExp(`^${escapeRegex(email)}$`, "i") },
  ];

  if (phone) {
    identityQueries.push({ mobileNumber: phone }, { username: phone });
  }

  const existingIdentity = await User.findOne({
    $or: identityQueries,
    deletedAt: { $exists: false },
  }).select("_id username email mobileNumber");

  if (existingIdentity) {
    throw generateError("An account already exists with this email or phone.", 409);
  }

  const user = new User({
    name: String(data.name || "").trim(),
    email,
    username: email,
    ...(phone ? { mobileNumber: phone } : {}),
    code: await generateUniqueUserCode("SADM"),
    role: "superadmin",
    userType: "superadmin",
    password: await hashBcrypt(data.password),
    is_active: true,
    is_enabled: true,
  });

  const savedUser = await user.save();

  try {
    const profileDetails = await ProfileDetails.create({
      user: savedUser._id,
      personalInfo: {
        name: savedUser.name,
        email: savedUser.email,
        username: savedUser.username,
        code: savedUser.code,
      },
    });
    savedUser.profile_details = profileDetails._id;
    await savedUser.save();
  } catch (error) {
    await User.deleteOne({ _id: savedUser._id });
    throw error;
  }

  return buildAuthResponseUser(savedUser);
};

async function generateUniqueUserCode(prefix = "USR") {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
    const exists = await User.exists({ code });
    if (!exists) {
      return code;
    }
  }

  throw generateError("Unable to generate a user code. Please try again.", 500);
}

function normalizeRegistrationLocation(location: any) {
  if (!location || typeof location !== "object") {
    return null;
  }

  const lat = typeof location.lat === "number" ? location.lat : null;
  const lng = typeof location.lng === "number" ? location.lng : null;

  return {
    address: String(location.address || "").trim(),
    city: String(location.city || "").trim(),
    state: String(location.state || "").trim(),
    country: String(location.country || "").trim(),
    postalCode: String(location.postalCode || "").trim(),
    formattedAddress: String(location.formattedAddress || location.address || "").trim(),
    placeId: String(location.placeId || "").trim(),
    lat,
    lng,
  };
}

function buildUserLocationFields(location: ReturnType<typeof normalizeRegistrationLocation>) {
  if (!location) {
    return {};
  }

  return {
    address: location.address,
    city: location.city,
    state: location.state,
    country: location.country,
    postalCode: location.postalCode,
    formattedAddress: location.formattedAddress,
    ...(location.placeId ? { placeId: location.placeId } : {}),
    ...(location.lat !== null && location.lng !== null
      ? { location: { lat: location.lat, lng: location.lng } }
      : {}),
  };
}

function buildCompanyAddressInfo(location: ReturnType<typeof normalizeRegistrationLocation>) {
  if (!location) {
    return [];
  }

  return [
    {
      address: location.address,
      country: location.country,
      state: location.state,
      city: location.city,
      pinCode: location.postalCode,
      formattedAddress: location.formattedAddress,
      ...(location.placeId ? { placeId: location.placeId } : {}),
      ...(location.lat !== null ? { lat: location.lat } : {}),
      ...(location.lng !== null ? { lng: location.lng } : {}),
    },
  ];
}

const registerLearner = async (data: any) => {
  const phone = String(data.phone || "").trim();
  const email = String(data.email || "").trim().toLowerCase();
  const location = normalizeRegistrationLocation(data.location);
  const existingUser = await findExistingIdentity(phone, email);

  if (existingUser) {
    throw buildIdentityConflictError(existingUser, phone);
  }

  const user = new User({
    name: String(data.name || "").trim(),
    mobileNumber: phone,
    username: phone,
    ...(email ? { email } : {}),
    code: await generateUniqueUserCode("LRN"),
    role: "user",
    userType: "learner",
    is_active: true,
    is_enabled: true,
    ...buildUserLocationFields(location),
  });

  await user.save();

  try {
    const profileDetails = await ProfileDetails.create({ user: user._id });
    user.profile_details = profileDetails._id;
    await user.save();
  } catch (error) {
    await user.deleteOne();
    throw error;
  }

  return {
    authorization_token: generateToken({ userId: user._id }),
    userType: user.userType,
    role: user.role,
  };
};

const registerAdmin = async (data: any) => {
  const name = String(data.name || "").trim();
  const phone = String(data.phone || "").trim();
  const email = String(data.email || "").trim().toLowerCase();
  const companyName = String(data.companyName || "").trim();
  const companyEmail = String(data.companyEmail || "").trim().toLowerCase() || email;
  const location = normalizeRegistrationLocation(data.location);

  const existingUser = await findExistingIdentity(phone, email);
  if (existingUser) {
    throw buildIdentityConflictError(existingUser, phone);
  }

  const existingCompany = await Company.findOne({
    company_name: { $regex: new RegExp(`^${escapeRegex(companyName)}$`, "i") },
    deletedAt: { $exists: false },
  });

  if (existingCompany) {
    throw generateError(
      "A company with this name already exists. Please sign in or use a different company name.",
      409
    );
  }

  const user = new User({
    name,
    ...(email ? { email } : {}),
    mobileNumber: phone,
    username: phone,
    code: await generateUniqueUserCode("ADM"),
    role: "admin",
    userType: "admin",
    is_active: true,
    is_enabled: true,
    ...buildUserLocationFields(location),
  });

  let savedUser: any = null;
  let company: any = null;

  try {
    savedUser = await user.save();
    const companyCode = await generateUniqueCompanyCode();
    const tenantSlug = await generateUniqueTenantSlug(companyName);
    const createdCompanyResult = await createManagedCompany({
      company_name: companyName,
      companyCode,
      tenantSlug,
      companyEmail,
      mobileNo: phone,
      bio: `${companyName} learning workspace`,
      addressInfo: buildCompanyAddressInfo(location),
      managerLevels: 3,
      verified_email_allowed: false,
      createdBy: savedUser._id,
      activeUser: savedUser._id,
    });

    if (createdCompanyResult.status !== "success") {
      throw generateError(
        createdCompanyResult.message || createdCompanyResult.data || "Unable to create company",
        createdCompanyResult.statusCode || 400
      );
    }

    company = createdCompanyResult.data;
    await Company.findByIdAndUpdate(company._id, {
      $set: {
        companyOrg: company._id,
        updatedAt: new Date(),
      },
    });
    savedUser.company = company._id;

    const profileDetails = await ProfileDetails.create({ user: savedUser._id });
    savedUser.profile_details = profileDetails._id;
    await savedUser.save();

    return {
      authorization_token: generateToken({ userId: savedUser._id }),
      userType: savedUser.userType,
      role: savedUser.role,
    };
  } catch (error) {
    if (savedUser?._id) {
      await ProfileDetails.deleteMany({ user: savedUser._id });
      await User.deleteOne({ _id: savedUser._id });
    }

    if (company?._id) {
      await Promise.allSettled([
        CompanyPolicy.deleteMany({ company: company._id }),
        companyDetails.deleteMany({ company: company._id }),
        Company.deleteOne({ _id: company._id }),
      ]);
    }

    throw error;
  }
};

const changePassword = async (data: any) => {
  try {
    const user = await User.findById(data.user);
    if (user) {
      let checkPassword = await compareBcrypt(data.oldPassword,user.password)
      if (!checkPassword) {
        throw generateError(
          `Current Password does not match to the Old Password`,
          400
        );
      }
      let hashPassword =  await hashBcrypt(data.newPassword)
      user.password = hashPassword;
      await user.save();
      return { status: "success", data: null };
    } else {
      return { status: "error", data: "User Does not exists" };
    }
  } catch (err) {
    return { status: "error", data: err };
  }
};

export const updateUserRole = async (id: string, role: string) => {
  try {
    const updatedUser = await User.findByIdAndUpdate(
      id,
      { role: role },
      { new: true }
    );
    if (updatedUser) {
      return {
        status: "success",
        data: updatedUser,
      };
    }
    return {
      status: "error",
      data: "User does not exists",
    };
  } catch (err) {
    return { status: "error", data: err };
  }
};

const getRoleUsers = async (data : any) => {
  try {
    const users = await User.aggregate([
      {
        $lookup: {
          from: 'companydetails',
          localField: 'companyDetail',
          foreignField: '_id',
          as: 'companyDetails',
        },
      },
      {
        $match: {
          'companyDetails.company': data.company,
          role: { $in: ['manager', 'admin','superadmin'] },
          deletedAt: { $exists: false },
        },
      },
      {
        $project: {
          password: 0,
          companyDetails: 0,
        },
      },
    ]);

    return {
      status: "success",
      statusCode: 200,
      data: { data: users || [] },
    };
  } catch (err: any) {
    return {
      status: "error",
      statusCode: 500,
      message: err?.message || 'An error occurred',
    };
  }
};

export {
  loginUserWithPassword,
  bootstrapSuperadmin,
  registerLearner,
  registerAdmin,
  changePassword,
  findUserById,
  findUserByUserName,
  getRoleUsers,
};
