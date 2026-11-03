import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import { TASK_OWNERS } from "../../schemas/Onboarding/OnboardingTemplate.schema";

export function text(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw generateError(`${label} must be ${min}-${max} characters`, 422);
  }
  return value.trim();
}
export function objectId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) throw generateError(`Invalid ${label}`, 400);
  return new mongoose.Types.ObjectId(value);
}
export function pagination(query: any) {
  const parse = (value: any, fallback: number, max: number) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw generateError("Invalid onboarding pagination", 400);
    return n;
  };
  const page = parse(query.page, 1, 10000), limit = parse(query.limit, 20, 50);
  return { page, limit, skip: (page - 1) * limit };
}
export function searchRegex(value: unknown) {
  if (value === undefined || value === "") return null;
  return new RegExp(text(value, "Search", 1, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
export function normalizeTemplate(input: any, existingTasks: any[] = []) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw generateError("Template content is required", 422);
  const name = text(input.name, "Template name", 2, 120);
  const description = text(input.description ?? "", "Description", 0, 2000);
  if (!Array.isArray(input.tasks) || input.tasks.length > 100) throw generateError("Use at most 100 checklist tasks", 422);
  const knownIds = new Set(existingTasks.map((task) => String(task._id))), usedIds = new Set<string>();
  const tasks = input.tasks.map((task: any, index: number) => {
    const label = `Task ${index + 1}`;
    if (!task || typeof task !== "object" || Array.isArray(task)) throw generateError(`${label} is invalid`, 422);
    const _id = task._id === undefined ? new mongoose.Types.ObjectId() : objectId(task._id, `${label} id`);
    if (task._id !== undefined && !knownIds.has(String(_id))) throw generateError(`${label} does not belong to this template`, 422);
    if (usedIds.has(String(_id))) throw generateError("A checklist task appears more than once", 422);
    usedIds.add(String(_id));
    if (!TASK_OWNERS.includes(task.owner)) throw generateError(`${label}: choose a valid task owner`, 422);
    if (!Number.isSafeInteger(task.dueDays) || task.dueDays < -90 || task.dueDays > 365) throw generateError(`${label}: due date must be 90 days before to 365 days after joining`, 422);
    if (typeof task.required !== "boolean" || typeof task.requiresDocument !== "boolean") throw generateError(`${label}: required and document settings must be true or false`, 422);
    if (task.owner !== "specific_user" && task.ownerUser) throw generateError(`${label}: choose a person only for a specific-user owner`, 422);
    return { _id, title: text(task.title, `${label} title`, 2, 150), instructions: text(task.instructions ?? "", `${label} instructions`, 0, 2000),
      owner: task.owner, ownerUser: task.owner === "specific_user" ? objectId(task.ownerUser, `${label} owner`) : null,
      ownerNameSnapshot: "", dueDays: task.dueDays, required: task.required, requiresDocument: task.requiresDocument };
  });
  return { name, nameKey: name.toLowerCase(), description, tasks };
}
export function assertPublishable(template: any) {
  if (!template.tasks.length) throw generateError("Add at least one task before publishing", 422);
  if (!template.hasDraft) throw generateError("There is no draft to publish", 409);
}
