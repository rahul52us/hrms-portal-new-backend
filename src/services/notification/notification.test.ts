import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  buildMyNotificationFilter,
  buildRequestNotificationDocuments,
} from "./notification.utils";

const company = new mongoose.Types.ObjectId();
const employee = new mongoose.Types.ObjectId();
const manager = new mongoose.Types.ObjectId();
const secondManager = new mongoose.Types.ObjectId();
const requestId = new mongoose.Types.ObjectId();

const unreadFilter = buildMyNotificationFilter({
  company,
  recipient: employee,
  read: "false",
});
assert.equal(String(unreadFilter.company), String(company));
assert.equal(String(unreadFilter.recipient), String(employee));
assert.equal(unreadFilter.isRead, false);

const allFilter = buildMyNotificationFilter({
  company,
  recipient: employee,
});
assert.equal("isRead" in allFilter, false);

assert.throws(
  () => buildMyNotificationFilter({ company, recipient: "not-an-id" }),
  /recipient/i
);

const approvalDocuments = buildRequestNotificationDocuments({
  company,
  recipients: [manager, manager, secondManager],
  actor: employee,
  eventType: "leave_request.awaiting_approval",
  entityType: "leave_request",
  entityId: requestId,
  title: "Leave request needs approval",
  message: "Ankit requested 1 day of Casual Leave.",
  actionUrl: "/employee",
  metadata: { leaveTypeCode: "CL" },
});

assert.equal(approvalDocuments.length, 2);
assert.deepEqual(
  approvalDocuments.map((document) => String(document.recipient)),
  [String(manager), String(secondManager)]
);
assert.equal(approvalDocuments[0].company, company);
assert.equal(approvalDocuments[0].category, "approval");
assert.equal(approvalDocuments[0].entityType, "leave_request");
assert.equal(approvalDocuments[0].metadata.leaveTypeCode, "CL");
assert.match(approvalDocuments[0].dedupeKey, new RegExp(String(manager)));

const outcomeDocuments = buildRequestNotificationDocuments({
  company,
  recipients: [employee],
  actor: manager,
  eventType: "leave_request.approved",
  entityType: "leave_request",
  entityId: requestId,
  title: "Leave request approved",
  message: "Your Casual Leave request was approved.",
  actionUrl: "/dashboard/requests",
});
assert.equal(outcomeDocuments[0].category, "request");
assert.equal(String(outcomeDocuments[0].recipient), String(employee));

assert.throws(
  () => buildRequestNotificationDocuments({
    company,
    recipients: [employee],
    eventType: "leave_request.approved",
    entityType: "leave_request",
    entityId: requestId,
    title: "Leave request approved",
    message: "Approved",
    actionUrl: "https://outside.example/request",
  }),
  /action url/i
);

console.log("Notification tests passed (17 assertions)");
