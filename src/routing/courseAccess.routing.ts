import express from "express";
import multer from "multer";
import authenticate from "../modules/config/authenticate";
import {
  createCourseAccessService,
  enrollInPublicCourseService,
  getAccessibleCoursesService,
  getCourseAssignmentsAuditService,
  getAssignedCoursesService,
  revokeCourseAccessService,
} from "../services/courseAccess/courseAccess.service";
import {
  assignCourseService,
  previewCourseAssignmentUploadService,
} from "../services/courseAccess/courseAssignment.service";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

router.post("/course-access", authenticate, createCourseAccessService);
router.post("/courses/:courseId/enroll", authenticate, enrollInPublicCourseService);
router.get("/courses/accessible", authenticate, getAccessibleCoursesService);
router.get("/courses/assigned", authenticate, getAssignedCoursesService);
router.get("/course-assignments", authenticate, getCourseAssignmentsAuditService);
router.post("/course-assign/preview", authenticate, upload.single("file"), previewCourseAssignmentUploadService);
router.post("/course-assign", authenticate, upload.single("file"), assignCourseService);
router.delete("/course-access/revoke/:id", authenticate, revokeCourseAccessService);

export default router;
