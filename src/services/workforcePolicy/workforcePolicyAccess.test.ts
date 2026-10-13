import assert from "node:assert/strict";
import { ensurePolicyManager, ensurePolicyViewer } from "./workforcePolicy.utils";

const delegatedHrRequest = {
  user: {
    role: "hr",
    effectivePermissions: {
      view_workforce_policies: true,
      manage_workforce_policies: true,
    },
  },
};

assert.doesNotThrow(() => ensurePolicyViewer(delegatedHrRequest));
assert.doesNotThrow(() => ensurePolicyManager(delegatedHrRequest));
assert.throws(
  () =>
    ensurePolicyManager({
      user: {
        role: "hr",
        effectivePermissions: {
          view_workforce_policies: true,
          manage_workforce_policies: false,
        },
      },
    }),
  /permission to manage workforce policies/i
);

console.log("Workforce policy delegated-access tests passed");
