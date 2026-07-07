import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv'

dotenv.config()
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadFile(file: any): Promise<string> {
  try {
    let uploadContent = null;
    let filename = "";

    if (typeof file === 'string') {
      uploadContent = file;
    } else if (file && typeof file === 'object') {
      uploadContent = file.buffer || file.url || file.data;
      filename = file.filename || file.name || "";
    }

    if (!uploadContent) {
      throw new Error("No upload content provided");
    }

    const options: any = {
      resource_type: 'auto'
    };

    if (filename) {
      options.public_id = filename.replace(/\.[^/.]+$/, "");
    }

    const result = await cloudinary.uploader.upload(uploadContent, options);
    return result.secure_url;
  } catch (error: any) {
    console.error("Cloudinary Upload Error:", error?.message || error);
    throw new Error('Failed to upload file to Cloudinary: ' + (error?.message || "Unknown error"));
  }
}

// Upload from base64 string — returns { url, publicId }
async function uploadBase64(
  base64String: string,
  folder: string = 'workflow_logos'
): Promise<{ url: string; publicId: string }> {
  try {
    const result = await cloudinary.uploader.upload(base64String, {
      folder,
      resource_type: 'auto',
    });
    return { url: result.secure_url, publicId: result.public_id };
  } catch (error: any) {
    throw new Error('Failed to upload logo to Cloudinary: ' + error.message);
  }
}

async function deleteFile(public_id: string): Promise<boolean> {
  try {
    const result = await cloudinary.uploader.destroy(`${process.env.bucketFolder_Name}/${public_id?.replace(/\.[^/.]+$/, "")}`);
    if (result.result === 'ok') {
      return true;
    } else {
      return false;
    }
  } catch (error : any) {
    return false;
  }
}

export { uploadFile, deleteFile,uploadBase64 };
