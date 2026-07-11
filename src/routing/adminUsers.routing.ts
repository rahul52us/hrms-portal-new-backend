import express from "express";
import multer from "multer";
import authenticate from "../modules/config/authenticate";
import {
  bulkManagedUsersHandler,
  createCompanyAdminHandler,
  createManagedUserHandler,
  deleteManagedUserHandler,
  downloadBulkUploadTemplateHandler,
  getPermissionConfigHandler,
  listManagedUsersHandler,
  updateManagedUserStatusHandler,
  updateRolePermissionsHandler,
  updateManagedUserHandler,
  updateUserPermissionsHandler,
} from "../services/adminUsers/adminUsers.service";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get("/", authenticate, listManagedUsersHandler);
router.get("/bulk/template", authenticate, downloadBulkUploadTemplateHandler);
router.get("/permissions/config", authenticate, getPermissionConfigHandler);
router.post("/company-admin", authenticate, createCompanyAdminHandler);
router.post("/", authenticate, createManagedUserHandler);
router.post("/bulk", authenticate, upload.single("file"), bulkManagedUsersHandler);
router.delete("/:id", authenticate, deleteManagedUserHandler);
router.put("/permissions/roles/:role", authenticate, updateRolePermissionsHandler);
router.put("/:id/permissions", authenticate, updateUserPermissionsHandler);
router.put("/:id/status", authenticate, updateManagedUserStatusHandler);
router.put("/:id", authenticate, updateManagedUserHandler);

export default router;
