// import { createPendingApprovalFunction } from "../../repository/document/document.repository";
import { Response, Request } from "express";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
// import DocumentModel from "../../schemas/document/document.schema";
import { getSingleWorkFlowService, getWorkflowLevelService } from "../workflow/workflow.service";
import { uploadDocumentFile } from "../../repository/file/file.repository";
import {
  createPendingApproval,
  getApprovedDocumentsRepo,
  getDocumentsByWorkflow,
  getPendingDocumentsRepo,
  getRejectedDocumentsRepo,
  getWorkflowAccessContext,
  processDocumentApprovalAction,
  updateDocumentRepo,
} from "../../repository/document/document.repository";
import compileEmailTemplate from "../../helpers/email-template";
import sendMail from "../../helpers/mail";
import { DocumentModel } from "../../schemas/document/document.schema";
export const findOneByDocumentIdAndDelete = async (data: any) => {
  try {
    await DocumentModel.findOneAndDelete({ documentId: data.documentId });
    return {
      status: "success",
      data: "Document has been delete successfully",
    };
  } catch (err: any) {
    return {
      status: "err",
      message: err?.message,
    };
  }
};

const resolveAuthenticatedUser = (req: any) => {
  const user = req?.user || req?.bodyData || {};
  return {
    user,
    userId: req?.user?._id || req?.userId || user?._id,
    company: user?.company,
    username: user?.username || user?.email || "",
    defaultWorkflow: user?.defaultWorkflow,
  };
};

