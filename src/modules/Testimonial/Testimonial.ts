import { NextFunction, Request, Response } from "express";
import Testimonial from "../../schemas/Testimonial";
import { generateError } from "../config/function";
import { testimonialCreateValidation } from "./utils/validation";
import { deleteFile, uploadFile } from "../../repository/uploadDoc.repository";
import { createCatchError, generateFileName } from "../../config/helper/function";
import { statusCode } from "../../config/helper/statusCode";


const createTestimonail = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    req.body.user = req.userId
    // const result = testimonialCreateValidation.validate(req.body);
    // if (result.error) {
    //   throw generateError(result.error.details[0], 422);
    // }

    const {image, ...rest} = req.body
    const test = new Testimonial(rest);
    const createdTestimonial = await test.save();
    if (!createdTestimonial) {
      throw generateError("failed to create data", 400);
    }

    if (image && image?.buffer !== "" && Object.entries(image || {}).length) {
      let url = await uploadFile(req.body.image);
      createdTestimonial.image = {
        name: image?.filename,
        url: url,
        type: image?.type,
      };
      await createdTestimonial.save();
    }

    return res.status(201).send({
      message: "New Testimonial has been created successfully",
      data: createdTestimonial.toObject(),
      statusCode: 201,
      success: true
    });
  } catch (err: any) {
    console.log(err?.message)
    next(err);
  }
};

export const updateTestimonial = async (req : any, res : any) => {
  try {
    const data = req.body
    const {image, ...rest} = data
    const testimonial = await Testimonial.findById(data._id);
    if (testimonial) {
      const updatedData: any = await Testimonial.findByIdAndUpdate(data._id, rest, {
        new: true,
      });

      if (
        data.isFileDeleted === 1 &&
        updatedData.image?.url &&
        updatedData.image?.name
      ) {
        await deleteFile(updatedData.image.name);
        updatedData.image = {
          name: undefined,
          url: undefined,
          type: undefined,
        };
        await updatedData.save();
      }

      if (
        data.image?.filename &&
        data.image?.buffer &&
        data.image
      ) {
        data.image.filename = generateFileName(data.image.filename)
        const url = await uploadFile(data.image);
        updatedData.image = {
          name: data.image.filename,
          url,
          type : data.image.type,
        };
        await updatedData.save();
      }
      await updatedData.save();
      return res.status(statusCode.success).send({
        status: "success",
        data: updatedData,
        message: "Testimonail Update Successfully",
      });
    } else {
      return res.status(statusCode.info).send({
        status: "success",
        data: "Testimonails does not exists",
        message: "Testimonails does not exists",
      });
    }
  } catch (err) {
    return createCatchError(err);
  }
};

export const deleteTestimonial = async (req : any , res : Response) => {
  try
  {
    const test = await Testimonial.findByIdAndDelete(req.params.id)
    if(test){
      if(test?.image?.name){
        await deleteFile(test.image.name);
      }
      return res.status(statusCode.success).send({
        status: "success",
        data: test,
        message: "Testimonail Update Successfully",
      });
    }
    else {
      return res.status(statusCode.info).send({
        status: "success",
        data: "Testimonails does not exists",
        message: "Testimonails does not exists",
      });
    }
  }
  catch(err : any)
  {
    return createCatchError(err);
  }
}
const getTestimonials = async (req: any, res: Response, next: NextFunction) => {
  try {
    let query: any = {};

    const limit = Number(req.query.limit) || 10;
    const page = Math.max(Number(req.query.page) || 1, 1);

    // Check for company filter
    if (req.query.company) {
      query.company = req.query.company;
    }

    // Check for profession filter
    if (req.query.search && req.query.search?.trim()) {
      query.profession = { $regex: req.query.search, $options: "i" };
    }

    const totalTestimonials = await Testimonial.countDocuments(query);
    const totalPages = Math.ceil(totalTestimonials / limit);

    const testimonials = await Testimonial.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.status(200).json({
      data: testimonials,
      totalPages,
      message: "Get Testimonials Successfully",
      statusCode: 200,
      success: true,
    });
  } catch (err) {
    next(err);
  }
};



export {createTestimonail, getTestimonials}