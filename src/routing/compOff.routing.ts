import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  approveCompOffClaimService,
  createCompOffClaimService,
  getCompOffClaimService,
  getCompOffEligibilityService,
  listCompOffClaimsService,
  listCompOffCreditsService,
  rejectCompOffClaimService,
  revokeCompOffClaimService,
  withdrawCompOffClaimService,
} from "../services/compOff/compOffClaim.service";

const compOffRouting = express.Router();

compOffRouting.use(authenticate);
compOffRouting.get("/eligibility", getCompOffEligibilityService);
compOffRouting.get("/credits", listCompOffCreditsService);
compOffRouting.post("/claims", createCompOffClaimService);
compOffRouting.get("/claims", listCompOffClaimsService);
compOffRouting.get("/claims/:claimId", getCompOffClaimService);
compOffRouting.post("/claims/:claimId/approve", approveCompOffClaimService);
compOffRouting.post("/claims/:claimId/reject", rejectCompOffClaimService);
compOffRouting.post("/claims/:claimId/revoke", revokeCompOffClaimService);
compOffRouting.post("/claims/:claimId/withdraw", withdrawCompOffClaimService);

export default compOffRouting;