export async function createPendingApprovalFunction(req: any) {
  try {
    if (req.body.documentId && req.body.updateDocRecord === true) {
      await findOneByDocumentIdAndDelete({
        documentId: req.body?.documentId,
      });
    }

    let {
      values,
      file,
      tags,
      type,
      approval,
      originalValues,
      isUpperApproval,
      partnerName,
      partnerId,
      order_taken_by,
    } = req.body;
    const { user, userId: userID, company, username, defaultWorkflow } =
      resolveAuthenticatedUser(req);
    const workflowId = req.body.activeWorkflow || defaultWorkflow;

    if (!userID) {
      return {
        status: "error",
        statusCode: 401,
        message: "Unauthorized user",
        data: null,
      };
    }

    if (!workflowId) {
      return {
        status: "error",
        statusCode: 400,
        message: "Workflow does not exist",
        data: null,
      };
    }

    const workflowAccess = await getWorkflowAccessContext(
      String(workflowId),
      String(userID)
    );
    if (workflowAccess.status !== "success") {
      return workflowAccess;
    }
    const currentLevelValue = workflowAccess.data.userLevel;
    const currentLevel = `level-${currentLevelValue}`;

    const { status, data } = await getSingleWorkFlowService(
      req,
      workflowId
    );

    if (status === "success") {
      if (type === "word") {
        values = {
          user: userID,
          createdBy: userID,
          company: company,
          workflow: workflowId,
          values: {
            level: currentLevel,
            values: values,
            created_At: new Date(),
            updated_At: new Date(),
          },
          originalValues: values,
          tags: {
            extraction: {
              type: "automatic",
            },
          },
          documentType: type,
          approval: [
            {
              comment: approval.comment,
              type: approval.type,
              status: approval.status,
              name: approval.name || username,
              level: approval.level,
              userId: userID,
              createdAt: new Date(),
            },
          ],
          helpInfo: req.body.helpInfo || {},
        };
      } else if (type === "schema" || type === "signature_verification") {
        values = {
          user: userID,
          createdBy: userID,
          company: company,
          workflow: workflowId,
          values: originalValues
            ? [
                {
                  level: currentLevel,
                  values: values?.valuesData,
                  created_At: new Date(),
                },
              ]
            : {
                level: currentLevel,
                values: values,
                created_At: new Date(),
              },
          originalValues: originalValues || values.fields,
          tags: {
            extraction: {
              type: "automatic",
            },
          },
          documentType: type,
          approval: [],
          helpInfo: req.body.helpInfo || {},
        };
        if (file) {
          const uploadedFile: any = await uploadDocumentFile(
            file.file,
            file.name,
            file.type
          );
          values = { ...values, file: uploadedFile.fileId };
        }
      } else {
        let uploadedFile: any = null;
        if (file) {
          uploadedFile = await uploadDocumentFile(file.file, file.name, file.type);
        }

        values = {
          user: userID,
          createdBy: userID,
          company: company,
          partnerName: partnerName,
          partnerId: partnerId,
          order_taken_by: order_taken_by,
          workflow: workflowId,
          values: {
            level: currentLevel,
            values: values,
            created_At: new Date(),
            updated_At: new Date(),
          },
          originalValues: values,
          file: uploadedFile?.fileId || undefined,
          tags: tags,
          approval:
            approval?.length > 0
              ? [
                  {
                    comment: approval[0].comment,
                    type: approval[0].type,
                    status: approval[0].status,
                    name: approval[0].name || username,
                    level: approval[0].level,
                    userId: userID,
                    fileId: uploadedFile?.fileId || undefined,
                    createdAt: new Date(),
                  },
                ]
              : [],
          helpInfo: req.body.helpInfo || {},
        };
      }

      if (req.body.documentId) {
        values = { ...values, documentId: req.body.documentId };
      }

      let files: any = [];

      if (Array.isArray(data.values.table)) {
        let filterTable = data.values.table.filter(
          (item: any) => item.isActive === true
        );
        if (filterTable.length) {
          files = filterTable[0].columnName;
        }
      }

      const output = [];

      for (const item of files) {
        const { key, isFile } = item;

        let checkKeys: any = null;
        if (type === "schema") {
          checkKeys = req?.body?.values?.hasOwnProperty(key);
        } else {
          checkKeys = values.hasOwnProperty(key);
        }
        if (isFile && checkKeys) {
          const fileData = req?.body?.values[key];
          try {
            console.log("the filedata are", fileData);
            const uploadFiles: any = await uploadDocumentFile(
              fileData.file,
              fileData.name,
              fileData.type
            );
            output.push({ [key]: uploadFiles.fileId });
          } catch (error:any) {
            console.log(error.message);
          }
        }
      }

      for (const item of files) {
        const { key, isFile } = item;
        if (req?.body?.values[key]) {
          if (isFile) {
            if (type === "schema") {
              if (originalValues) {
                delete values[key];
              } else {
                delete values.values?.values?.[key];
              }
            }
            delete values[key];
          }
        }
      }

      values = { ...values, additionalFiles: output };

      const createdDocument = await createPendingApproval(values);
      let {
        currentUser,
        currentUserDetails,
        workflow,
        notifications,
        triggers,
        triggerMailForLevel1,
      } = await getWorkflowLevelService(
        workflowId,
        currentLevel,
        req.body.status
      );

      let commentText = "";
      if (req.body.comment) {
        commentText = ` and added the following comment: "${req.body.comment}"`;
      }

      let message;
      if (req.body.status === "approved") {
        // console.log("this is an approved state");

        message = `${
          username?.charAt(0)?.toUpperCase() +
          username?.slice(1)?.toLowerCase()
        } has ${
          req.body.status
        } the document and sent it for the approval in the next level process of the document.${
          commentText ? ` Added Comments: "${req.body.comment}"` : ""
        }`;
      }

      if (req.body.status === "pending") {
        message = `${
          username?.charAt(0)?.toUpperCase() +
          username?.slice(1)?.toLowerCase()
        } hasn't approved the document. The document status is ${
          req.body.status
        }.${commentText ? ` Added Comments: "${req.body.comment}"` : ""}`;
      }

      if (req.body.status === "rejected") {
        message = `${
          username?.charAt(0)?.toUpperCase() +
          username?.slice(1)?.toLowerCase()
        } hasn't approved the document. The document status is ${
          req.body.status
        }.${commentText ? ` Added Comments: "${req.body.comment}"` : ""}`;
      }

      const datas = {
        user: userID,
        message: message,
        documentId: createdDocument?._id,
        type: req.body.type,
        workflow: workflowId,
      };

      const notificationsPromises = currentUser.map(
        async (userId: any, index: number) => {
          const userData = {
            ...datas,
            receiver: userId,
          };

          try {
            const filterNotify = notifications?.filter(
              (item: any) =>
                item.level.includes(currentUserDetails[index].level) &&
                item.approval.includes(req.body.status) &&
                item.isActive
            );

            if (filterNotify && filterNotify.length > 0) {
              const emailResults = [];
              const smsResults = [];
              const notificationResults = [];

              for (const notifyItem of filterNotify) {
                if (notifyItem.type.includes("notification")) {
                  // await createNotificationsService(userData);
                  notificationResults.push({
                    status: "success",
                    message: `Notification created for user ${userId}`,
                  });
                }

                if (notifyItem.type.includes("email")) {
                  const dt: any = {
                    username,
                    approver: currentUserDetails[index].username,
                    status: req.body.status,
                    workflow: workflow?.workFlowName,
                    documentUrl: process.env.FRONTEND_URL,
                    comments: `${username} has uploaded the document. Kindly review it once`,
                    logo: "https://www.sequelstring.com/_next/image?url=%2Fimages%2Flogo.webp&w=256&q=100",
                  };

                  const template = await compileEmailTemplate({
                    fileName: "workflowApproval.mjml",
                    data: dt,
                  });

                  // Send email
                  await sendMail(
                    currentUserDetails[index].username,
                    "Review Documents",
                    template
                  );
                  emailResults.push({
                    status: "success",
                    message: `Email sent to user ${userId}`,
                  });
                }

                if (notifyItem.type.includes("sms")) {
                  smsResults.push({
                    status: "success",
                    message: `SMS sent to user ${userId}`,
                  });
                }
              }

              const notificationError = notificationResults.some(
                (result) => result.status === "error"
              );
              const emailError = emailResults.some(
                (result) => result.status === "error"
              );
              const smsError = smsResults.some(
                (result) => result.status === "error"
              );
              if (triggerMailForLevel1) {
                const newDt: any = {
                  username,
                  approver: username,
                  status: req.body.status,
                  workflow: workflow?.workFlowName,
                  documentUrl: process.env.FRONTEND_URL,
                  comments: `You have successfully uploaded your document`,
                  logo: "https://www.sequelstring.com/_next/image?url=%2Fimages%2Flogo.webp&w=256&q=100",
                };

                const newTemplate = await compileEmailTemplate({
                  fileName: "workflowApproval.mjml",
                  data: newDt,
                });

                await sendMail(
                  username,
                  "Document Uploaded Succesfully",
                  newTemplate
                );
              }

              if (notificationError || emailError || smsError) {
                return {
                  status: "error",
                  message: `Failed to notify user ${userId}`,
                };
              } else {
                return {
                  status: "success",
                };
              }
            } else {
              return {
                status: "error",
                message: `No matching notification found for user ${userId}`,
              };
            }
          } catch (error) {
            return {
              status: "error",
              message: `Failed to notify user ${userId}`,
            };
          }
        }
      );

      const notificationsResults = await Promise.all(notificationsPromises);
      const success = notificationsResults.every(
        (notify) => notify.status !== "error"
      );

      // apply the trigger here
      for (const item of triggers) {
        try {
          if (item.isActive) {
            if (
              item.approval === req.body.status &&
              item.level === req.body.level
            ) {
              if (item.action === "url") {
                // const { status, data } = await sendTriggerRequest(
                //   item.method,
                //   { values: req.body.values },
                //   "token"
                // );
              }
            }
          }
        } catch (error:any) {
          console.error("Error processing trigger:", error?.message);
        }
      }

      return {
        status: "success",
        message: "Document Created successfully",
        statusCode: 200,
        data: {
          documentId: createdDocument.documentId,
          workflowId: createdDocument.workflow,
          values: req.body.values,
          file: file,
        },
      };
    } else {
      return {
        status: "error",
        statusCode: 400,
        message: "Workflow does not exists",
        data: null,
      };
    }
  } catch (error:any) {
    console.log(error);
    return {
      status: "error",
      statusCode: 400,
      message: error?.message,
      data: null,
    };
  }
}


