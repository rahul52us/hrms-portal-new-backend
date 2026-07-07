import { statusCode } from "../../config/helper/statusCode";
import { generateFileName } from "../../config/helper/function";
import { uploadFile } from "../uploadDoc.repository";
import mongoose from "mongoose";
import { GridFSBucket } from "mongodb";
import { Readable } from "stream";
import fileSystemSchema from "../../schemas/fileSystem/fileSystem.schema";
// import fileSystemSchema from "../../schemas/file/file.schema";

export const uploadFileDocument = async (data: any) => {
  try {
    if (data.file?.filename && data.file?.buffer && data.file) {
      data.file.filename = generateFileName(data.file.filename);
      const url = await uploadFile(data.file);
      return {
        status: "success",
        data: url,
        statusCode: statusCode.success,
        message: "Document has been uploaded",
      };
    }
  } catch (err: any) {
    return {
      status: "error",
      data: err?.message,
      statusCode: statusCode.serverError,
      message: err?.message,
    };
  }
};


export async function uploadDocumentFile(file: string, name: string, type: string) {
  return new Promise((resolve, reject) => {
      try {
          const connection = mongoose.connection;
          const bucket = new GridFSBucket(connection.db);

          const base64Data = file
          const buffer = Buffer.from(base64Data, 'base64');
          const readableStream = new Readable();
          readableStream.push(buffer);
          readableStream.push(null);

          const uploadStream : any = bucket.openUploadStream(name, {
              metadata: { contentType: type },
          });

          readableStream.pipe(uploadStream);

          uploadStream.on("finish", () => {
              const fileId = uploadStream.id;
              fileSystemSchema
                  .create({
                      fileId: fileId,
                  })
                  .then((data) => {
                      resolve(data);
                  })
                  .catch((err) => {
                      reject("File metadata saving failed");
                  });
          });

          uploadStream.on("error", (error : any) => {
              reject("Error uploading file: " + error.message);
          });
      } catch (err:any) {
          reject("Error uploading the file: " + err.message);
      }
  });
}

export async function getFileStream(fileId: string): Promise<{ stream: any; contentType: string; filename: string }> {
  try {
    const connection = mongoose.connection;
    const bucket = new GridFSBucket(connection.db);
    const oid = new mongoose.Types.ObjectId(fileId);

    const files = await bucket.find({ _id: oid }).toArray();
    if (!files || files.length === 0) {
      throw new Error("File not found");
    }
    const file = files[0];
    const stream = bucket.openDownloadStream(oid);
    return {
      stream,
      contentType: file.metadata?.contentType || "application/octet-stream",
      filename: file.filename,
    };
  } catch (err: any) {
    throw err;
  }
}