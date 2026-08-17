import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";

const applyChanges = process.argv.includes("--apply");

async function getManagerLevelsIndexes(
  companies: ReturnType<typeof mongoose.connection.collection>
) {
  const indexes = await companies.indexes();
  return indexes.filter((index: any) =>
    Object.keys(index.key || {}).includes("managerLevels")
  );
}

async function removeLegacyCompanyManagerLevels() {
  await connectToDatabase();

  const companies = mongoose.connection.collection("companies");
  const [fieldCount, legacyIndexes] = await Promise.all([
    companies.countDocuments({ managerLevels: { $exists: true } }),
    getManagerLevelsIndexes(companies),
  ]);

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} Company managerLevels cleanup: ` +
      `${fieldCount} fields and ${legacyIndexes.length} indexes found.`
  );

  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  const result = await companies.updateMany(
    { managerLevels: { $exists: true } },
    { $unset: { managerLevels: "" } }
  );

  for (const index of legacyIndexes) {
    if (index.name && index.name !== "_id_") {
      await companies.dropIndex(index.name);
    }
  }

  const [remainingFields, remainingIndexes] = await Promise.all([
    companies.countDocuments({ managerLevels: { $exists: true } }),
    getManagerLevelsIndexes(companies),
  ]);

  if (remainingFields || remainingIndexes.length) {
    throw new Error(
      `Cleanup verification failed: ${remainingFields} fields and ` +
        `${remainingIndexes.length} indexes remain.`
    );
  }

  console.log(
    `Company managerLevels cleanup complete. Updated ${result.modifiedCount} documents ` +
      `and dropped ${legacyIndexes.length} indexes.`
  );
}

removeLegacyCompanyManagerLevels()
  .catch((error) => {
    console.error("Company managerLevels cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
