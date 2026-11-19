import assert from "node:assert/strict";
import mongoose from "mongoose";
import Instance from "../../schemas/Onboarding/EmployeeOnboarding.schema";
import { attachEffectivePermissions } from "../permissions/permission.utils";
import { onboardingWorkspace } from "./employeeOnboarding.service";

async function main() {
  const company = new mongoose.Types.ObjectId(), actorId = new mongoose.Types.ObjectId();
  const originalExists = Instance.exists;
  let hasOtherAssignedTask = false, queries = 0;
  // Exercise the real handler without connecting to or changing any company database.
  Instance.exists = (async (filter: any) => {
    queries++;
    assert.equal(String(filter.company), String(company));
    assert.equal(String(filter.employee.$ne), String(actorId), "Own checklist must not create a duplicate task tab");
    const task = filter.tasks.$elemMatch;
    assert.equal(String(task["assignees.user"]), String(actorId));
    assert.deepEqual(task.$or, [{ owner: { $ne: "hr" } }, { ownerResolution: "manual" }], "Revoked automatic HR queues cannot expose an inbox");
    return hasOtherAssignedTask ? { _id: new mongoose.Types.ObjectId() } : null;
  }) as any;
  const workspace = async (role: string, permissions?: Record<string, boolean>) => {
    const user = attachEffectivePermissions({ user: { _id: actorId, company, role, ...(permissions ? { permissions } : {}) } });
    let response: any, failure: any;
    await onboardingWorkspace({ user, body: {}, query: {} }, { json: (value: any) => { response = value; } }, (error: any) => { failure = error; });
    if (failure) throw failure;
    assert.equal(response.success, true);
    return response.data;
  };
  try {
    const employee = await workspace("user");
    assert.equal(employee.canView, false);
    assert.equal(employee.canViewAssignedTasks, false);
    assert.deepEqual(employee.scopes, ["mine", "tasks"], "Navigation visibility must not revoke own-task API access");
    assert.equal(queries, 1);

    hasOtherAssignedTask = true;
    assert.equal((await workspace("user")).canViewAssignedTasks, true, "Reporting managers keep work assigned on other employees' checklists");
    assert.equal((await workspace("user", { view_assets: true, manage_assets: true })).canViewAssignedTasks, true, "Named IT owners do not need an administrative role");
    hasOtherAssignedTask = false;
    assert.equal((await workspace("user")).canViewAssignedTasks, false, "Visibility is refreshed after ownership is revoked");

    const previousQueries = queries;
    for (const role of ["admin", "hradmin", "hr"]) {
      assert.equal((await workspace(role)).canViewAssignedTasks, true, `${role} keeps its operational inbox`);
    }
    assert.equal((await workspace("user", { view_onboarding: true })).canViewAssignedTasks, true, "Delegated operators retain My tasks");
    assert.equal(queries, previousQueries, "Operational accounts do not load employee assignments to show their inbox");
    assert.equal((await workspace("hradmin", { view_onboarding: false, manage_onboarding: false })).canViewAssignedTasks, true, "HR Admin still has a route to personal assigned tasks without company-wide access");
  } finally {
    Instance.exists = originalExists;
  }
  console.log("Onboarding workspace tests passed: employee deduplication, manager/IT task visibility, tenant/owner filters and operational inboxes.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
