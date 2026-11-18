import assert from "node:assert/strict";
import mongoose from "mongoose";

// Cold import is intentional: another service must not accidentally register a missing refPath target first.
mongoose.set("autoCreate", false);
mongoose.set("autoIndex", false);
const Assignment = require("./WorkforcePolicyAssignment.schema").default;
assert.doesNotThrow(() => Assignment.db.model("TimesheetPolicy"), "Assignment loading must register TimesheetPolicy without relying on route import order");

async function main() {
  const names = Assignment.schema.path("resourceModel").enumValues as string[];
  assert.equal(names.length, 6);
  for (const name of names) {
    const Target = Assignment.db.model(name), originalFind = Target.find, id = new mongoose.Types.ObjectId();
    let reads = 0;
    try {
      Target.find = function(...args: any[]) {
        const query = originalFind.apply(this, args);
        query.exec = async () => { reads++; return [new Target({ _id: id, name: `${name} fixture`, code: "MODEL_QA", status: "active" })]; };
        return query;
      };
      const rows = [{ resourceModel: name, resource: id }];
      await Assignment.populate(rows, { path: "resource", select: "name code status" });
      const resource: any = rows[0].resource;
      assert.equal(resource.constructor.modelName, name);
      assert.equal(resource.name, `${name} fixture`);
      assert.equal(reads, 1);
    } finally { Target.find = originalFind; }
  }
  assert.equal(mongoose.connection.readyState, 0, "Regression test must not connect to a database");
  console.log("Cold assignment import registered and populated all six policy resource models without database access");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
