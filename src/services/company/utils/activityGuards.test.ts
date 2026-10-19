import assert from "node:assert/strict";
import Company from "../../../schemas/company/Company";
import {
  assertCompanyIsActiveForManagement,
  buildInactiveCompanyMessage,
  ensureCompanyManagementAccess,
  ensureUserAccountEnabled,
} from "./activityGuards";

const VALID_COMPANY_ID = "64b7f0f2a1b2c3d4e5f60718";
const OTHER_COMPANY_ID = "64b7f0f2a1b2c3d4e5f60719";

function expectThrows(fn: () => unknown, statusCode: number, messagePart?: string) {
  try {
    fn();
  } catch (error: any) {
    assert.equal(error.statusCode, statusCode);
    if (messagePart) assert.match(error.message, new RegExp(messagePart));
    return;
  }
  assert.fail(`Expected an error with status ${statusCode}`);
}

async function expectRejects(promise: Promise<unknown>, statusCode: number, messagePart?: string) {
  try {
    await promise;
  } catch (error: any) {
    assert.equal(error.statusCode, statusCode);
    if (messagePart) assert.match(error.message, new RegExp(messagePart));
    return;
  }
  assert.fail(`Expected a rejection with status ${statusCode}`);
}

// Replaces Company.findOne so no database connection is needed.
function stubCompanyLookup(result: any) {
  const original = (Company as any).findOne;
  const calls: any[] = [];

  (Company as any).findOne = (filter: any) => {
    calls.push(filter);
    return { lean: async () => result };
  };

  return {
    calls,
    restore: () => {
      (Company as any).findOne = original;
    },
  };
}

function testInactiveCompanyMessage() {
  const named = buildInactiveCompanyMessage("create employees", "Acme");
  assert.ok(named.startsWith("Acme is inactive."));
  assert.ok(named.includes("You cannot create employees until the company is reactivated."));

  const unnamed = buildInactiveCompanyMessage("create employees");
  assert.ok(unnamed.startsWith("This company is inactive."));
}

function testEnsureUserAccountEnabled() {
  expectThrows(() => ensureUserAccountEnabled({ is_enabled: false }), 403, "deactivated");

  assert.doesNotThrow(() => ensureUserAccountEnabled({ is_enabled: true }));
  assert.doesNotThrow(() => ensureUserAccountEnabled({}), "missing flag is not a deactivation");
  assert.doesNotThrow(() => ensureUserAccountEnabled(null));
  assert.doesNotThrow(() => ensureUserAccountEnabled(undefined));
}

function testAssertCompanyIsActiveForManagement() {
  expectThrows(
    () => assertCompanyIsActiveForManagement({ is_active: false, company_name: "Acme" }, "edit users"),
    403,
    "Acme is inactive"
  );

  assert.doesNotThrow(() => assertCompanyIsActiveForManagement({ is_active: true }, "edit users"));
  assert.doesNotThrow(() => assertCompanyIsActiveForManagement({}, "edit users"));
  assert.doesNotThrow(() => assertCompanyIsActiveForManagement(null, "edit users"));
}

async function testNonSuperadminWithoutCompanyIsRejected() {
  await expectRejects(
    ensureCompanyManagementAccess({ actor: { role: "admin" }, actionLabel: "manage users" }),
    403,
    "missing company access"
  );
}

async function testNonSuperadminCannotTargetAnotherCompany() {
  const stub = stubCompanyLookup({ _id: OTHER_COMPANY_ID });
  try {
    await expectRejects(
      ensureCompanyManagementAccess({
        actor: { role: "hradmin", companyId: VALID_COMPANY_ID },
        requestedCompanyId: OTHER_COMPANY_ID,
        actionLabel: "manage users",
      }),
      403,
      "only manage records from your company"
    );
    assert.equal(stub.calls.length, 0, "must reject before touching the database");
  } finally {
    stub.restore();
  }
}

async function testSuperadminWithoutCompanyNeedsExplicitAllowance() {
  await expectRejects(
    ensureCompanyManagementAccess({ actor: { role: "superadmin" }, actionLabel: "view" }),
    422,
    "Company context is required"
  );

  const result = await ensureCompanyManagementAccess({
    actor: { role: "superadmin" },
    actionLabel: "view",
    allowSuperadminWithoutCompany: true,
  });
  assert.equal(result, null);
}

async function testRoleIsNormalizedBeforeComparison() {
  const result = await ensureCompanyManagementAccess({
    actor: { role: "  SuperAdmin " },
    actionLabel: "view",
    allowSuperadminWithoutCompany: true,
  });
  assert.equal(result, null, "case and whitespace must not downgrade a superadmin");
}

async function testInvalidCompanyIdIsRejected() {
  await expectRejects(
    ensureCompanyManagementAccess({
      actor: { role: "admin", companyId: "not-an-object-id" },
      actionLabel: "manage users",
    }),
    400,
    "Invalid company id"
  );
}

async function testActorCompanyFallsBackToCompanyField() {
  const company = { _id: VALID_COMPANY_ID, is_active: true, company_name: "Acme" };
  const stub = stubCompanyLookup(company);
  try {
    const result = await ensureCompanyManagementAccess({
      actor: { role: "admin", company: VALID_COMPANY_ID },
      actionLabel: "manage users",
    });
    assert.equal(result, company);
    assert.equal(String(stub.calls[0]._id), VALID_COMPANY_ID);
    assert.deepEqual(stub.calls[0].deletedAt, { $exists: false }, "soft-deleted companies excluded");
  } finally {
    stub.restore();
  }
}

async function testSuperadminCanTargetAnyCompany() {
  const company = { _id: OTHER_COMPANY_ID, is_active: true };
  const stub = stubCompanyLookup(company);
  try {
    const result = await ensureCompanyManagementAccess({
      actor: { role: "superadmin" },
      requestedCompanyId: OTHER_COMPANY_ID,
      actionLabel: "manage users",
    });
    assert.equal(result, company);
    assert.equal(String(stub.calls[0]._id), OTHER_COMPANY_ID);
  } finally {
    stub.restore();
  }
}

async function testMissingCompanyReturnsNotFound() {
  const stub = stubCompanyLookup(null);
  try {
    await expectRejects(
      ensureCompanyManagementAccess({
        actor: { role: "admin", companyId: VALID_COMPANY_ID },
        actionLabel: "manage users",
      }),
      404,
      "Company not found"
    );
  } finally {
    stub.restore();
  }
}

async function testInactiveCompanyBlocksManagement() {
  const stub = stubCompanyLookup({ _id: VALID_COMPANY_ID, is_active: false, company_name: "Acme" });
  try {
    await expectRejects(
      ensureCompanyManagementAccess({
        actor: { role: "admin", companyId: VALID_COMPANY_ID },
        actionLabel: "add employees",
      }),
      403,
      "cannot add employees"
    );
  } finally {
    stub.restore();
  }
}

async function main() {
  testInactiveCompanyMessage();
  testEnsureUserAccountEnabled();
  testAssertCompanyIsActiveForManagement();
  await testNonSuperadminWithoutCompanyIsRejected();
  await testNonSuperadminCannotTargetAnotherCompany();
  await testSuperadminWithoutCompanyNeedsExplicitAllowance();
  await testRoleIsNormalizedBeforeComparison();
  await testInvalidCompanyIdIsRejected();
  await testActorCompanyFallsBackToCompanyField();
  await testSuperadminCanTargetAnyCompany();
  await testMissingCompanyReturnsNotFound();
  await testInactiveCompanyBlocksManagement();

  console.log("Company activity guard tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
