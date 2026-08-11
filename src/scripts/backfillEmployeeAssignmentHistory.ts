import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import EmployeeAssignmentHistory from "../schemas/EmployeeAssignment/EmployeeAssignmentHistory.schema";
import User from "../schemas/User/User";
import { ensureCurrentEmployeeAssignment } from "../services/employeeAssignment/employeeAssignment.service";

async function run() {
  await connectToDatabase();

  const apply = process.argv.includes("--apply");
  const batchSizeArgument = process.argv.find((argument) =>
    argument.startsWith("--batch-size=")
  );
  const requestedBatchSize = Number(batchSizeArgument?.split("=")[1] || 250);
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.max(25, Math.min(1000, Math.floor(requestedBatchSize)))
    : 250;
  const companyArgument = process.argv.find((argument) =>
    argument.startsWith("--company=")
  );
  const companyId = String(companyArgument?.split("=")[1] || "").trim();
  if (companyId && !mongoose.Types.ObjectId.isValid(companyId)) {
    throw new Error("--company must be a valid company ObjectId");
  }

  const userFilter: Record<string, any> = {
    company: { $type: "objectId" },
    deletedAt: null,
  };
  if (companyId) userFilter.company = new mongoose.Types.ObjectId(companyId);

  const cursor = User.find(userFilter)
    .sort({ _id: 1 })
    .cursor({ batchSize });

  let processed = 0;
  let existingCurrent = 0;
  let missing = 0;
  let inconsistent = 0;
  let created = 0;
  let failed = 0;

  for await (const user of cursor) {
    processed += 1;
    const currentExists = await EmployeeAssignmentHistory.exists({
      company: user.company,
      employee: user._id,
      isCurrent: true,
    });

    if (currentExists) {
      existingCurrent += 1;
      continue;
    }

    const anyHistoryExists = await EmployeeAssignmentHistory.exists({
      company: user.company,
      employee: user._id,
    });
    if (anyHistoryExists) {
      inconsistent += 1;
      console.error(
        `Employee ${user._id} has assignment history but no current record; manual review required.`
      );
      continue;
    }

    missing += 1;
    if (!apply) continue;

    try {
      const assignment = await ensureCurrentEmployeeAssignment({
        user,
        source: "assignment_history_backfill",
      });
      if (assignment) created += 1;
    } catch (error) {
      failed += 1;
      console.error(`Failed to backfill employee ${user._id}:`, error);
    }
  }

  console.log(
    `Assignment history ${apply ? "apply" : "dry run"} complete. ` +
      `Processed ${processed}, current ${existingCurrent}, missing ${missing}, ` +
      `inconsistent ${inconsistent}, created ${created}, failed ${failed}.`
  );

  if (!apply && missing > 0) {
    console.log("Run npm run assignments:backfill:apply to create the missing history records.");
  }
  if (failed > 0 || inconsistent > 0) process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error("Assignment history backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
