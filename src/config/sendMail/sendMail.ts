import nodemailer from "nodemailer";
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

interface RestOptions {
  [key: string]: any;
}

const SendMail = async (
  sendTo: string,
  subject: string,
  fileName: string,
  rest: RestOptions,
  attachmentBase64String?: string,
  cc?: string[]
) => {
  try {
    // Create a transporter object using the SMTP settings
    const transporter = nodemailer.createTransport({
      host: "smtp.hostinger.com",
      port: 587,
      secure: false, // TLS is used
      auth: {
        user: process.env.WELCOME_REGISTER_EMAIL_USERNAME,
        pass: process.env.WELCOME_REGISTER_EMAIL_PASSWORD,
      },
    });

    // Path to the email template
    const templatePath = path.join(__dirname, 'templates', fileName);
    const template = fs.readFileSync(templatePath, 'utf8');

    // Replace default placeholders
    let personalizedTemplate = template
      .replace('{{buttonText}}', 'Click Here')
      .replace('{{year}}', new Date().getFullYear().toString())
      .replace('{{companyName}}', process.env.COMPANY_NAME || '');

    // Replace placeholders with values from the `rest` object
    for (const [key, value] of Object.entries(rest)) {
      const placeholder = `{{${key}}}`;
      personalizedTemplate = personalizedTemplate.replace(new RegExp(placeholder, 'g'), String(value));
    }

    // Ensure logoUrl is replaced if not provided
    if (!rest.logoUrl) {
      personalizedTemplate = personalizedTemplate.replace('{{logoUrl}}', process.env.WEB_LOGO || "https://img.freepik.com/free-vector/bird-colorful-logo-gradient-vector_343694-1365.jpg");
    }

    // Email message template
    const messageTemplate: any = {
      from: process.env.WELCOME_REGISTER_EMAIL_USERNAME,
      to: sendTo,
      subject: subject,
      html: personalizedTemplate,
    };

    if (cc) {
      messageTemplate.cc = cc;
    }

    // Handle attachment if provided
    if (attachmentBase64String) {
      const mimeType = attachmentBase64String.split(';')[0].split(':')[1];
      const base64Content : any = attachmentBase64String.split(';base64,').pop();
      const fileBuffer = Buffer.from(base64Content, 'base64');
      let fileExtension = mimeType === "application/pdf" ? "pdf" : "xlsx";

      messageTemplate.attachments = [
        {
          filename: `attachment.${fileExtension}`,
          content: fileBuffer,
          encoding: 'base64',
          contentType: mimeType,
        }
      ];
    }

    // Send the email
    await transporter.sendMail(messageTemplate);
    return { success: true };

  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false };
  }
};

export default SendMail;
