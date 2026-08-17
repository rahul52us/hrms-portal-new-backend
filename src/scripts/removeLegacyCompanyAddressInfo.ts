import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";

const applyChanges = process.argv.includes("--apply");

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

async function getAddressInfoIndexes(
  companies: ReturnType<typeof mongoose.connection.collection>
) {
  const indexes = await companies.indexes();
  return indexes.filter((index: any) =>
    Object.keys(index.key || {}).some(
      (key) => key === "addressInfo" || key.startsWith("addressInfo.")
    )
  );
}

async function findOfficeLocationCandidates() {
  const companies = mongoose.connection.collection("companies");
  const officeLocations = mongoose.connection.collection("officelocations");
  const legacyCompanies = await companies
    .find(
      {
        type: { $ne: "user" },
        deletedAt: { $exists: false },
        addressInfo: { $type: "array" },
      },
      { projection: { company_name: 1, addressInfo: 1 } }
    )
    .toArray();
  const candidates: Array<{
    companyId: mongoose.Types.ObjectId;
    companyName: string;
    address: Record<string, unknown>;
  }> = [];

  for (const company of legacyCompanies) {
    const address = Array.isArray(company.addressInfo)
      ? company.addressInfo.find((entry: any) => normalizeText(entry?.city))
      : null;
    if (!address) {
      continue;
    }

    const existingLocation = await officeLocations.findOne({
      company: company._id,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });
    if (!existingLocation) {
      candidates.push({
        companyId: company._id,
        companyName: normalizeText(company.company_name),
        address,
      });
    }
  }

  return candidates;
}

async function removeLegacyCompanyAddressInfo() {
  await connectToDatabase();

  const companies = mongoose.connection.collection("companies");
  const officeLocations = mongoose.connection.collection("officelocations");
  const [fieldCount, legacyIndexes, locationCandidates] = await Promise.all([
    companies.countDocuments({ addressInfo: { $exists: true } }),
    getAddressInfoIndexes(companies),
    findOfficeLocationCandidates(),
  ]);

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} Company addressInfo cleanup: ` +
      `${fieldCount} fields, ${legacyIndexes.length} indexes, and ` +
      `${locationCandidates.length} Head Office locations to create.`
  );

  if (!applyChanges) {
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  let createdLocations = 0;
  for (const candidate of locationCandidates) {
    const now = new Date();
    const address = candidate.address;
    await officeLocations.insertOne({
      company: candidate.companyId,
      name: "Head Office",
      code: "HQ",
      address: normalizeText(address.address || address.formattedAddress),
      city: normalizeText(address.city),
      state: normalizeText(address.state),
      country: normalizeText(address.country),
      pinCode: normalizeText(address.pinCode || address.postalCode),
      is_active: true,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    createdLocations += 1;
  }

  const result = await companies.updateMany(
    { addressInfo: { $exists: true } },
    { $unset: { addressInfo: "" } }
  );

  for (const index of legacyIndexes) {
    if (index.name && index.name !== "_id_") {
      await companies.dropIndex(index.name);
    }
  }

  const [remainingFields, remainingIndexes] = await Promise.all([
    companies.countDocuments({ addressInfo: { $exists: true } }),
    getAddressInfoIndexes(companies),
  ]);
  if (remainingFields || remainingIndexes.length) {
    throw new Error(
      `Cleanup verification failed: ${remainingFields} fields and ` +
        `${remainingIndexes.length} indexes remain.`
    );
  }

  console.log(
    `Company addressInfo cleanup complete. Created ${createdLocations} Head Office locations, ` +
      `updated ${result.modifiedCount} company documents, and dropped ` +
      `${legacyIndexes.length} indexes.`
  );
}

removeLegacyCompanyAddressInfo()
  .catch((error) => {
    console.error("Company addressInfo cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
