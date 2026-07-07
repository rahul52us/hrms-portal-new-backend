import express from 'express'
import authenticate from "../modules/config/authenticate";
import { createDepartmentService, deleteDepartmentService, getDepartmentsService, updateDepartmentService } from '../services/department/department.service';


const departmentRouting = express.Router()
departmentRouting.post("/create",authenticate, createDepartmentService);
departmentRouting.put("/update/:id",authenticate, updateDepartmentService);
departmentRouting.delete("/delete/:id", authenticate, deleteDepartmentService);
departmentRouting.get("/list",authenticate, getDepartmentsService);

export default departmentRouting;