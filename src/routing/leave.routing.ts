import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  adjustLeaveBalanceService,
  addLeaveRequestDocumentsService,
  approveLeaveRequestService,
  cancelLeaveRequestService,
  createLeaveRequestService,
  getEligibleLeaveTypesService,
  getLeaveRequestService,
  listLeaveBalancesService,
  listLeaveRequestsService,
  listLeaveTransactionsService,
  previewLeaveRequestService,
  rebuildLeaveBalanceService,
  runLeaveAccrualCatchUpService,
  rejectLeaveRequestService,
  withdrawLeaveRequestService,
  uploadLeaveAttachmentService,
  verifyLeaveRequestDocumentsService,
  waiveLeaveRequestDocumentsService,
} from "../services/leave/leaveRequest.service";
import {
  approveLeaveCancellationRequestService,
  createLeaveCancellationRequestService,
  getLeaveCancellationRequestService,
  listLeaveCancellationRequestsService,
  rejectLeaveCancellationRequestService,
  withdrawLeaveCancellationRequestService,
} from "../services/leave/leaveCancellationRequest.service";
import {
  approveLeaveEncashmentRequestService,
  cancelApprovedLeaveEncashmentRequestService,
  createLeaveEncashmentRequestService,
  getLeaveEncashmentEligibilityService,
  getLeaveEncashmentRequestService,
  listLeaveEncashmentRequestsService,
  rejectLeaveEncashmentRequestService,
  settleLeaveEncashmentRequestService,
  withdrawLeaveEncashmentRequestService,
} from "../services/leave/leaveEncashmentRequest.service";

const leaveRouting = express.Router();

leaveRouting.use(authenticate);
leaveRouting.get("/eligible", getEligibleLeaveTypesService);
leaveRouting.get("/balances", listLeaveBalancesService);
leaveRouting.get("/transactions", listLeaveTransactionsService);
leaveRouting.post("/attachments", uploadLeaveAttachmentService);
leaveRouting.post("/balances/adjustments", adjustLeaveBalanceService);
leaveRouting.post("/balances/rebuild", rebuildLeaveBalanceService);
leaveRouting.post("/accruals/run", runLeaveAccrualCatchUpService);
leaveRouting.post("/requests/preview", previewLeaveRequestService);
leaveRouting.post("/requests", createLeaveRequestService);
leaveRouting.get("/requests", listLeaveRequestsService);
leaveRouting.get("/requests/:requestId", getLeaveRequestService);
leaveRouting.post("/requests/:requestId/documents", addLeaveRequestDocumentsService);
leaveRouting.post("/requests/:requestId/documents/verify", verifyLeaveRequestDocumentsService);
leaveRouting.post("/requests/:requestId/documents/waive", waiveLeaveRequestDocumentsService);
leaveRouting.post("/requests/:requestId/approve", approveLeaveRequestService);
leaveRouting.post("/requests/:requestId/reject", rejectLeaveRequestService);
leaveRouting.post("/requests/:requestId/withdraw", withdrawLeaveRequestService);
leaveRouting.post("/requests/:requestId/cancel", cancelLeaveRequestService);
leaveRouting.post("/requests/:requestId/cancellation-requests", createLeaveCancellationRequestService);
leaveRouting.get("/cancellation-requests", listLeaveCancellationRequestsService);
leaveRouting.get("/cancellation-requests/:cancellationRequestId", getLeaveCancellationRequestService);
leaveRouting.post(
  "/cancellation-requests/:cancellationRequestId/approve",
  approveLeaveCancellationRequestService
);
leaveRouting.post(
  "/cancellation-requests/:cancellationRequestId/reject",
  rejectLeaveCancellationRequestService
);
leaveRouting.post(
  "/cancellation-requests/:cancellationRequestId/withdraw",
  withdrawLeaveCancellationRequestService
);
leaveRouting.get("/encashments/eligible", getLeaveEncashmentEligibilityService);
leaveRouting.post("/encashments", createLeaveEncashmentRequestService);
leaveRouting.get("/encashments", listLeaveEncashmentRequestsService);
leaveRouting.get("/encashments/:encashmentRequestId", getLeaveEncashmentRequestService);
leaveRouting.post(
  "/encashments/:encashmentRequestId/approve",
  approveLeaveEncashmentRequestService
);
leaveRouting.post(
  "/encashments/:encashmentRequestId/reject",
  rejectLeaveEncashmentRequestService
);
leaveRouting.post(
  "/encashments/:encashmentRequestId/withdraw",
  withdrawLeaveEncashmentRequestService
);
leaveRouting.post(
  "/encashments/:encashmentRequestId/settle",
  settleLeaveEncashmentRequestService
);
leaveRouting.post(
  "/encashments/:encashmentRequestId/cancel",
  cancelApprovedLeaveEncashmentRequestService
);

export default leaveRouting;
