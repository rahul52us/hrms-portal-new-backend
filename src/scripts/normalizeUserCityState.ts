import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";

const applyChanges = process.argv.includes("--apply");

function normalizedValue(path: string) {
  return {
    $toLower: {
      $trim: {
        input: { $ifNull: [`$${path}`, ""] },
      },
    },
  };
}

function needsNormalization(path: string) {
  return {
    [path]: { $type: "string" },
    $expr: { $ne: [`$${path}`, normalizedValue(path)] },
  };
}

async function normalizeUserCityState() {
  await connectToDatabase();

  const users = mongoose.connection.collection("users");
  const profiles = mongoose.connection.collection("profiledetails");
  const targets = [
    { label: "User city", collection: users, path: "city" },
    { label: "User state", collection: users, path: "state" },
    { label: "profile city", collection: profiles, path: "personalInfo.city" },
    { label: "profile state", collection: profiles, path: "personalInfo.state" },
  ];

  const counts = await Promise.all(
    targets.map((target) => target.collection.countDocuments(needsNormalization(target.path)))
  );
  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} User city/state normalization: ` +
      targets.map((target, index) => `${counts[index]} ${target.label} values`).join(", ") +
      "."
  );

  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  const results: Array<{ modifiedCount: number }> = [];
  for (const target of targets) {
    results.push(
      await target.collection.updateMany(
        needsNormalization(target.path),
        [{ $set: { [target.path]: normalizedValue(target.path) } }]
      )
    );
  }

  const remaining = await Promise.all(
    targets.map((target) => target.collection.countDocuments(needsNormalization(target.path)))
  );
  if (remaining.some(Boolean)) {
    throw new Error(
      `Normalization verification failed: ${targets
        .map((target, index) => `${remaining[index]} ${target.label} values`)
        .join(", ")} remain.`
    );
  }

  console.log(
    `User city/state normalization complete. ` +
      targets
        .map((target, index) => `${results[index].modifiedCount} ${target.label} values updated`)
        .join(", ") +
      "."
  );
}

normalizeUserCityState()
  .catch((error) => {
    console.error("User city/state normalization failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
