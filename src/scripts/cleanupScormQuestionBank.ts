import mongoose from "mongoose";
import "dotenv/config";

import connectToDatabase from "../db/db";
import ScormQuestionBank from "../schemas/course/ScormQuestionBank";

function readArgument(name: string) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length).trim() : "";
}

async function main() {
  const execute = process.argv.includes("--execute");
  const courseId = readArgument("courseId");
  const scormPackageId = readArgument("packageId");
  const query: Record<string, unknown> = {};

  if (courseId) {
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      throw new Error("--courseId must be a valid MongoDB ObjectId");
    }
    query.courseId = new mongoose.Types.ObjectId(courseId);
  }

  if (scormPackageId) {
    query.scormPackageId = scormPackageId;
  }

  await connectToDatabase();

  const matchingRecords = await ScormQuestionBank.countDocuments(query);
  console.log("[ScormQuestionBank] Matching legacy records:", matchingRecords);

  if (!execute) {
    console.log(
      "[ScormQuestionBank] Dry run only. Re-run with --execute to delete the matching records."
    );
    return;
  }

  const result = await ScormQuestionBank.deleteMany(query);
  console.log("[ScormQuestionBank] Deleted legacy records:", result.deletedCount);
}

main()
  .catch((error) => {
    console.error("[ScormQuestionBank] Cleanup failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect().catch(() => undefined);
    }
  });
