import nodemailer from "nodemailer";
import * as fs from 'fs';
import * as path from 'path'
import dotenv from 'dotenv'

dotenv.config()

const SendMail = (names: string, username: string, link: string, subject : string, fileName :string) => {
  const transporter = nodemailer.createTransport({
  host: "smtp.hostinger.com", // SMTP server hostnam
  port: 587, // SMTP server port
  secure: false, // Use SSL/TLS
  auth: {
    user: process.env.WELCOME_REGISTER_EMAIL_USERNAME,
    pass: process.env.WELCOME_REGISTER_EMAIL_PASSWORD
  },
});

const templatePath = path.join(__dirname,'templates',fileName);

const template = fs.readFileSync(templatePath, 'utf8');

const personalizedTemplate = template
  .replace('{{name}}', names)
  .replace('{{link}}', link);

// Create an email message
const message = {
    from: process.env.WELCOME_REGISTER_EMAIL_USERNAME,
    to: username,
    subject:subject,
    html: personalizedTemplate,
  };

  // Send the email
  return new Promise((resolve) => {
    transporter.sendMail(message, (err) => {
      if (err) {
        resolve({success: false}); // Reject the promise in case of error
      } else {
        resolve({success : true}); // Resolve the promise if the email is sent successfully
      }
    });
  })
}

export default SendMail;