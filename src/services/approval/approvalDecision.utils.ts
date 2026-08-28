import { generateError } from "../../config/Error/functions";

function text(value: unknown) {
  return String(value || "").trim();
}

export function approveCurrentApprovalStep(
  instance: any,
  actor: any,
  comment?: string,
  now = new Date()
) {
  if (String(instance.employee) === String(actor._id)) {
    throw generateError("You cannot approve your own request", 403);
  }
  const step = instance.steps.find(
    (item: any) => item.order === instance.currentStepOrder && item.status === "pending"
  );
  if (!step) throw generateError("Current approval step is unavailable", 409);
  const approver = step.approvers.find(
    (item: any) => String(item.user) === String(actor._id) && item.status === "pending"
  );
  if (!approver) throw generateError("This request is not awaiting your approval", 403);

  approver.status = "approved";
  approver.actedAt = now;
  approver.comment = text(comment);
  const stepComplete = step.approvalRule === "any"
    || step.approvers.every((item: any) => ["approved", "skipped"].includes(item.status));
  if (stepComplete) {
    if (step.approvalRule === "any") {
      step.approvers.forEach((item: any) => {
        if (item.status === "pending") item.status = "skipped";
      });
    }
    step.status = "approved";
    step.completedAt = now;
    const nextStep = instance.steps.find((item: any) => item.status === "waiting");
    if (nextStep) {
      nextStep.status = "pending";
      nextStep.approvers.forEach((item: any) => {
        item.status = "pending";
      });
      instance.currentStepOrder = nextStep.order;
    } else {
      instance.status = "approved";
      instance.currentStepOrder = null;
      instance.completedAt = now;
    }
  }
  instance.history.push({
    action: "step_approved",
    stepOrder: step.order,
    actor: actor._id,
    actorNameSnapshot: text(actor.name || actor.username),
    comment: text(comment),
    at: now,
  });
  return instance;
}

export function rejectCurrentApprovalStep(
  instance: any,
  actor: any,
  comment: string,
  now = new Date()
) {
  if (String(instance.employee) === String(actor._id)) {
    throw generateError("You cannot reject your own request", 403);
  }
  const step = instance.steps.find(
    (item: any) => item.order === instance.currentStepOrder && item.status === "pending"
  );
  const approver = step?.approvers.find(
    (item: any) => String(item.user) === String(actor._id) && item.status === "pending"
  );
  if (!step || !approver) throw generateError("This request is not awaiting your decision", 403);

  approver.status = "rejected";
  approver.actedAt = now;
  approver.comment = text(comment);
  step.approvers.forEach((item: any) => {
    if (item.status === "pending") item.status = "skipped";
  });
  step.status = "rejected";
  step.completedAt = now;
  instance.status = "rejected";
  instance.currentStepOrder = null;
  instance.completedAt = now;
  instance.history.push({
    action: "rejected",
    stepOrder: step.order,
    actor: actor._id,
    actorNameSnapshot: text(actor.name || actor.username),
    comment: text(comment),
    at: now,
  });
  return instance;
}