export async function createPendingApprovalService(
  req: Request & { user?: any; userId?: any; bodyData?: any },
  res: Response
) {
  try {
    const { status, data, statusCode, message } =
      await createPendingApprovalFunction({
        user: req?.user,
        userId: req?.userId,
        bodyData: req?.bodyData,
        body: req?.body,
      });
    return res.status(statusCode).json({
      status: status,
      message: message,
      data: data,
    });
  } catch (error:any) {
    console.log(error?.message);
    return res.status(400).json({
      status: "error",
      message: error?.message,
    });
  }
}

// ── Simple schema-agnostic document create (GridFS File Storage) ─────────
/**
 * POST /documents
 * Body: { workflowId, documentData, tableData, file?: { base64, name, mimeType } }
 */
export const createDocumentService = async (req: Request & { user?: any, userId?: any, bodyData?: any }, res: Response) => {
  try {
    const { workflowId, documentData, tableData, file } = req.body;
    if (!workflowId) return res.status(400).json({ status: 'error', message: 'workflowId is required' });

    const { userId, company } = resolveAuthenticatedUser(req);
    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthorized user" });
    }

    const workflowAccess = await getWorkflowAccessContext(String(workflowId), String(userId));
    if (workflowAccess.status !== "success") {
      return res.status(workflowAccess.statusCode).json({
        status: workflowAccess.status,
        message: workflowAccess.message,
        data: workflowAccess.data,
      });
    }

    if (workflowAccess.data.userLevel !== 1) {
      return res.status(403).json({
        status: "error",
        message: "Only level 1 users can create documents in this workflow",
      });
    }

    let fileRef: any = null;

    if (file?.base64) {
      // Save Base64 file using existing GridFS repository logic
      const base64Data = file.base64.replace(/^data:[^;]+;base64,/, '');
      const uploadedFile: any = await uploadDocumentFile(
        base64Data,
        file.name || 'document.pdf',
        file.mimeType || 'application/pdf'
      );
      fileRef = uploadedFile?.fileId;
    }

    const doc = await createPendingApproval({
      workflow: workflowId,
      user: userId,
      createdBy: userId,
      company: company,
      documentType: 'schema',
      status: 'pending',
      currentLevel: 1,
      values: {
        fields: documentData || {},
        tables: tableData || {},
      },
      file: fileRef as any,
      created_At: new Date(),
    } as any);

    return res.status(201).json({ status: 'success', message: 'Document created', data: doc });
  } catch (err: any) {
    console.error('createDocumentService:', err);
    return res.status(500).json({ status: 'error', message: err?.message || 'Internal server error' });
  }
};

