import express from "express";
import { verifyToken } from "../../services/token/token.service";
const router = express.Router();

router.post("/verify", verifyToken);

export default router;