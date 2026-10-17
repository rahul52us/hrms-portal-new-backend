import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import Company from "../schemas/company/Company";

const applyChanges = process.argv.includes("--apply");

const defaults = {
  "payrollSettings.payrollReminderDay": 20,
  "payrollSettings.payrollNotificationsEnabled": true,
  "payrollSettings.accessLogRetentionDays": 365,
  "payrollSettings.operationalJobRetentionDays": 90,
  "payrollSettings.finalizedPayrollRetentionYears": 8,
};

async function migrate() {
  await connectToDatabase();
  const counts = await Promise.all(Object.keys(defaults).map((path) =>
    Company.collection.countDocuments({ [path]: { $exists: false } })
  ));
  const affected = await Company.collection.countDocuments({
    $or: Object.keys(defaults).map((path) => ({ [path]: { $exists: false } })),
  });
  console.log(`${applyChanges ? "Applying" : "Dry run for"} payroll operations settings: ${affected} company record(s) need at least one default.`);
  Object.keys(defaults).forEach((path, index) => console.log(`  ${path}: ${counts[index]} missing`));

  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  let modified = 0;
  for (const [path, value] of Object.entries(defaults)) {
    const result = await Company.collection.updateMany(
      { [path]: { $exists: false } },
      { $set: { [path]: value, updatedAt: new Date() } }
    );
    modified += result.modifiedCount;
  }
  console.log(`Payroll operations settings migration complete. Applied ${modified} field default(s).`);
}

migrate()
  .catch((error) => {
    console.error("Payroll operations settings migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
