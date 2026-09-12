import mongoose from "mongoose";

type ObjectIdInput = mongoose.Types.ObjectId | string | { _id?: unknown } | null | undefined;

export interface RequestNotificationOptions {
  company: ObjectIdInput;
  recipients: ObjectIdInput[];
  actor?: ObjectIdInput;
  eventType: string;
  entityType: string;
  entityId: ObjectIdInput;
  title: string;
  message: string;
  actionUrl?: string;
  priority?: "low" | "medium" | "high" | "critical";
  category?: "request" | "approval" | "attendance" | "announcement" | "system";
  metadata?: Record<string, unknown>;
  dedupeEventKey?: string;
}

export interface RequestNotificationDocument {
  company: mongoose.Types.ObjectId;
  recipient: mongoose.Types.ObjectId;
  actor: mongoose.Types.ObjectId | null;
  title: string;
  message: string;
  category: "request" | "approval" | "attendance" | "announcement" | "system";
  eventType: string;
  entityType: string;
  entityId: mongoose.Types.ObjectId;
  actionUrl: string;
  priority: "low" | "medium" | "high" | "critical";
  metadata: Record<string, unknown>;
  dedupeKey: string;
  type: string;
}

function objectId(value: ObjectIdInput, label: string) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  const normalized = String((value as any)?._id || value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw new Error(`A valid ${label} is required`);
  }
  return new mongoose.Types.ObjectId(normalized);
}

function optionalObjectId(value: ObjectIdInput) {
  if (!value) return null;
  return objectId(value, "notification actor");
}

export function buildMyNotificationFilter(options: {
  recipient: ObjectIdInput;
  company?: ObjectIdInput;
  read?: "true" | "false" | boolean;
}) {
  const filter: Record<string, unknown> = {
    recipient: objectId(options.recipient, "notification recipient"),
  };
  if (options.company) {
    filter.company = objectId(options.company, "notification company");
  }
  if (options.read === true || options.read === "true") filter.isRead = true;
  if (options.read === false || options.read === "false") filter.isRead = false;
  return filter;
}

export function buildRequestNotificationDocuments(
  options: RequestNotificationOptions
): RequestNotificationDocument[] {
  const company = objectId(options.company, "notification company");
  const entityId = objectId(options.entityId, "notification entity");
  const actor = optionalObjectId(options.actor);
  const title = String(options.title || "").trim();
  const message = String(options.message || "").trim();
  const eventType = String(options.eventType || "").trim();
  const entityType = String(options.entityType || "").trim();
  const actionUrl = String(options.actionUrl || "").trim();
  if (!title || !message || !eventType || !entityType) {
    throw new Error("Notification title, message, event type, and entity type are required");
  }
  if (actionUrl && (!actionUrl.startsWith("/") || actionUrl.startsWith("//"))) {
    throw new Error("Notification action URL must be an internal application path");
  }

  const recipients = new Map<string, mongoose.Types.ObjectId>();
  for (const recipient of options.recipients || []) {
    const id = objectId(recipient, "notification recipient");
    recipients.set(String(id), id);
  }
  const category = options.category || (eventType.endsWith("awaiting_approval") ? "approval" : "request");
  const eventKey = String(options.dedupeEventKey || eventType).trim();

  return Array.from(recipients.values()).map((recipient) => ({
    company,
    recipient,
    actor,
    title,
    message,
    category,
    eventType,
    entityType,
    entityId,
    actionUrl,
    priority: options.priority || "medium",
    metadata: options.metadata || {},
    dedupeKey: `${company}:${entityType}:${entityId}:${eventKey}:${recipient}`,
    type: eventType,
  }));
}
