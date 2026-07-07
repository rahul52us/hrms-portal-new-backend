// import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import UserModel from "../../schemas/User/User";
// import appointmentsSchema from "../../schemas/appointments/appointments.schema";
// import LabItemModal from "../../schemas/labItems/labItems.schema";
import { DocumentModel } from "../../schemas/document/document.schema";
import { WorkflowModel } from "../../schemas/workflow/workflow.schema";

const parseLevelExpression = (input: any) => ({
  $convert: {
    input: {
      $let: {
        vars: {
          levelValue: { $toString: input },
        },
        in: {
          $cond: [
            { $regexMatch: { input: "$$levelValue", regex: /^level-/i } },
            { $arrayElemAt: [{ $split: ["$$levelValue", "-"] }, 1] },
            "$$levelValue",
          ],
        },
      },
    },
    to: "int",
    onError: 0,
    onNull: 0,
  },
});

const toObjectIdExpression = (input: any) => ({
  $convert: {
    input,
    to: "objectId",
    onError: null,
    onNull: null,
  },
});

const isAdminRequest = (req: any) => {
  const role = String(req?.bodyData?.role || "").toLowerCase();
  const userType = String(req?.bodyData?.userType || "").toLowerCase();

  return role === "admin" || role === "superadmin" || userType === "admin" || userType === "superadmin";
};

const resolveWorkflowObjectId = (workflowId?: string) => {
  if (!workflowId || !mongoose.Types.ObjectId.isValid(workflowId)) {
    return null;
  }

  return new mongoose.Types.ObjectId(workflowId);
};

const buildLevelApprovalPresenceExpression = (
  levelVariable: string,
  action: "approved" | "rejected"
) => ({
  $gt: [
    {
      $size: {
        $filter: {
          input: { $ifNull: ["$approval", []] },
          as: "approvalEntry",
          cond: {
            $and: [
              {
                $eq: [parseLevelExpression("$$approvalEntry.level"), levelVariable],
              },
              {
                $eq: [{ $ifNull: ["$$approvalEntry.action", "$$approvalEntry.status"] }, action],
              },
            ],
          },
        },
      },
    },
    0,
  ],
});

const buildLastApprovalRejectedExpression = (levelVariable: string) => ({
  $and: [
    { $eq: [parseLevelExpression("$lastApproval.level"), levelVariable] },
    { $eq: [{ $ifNull: ["$lastApproval.action", "$lastApproval.status"] }, "rejected"] },
  ],
});




