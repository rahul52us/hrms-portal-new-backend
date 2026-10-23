import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  projectOptions, projectPeople, listProjects, getProject, createProject, updateProject,
  changeProjectStatus, listWorkTypes, saveWorkType, listAssignments, createAssignments,
  endAssignment, projectAudit,
} from "../services/project/project.service";

const router = express.Router();
router.use(authenticate);
router.get("/options", projectOptions);
router.get("/people", projectPeople);
router.get("/", listProjects);
router.post("/", createProject);
router.get("/:projectId", getProject);
router.put("/:projectId", updateProject);
router.post("/:projectId/archive", changeProjectStatus("archived"));
router.post("/:projectId/restore", changeProjectStatus("active"));
router.get("/:projectId/work-types", listWorkTypes);
router.post("/:projectId/work-types", saveWorkType);
router.put("/:projectId/work-types/:workTypeId", saveWorkType);
router.get("/:projectId/assignments", listAssignments);
router.post("/:projectId/assignments", createAssignments);
router.post("/:projectId/assignments/:assignmentId/end", endAssignment);
router.get("/:projectId/audit", projectAudit);
export default router;
