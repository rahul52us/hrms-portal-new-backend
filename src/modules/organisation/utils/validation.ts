import Joi from "joi";
import {
  COMPANY_CODE_PATTERN,
  MAX_COMPANY_CODE_LENGTH,
} from "../../../services/employeeCode/employeeCode.utils";

const DEFAULT_THEME_COLOR = "#2563EB";
const HEX_COLOR_PATTERN = /^#(?:[0-9A-Fa-f]{3}){1,2}$/;

// Company details schema
const companyDetailsSchema = Joi.object({
  company_name: Joi.string().required().messages({
    "any.required": "Company name field is required",
    "string.empty": "Company name field cannot be empty",
  }),
  logo: Joi.any(),
  mobileNo: Joi.string()
    .pattern(/^\d{10,15}$/)
    .required()
    .messages({
      "any.required": "Mobile number field is required",
      "string.empty": "Mobile number field cannot be empty",
      "string.pattern.base": "Mobile number must be between 10 and 15 digits",
    }),
  companyCode: Joi.string()
    .trim()
    .uppercase()
    .min(2)
    .max(MAX_COMPANY_CODE_LENGTH)
    .pattern(COMPANY_CODE_PATTERN)
    .required()
    .messages({
      "any.required": "Company Code field is required",
      "string.empty": "Company Code field cannot be empty",
      "string.pattern.base": "Company code can contain only letters, numbers, and single hyphens",
    }),
  workNo: Joi.string().pattern(/^\d{10,15}$/),
  remember_me: Joi.boolean(),
  bio: Joi.string().allow(""),
  primaryThemeColor: Joi.string()
    .trim()
    .pattern(HEX_COLOR_PATTERN)
    .empty("")
    .default(DEFAULT_THEME_COLOR)
    .messages({
      "string.pattern.base": "Primary theme color must be a valid hex color",
    }),
  facebookLink: Joi.string().uri().allow(""),
  instagramLink: Joi.string().uri().allow(""),
  twitterLink: Joi.string().uri().allow(""),
  githubLink: Joi.string().uri().allow(""),
  telegramLink: Joi.string().uri().allow(""),
  linkedInLink: Joi.string().uri().allow(""),
  otherLinks: Joi.array().items(Joi.string().uri().allow("")).messages({
    "array.base": "Other links must be an array",
    "array.items": "Other links must be valid URLs",
  }),
});

// Main schema
const createValidation = Joi.object({
  username: Joi.string().email().required().messages({
    "any.required": "Username field is required",
    "string.empty": "Username field cannot be empty",
    "string.email": "Username must be a valid email address",
  }),
  name: Joi.string().required().messages({
    "any.required": "Name field is required",
    "string.empty": "Name field cannot be empty",
  }),
  password: Joi.string().required().messages({
    "any.required": "Password field is required",
    "string.empty": "Password field cannot be empty",
  }),
  code: Joi.string().required().messages({
    "any.required": "Code field is required",
    "string.empty": "Code field cannot be empty",
  }),
  companyDetails: companyDetailsSchema, // Nested company details schema
}).options({
  abortEarly: false,
});

export { createValidation };
