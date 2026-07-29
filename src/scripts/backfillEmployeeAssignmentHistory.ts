import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import User from "../schemas/User/User";
import { ensureCurrentEmployeeAssignment } from "../services/employeeAssignment/employeeAssignment.service";

async function run() {
  await connectToDatabase();

  const users = await User.find({
    company: { $type: "objectId" },
    deletedAt: null,
  }).sort({ createdAt: 1 });

  let ensured = 0;

  for (const user of users) {
    const assignment = await ensureCurrentEmployeeAssignment({
      user,
      source: "assignment_history_backfill",
    });

    if (assignment) ensured += 1;
  }

  console.log(
    `Assignment history backfill complete. Processed ${users.length}, current records ensured ${ensured}.`
  );
}

run()
  .catch((error) => {
    console.error("Assignment history backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
