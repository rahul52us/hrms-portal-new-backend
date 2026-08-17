import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import User from "../schemas/User/User";
import ProfileDetails from "../schemas/User/ProfileDetails";

const applyChanges = process.argv.includes("--apply");

const missingRoleFilter = {
  userType: { $type: "string", $ne: "" },
  $or: [
    { role: { $exists: false } },
    { role: null },
    { role: "" },
  ],
};

const conflictingRoleFilter = {
  role: { $type: "string" },
  userType: { $type: "string" },
  $expr: {
    $ne: [
      { $toLower: { $trim: { input: "$role" } } },
      { $toLower: { $trim: { input: "$userType" } } },
    ],
  },
};

async function removeLegacyUserType() {
  await connectToDatabase();

  const indexes = await User.collection.indexes();
  const legacyIndexes = indexes.filter((index: any) =>
    Object.keys(index.key || {}).includes("userType")
  );
  const hasRoleIndex = indexes.some((index: any) => {
    const keys = Object.keys(index.key || {});
    return keys.length === 1 && keys[0] === "role";
  });
  const [legacyFieldCount, profileFieldCount, missingRoleCount, conflictCount] = await Promise.all([
    User.collection.countDocuments({ userType: { $exists: true } }),
    ProfileDetails.collection.countDocuments({ "personalInfo.userType": { $exists: true } }),
    User.collection.countDocuments(missingRoleFilter),
    User.collection.countDocuments(conflictingRoleFilter),
  ]);

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} User role consolidation: ` +
      `${legacyFieldCount} User fields, ${profileFieldCount} profile fields, ` +
      `${missingRoleCount} roles to backfill, ` +
      `${conflictCount} conflicts that will keep role, ${legacyIndexes.length} legacy indexes, ` +
      `and role index ${hasRoleIndex ? "present" : "missing"}.`
  );

  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  const backfill = await User.collection.updateMany(
    missingRoleFilter,
    [
      {
        $set: {
          role: { $toLower: { $trim: { input: "$userType" } } },
        },
      },
    ]
  );
  const cleanup = await User.collection.updateMany(
    { userType: { $exists: true } },
    { $unset: { userType: "" } }
  );
  const profileCleanup = await ProfileDetails.collection.updateMany(
    { "personalInfo.userType": { $exists: true } },
    { $unset: { "personalInfo.userType": "" } }
  );

  for (const index of legacyIndexes) {
    if (index.name) {
      await User.collection.dropIndex(index.name);
    }
  }
  if (!hasRoleIndex) {
    await User.collection.createIndex({ role: 1 }, { name: "role_1" });
  }

  console.log(
    `User role consolidation complete. Backfilled ${backfill.modifiedCount} roles, ` +
      `removed ${cleanup.modifiedCount} User fields and ${profileCleanup.modifiedCount} ` +
      `profile fields, and dropped ` +
      `${legacyIndexes.length} indexes. Role index ${hasRoleIndex ? "already existed" : "created"}.`
  );
}

removeLegacyUserType()
  .catch((error) => {
    console.error("User role consolidation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