// ── Get all documents for a workflow ──────────────────────────────────
/**
 * GET /documents/:workflowId
 */
export const approveDocument = async (
  documentId: string,
  userId: string,
  comment?: string
) => {
  return processDocumentApprovalAction(documentId, userId, "approved", comment);
};

export const rejectDocument = async (
  documentId: string,
  userId: string,
  comment?: string
) => {
  return processDocumentApprovalAction(documentId, userId, "rejected", comment);
};

export const getPendingDocuments = async (userId: string) => {
  return getPendingDocumentsRepo(userId);
};

export const getApprovedDocuments = async (userId: string) => {
  return getApprovedDocumentsRepo(userId);
};

export const getRejectedDocuments = async (userId: string) => {
  return getRejectedDocumentsRepo(userId);
};

export const updateDocument = async (
  documentId: string,
  userId: string,
  payload: { fields?: Record<string, any>; tables?: Record<string, any[]> }
) => {
  return updateDocumentRepo(documentId, userId, payload);
};

export const approveDocumentService = async (
  req: Request & { userId?: any },
  res: Response
) => {
  try {
    const userId = String(req.userId || "");
    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthorized user" });
    }

    const result = await approveDocument(req.params.documentId, userId, req.body?.comment);
    return res.status(result.statusCode).json(result);
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      message: error?.message || "Internal server error",
    });
  }
};

