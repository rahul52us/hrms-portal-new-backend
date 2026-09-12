import mongoose, { ClientSession } from "mongoose";
import NotificationSchema from "../../schemas/Notification/notification.schema";
import {
  buildMyNotificationFilter,
  buildRequestNotificationDocuments,
  RequestNotificationOptions,
} from "./notification.utils";

export const createNotification = async(data : any) => {
    try
    {
        const notify = NotificationSchema(data)
        const savedNotify = await notify.save()
        return {
            status : 'success',
            data : savedNotify,
            message : 'Notifition Has been created Successful'
        }
    }
    catch(err : any)
    {
        return {
            status : 'error',
            data : err?.message,
            message : err?.message
        }
    }
}

export async function createRequestNotifications(
  options: RequestNotificationOptions,
  session?: ClientSession
) {
  const documents = buildRequestNotificationDocuments(options);
  if (!documents.length) return [];
  return NotificationSchema.create(documents, session ? { session } : undefined);
}

function actorNotificationScope(req: any) {
  const recipient = String(req?.userId || req?.user?._id || req?.bodyData?._id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(recipient)) {
    throw new Error("Authenticated notification recipient is invalid");
  }
  const companyValue = String(req?.user?.company || req?.bodyData?.company || "").trim();
  return {
    recipient: new mongoose.Types.ObjectId(recipient),
    company: mongoose.Types.ObjectId.isValid(companyValue)
      ? new mongoose.Types.ObjectId(companyValue)
      : undefined,
  };
}

function pagination(query: any) {
  const page = Math.max(1, Number.parseInt(String(query?.page || "1"), 10) || 1);
  const limit = Math.max(1, Math.min(50, Number.parseInt(String(query?.limit || "10"), 10) || 10));
  return { page, limit, skip: (page - 1) * limit };
}

function requestedReadState(value: unknown) {
  if (value === undefined || value === "") return undefined;
  if (value !== "true" && value !== "false") {
    throw new Error("read must be true or false");
  }
  return value as "true" | "false";
}

export const markNotificationAsRead = async (req: any, res: any) => {
  try {
    const notificationId = String(req.params?.notificationId || req.body?._id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(notificationId)) {
      return res.status(400).send({ status: "error", data: null, message: "Valid notification id is required" });
    }
    const scope = actorNotificationScope(req);
    const filter = buildMyNotificationFilter(scope);

    const updatedNotification = await NotificationSchema.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(notificationId), ...filter },
      { isRead: true, readAt: new Date() },
      { new: true }
    );

    if (!updatedNotification) {
      return res.status(404).send({
        status: 'error',
        data: null,
        message: 'Notification not found',
      });
    }

    return res.status(200).send({
      status: 'success',
      data: updatedNotification,
      message: 'Notification marked as read successfully',
    });
  } catch (err: any) {
    return res.status(500).send({
      status: 'error',
      data: err?.message,
      message: err?.message,
    });
  }
};

export const markAllNotificationsAsRead = async (req: any, res: any) => {
  try {
    const filter = buildMyNotificationFilter({ ...actorNotificationScope(req), read: false });
    const result = await NotificationSchema.updateMany(filter, {
      $set: { isRead: true, readAt: new Date() },
    });
    return res.status(200).send({
      status: "success",
      data: { updatedCount: result.modifiedCount },
      message: "Notifications marked as read successfully",
    });
  } catch (err: any) {
    return res.status(500).send({ status: "error", data: err?.message, message: err?.message });
  }
};

export const getNotification = async (req: any, res: any) => {
  try {
    const scope = actorNotificationScope(req);
    const filter = buildMyNotificationFilter({
      ...scope,
      read: requestedReadState(req.query?.read),
    });
    const unreadFilter = buildMyNotificationFilter({ ...scope, read: false });
    const { page, limit, skip } = pagination(req.query);

    const [notifications, totalCount, unreadCount] = await Promise.all([
      NotificationSchema.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      NotificationSchema.countDocuments(filter),
      NotificationSchema.countDocuments(unreadFilter),
    ]);

    return res.status(200).send({
      status: 'success',
      data: notifications,
      totalPages: Math.ceil(totalCount / limit),
      unreadCount,
      pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) },
      message: 'Notifications fetched successfully',
    });
  } catch (err: any) {
    const statusCode = /read must|recipient is invalid/i.test(err?.message || "") ? 400 : 500;
    res.status(statusCode).send({
      status: 'error',
      data: err?.message,
      message: err?.message,
    });
  }
};



