import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  updateBankDetialsService,
  createUserservice,
  getCountDesignationStatusService,
  getTotalUsersService,
  updateUserProfileService,
  updateFamilyDetailsService,
  updateWorkExperienceService,
  updateDocumentService,
  updateCompanyDetailsService,
  getUserRoleUser,
  getManagersEmploysService,
  getManagerUsersCountsService,
  getUserInfoWithManagerService,
  getUserInfoWithManagerActionService,
  updatePermissionsService,
  getManagersOfUserService,
  getRoleCountOfCompanyService,
  getCompanyDetailsByIdService,
  updateQualifcationService,
  // UpdateSalaryStructureService,
  // getSalaryStructureService,
  getCompanyDetailsByUserIdService,
  getAllUserService,
  getUserByNameService,
  deleteUserService,
  createAdminUserservice,
  toggleUserStatusService
} from "../services/employe/user.service";

const router = express.Router();

router.post("/create", authenticate, createUserservice);
router.post("/admin/create", authenticate, createAdminUserservice);
router.put("/profile/:id", authenticate, updateUserProfileService);
router.put("/status/:id", authenticate, toggleUserStatusService);
router.delete("/profile/:id", authenticate, deleteUserService);
router.get('/details/:id',authenticate,getCompanyDetailsByIdService)
router.get("/:_id", getUserByNameService);
router.get('/companydetails/:id',authenticate,getCompanyDetailsByUserIdService)
router.post("/", authenticate, getAllUserService);
router.get("/managers/:id", authenticate, getManagersEmploysService);
// router.post('/salaryStructure',authenticate,getSalaryStructureService)
router.post("/total/count", authenticate, getTotalUsersService);
router.get("/designation/count", authenticate, getCountDesignationStatusService);
router.put("/bankDetails/:id",authenticate,updateBankDetialsService)
router.put('/companyDetails/:id',authenticate,updateCompanyDetailsService)
router.put('/familyDetails/:id',authenticate,updateFamilyDetailsService)
router.put('/workExperience/:id',authenticate,updateWorkExperienceService)
// router.put('/salaryStructure/:id',authenticate,UpdateSalaryStructureService)
router.put('/updateDocuments/:id',authenticate,updateDocumentService)
router.put('/qualifications/:id',authenticate,updateQualifcationService)
router.put('/permissions/:id',authenticate,updatePermissionsService)
router.get('/users/roles',authenticate,getUserRoleUser)
router.post('/managers/Users/count',authenticate,getManagerUsersCountsService)
router.post('/info/Subordinate',getUserInfoWithManagerService)
router.get('/info/Subordinate/:id',getUserInfoWithManagerActionService)
router.get('/getManagers/:userId', getManagersOfUserService)
router.get('/get/roles/count',authenticate,getRoleCountOfCompanyService)

export default router;