import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  getManagerLearnerAnswersService,
  getManagerLearnerProgressService,
  getManagerLearnersService,
  reviewManagerAnswerService,
} from "../services/manager/managerTracking.service";

const router = express.Router();

router.get("/learners", authenticate, getManagerLearnersService);
router.get("/learner-progress", authenticate, getManagerLearnerProgressService);
router.get("/learner-answers", authenticate, getManagerLearnerAnswersService);
router.post("/review-answer", authenticate, reviewManagerAnswerService);

export default router;
