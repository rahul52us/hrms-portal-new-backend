import express from "express";
import authenticate from "../modules/config/authenticate";
import { getOrganizationHierarchyService } from "../services/organization/organization.service";

const router = express.Router();

router.get("/", authenticate, getOrganizationHierarchyService);

export default router;

