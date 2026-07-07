import { NextFunction, Response } from "express";
import { generateError } from "../config/function";
import { deleteFile, uploadFile } from "../../repository/uploadDoc.repository";
import { createCatchError, generateFileName } from "../../config/helper/function";
import { statusCode } from "../../config/helper/statusCode";
import Events from "../../schemas/events/events.schema";


const createEvent = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    req.body.user = req.userId
    const {image, ...rest} = req.body
    const test = new Events(rest);
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
      message: "New Events has been created successfully",
      data: createdTestimonial.toObject(),
      statusCode: 201,
      success: true
    });
  } catch (err: any) {
    console.log(err?.message)
    next(err);
  }
};

export const updateEvent = async (req : any, res : any) => {
  try {
    const data = req.body
    const {image, ...rest} = data

    const testimonial = await Events.findById(data._id);
    if (testimonial) {
      const updatedData: any = await Events.findByIdAndUpdate(data._id, {...rest, eventDate : rest?.eventDate}, {
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
        message: "Event Update Successfully",
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

export const deleteEvent = async (req : any , res : Response) => {
  try
  {
    const test = await Events.findByIdAndDelete(req.params.id)
    if(test){
      if(test?.image?.name){
        await deleteFile(test.image.name);
      }
      return res.status(statusCode.success).send({
        status: "success",
        data: test,
        message: "Event Update Successfully",
      });
    }
    else {
      return res.status(statusCode.info).send({
        status: "success",
        data: "Event does not exists",
        message: "Event does not exists",
      });
    }
  }
  catch(err : any)
  {
    return createCatchError(err);
  }
}
const getEvent = async (req: any, res: Response, next: NextFunction) => {
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
      query.title = { $regex: req.query.search, $options: "i" };
    }

    if (req.query.target && req.query.search?.trim()) {
        query.target = { $regex: req.query.target, $options: "i" };
      }

      if (req.query.category && req.query.category?.trim()) {
        query.category = { $regex: req.query.category, $options: "i" };
      }

    const totalTestimonials = await Events.countDocuments(query);
    const totalPages = Math.ceil(totalTestimonials / limit);

    const testimonials = await Events.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.status(200).json({
      data: testimonials,
      totalPages,
      message: "Get Event Successfully",
      statusCode: 200,
      success: true,
    });
  } catch (err) {
    next(err);
  }
};



export {createEvent, getEvent}