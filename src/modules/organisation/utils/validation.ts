import Joi from "joi";

const DEFAULT_THEME_COLOR = "#2563EB";
const HEX_COLOR_PATTERN = /^#(?:[0-9A-Fa-f]{3}){1,2}$/;

// Address schema
const addressSchema = Joi.object({
  address: Joi.string().required().messages({
    "any.required": "Address field is required",
    "string.empty": "Address field cannot be empty",
  }),
  country: Joi.string().required().messages({
    "any.required": "Country field is required",
    "string.empty": "Country field cannot be empty",
  }),
  state: Joi.string().required().messages({
    "any.required": "State field is required",
    "string.empty": "State field cannot be empty",
  }),
  city: Joi.string().required().messages({
    "any.required": "City field is required",
    "string.empty": "City field cannot be empty",
  }),
  pinCode: Joi.string()
    .pattern(/^\d{6}$/)
    .required()
    .messages({
      "any.required": "Pin code field is required",
      "string.empty": "Pin code field cannot be empty",
      "string.pattern.base": "Pin code must be a 6-digit number",
    }),
});

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
  companyCode: Joi.string().required().messages({
      "any.required": "Company Code field is required",
      "string.empty": "Company Code field cannot be empty",
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
  addressInfo: Joi.array().items(addressSchema).messages({
    "array.base": "Address info must be an array",
    "array.items": "Address info must contain valid address objects",
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
