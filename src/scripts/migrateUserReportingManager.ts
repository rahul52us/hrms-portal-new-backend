import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import User from "../schemas/User/User";

const applyChanges = process.argv.includes("--apply");
const legacyManagerQuery = {
  $or: [
    { managerChain: { $exists: true } },
    { assignedManagers: { $exists: true } },
    { managers: { $exists: true } },
  ],
};

function objectIdString(value: any) {
  const normalized = String(value?._id || value || "");
  return mongoose.Types.ObjectId.isValid(normalized) ? normalized : "";
}

function getLegacyDirectManager(user: any) {
  const chainManager = (Array.isArray(user.managerChain) ? [...user.managerChain] : [])
    .sort((left, right) => Number(left?.level || 0) - Number(right?.level || 0))
    .map((entry) => objectIdString(entry?.manager))
    .find(Boolean);
  if (chainManager) return chainManager;

  const assignedManager = (Array.isArray(user.assignedManagers) ? user.assignedManagers : [])
    .map(objectIdString)
    .find(Boolean);
  if (assignedManager) return assignedManager;

  return (Array.isArray(user.managers) ? [...user.managers] : [])
    .filter((entry) => String(entry?.status || "").toUpperCase() === "ASSIGNED")
    .sort((left, right) => Number(left?.level || 0) - Number(right?.level || 0))
    .map((entry) => objectIdString(entry?.managerId))
    .find(Boolean) || "";
}

function assertNoCycles(managerByUserId: Map<string, string>) {
  for (const userId of managerByUserId.keys()) {
    const seen = new Set<string>([userId]);
    let managerId = managerByUserId.get(userId) || "";
    for (let depth = 0; managerId; depth += 1) {
      if (depth >= 50 || seen.has(managerId)) {
        throw new Error(`Circular or excessively deep reporting hierarchy detected for user ${userId}`);
      }
      seen.add(managerId);
      managerId = managerByUserId.get(managerId) || "";
    }
  }
}

async function migrate() {
  await connectToDatabase();
  const users = await User.collection.find({}).toArray();
  const usersWithLegacyFields = users.filter(
    (user) =>
      Object.prototype.hasOwnProperty.call(user, "managerChain") ||
      Object.prototype.hasOwnProperty.call(user, "assignedManagers") ||
      Object.prototype.hasOwnProperty.call(user, "managers")
  );
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const backfills = new Map<string, string>();

  usersWithLegacyFields.forEach((user) => {
    if (objectIdString(user.reportingManager)) return;
    const managerId = getLegacyDirectManager(user);
    if (!managerId) return;
    const manager = userById.get(managerId);
    if (!manager || String(manager.company || "") !== String(user.company || "")) {
      throw new Error(`Cannot backfill reporting manager for user ${user._id}: manager is missing or belongs to another company`);
    }
    if (managerId === String(user._id)) {
      throw new Error(`Cannot backfill reporting manager for user ${user._id}: self-reference detected`);
    }
    backfills.set(String(user._id), managerId);
  });

  const managerByUserId = new Map<string, string>();
  users.forEach((user) => {
    const userId = String(user._id);
    const managerId = objectIdString(user.reportingManager) || backfills.get(userId) || "";
    managerByUserId.set(userId, managerId);
  });
  assertNoCycles(managerByUserId);

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} reporting-manager cleanup: ` +
      `${usersWithLegacyFields.length} users with legacy fields, ${backfills.size} reporting-manager backfills.`
  );
  if (!applyChanges || usersWithLegacyFields.length === 0) {
    if (!applyChanges && usersWithLegacyFields.length > 0) {
      console.log("No data changed. Run the apply command after reviewing this result.");
    }
    return;
  }

  if (backfills.size > 0) {
    await User.collection.bulkWrite(
      Array.from(backfills.entries()).map(([userId, managerId]) => ({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(userId) },
          update: { $set: { reportingManager: new mongoose.Types.ObjectId(managerId) } },
        },
      }))
    );
  }
  const cleanupResult = await User.collection.updateMany(legacyManagerQuery, {
    $unset: { managerChain: "", assignedManagers: "", managers: "" },
  });
  console.log(
    `Reporting-manager cleanup complete. Backfilled ${backfills.size}; cleaned ${cleanupResult.modifiedCount} users.`
  );
}

migrate()
  .catch((error) => {
    console.error("Reporting-manager cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
