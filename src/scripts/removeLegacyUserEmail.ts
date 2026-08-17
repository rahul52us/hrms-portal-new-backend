import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";

const applyChanges = process.argv.includes("--apply");
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeUsername = (value: unknown) => String(value || "").trim().toLowerCase();

async function removeLegacyUserEmail() {
  await connectToDatabase();

  const users = mongoose.connection.collection("users");
  const profiles = mongoose.connection.collection("profiledetails");
  const documents = await users
    .find({}, { projection: { email: 1, username: 1, deletedAt: 1 } })
    .toArray();
  const indexes = await users.indexes();
  const legacyIndexes = indexes.filter((index: any) =>
    Object.keys(index.key || {}).includes("email")
  );
  const usernameIndexes = indexes.filter((index: any) =>
    Object.keys(index.key || {}).includes("username")
  );

  const targets = documents.map((document: any) => ({
    id: document._id,
    username: normalizeUsername(document.email || document.username),
    isDeleted: Boolean(document.deletedAt),
  }));
  const invalid = targets.filter((target) => !EMAIL_PATTERN.test(target.username));
  const usernameOwners = new Map<string, string[]>();

  for (const target of targets.filter((entry) => !entry.isDeleted)) {
    const owners = usernameOwners.get(target.username) || [];
    owners.push(String(target.id));
    usernameOwners.set(target.username, owners);
  }

  const duplicates = Array.from(usernameOwners.entries()).filter(
    ([username, owners]) => Boolean(username) && owners.length > 1
  );
  const [legacyFieldCount, profileEmailCount] = await Promise.all([
    users.countDocuments({ email: { $exists: true } }),
    profiles.countDocuments({ "personalInfo.email": { $exists: true } }),
  ]);

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} User username consolidation: ` +
      `${legacyFieldCount} User email fields, ${profileEmailCount} profile email fields, ` +
      `${invalid.length} invalid or missing usernames, ${duplicates.length} duplicate usernames, ` +
      `${legacyIndexes.length} email indexes, and ${usernameIndexes.length} username indexes.`
  );

  if (invalid.length > 0) {
    console.log(
      `Invalid accounts: ${invalid
        .slice(0, 20)
        .map((entry) => `${entry.id}:${entry.username || "<missing>"}`)
        .join(", ")}`
    );
  }

  if (duplicates.length > 0) {
    console.log(
      `Duplicate usernames: ${duplicates
        .slice(0, 20)
        .map(([username, owners]) => `${username} (${owners.join(", ")})`)
        .join("; ")}`
    );
  }

  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  if (invalid.length > 0 || duplicates.length > 0) {
    throw new Error("Resolve invalid or duplicate usernames before applying this migration.");
  }

  await users.updateMany(
    {},
    [
      {
        $set: {
          username: {
            $toLower: {
              $trim: {
                input: { $ifNull: ["$email", "$username"] },
              },
            },
          },
        },
      },
      { $unset: "email" },
    ]
  );
  await profiles.updateMany(
    { "personalInfo.email": { $exists: true } },
    { $unset: { "personalInfo.email": "" } }
  );

  for (const index of [...legacyIndexes, ...usernameIndexes]) {
    if (index.name && index.name !== "_id_") {
      await users.dropIndex(index.name);
    }
  }
  await users.createIndex(
    { username: 1 },
    {
      name: "username_active_unique",
      unique: true,
      partialFilterExpression: { deletedAt: null },
    }
  );

  console.log(
    `User username consolidation complete. Removed ${legacyFieldCount} User email fields and ` +
      `${profileEmailCount} profile email fields, dropped ${legacyIndexes.length} email indexes, ` +
      `and created the unique username index.`
  );
}

removeLegacyUserEmail()
  .catch((error) => {
    console.error("User username consolidation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
