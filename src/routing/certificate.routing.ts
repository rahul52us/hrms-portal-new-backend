import express from "express";
import multer from "multer";
import authenticate from "../modules/config/authenticate";
import {
  createCertificateTemplateService,
  downloadMyCertificateService,
  getMyCertificateService,
  issueMyCertificateService,
  listCertificateTemplatesService,
  previewCertificateTemplateService,
  updateCertificateTemplateService,
} from "../services/certificate/certificate.service";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

router.get("/templates", authenticate, listCertificateTemplatesService);
router.post("/templates", authenticate, upload.single("template"), createCertificateTemplateService);
router.get("/templates/:id/preview", authenticate, previewCertificateTemplateService);
router.patch("/templates/:id", authenticate, upload.single("template"), updateCertificateTemplateService);
router.get("/my/:courseId", authenticate, getMyCertificateService);
router.post("/my/:courseId/issue", authenticate, issueMyCertificateService);
router.get("/my/:courseId/download", authenticate, downloadMyCertificateService);

export default router;
