import express from "express";
import { uploadFileDocumentService, viewFileService } from "../services/file/file.service";

const fileRouting = express.Router();
fileRouting.post("/upload", uploadFileDocumentService);
fileRouting.get("/view/:fileId", viewFileService);


export default fileRouting;
