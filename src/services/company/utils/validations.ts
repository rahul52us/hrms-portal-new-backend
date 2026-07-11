import Joi from "joi";

const DEFAULT_THEME_COLOR = "#2563EB";
const HEX_COLOR_PATTERN = /^#(?:[0-9A-Fa-f]{3}){1,2}$/;
const PHONE_PATTERN = /^[0-9+()\-\s]{7,20}$/;

const addressSchema = Joi.object({
  address: Joi.string().allow("", null).default(""),
  country: Joi.string().allow("", null).default(""),
  state: Joi.string().allow("", null).default(""),
  city: Joi.string().allow("", null).default(""),
  pinCode: Joi.string().allow("", null).default(""),
});

export const createManagedCompanyValidation = Joi.object({
  company_name: Joi.string().trim().required().messages({
    "any.required": "Company name is required",
    "string.empty": "Company name is required",
  }),
  companyCode: Joi.string().trim().required().messages({
    "any.required": "Company code is required",
    "string.empty": "Company code is required",
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
  managerLevels: Joi.number().integer().min(1).max(20).default(3),
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
  addressInfo: Joi.array().items(addressSchema).min(1).required().messages({
    "any.required": "At least one address is required",
    "array.min": "At least one address is required",
  }),
  logo: Joi.alternatives()
    .try(
      Joi.object({
        buffer: Joi.any().required(),
        filename: Joi.string().required(),
        type: Joi.string().allow("", null).default(""),
      }),
      Joi.object({
        file: Joi.array().max(0).default([]),
      }),
      Joi.object().max(0)
    )
    .allow(null),
});
