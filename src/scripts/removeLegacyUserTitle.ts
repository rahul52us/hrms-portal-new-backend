import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import User from "../schemas/User/User";
import ProfileDetails from "../schemas/User/ProfileDetails";

const applyChanges = process.argv.includes("--apply");

async function removeLegacyUserTitle() {
  await connectToDatabase();

  const [userCount, profileCount] = await Promise.all([
    User.collection.countDocuments({ title: { $exists: true } }),
    ProfileDetails.collection.countDocuments({ "personalInfo.title": { $exists: true } }),
  ]);

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} legacy User title cleanup: ` +
      `${userCount} User fields and ${profileCount} profile fields found.`
  );

  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  const [users, profiles] = await Promise.all([
    User.collection.updateMany(
      { title: { $exists: true } },
      { $unset: { title: "" } }
    ),
    ProfileDetails.collection.updateMany(
      { "personalInfo.title": { $exists: true } },
      { $unset: { "personalInfo.title": "" } }
    ),
  ]);

  console.log(
    `Legacy User title cleanup complete. Updated ${users.modifiedCount} users and ` +
      `${profiles.modifiedCount} profiles.`
  );
}

removeLegacyUserTitle()
  .catch((error) => {
    console.error("Legacy User title cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
