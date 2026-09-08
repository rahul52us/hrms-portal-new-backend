import assert from "node:assert/strict";
import {
  approvalWorkflowVersionRequestTypes,
  approvalWorkflowVersionSupportsRequestType,
  approvalWorkflowVersionEffectiveTime,
  missingApprovalWorkflowRequestTypes,
  selectEffectiveApprovalWorkflowVersion,
} from "./approvalWorkflowVersion.utils";

const at = new Date("2026-09-01T12:00:00.000Z");

function testSelectsLatestEffectivePublishedVersion() {
  const selected = selectEffectiveApprovalWorkflowVersion(
    [
      { _id: "v1", versionNumber: 1, status: "published", effectiveFrom: "2026-01-01" },
      { _id: "v2", versionNumber: 2, status: "published", effectiveFrom: "2026-08-01" },
      { _id: "v3", versionNumber: 3, status: "published", effectiveFrom: "2026-10-01" },
      { _id: "v4", versionNumber: 4, status: "draft", effectiveFrom: "2026-08-15" },
    ],
    at
  );
  assert.equal(selected?._id, "v2");
}

function testUsesPublicationDateForLegacyVersions() {
  const selected = selectEffectiveApprovalWorkflowVersion(
    [
      { _id: "v1", versionNumber: 1, status: "published", publishedAt: "2026-01-01" },
      { _id: "v2", versionNumber: 2, status: "published", publishedAt: "2026-08-31" },
    ],
    at
  );
  assert.equal(selected?._id, "v2");
  assert.equal(
    approvalWorkflowVersionEffectiveTime({ status: "published", publishedAt: "2026-08-31" }),
    new Date("2026-08-31").getTime()
  );
}

function testReturnsNullWithoutAnEffectivePublishedVersion() {
  assert.equal(
    selectEffectiveApprovalWorkflowVersion(
      [
        { _id: "draft", versionNumber: 1, status: "draft", effectiveFrom: "2026-01-01" },
        { _id: "future", versionNumber: 2, status: "published", effectiveFrom: "2026-10-01" },
      ],
      at
    ),
    null
  );
}

function testUsesVersionRequestTypesWhenPresent() {
  const version = { applicableTo: ["leave_request", "leave_encashment_request"] };
  assert.deepEqual(
    approvalWorkflowVersionRequestTypes(version, ["leave_request"]),
    ["leave_request", "leave_encashment_request"]
  );
  assert.equal(
    approvalWorkflowVersionSupportsRequestType(
      version,
      ["leave_request"],
      "leave_encashment_request"
    ),
    true
  );
}

function testFallsBackForLegacyVersions() {
  assert.equal(
    approvalWorkflowVersionSupportsRequestType(
      { versionNumber: 1 },
      ["leave_request"],
      "leave_request"
    ),
    true
  );
}

function testFindsRemovedPublishedRequestTypes() {
  assert.deepEqual(
    missingApprovalWorkflowRequestTypes(
      ["leave_request", "remote_work_request"],
      ["leave_request", "leave_encashment_request"]
    ),
    ["remote_work_request"]
  );
}

[
  testSelectsLatestEffectivePublishedVersion,
  testUsesPublicationDateForLegacyVersions,
  testReturnsNullWithoutAnEffectivePublishedVersion,
  testUsesVersionRequestTypesWhenPresent,
  testFallsBackForLegacyVersions,
  testFindsRemovedPublishedRequestTypes,
].forEach((test) => test());

console.log("Approval workflow version tests passed (6 tests)");
