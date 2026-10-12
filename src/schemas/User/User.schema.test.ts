import assert from "node:assert/strict";
import User from "./User";

const departmentPath = User.schema.path("department");
const accessRolePath = User.schema.path("accessRole");

assert.ok(departmentPath, "User.department must exist");
assert.equal(departmentPath.instance, "String");
assert.equal(
  departmentPath.options.ref,
  undefined,
  "User.department stores a department name and must not be populated as an ObjectId reference"
);
assert.ok(accessRolePath, "User.accessRole must exist");
assert.equal(accessRolePath.instance, "String");
assert.equal(accessRolePath.options.default, null);

console.log("User schema tests passed (6 assertions)");
