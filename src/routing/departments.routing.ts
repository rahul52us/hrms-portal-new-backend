import express from 'express'
import authenticate from "../modules/config/authenticate";
import {
  addDepartmentTeamService,
  assignDepartmentHeadService,
  createDepartmentService,
  deleteDepartmentService,
  deleteDepartmentTeamService,
  getDepartmentsService,
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
departmentRouting.delete("/delete/:id", authenticate, deleteDepartmentService);
departmentRouting.get("/list",authenticate, getDepartmentsService);

export default departmentRouting;
