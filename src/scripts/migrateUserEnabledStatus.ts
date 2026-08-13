import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import User from "../schemas/User/User";

const applyChanges = process.argv.includes("--apply");

async function migrate() {
  await connectToDatabase();

  const [legacyFieldCount, missingEnabledCount, deletedEnabledCount] = await Promise.all([
    User.collection.countDocuments({ is_active: { $exists: true } }),
    User.collection.countDocuments({
      deletedAt: null,
      $or: [{ is_enabled: { $exists: false } }, { is_enabled: null }],
    }),
    User.collection.countDocuments({
      deletedAt: { $ne: null },
      is_enabled: { $ne: false },
    }),
  ]);

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} User status cleanup: ` +
      `${legacyFieldCount} legacy is_active fields, ` +
      `${missingEnabledCount} enabled defaults to backfill, ` +
      `${deletedEnabledCount} deleted accounts to disable.`
  );

  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  const [enabledBackfill, deletedDisable, legacyCleanup] = await Promise.all([
    User.collection.updateMany(
      {
        deletedAt: null,
        $or: [{ is_enabled: { $exists: false } }, { is_enabled: null }],
      },
      { $set: { is_enabled: true } }
    ),
    User.collection.updateMany(
      { deletedAt: { $ne: null }, is_enabled: { $ne: false } },
      { $set: { is_enabled: false } }
    ),
    User.collection.updateMany(
      { is_active: { $exists: true } },
      { $unset: { is_active: "" } }
    ),
  ]);

  console.log(
    `User status cleanup complete. Backfilled ${enabledBackfill.modifiedCount}, ` +
      `disabled ${deletedDisable.modifiedCount} deleted accounts, ` +
      `removed ${legacyCleanup.modifiedCount} legacy fields.`
  );
}

migrate()
  .catch((error) => {
    console.error("User status cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
