import express from 'express'
import authenticate from "../modules/config/authenticate";
import {
  addDepartmentTeamService,
  archiveDepartmentService,
  assignDepartmentHeadService,
  createDepartmentService,
  deleteDepartmentTeamService,
  getDepartmentArchiveImpactService,
  getDepartmentTransferPreviewService,
  getDepartmentsService,
  transferDepartmentEmployeesService,
  updateDepartmentService,
  updateDepartmentTeamService,
} from '../services/department/department.service';


const departmentRouting = express.Router()
departmentRouting.post("/create",authenticate, createDepartmentService);
departmentRouting.put("/update/:id",authenticate, updateDepartmentService);
departmentRouting.put("/head/:id", authenticate, assignDepartmentHeadService);
departmentRouting.post("/:id/teams", authenticate, addDepartmentTeamService);
departmentRouting.put("/:id/teams/:teamId", authenticate, updateDepartmentTeamService);
departmentRouting.delete("/:id/teams/:teamId", authenticate, deleteDepartmentTeamService);
departmentRouting.get("/:id/archive-impact", authenticate, getDepartmentArchiveImpactService);
departmentRouting.get("/:id/transfer-preview", authenticate, getDepartmentTransferPreviewService);
departmentRouting.post("/:id/transfer-employees", authenticate, transferDepartmentEmployeesService);
departmentRouting.post("/:id/archive", authenticate, archiveDepartmentService);
departmentRouting.get("/list",authenticate, getDepartmentsService);

export default departmentRouting;
