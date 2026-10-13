import assert from "node:assert/strict";
import {
  ensurePayrollRunApprover,
  ensurePayrollRunManager,
  ensurePayrollViewer,
  isPayrollOperationsActor,
} from "./payroll.utils";

function requestWithPermissions(permissions: Record<string, boolean>) {
  return {
    user: {
      role: "user",
      accessRole: "payrollexecutive",
      effectivePermissions: permissions,
    },
  };
}

assert.equal(
  isPayrollOperationsActor({ role: "user", accessRole: "Payroll Executive" }),
  true
);
assert.equal(isPayrollOperationsActor({ role: "user" }), false);

const delegatedRequest = requestWithPermissions({
  view_payroll: true,
  manage_payroll_runs: true,
  approve_payroll_runs: false,
});
assert.doesNotThrow(() => ensurePayrollViewer(delegatedRequest));
assert.doesNotThrow(() => ensurePayrollRunManager(delegatedRequest));
assert.throws(() => ensurePayrollRunApprover(delegatedRequest), /permission to approve payroll runs/i);
assert.doesNotThrow(() =>
  ensurePayrollViewer({
    user: { role: "user", effectivePermissions: { view_payroll: true } },
  })
);
assert.throws(
  () => ensurePayrollViewer({ user: { role: "user", effectivePermissions: {} } }),
  /has not been assigned/i
);

console.log("Payroll access-role guard tests passed");
