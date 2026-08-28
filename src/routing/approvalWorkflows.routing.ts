import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  archiveApprovalWorkflowService,
  createApprovalWorkflowService,
  createApprovalWorkflowVersionService,
  getApprovalWorkflowService,
  listApprovalWorkflowsService,
  publishApprovalWorkflowVersionService,
  updateApprovalWorkflowVersionService,
} from "../services/approval/approvalWorkflow.service";

const approvalWorkflowsRouting = express.Router();

approvalWorkflowsRouting.use(authenticate);
approvalWorkflowsRouting.get("/", listApprovalWorkflowsService);
approvalWorkflowsRouting.post("/", createApprovalWorkflowService);
approvalWorkflowsRouting.get("/:workflowId", getApprovalWorkflowService);
approvalWorkflowsRouting.post("/:workflowId/archive", archiveApprovalWorkflowService);
approvalWorkflowsRouting.post("/:workflowId/versions", createApprovalWorkflowVersionService);
approvalWorkflowsRouting.put("/:workflowId/versions/:versionId", updateApprovalWorkflowVersionService);
approvalWorkflowsRouting.post(
  "/:workflowId/versions/:versionId/publish",
  publishApprovalWorkflowVersionService
);

export default approvalWorkflowsRouting;
