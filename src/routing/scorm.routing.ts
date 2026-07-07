import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  commitScormTrackingService,
  finishScormTrackingService,
  getMyScormAnswersService,
  getScormProgressService,
  initializeScormTrackingService,
  updateSectionProgressService,
} from "../services/scorm/scormTracking.service";

import { decodeScormPayloadMiddleware } from "../middlewares/scormPayload.middleware";

const router = express.Router();

router.post("/initialize", authenticate, initializeScormTrackingService);
router.post("/commit", authenticate, decodeScormPayloadMiddleware, commitScormTrackingService);
router.post("/finish", authenticate, decodeScormPayloadMiddleware, finishScormTrackingService);
router.post("/section-progress", authenticate, decodeScormPayloadMiddleware, updateSectionProgressService);
router.get("/progress", authenticate, getScormProgressService);
router.get("/answers", authenticate, getMyScormAnswersService);

export default router;
