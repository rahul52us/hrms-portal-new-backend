import Joi from "joi";
import {
  COMPANY_CODE_PATTERN,
  MAX_COMPANY_CODE_LENGTH,
} from "../../employeeCode/employeeCode.utils";

const DEFAULT_THEME_COLOR = "#2563EB";
const HEX_COLOR_PATTERN = /^#(?:[0-9A-Fa-f]{3}){1,2}$/;
const PHONE_PATTERN = /^[0-9+()\-\s]{7,20}$/;
const SUPPORTED_LOGO_TYPES = ["image/png", "image/jpeg"];
const MAX_LOGO_BASE64_LENGTH = 2_800_000;

const optionalAddressField = (maximum: number) =>
  Joi.string().trim().max(maximum).allow("", null).default("");

const registeredAddressSchema = Joi.object({
  addressLine1: optionalAddressField(200),
  addressLine2: optionalAddressField(200),
  city: optionalAddressField(100),
  state: optionalAddressField(100),
  postalCode: optionalAddressField(20),
  country: optionalAddressField(100),
}).default({});

const companyAdminSchema = Joi.object({
  create: Joi.boolean().default(false),
  name: Joi.when("create", {
    is: true,
    then: Joi.string().trim().required().messages({
      "any.required": "Company admin name is required",
      "string.empty": "Company admin name is required",
    }),
    otherwise: Joi.string().trim().allow("", null).default(""),
  }),
  username: Joi.when("create", {
    is: true,
    then: Joi.string().trim().email({ tlds: { allow: false } }).required().messages({
      "any.required": "Company admin email is required",
      "string.empty": "Company admin email is required",
      "string.email": "Enter a valid company admin email address",
    }),
    otherwise: Joi.string().trim().allow("", null).default(""),
  }),
  password: Joi.string().allow("", null).default(""),
  sendInvite: Joi.boolean().default(true),
}).default({ create: false });

export const createManagedCompanyValidation = Joi.object({
  company_name: Joi.string().trim().required().messages({
    "any.required": "Company name is required",
    "string.empty": "Company name is required",
  }),
  companyCode: Joi.string()
    .trim()
    .uppercase()
    .min(2)
    .max(MAX_COMPANY_CODE_LENGTH)
    .pattern(COMPANY_CODE_PATTERN)
    .required()
    .messages({
    "any.required": "Company code is required",
    "string.empty": "Company code is required",
    "string.min": "Company code must contain at least 2 characters",
    "string.max": `Company code cannot exceed ${MAX_COMPANY_CODE_LENGTH} characters`,
    "string.pattern.base": "Company code can contain only letters, numbers, and single hyphens",
  }),
  companyType: Joi.string().trim().default("company"),
  tenantSlug: Joi.string().trim().allow("", null).default(""),
  customDomain: Joi.string().trim().allow("", null).default(""),
  companyEmail: Joi.string()
    .trim()
    .email({ tlds: { allow: false } })
    .required()
    .messages({
      "any.required": "Company email is required",
      "string.empty": "Company email is required",
      "string.email": "Enter a valid company email address",
    }),
  is_active: Joi.boolean().optional(),
  mobileNo: Joi.string()
    .trim()
    .pattern(PHONE_PATTERN)
    .required()
    .messages({
      "any.required": "Primary phone number is required",
      "string.empty": "Primary phone number is required",
      "string.pattern.base": "Enter a valid primary phone number",
    }),
  workNo: Joi.string().trim().allow("", null).default(""),
  webLink: Joi.string().trim().allow("", null).default(""),
  bio: Joi.string().trim().min(10).allow("", null).default("").messages({
    "string.min": "Company description should be at least 10 characters",
  }),
  primaryThemeColor: Joi.string()
    .trim()
    .pattern(HEX_COLOR_PATTERN)
    .empty("")
    .default(DEFAULT_THEME_COLOR)
    .messages({
      "string.pattern.base": "Primary theme color must be a valid hex color",
    }),
  verified_email_allowed: Joi.boolean().default(false),
  facebookLink: Joi.string().trim().allow("", null).default(""),
  instagramLink: Joi.string().trim().allow("", null).default(""),
  linkedInLink: Joi.string().trim().allow("", null).default(""),
  twitterLink: Joi.string().trim().allow("", null).default(""),
  githubLink: Joi.string().trim().allow("", null).default(""),
  telegramLink: Joi.string().trim().allow("", null).default(""),
  otherLinks: Joi.array().items(Joi.string().trim()).default([]),
  registeredAddress: registeredAddressSchema,
  logo: Joi.alternatives()
    .try(
      Joi.object({
        buffer: Joi.string()
          .max(MAX_LOGO_BASE64_LENGTH)
          .pattern(/^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i)
          .required()
          .messages({
            "string.max": "Company logo cannot exceed 2 MB",
            "string.pattern.base": "Company logo content must be a PNG or JPEG image",
          }),
        filename: Joi.string().required(),
        type: Joi.string()
          .valid(...SUPPORTED_LOGO_TYPES)
          .required()
          .messages({
            "any.only": "Company logo must be a PNG or JPEG image",
            "any.required": "Company logo file type is required",
          }),
      }),
      Joi.object({
        file: Joi.array().max(0).default([]),
      }),
      Joi.object().max(0)
    )
    .allow(null),
  isLogoEdit: Joi.boolean().optional(),
  deletedFiles: Joi.array().items(Joi.string()).optional(),
  companyAdmin: companyAdminSchema,
});
