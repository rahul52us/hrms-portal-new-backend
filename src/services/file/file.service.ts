import { Response } from "express";
import { uploadFileDocument, getFileStream } from "../../repository/file/file.repository";

export const uploadFileDocumentService = async (
  req: any,
  res: Response,
  next: any
) => {
  try {
    const { status, statusCode, data, message } : any = await uploadFileDocument({...req.body});

    if (status === "success") {
      return res.status(statusCode).send({
        message: message,
        data: data,
        status: status,
      });
    } else {
      return res.status(statusCode).send({
        data,
        message,
        status,
      });
    }
  } catch (err: any) {
    next(err);
  }
};

export const viewFileService = async (req: any, res: Response) => {
  try {
    const { fileId } = req.params;
    if (!fileId) return res.status(400).json({ status: "error", message: "fileId is required" });

    const { stream, contentType, filename } = await getFileStream(fileId);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    stream.pipe(res);
  } catch (err: any) {
    res.status(404).json({ status: "error", message: err.message || "File not found" });
  }
};