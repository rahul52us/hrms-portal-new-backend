import { generateError } from "../../config/Error/functions";
const id = (value: any) => String(value?._id || value || "");

export function reassignCurrentApprovalStep(instance: any, options: {
  actor: any; replacement: any; fromUserId: string; stepOrder: number; reason: string; now?: Date;
}) {
  const { actor, replacement, fromUserId, stepOrder, reason } = options, now = options.now || new Date();
  if (instance.status !== "pending" || instance.currentStepOrder !== stepOrder) throw generateError("The current approval level has changed", 409);
  if ([id(instance.employee), id(actor)].includes(id(replacement)) || id(instance.employee) === id(actor)) throw generateError("You cannot reassign your own request or assign approval to yourself or the employee", 403);
  const step = instance.steps.find((s: any) => s.order === stepOrder && s.status === "pending");
  const source = step?.approvers.find((a: any) => id(a.user) === fromUserId && a.status === "pending");
  if (!source) throw generateError("The selected approver is no longer pending at this level", 409);
  if (instance.steps.some((s: any) => s.approvers.some((a: any) => id(a.user) === id(replacement)))) throw generateError("This person is already in the approval workflow; choose another approver", 422);
  const pendingBefore = step.approvers.filter((a: any) => a.status === "pending").map((a: any) => id(a.user));
  const from = { user: id(source.user), name: source.nameSnapshot, role: source.roleSnapshot };
  const to = { user: id(replacement), name: replacement.name || replacement.username, role: replacement.role };
  source.status = "skipped"; source.reassignedTo = replacement._id; source.reassignedAt = now;
  step.approvers.push({ user: replacement._id, nameSnapshot: to.name, roleSnapshot: to.role, status: "pending", replacesUser: source.user });
  const pendingAfter = step.approvers.filter((a: any) => a.status === "pending").map((a: any) => id(a.user));
  const evidence = { stepOrder, stepName: step.nameSnapshot, approvalRule: step.approvalRule, from, to, pendingBefore, pendingAfter };
  instance.history.push({ action: "approver_reassigned", stepOrder, actor: actor._id, actorNameSnapshot: actor.name || actor.username, comment: reason, reassignment: evidence, at: now });
  return evidence;
}
