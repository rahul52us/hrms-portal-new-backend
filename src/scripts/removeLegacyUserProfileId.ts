import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";

const applyChanges = process.argv.includes("--apply");

async function getProfileIdIndexes(users: ReturnType<typeof mongoose.connection.collection>) {
  const indexes = await users.indexes();
  return indexes.filter((index: any) =>
    Object.keys(index.key || {}).includes("profileId")
  );
}

async function removeLegacyUserProfileId() {
  await connectToDatabase();

  const users = mongoose.connection.collection("users");
  const profiles = mongoose.connection.collection("profiledetails");
  const [userCount, profileCount, legacyIndexes] = await Promise.all([
    users.countDocuments({ profileId: { $exists: true } }),
    profiles.countDocuments({ "personalInfo.profileId": { $exists: true } }),
    getProfileIdIndexes(users),
  ]);

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} legacy User profileId cleanup: ` +
      `${userCount} User fields, ${profileCount} profile fields, and ` +
      `${legacyIndexes.length} indexes found.`
  );

  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  const [userResult, profileResult] = await Promise.all([
    users.updateMany(
      { profileId: { $exists: true } },
      { $unset: { profileId: "" } }
    ),
    profiles.updateMany(
      { "personalInfo.profileId": { $exists: true } },
      { $unset: { "personalInfo.profileId": "" } }
    ),
  ]);

  for (const index of legacyIndexes) {
    if (index.name && index.name !== "_id_") {
      await users.dropIndex(index.name);
    }
  }

  const [remainingUsers, remainingProfiles, remainingIndexes] = await Promise.all([
    users.countDocuments({ profileId: { $exists: true } }),
    profiles.countDocuments({ "personalInfo.profileId": { $exists: true } }),
    getProfileIdIndexes(users),
  ]);

  if (remainingUsers || remainingProfiles || remainingIndexes.length) {
    throw new Error(
      `Cleanup verification failed: ${remainingUsers} User fields, ` +
        `${remainingProfiles} profile fields, and ${remainingIndexes.length} indexes remain.`
    );
  }

  console.log(
    `Legacy User profileId cleanup complete. Updated ${userResult.modifiedCount} users, ` +
      `${profileResult.modifiedCount} profiles, and dropped ${legacyIndexes.length} indexes.`
  );
}

removeLegacyUserProfileId()
  .catch((error) => {
    console.error("Legacy User profileId cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
