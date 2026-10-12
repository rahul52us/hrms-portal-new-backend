import assert from "node:assert/strict";
import {
  PERMISSION_KEYS,
  attachEffectivePermissions,
  computeEffectivePermissions,
  getDefaultPermissionsForRole,
  sanitizePermissionRecordForRole,
} from "./permission.utils";

function testPayrollExecutiveDefaults() {
  const permissions = getDefaultPermissionsForRole("payroll executive");
  assert.equal(permissions[PERMISSION_KEYS.VIEW_PAYROLL], true);
  assert.equal(permissions[PERMISSION_KEYS.MANAGE_PAYROLL_RUNS], true);
  assert.equal(permissions[PERMISSION_KEYS.APPROVE_PAYROLL_RUNS], false);
  assert.equal(permissions[PERMISSION_KEYS.FINALIZE_PAYROLL_RUNS], false);
  assert.equal(permissions[PERMISSION_KEYS.VIEW_USERS], false);
}

function testEmployeeAccessRoleDoesNotChangeOrganizationalRole() {
  const user = attachEffectivePermissions({
    user: {
      role: "user",
      accessRole: "payrollexecutive",
      permissions: {},
    },
    company: { rolePermissions: {} },
  });

  assert.equal(user.role, "user");
  assert.equal(user.accessRole, "payrollexecutive");
  assert.equal(user.effectivePermissions[PERMISSION_KEYS.VIEW_PAYROLL], true);
  assert.equal(user.effectivePermissions[PERMISSION_KEYS.MANAGE_PAYROLL_RUNS], true);
  assert.equal(user.effectivePermissions[PERMISSION_KEYS.VIEW_USERS], false);
}

function testCompanyRoleConfigurationAndIndividualOverride() {
  const permissions = computeEffectivePermissions({
    role: "user",
    accessRole: "payrollexecutive",
    accessRolePermissionOverrides: {
      [PERMISSION_KEYS.APPROVE_PAYROLL_RUNS]: true,
      [PERMISSION_KEYS.MANAGE_PAYROLL_RUNS]: true,
      [PERMISSION_KEYS.VIEW_PAYROLL]: true,
    },
    userOverrides: {
      [PERMISSION_KEYS.MANAGE_PAYROLL_RUNS]: false,
      [PERMISSION_KEYS.APPROVE_PAYROLL_RUNS]: false,
    },
  });

  assert.equal(permissions[PERMISSION_KEYS.VIEW_PAYROLL], true);
  assert.equal(permissions[PERMISSION_KEYS.MANAGE_PAYROLL_RUNS], false);
  assert.equal(permissions[PERMISSION_KEYS.APPROVE_PAYROLL_RUNS], false);
}

function testHiddenPermissionManagementCannotBeRemovedByVisibleRoleForm() {
  const adminPermissions = sanitizePermissionRecordForRole("admin", {
    [PERMISSION_KEYS.VIEW_USERS]: true,
  });
  const hrAdminPermissions = sanitizePermissionRecordForRole("hradmin", {});
  const payrollPermissions = sanitizePermissionRecordForRole("payrollexecutive", {
    [PERMISSION_KEYS.MANAGE_PERMISSIONS]: true,
  });

  assert.equal(adminPermissions[PERMISSION_KEYS.MANAGE_PERMISSIONS], true);
  assert.equal(hrAdminPermissions[PERMISSION_KEYS.MANAGE_PERMISSIONS], true);
  assert.equal(payrollPermissions[PERMISSION_KEYS.MANAGE_PERMISSIONS], false);
}

testPayrollExecutiveDefaults();
testEmployeeAccessRoleDoesNotChangeOrganizationalRole();
testCompanyRoleConfigurationAndIndividualOverride();
testHiddenPermissionManagementCannotBeRemovedByVisibleRoleForm();

console.log("Permission access-role tests passed");
