import { createHash } from "crypto";
import { ClientSession } from "mongoose";
import { generateError } from "../../config/Error/functions";
import { OnboardingPolicy as Policy, OnboardingPolicyVersion as Version } from "../../schemas/Onboarding/OnboardingPolicy.schema";
import { text } from "./onboardingTemplate.utils";

export function policyContent(value: any) {
  return { name: value.name, description: value.description || "", body: value.body, acknowledgementText: value.acknowledgementText };
}
export function normalizePolicy(input: any) {
  return { name: text(input.name, "Policy name", 2, 150), description: text(input.description ?? "", "Description", 0, 2000),
    body: text(input.body, "Policy text", 20, 40000), acknowledgementText: text(input.acknowledgementText, "Acknowledgement statement", 10, 1000) };
}
export const policyHash = (content: any) => createHash("sha256").update(JSON.stringify(policyContent(content))).digest("hex");
export function assertPolicyIntegrity(version: any) {
  if (!version || policyHash(version.content) !== version.contentHash) throw generateError("Published policy content could not be verified", 503);
}
/** Pin exact immutable versions; a policy update must never silently change an assigned checklist. */
export async function resolveTaskPolicies(company: any, tasks: any[], session: ClientSession) {
  const selected = tasks.filter((task) => task.kind === "policy_acknowledgement");
  const ids = [...new Set(selected.map((task) => String(task.policyVersionId)))];
  if (!ids.length) return new Map<string, any>();
  const versions: any[] = await Version.find({ company, _id: { $in: ids } }).session(session).lean();
  if (versions.length !== ids.length) throw generateError("Choose published policy versions from this company", 422);
  const parents = [...new Set(versions.map((version) => String(version.policy)))];
  for (const id of parents) {
    const fenced = await Policy.updateOne({ _id: id, company, status: "published" }, { $inc: { assignmentFence: 1 } }, { session, timestamps: false });
    if (!fenced.matchedCount) throw generateError("A selected policy is archived or unpublished. Update the checklist policy selection.", 409);
  }
  const map = new Map(versions.map((version) => { assertPolicyIntegrity(version); return [String(version._id), version] as const; }));
  for (const task of selected) {
    const version = map.get(String(task.policyVersionId));
    task.policyNameSnapshot = version.content.name; task.policyVersionNumber = version.version;
  }
  return map;
}
