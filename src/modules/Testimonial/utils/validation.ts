import * as Joi from "joi";

const testimonialCreateValidation = Joi.object({
  name: Joi.string().trim().min(2).max(50).messages({
    "string.empty": "Name is required",
    "string.min": "Name must be at least {#limit} characters long",
    "string.max": "Name cannot exceed {#limit} characters",
  }),
  rating: Joi.number().min(1).max(5).messages({
    "string.empty": "rating is required"
  }),
  user: Joi.string().messages({
    "any.required": "User is required",
    "string.empty": "User is required",
  }),
  company: Joi.any().allow(null).messages({
    "any.required": "Organisation is required",
    "string.empty": "Organisation is required",
  }),
  profession: Joi.string(),
  image: Joi.any(),
  description: Joi.string(),
}).options({
  abortEarly: false,
});

export { testimonialCreateValidation };
