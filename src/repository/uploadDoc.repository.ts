import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv'
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

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

type BunnyUploadInput = {
  file?: string | Buffer;
  filename?: string;
  name?: string;
  type?: string;
  folder?: string;
};

function getBunnyConfig() {
  const storageZone = process.env.BUNNY_STORAGE_ZONE;
  const accessKey = process.env.BUNNY_STORAGE_ACCESS_KEY;
  const baseUrl = process.env.BUNNY_STORAGE_BASE_URL || "https://storage.bunnycdn.com";

  if (!storageZone || !accessKey) {
    throw new Error("Bunny storage is not configured");
  }

  return { storageZone, accessKey, baseUrl };
}

function normalizeBase64Input(file: string | Buffer | undefined) {
  if (!file) return null;
  if (Buffer.isBuffer(file)) return file;
  const input = String(file);
  const base64 = input.includes("base64,") ? input.split("base64,").pop() || "" : input;
  return Buffer.from(base64, "base64");
}

async function uploadToBunny(input: BunnyUploadInput): Promise<{ url: string; fileName: string; path: string }> {
  const { storageZone, accessKey, baseUrl } = getBunnyConfig();
  const buffer = normalizeBase64Input(input.file);

  if (!buffer) {
    throw new Error("No file data provided for Bunny upload");
  }

  const safeName = String(input.filename || input.name || `file-${uuidv4()}`)
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "");
  const folder = String(input.folder || "employee-documents").replace(/^\/+|\/+$/g, "");
  const filePath = `${folder}/${Date.now()}-${uuidv4()}-${safeName}`;
  const uploadUrl = `${baseUrl.replace(/\/+$/, "")}/${storageZone}/${filePath}`;

  await axios.put(uploadUrl, buffer, {
    headers: {
      AccessKey: accessKey,
      "Content-Type": input.type || "application/octet-stream",
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const publicBase = process.env.BUNNY_PUBLIC_BASE_URL;
  const url = publicBase
    ? `${publicBase.replace(/\/+$/, "")}/${filePath}`
    : `https://${storageZone}.b-cdn.net/${filePath}`;

  return {
    url,
    fileName: safeName,
    path: filePath,
  };
}

export { uploadFile, deleteFile,uploadBase64, uploadToBunny };
