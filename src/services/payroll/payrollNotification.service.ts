import mongoose from "mongoose";
import Notification from "../../schemas/Notification/notification.schema";
import User from "../../schemas/User/User";
import { buildRequestNotificationDocuments, RequestNotificationOptions } from "../notification/notification.utils";
import {
  attachEffectivePermissions,
  hasPermission,
  PermissionKey,
} from "../permissions/permission.utils";

export async function resolvePayrollPermissionRecipients(options: {
  company: any;
  permission: PermissionKey;
  exclude?: Array<mongoose.Types.ObjectId | string>;
}) {
  const excluded = new Set((options.exclude || []).map(String));
  const users: any[] = await User.find({
    company: options.company._id,
    is_enabled: true,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).select("_id role accessRole permissions").lean();
  return users
    .map((user) => attachEffectivePermissions({ user, company: options.company }))
    .filter((user) => !excluded.has(String(user._id)) && hasPermission(user, options.permission))
    .map((user) => user._id);
}

export async function upsertPayrollNotifications(options: RequestNotificationOptions) {
  const documents = buildRequestNotificationDocuments(options);
  let created = 0;
  for (let index = 0; index < documents.length; index += 1000) {
    const batch = documents.slice(index, index + 1000);
    const result: any = await Notification.bulkWrite(
      batch.map((document) => ({
        updateOne: {
          filter: { dedupeKey: document.dedupeKey },
          update: { $setOnInsert: document },
          upsert: true,
        },
      })),
      { ordered: false }
    );
    created += Number(result.upsertedCount || 0);
  }
  return created;
}

export async function sendPayrollNotificationSafely(options: RequestNotificationOptions) {
  try {
    return await upsertPayrollNotifications(options);
  } catch (error: any) {
    console.error("Payroll notification delivery failed:", error?.message || error);
    return 0;
  }
}
