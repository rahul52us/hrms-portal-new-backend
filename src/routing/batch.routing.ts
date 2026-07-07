import express from "express";
import multer from "multer";
import authenticate from "../modules/config/authenticate";
import {
  createBatchService,
  deleteBatchService,
  getBatchDetailsService,
  getMyBatchesService,
  getMyCourseDetailsService,
  getMyCoursesService,
  listBatchesService,
  previewBatchUploadService,
  updateBatchService,
} from "../services/batch/batch.service";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

router.post("/batches", authenticate, upload.single("file"), createBatchService);
router.post("/batches/preview-upload", authenticate, upload.single("file"), previewBatchUploadService);
router.get("/batches", authenticate, listBatchesService);
router.put("/batches/:id", authenticate, upload.single("file"), updateBatchService);
router.delete("/batches/:id", authenticate, deleteBatchService);
router.get("/batches/:id", authenticate, getBatchDetailsService);
router.get("/my-courses/:courseId", authenticate, getMyCourseDetailsService);
router.get("/my-courses", authenticate, getMyCoursesService);
router.get("/my-batches", authenticate, getMyBatchesService);

export default router;
