import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  getOrganizationChildrenService,
  getOrganizationHierarchyService,
  getOrganizationPersonService,
  getOrganizationRootsService,
  listOrganizationPeopleService,
} from "../services/organization/organization.service";

const router = express.Router();

router.get("/", authenticate, getOrganizationHierarchyService);
router.get("/roots", authenticate, getOrganizationRootsService);
router.get("/children", authenticate, getOrganizationChildrenService);
router.get("/list", authenticate, listOrganizationPeopleService);
router.get("/person/:userId", authenticate, getOrganizationPersonService);

export default router;
