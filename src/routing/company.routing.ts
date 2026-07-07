import express from "express";
import {
  createCompany,
  createOrganisationCompany,
  filterCompany,
  getCompanyDetails,
  updatedCompanyDetails,
  updateCompanyPreferences,
  updateOrganisationCompany,
} from "../modules/organisation/Company";
import {
  createManagedCompanyService,
  deleteManagedCompanyService,
  getCompanyCountService,
  getCompanyDetailsByNameService,
  getCompanyPoliciesService,
  getHolidayService,
  getIndividualPolicyService,
  getManagedCompaniesService,
  getOrganisationsCompanyService,
  getWorkLocationservice,
  getWorkTimingService,
  updateManagedCompanyStatusService,
  updateCompanyPolicyService,
  updateHolidayExcelService,
  updateHolidayService,
  updateWorkLocationExcelService,
  updateWorkLocationService,
  updateWorkTimingService,
} from "../services/company/company.service";
import authenticate from "../modules/config/authenticate";

const router = express.Router();

router.post("/create", createCompany);
router.post("/manage", authenticate, createManagedCompanyService);
router.post("/update", authenticate, updatedCompanyDetails);
router.post("/updateOperatingHours", authenticate, updateCompanyPreferences);
router.post("/single/create", authenticate, createOrganisationCompany);

router.delete("/:id", authenticate, deleteManagedCompanyService);
router.put("/policy", authenticate, updateCompanyPolicyService);
router.put("/:id/status", authenticate, updateManagedCompanyStatusService);
router.put("/:id", authenticate, updateOrganisationCompany);
router.put("/policy/holidays", authenticate, updateHolidayService);
router.put("/policy/holidays/excel", authenticate, updateHolidayExcelService);
router.put("/policy/workTiming", authenticate, updateWorkTimingService);
router.put("/policy/workLocation", authenticate, updateWorkLocationService);
router.put("/policy/workLocations/excel", authenticate, updateWorkLocationExcelService);

router.get("/count", authenticate, getCompanyCountService);
router.get("/manage", authenticate, getManagedCompaniesService);
router.get("/policy", authenticate, getIndividualPolicyService);
router.get("/companies", authenticate, getOrganisationsCompanyService);
router.get("/search", filterCompany);
router.get("/details", getCompanyDetailsByNameService);
router.get("/policies", authenticate, getCompanyPoliciesService);
router.get("/policy/holidays", authenticate, getHolidayService);
router.get("/policy/workLocations", authenticate, getWorkLocationservice);
router.get("/policy/workTiming", authenticate, getWorkTimingService);
router.get("/:company", getCompanyDetails);

export default router;
