import Joi from "joi";

const UserValidation = Joi.object({
  name: Joi.string().when("role", {
    is: Joi.not("admin"),
    then: Joi.string().min(3).max(30).required().messages({
      "string.min": "Name must have a minimum length of {#limit}",
      "string.max": "Name should not exceed a maximum length of {#limit}",
      "any.required": "Name is required",
    }),
    otherwise: Joi.string().allow("").optional(),
  }),
  username:Joi.string().min(5).max(30).required().messages({
      "string.min": "username must have a minimum length of {#limit}",
      "string.max": "username should not exceed a maximum length of {#limit}",
      "any.required": "Username is required"
  }),
  pic: Joi.string().allow("").optional(),
  is_active: Joi.boolean().default(true),
  role: Joi.string().valid("user", "admin", "superadmin", "manager", "customer", "support").default("user"),
  company: Joi.string().when("role", {
    is: Joi.not("admin"),
    then: Joi.string().required().messages({
      "any.required": "Please select the company",
    }),
    otherwise: Joi.string().allow("").optional(),
  }),
  password: Joi.string().when("role", {
    is: Joi.not("admin"),
    then: Joi.string()
      .pattern(/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/)
      .message(
        "Password must contain at least 8 characters, including one uppercase letter, one lowercase letter, and one digit."
      )
      .required(),
    otherwise: Joi.string().allow("").optional(),
  }),
}).options({
  abortEarly: false,
});

const forgotEmailValidation = Joi.object({
  username: Joi.string().email().required().messages({
    "string.email": "Username should be a valid email address",
    "any.required": "Username is required",
  }),
});

const resetPasswordValidation = Joi.object({
  password: Joi.string()
    .pattern(/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/)
    .message(
      "Password must contain at least 8 characters, including one uppercase letter, one lowercase letter, and one digit."
    )
    .required(),
  token: Joi.string().required().messages({
    "any.required":"Token is  required"
  })
})

const passwordLoginValidation = Joi.object({
  email: Joi.string().trim().lowercase().email().required().messages({
    "string.email": "Email must be valid",
    "any.required": "Email is required",
    "string.empty": "Email is required",
  }),
  password: Joi.string().min(8).max(128).required().messages({
    "any.required": "Password is required",
    "string.empty": "Password is required",
  }),
}).options({ abortEarly: false });

const bootstrapSuperadminValidation = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  email: Joi.string().trim().lowercase().email().required().messages({
    "string.email": "Email must be valid",
    "any.required": "Email is required",
  }),
  phone: Joi.string().trim().pattern(/^\d{10}$/).optional().messages({
    "string.pattern.base": "Phone must be a valid 10-digit number",
  }),
  password: Joi.string()
    .pattern(/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/)
    .message(
      "Password must contain at least 8 characters, including one uppercase letter, one lowercase letter, and one digit."
    )
    .required(),
  setupKey: Joi.string().trim().allow("").optional(),
}).options({ abortEarly: false });

const registrationLocationValidation = Joi.object({
  address: Joi.string().trim().min(3).max(240).required().messages({
    "any.required": "Address is required",
    "string.empty": "Address is required",
  }),
  city: Joi.string().trim().max(80).required().messages({
    "any.required": "City is required",
    "string.empty": "City is required",
  }),
  state: Joi.string().trim().max(80).required().messages({
    "any.required": "State is required",
    "string.empty": "State is required",
  }),
  country: Joi.string().trim().max(80).required().messages({
    "any.required": "Country is required",
    "string.empty": "Country is required",
  }),
  postalCode: Joi.string().trim().max(20).required().messages({
    "any.required": "Pincode is required",
    "string.empty": "Pincode is required",
  }),
  formattedAddress: Joi.string().trim().allow("").max(300).optional(),
  placeId: Joi.string().trim().allow("").max(180).optional(),
  lat: Joi.number().min(-90).max(90).allow(null).optional(),
  lng: Joi.number().min(-180).max(180).allow(null).optional(),
}).required();

const learnerRegistrationValidation = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  phone: Joi.string().trim().pattern(/^\d{10}$/).required().messages({
    "string.pattern.base": "Phone must be a valid 10-digit number",
    "any.required": "Phone is required",
  }),
  email: Joi.string().trim().lowercase().email().optional(),
  verificationToken: Joi.string().trim().required().messages({
    "any.required": "Verification token is required",
  }),
  invitationToken: Joi.string().trim().optional(),
  courseId: Joi.string().trim().optional(),
  location: registrationLocationValidation,
}).options({ abortEarly: false });

const adminRegistrationValidation = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  phone: Joi.string().trim().pattern(/^\d{10}$/).required().messages({
    "string.pattern.base": "Phone must be a valid 10-digit number",
    "any.required": "Phone is required",
  }),
  email: Joi.string().trim().lowercase().email().optional().messages({
    "string.email": "Email must be valid",
  }),
  verificationToken: Joi.string().trim().required().messages({
    "any.required": "Verification token is required",
  }),
  companyName: Joi.string().trim().min(2).max(120).required().messages({
    "any.required": "Company name is required",
    "string.empty": "Company name is required",
  }),
  companyEmail: Joi.string().trim().lowercase().email().optional(),
  location: registrationLocationValidation,
}).options({ abortEarly: false });

const changePasswordValidation = Joi.object({
  oldPassword: Joi.string()
    .pattern(/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/)
    .message(
      "Password must contain at least 8 characters, including one uppercase letter, one lowercase letter, and one digit."
    )
    .required(),
  newPassword: Joi.string()
  .pattern(/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/)
  .message(
    "Password must contain at least 8 characters, including one uppercase letter, one lowercase letter, and one digit."
  )
  .required(),
  company: Joi.string()
})

export {
  UserValidation,
  forgotEmailValidation,
  resetPasswordValidation,
  passwordLoginValidation,
  bootstrapSuperadminValidation,
  learnerRegistrationValidation,
  adminRegistrationValidation,
  changePasswordValidation,
};
