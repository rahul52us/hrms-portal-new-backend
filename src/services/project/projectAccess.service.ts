import mongoose from "mongoose";
import User from "../../schemas/User/User";
import Project from "../../schemas/project/Project.schema";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { companyProjectManager, companyProjectViewer, projectId, projectManagementDisabled } from "./project.utils";

export interface ProjectWorkspaceAccess {
  canAccessWorkspace: boolean;
  canCreate: boolean;
  canAdmin: boolean;
  scopes: Array<"all" | "managed">;
}

export async function resolveProjectWorkspaceAccess(actor: any): Promise<ProjectWorkspaceAccess> {
  const denied: ProjectWorkspaceAccess = { canAccessWorkspace: false, canCreate: false, canAdmin: false, scopes: [] };
  const companyId = projectId(actor?.company || actor?.companyId), actorId = projectId(actor?._id);
  if (actor?.role === "superadmin" || !mongoose.Types.ObjectId.isValid(companyId) || !mongoose.Types.ObjectId.isValid(actorId) || !hasPermission(actor, PERMISSION_KEYS.VIEW_PROJECTS)) return denied;
  const company = new mongoose.Types.ObjectId(companyId), employee = new mongoose.Types.ObjectId(actorId);
  const canAdmin = companyProjectManager(actor);
  let canCreate = !projectManagementDisabled(actor) && hasPermission(actor, PERMISSION_KEYS.MANAGE_PROJECTS);
  let canAccessWorkspace = companyProjectViewer(actor) || canCreate;
  if (!canAccessWorkspace) {
    const [managedProject, directReport] = await Promise.all([
      Project.exists({ company, managers: employee }),
      projectManagementDisabled(actor) ? false : User.exists({ company, reportingManager: employee, role: { $ne: "superadmin" }, is_enabled: { $ne: false }, deletedAt: null }),
    ]);
    canCreate = Boolean(directReport);
    canAccessWorkspace = Boolean(managedProject) || canCreate;
  }
  return { canAccessWorkspace, canCreate, canAdmin,
    scopes: !canAccessWorkspace ? [] : companyProjectViewer(actor) ? ["all", "managed"] : ["managed"] };
}
