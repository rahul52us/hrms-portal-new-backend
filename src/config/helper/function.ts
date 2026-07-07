import mongoose from "mongoose";
import { statusCode } from "./statusCode";

// utils/security.ts
import bcrypt from "bcryptjs"; // Lightweight bcrypt for frontend
import CryptoJS from "crypto-js"; // AES encryption

const SECRET_KEY = "myanothdasd55das45dasernewkey775sda85dadas5"; // Store in env or config

// AES Encrypt
export const encryptAES = (text: string): string => {
  return CryptoJS.AES.encrypt(text, SECRET_KEY).toString();
};

// AES Decrypt
export const decryptAES = (cipher: string): string => {
  const bytes = CryptoJS.AES.decrypt(cipher, SECRET_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
};

// Bcrypt Hash
export const hashBcrypt = async (text: string): Promise<string> => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(text, salt);
};

// Bcrypt Compare
export const compareBcrypt = async (text: string, hash: string): Promise<boolean> => {
  return await bcrypt.compare(text, hash);
};


export const createCatchError = (err: any) => {
  return {
    status: "error",
    data: err?.message,
    statusCode: statusCode.serverError,
    message: err?.message,
  };
};

export const convertIdsToObjects = async (data : any) => {
  try
  {
    if(!Array.isArray(data)){
      data = [data]
    }
    data = data.map((item : string) => new mongoose.Types.ObjectId(item))
    return data || []
  }
  catch{
    return []
  }
}

export function generateFileName(originalName: string): string {
  const randomChars = Math.random().toString(36).substring(2, 7); // Generate 5 random alphanumeric characters
  const extension = originalName?.split('.').pop(); // Get the file extension
  const baseName = originalName?.replace(/\.[^/.]+$/, ""); // Get the file name without the extension

  return `${randomChars}_${baseName}.${extension}`; // Combine random characters, base name, and extension
}



// import crypto from "crypto";
// import dotenv from 'dotenv';
// import { v4 as uuidv4 } from "uuid";
// import Razorpay from "razorpay";
// import axios from 'axios';
// import OrderPayment from "./schemas/OrderPayment.shchema";

// dotenv.config();

// const instance = new Razorpay({
//   key_id: process.env.RAZORPAY_KEY_ID,
//   key_secret: process.env.RAZORPAY_SECRET_KEY
// });

// // Function to fetch the payment status from Razorpay
// export const fetchPaymentStatus = async (paymentId : string) => {
//   try {
//     const key_id = process.env.RAZORPAY_KEY_ID;
//     const key_secret = process.env.RAZORPAY_SECRET_KEY;

//     const auth = Buffer.from(`${key_id}:${key_secret}`).toString('base64');

//     const response = await axios.get(`https://api.razorpay.com/v1/payments/${paymentId}`, {
//       headers: {
//         Authorization: `Basic ${auth}`,
//       },
//     });

//     return {
//       status: 'success',
//       data: response.data,
//     };
//   } catch (error) {
//     console.error('Error fetching payment status:', error.response.data);
//     return {
//       status: 'error',
//       message: error.response.data,
//     };
//   }
// };

// export const createOrderPayment = async (data : any) => {
//   const uniqueReceipt = `receipt_${uuidv4().slice(0, 25)}`;

//   try {
//     const options = {
//       amount: data.amount * 100, // Amount in paise
//       currency: "INR",
//       receipt: uniqueReceipt
//     };

//     const order = await instance.orders.create(options);

//     const orderPayment = new OrderPayment({
//       user: data.user,
//       order_id: order.id,
//       receipt: order.receipt,
//       amount: order.amount,
//       amount_due: order.amount_due,
//       amount_paid: order.amount_paid,
//       currency: order.currency,
//       offer_id: order.offer_id,
//       status: order.status,
//     });

//     const savedPayment = await orderPayment.save();

//     return {
//       status: "success",
//       statusCode: 201,
//       data: { ...savedPayment?.toObject(), ...order },
//       message: "Order has been initiated successfully",
//     };
//   } catch (err) {
//     console.log(err);
//     return {
//       status: "error",
//       statusCode: 500,
//       data: err?.message,
//       message: "Internal server error",
//     };
//   }
// };

// export const verifyPayment = async (data : any) => {
//   const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = data;

//   const secret = process.env.RAZORPAY_SECRET_KEY;

//   const shasum = crypto.createHmac("sha256", secret);
//   shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
//   const digest = shasum.digest("hex");

//   if (digest === razorpay_signature) {
//     const dt = await OrderPayment.findOne({ order_id: razorpay_order_id });
//     if (dt) {
//       // Fetch the actual payment status from Razorpay
//       const paymentStatus = await fetchPaymentStatus(razorpay_payment_id);
//       // Update the order status based on the fetched payment status
//       if (paymentStatus.data.status === 'captured') {
//         dt.payment_id = razorpay_payment_id;
//         dt.signature = razorpay_signature;
//         dt.status = 'captured';
//         dt.payment_details.method = paymentStatus.data?.method,
//         dt.payment_details.details = paymentStatus.data
//       } else if (paymentStatus.data.status === 'failed') {
//         dt.status = 'failed'
//       } else {
//         dt.status = 'pending';
//       }

//       await dt.save();

//       return {
//         statusCode: 200,
//         status: "success",
//         message: "Payment verified successfully",
//         data: "Payment verified successfully",
//       };
//     } else {
//       return {
//         statusCode: 400,
//         status: "error",
//         message: "Order not found",
//         data: "Order not found",
//       };
//     }
//   } else {
//     return {
//       statusCode: 400,
//       status: "error",
//       message: "Payment verification failed",
//       data: "Payment verification failed",
//     };
//   }
// };

// export const verifyOrderPayment = async (data : any) => {
//   try {
//     const orderData = await OrderPayment.findByIdAndUpdate(
//       data.id,
//       { $set: data },
//       { new: true }
//     );

//     if (orderData) {
//       return {
//         statusCode: 200,
//         data: orderData,
//         status: "success",
//         message: "Order has been updated successfully",
//       };
//     } else {
//       return {
//         statusCode: 404,
//         data: "Order does not exist",
//         status: "error",
//         message: "Order does not exist",
//       };
//     }
//   } catch (err) {
//     return {
//       statusCode: 500,
//       status: "error",
//       message: "Internal server error",
//     };
//   }
// };
