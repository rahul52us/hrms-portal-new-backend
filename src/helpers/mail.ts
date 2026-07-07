import nodemailer from "nodemailer";
// import Sentry from '@sentry/node';

// import {
//   SMTP_HOST,
//   SMTP_PORT,
//   SMTP_USER,
//   SMTP_PASS,
//   SMTP_DEFAULT_TO_EMAIL,
// } from "../../utils/env";

let config: object = {
  host: "smtp.hostinger.com",
  port: 587,
  secure: false, //ssl
  auth: {
    user: "flow@flowbd.com",
    pass: "Flow@123456",
  },
};

const mailTransport = nodemailer.createTransport(config);

export default async function sendMail(
  to: string,
  subject: string,
  html: string,
  attachmentBase64String?: string,
  cc?: string | string[]
): Promise<boolean> {
  try {
    const mailOptions: any = {
      from: "flow@flowbd.com",
      to,
      subject,
      html,
    };

    if (cc) {
      mailOptions.cc = cc;
    }

    if (attachmentBase64String) {
      const base64Content :any= attachmentBase64String.split(";base64,").pop();
      const fileBuffer = Buffer.from(base64Content, "base64");
      const today = new Date();
      const day = String(today.getDate()).padStart(2, "0");
      const month = String(today.getMonth() + 1).padStart(2, "0");
      const year = today.getFullYear();
      const hours = String(today.getHours()).padStart(2, "0");
      const minutes = String(today.getMinutes()).padStart(2, "0");
      
      const name = `DRUG_ORDER_${day}_${month}_${year}-${hours}_${minutes}.xlsx`;
      mailOptions.attachments = [
        {
          filename: name,
          content: fileBuffer,
          encoding: "base64",
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ];
    }

    await mailTransport.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.log(error, "Error sending");
    // Sentry.captureException(error);
    return false;
  }
}
