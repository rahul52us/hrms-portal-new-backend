import { NextFunction, Response } from "express";
import {
  createContact,
  getContacts,
} from "../../repository/contact/contact.repository";
import SendMail from "../../config/sendMail/sendMail";
import mongoose from "mongoose";

export const createContactService = async (
  req: any,
  res: Response,
  next: any
) => {
  try {
    if (req.body.type === "subscriber") {
      const websiteEmail = process.env.WEBSITE_EMAIL;

      if (!websiteEmail) {
        return res.status(500).send({
          message: "Website email is not configured.",
          status: "error",
        });
      }

      SendMail(
        websiteEmail,
        "New Subscriber Submission Alert",
        "contact/adminSubscription.html",
        { ...req.body, userEmail: req.body?.email, reciever_mail: websiteEmail }
      );

      SendMail(
        req.body.email,
        "Your Information Has Been Successfully Submitted",
        "contact/userSubscription.html",
        { ...req.body, userEmail: req.body?.email }
      );

      return res.status(200).send({
        message: "Subscribe Successfully",
        data: req.body,
        status: "success",
      });
    } else {
      const { status, statusCode, data, message } = await createContact({
        ...req.body,
        name: `${req.body.firstName} ${req.body.lastName}`,
      });

      if (status === "success") {
        const websiteEmail = process.env.WEBSITE_EMAIL;

        if (!websiteEmail) {
          return res.status(500).send({
            message: "Website email is not configured.",
            status: "error",
          });
        }

        SendMail(
          websiteEmail,
          "User Information Submission Alert",
          "contact/userInfo.html",
          { ...req.body, reciever_mail: websiteEmail }
        );

        SendMail(
          req.body.email,
          "Your Information Has Been Successfully Submitted",
          "contact/customerMail.html",
          { ...req.body }
        );

        return res.status(statusCode).send({
          message: message,
          data: req.body,
          status: status,
        });
      } else {
        // If creation fails, return the error response
        return res.status(statusCode).send({
          data,
          message,
          status,
        });
      }
    }
  } catch (err: any) {
    next(err);
  }
};

export const getContactsService = async (
  req: any,
  res: Response,
  next: any
) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req?.query?.search?.trim() || undefined;

    const { status, statusCode, data, totalPages, message } = await getContacts(
      search,
      page,
      limit,
      new mongoose.Types.ObjectId(req.body.company)
    );

    return res.status(statusCode).send({
      message: message,
      status: status,
      data: { data, totalPages },
      totalPages,
    });
  } catch (err: any) {
    next(err);
  }
};

export const sendResume = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const { attachmentBase64String } = req.body;

    const applicantName = `${req.body?.firstName || "Applicant"} ${
      req.body?.lastName || ""
    }`.trim();
    const emailSubject = `New Resume Submission from ${applicantName}`;

    await SendMail(
      process.env.WEBSITE_EMAIL!,
      emailSubject,
      "resume/send_resume.html",
      { ...req.body, reciever_mail: process.env.WEBSITE_EMAIL },
      attachmentBase64String
    );

    await SendMail(
      req.body?.email,
      "Application Received – Thank You!",
      "resume/confirmation.html",
      { ...req.body, reciever_mail: req.body?.email }
    );

    return res.status(200).send({
      message: "Resume has been Sent Successfully",
      status: "success",
      data: "Resume has been sent successfully",
    });
  } catch (err: any) {
    next(err);
  }
};