export const rejectDocumentService = async (
  req: Request & { userId?: any },
  res: Response
) => {
  try {
    const userId = String(req.userId || "");
    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthorized user" });
    }

    const result = await rejectDocument(req.params.documentId, userId, req.body?.comment);
    return res.status(result.statusCode).json(result);
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      message: error?.message || "Internal server error",
    });
  }
};

export const getPendingDocumentsService = async (
  req: Request & { userId?: any },
  res: Response
) => {
  try {
    const userId = String(req.userId || "");
    const workflowId = req.query?.workflowId ? String(req.query.workflowId) : "";
    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthorized user" });
    }
    if (!workflowId) {
      return res.status(400).json({ status: "error", message: "workflowId is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(workflowId)) {
      return res.status(400).json({ status: "error", message: "workflowId is invalid" });
    }

    const result = await getPendingDocumentsRepo(userId, workflowId);
    return res.status(result.statusCode).json(result);
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      message: error?.message || "Internal server error",
    });
  }
};

export const updateDocumentService = async (
  req: Request & { userId?: any },
  res: Response
) => {
  try {
    const userId = String(req.userId || "");
    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthorized user" });
    }

    const result = await updateDocument(req.params.documentId, userId, {
      fields: req.body?.fields || {},
      tables: req.body?.tables || {},
    });
    return res.status(result.statusCode).json(result);
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      message: error?.message || "Internal server error",
    });
  }
};

export const getApprovedDocumentsService = async (
  req: Request & { userId?: any },
  res: Response
) => {
  try {
    const userId = String(req.userId || "");
    const workflowId = req.query?.workflowId ? String(req.query.workflowId) : "";
    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthorized user" });
    }
    if (!workflowId) {
      return res.status(400).json({ status: "error", message: "workflowId is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(workflowId)) {
      return res.status(400).json({ status: "error", message: "workflowId is invalid" });
    }

    const result = await getApprovedDocumentsRepo(userId, workflowId);
    return res.status(result.statusCode).json(result);
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      message: error?.message || "Internal server error",
    });
  }
};

export const getRejectedDocumentsService = async (
  req: Request & { userId?: any },
  res: Response
) => {
  try {
    const userId = String(req.userId || "");
    const workflowId = req.query?.workflowId ? String(req.query.workflowId) : "";
    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthorized user" });
    }
    if (!workflowId) {
      return res.status(400).json({ status: "error", message: "workflowId is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(workflowId)) {
      return res.status(400).json({ status: "error", message: "workflowId is invalid" });
    }

    const result = await getRejectedDocumentsRepo(userId, workflowId);
    return res.status(result.statusCode).json(result);
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      message: error?.message || "Internal server error",
    });
  }
};

export const getDocumentsByWorkflowService = async (
  req: Request & { user?: any, userId?: any, bodyData?: any },
  res: Response
) => {
  try {
    const { workflowId } = req.params;
    const { userId, company } = resolveAuthenticatedUser(req);
    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthorized user" });
    }
    if (!mongoose.Types.ObjectId.isValid(workflowId)) {
      return res.status(400).json({ status: "error", message: "workflowId is invalid" });
    }

    const result = await getDocumentsByWorkflow(workflowId, String(userId), company);
    return res.status(result.statusCode).json(result);
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err?.message });
  }
};
