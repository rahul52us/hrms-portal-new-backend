import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  approveRemoteWorkRequestService,
  cancelRemoteWorkRequestService,
  createRemoteWorkRequestService,
  getRemoteWorkEligibilityService,
  getRemoteWorkRequestService,
  listRemoteWorkRequestsService,
  previewRemoteWorkRequestService,
  rejectRemoteWorkRequestService,
  withdrawRemoteWorkRequestService,
} from "../services/remoteWork/remoteWorkRequest.service";

const remoteWorkRouting = express.Router();

remoteWorkRouting.use(authenticate);
remoteWorkRouting.get("/eligibility", getRemoteWorkEligibilityService);
remoteWorkRouting.post("/requests/preview", previewRemoteWorkRequestService);
remoteWorkRouting.post("/requests", createRemoteWorkRequestService);
remoteWorkRouting.get("/requests", listRemoteWorkRequestsService);
remoteWorkRouting.get("/requests/:requestId", getRemoteWorkRequestService);
remoteWorkRouting.post("/requests/:requestId/approve", approveRemoteWorkRequestService);
remoteWorkRouting.post("/requests/:requestId/reject", rejectRemoteWorkRequestService);
remoteWorkRouting.post("/requests/:requestId/withdraw", withdrawRemoteWorkRequestService);
remoteWorkRouting.post("/requests/:requestId/cancel", cancelRemoteWorkRequestService);

export default remoteWorkRouting;
