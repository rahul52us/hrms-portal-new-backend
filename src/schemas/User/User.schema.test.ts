import assert from "node:assert/strict";
import User from "./User";

const departmentPath = User.schema.path("department");

assert.ok(departmentPath, "User.department must exist");
assert.equal(departmentPath.instance, "String");
assert.equal(
  departmentPath.options.ref,
  undefined,
  "User.department stores a department name and must not be populated as an ObjectId reference"
);

console.log("User schema tests passed (3 assertions)");
