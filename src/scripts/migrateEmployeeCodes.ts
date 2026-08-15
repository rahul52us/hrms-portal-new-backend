import "dotenv/config";
import mongoose from "mongoose";
import connectToDatabase from "../db/db";
import Company from "../schemas/company/Company";
import ProfileDetails from "../schemas/User/ProfileDetails";
import User from "../schemas/User/User";
import {
  buildEmployeeIdentifier,
  normalizeCompanyCode,
} from "../services/employeeCode/employeeCode.utils";

const applyChanges = process.argv.includes("--apply");

type EmployeeCodeChange = {
  userId: mongoose.Types.ObjectId;
  previousCode: string;
  employeeNumber: string;
  code: string;
};

async function migrate() {
  await connectToDatabase();

  const users = await User.collection
    .find({ company: { $type: "objectId" } })
    .project({ _id: 1, company: 1, code: 1, employeeNumber: 1, deletedAt: 1 })
    .toArray();
  users.sort(
    (first: any, second: any) =>
      Number(Boolean(first.deletedAt)) - Number(Boolean(second.deletedAt))
  );
  const companies = await Company.collection
    .find({})
    .project({ _id: 1, companyCode: 1, type: 1 })
    .toArray();
  const companyById = new Map(
    companies.map((company: any) => [String(company._id), company])
  );
  const errors: string[] = [];
  const companyCodeOwners = new Map<string, string>();

  for (const company of companies) {
    const companyCode = normalizeCompanyCode(company.companyCode);
    const existingCompanyId = companyCodeOwners.get(companyCode);
    if (existingCompanyId && existingCompanyId !== String(company._id)) {
      errors.push(`Company code ${companyCode} is assigned to multiple companies`);
    } else {
      companyCodeOwners.set(companyCode, String(company._id));
    }
  }

  const changes: EmployeeCodeChange[] = [];
  const targetCodeOwners = new Map<string, string>();
  const tenantNumberOwners = new Map<string, string>();

  for (const user of users) {
    const company = companyById.get(String(user.company));
    if (!company) {
      errors.push(`User ${user._id} references a missing company`);
      continue;
    }

    const sourceEmployeeNumber = user.employeeNumber || user.code;
    let identifier = buildEmployeeIdentifier(
      company.companyCode,
      sourceEmployeeNumber
    );
    if (!identifier) {
      errors.push(
        `User ${user._id} has an invalid employee number/code (${sourceEmployeeNumber || "missing"})`
      );
      continue;
    }

    const tenantNumberKey = `${String(user.company)}:${identifier.employeeNumber}`;
    const existingTenantOwner = tenantNumberOwners.get(tenantNumberKey);
    if (existingTenantOwner && existingTenantOwner !== String(user._id)) {
      if (!user.deletedAt) {
        errors.push(
          `Employee number ${identifier.employeeNumber} is duplicated in company ${identifier.companyCode}`
        );
        continue;
      }

      const archivedSuffix = `ARCHIVED-${String(user._id).slice(-6).toUpperCase()}`;
      const archivedBase = identifier.employeeNumber.slice(
        0,
        Math.max(1, 40 - archivedSuffix.length - 1)
      );
      identifier = buildEmployeeIdentifier(
        company.companyCode,
        `${archivedBase}-${archivedSuffix}`
      );
      if (!identifier) {
        errors.push(`Could not resolve archived employee code for user ${user._id}`);
        continue;
      }
    }
    tenantNumberOwners.set(
      `${String(user.company)}:${identifier.employeeNumber}`,
      String(user._id)
    );

    const targetCodeKey = identifier.code.toUpperCase();
    const existingTargetOwner = targetCodeOwners.get(targetCodeKey);
    if (existingTargetOwner && existingTargetOwner !== String(user._id)) {
      errors.push(`Canonical employee code ${identifier.code} is duplicated`);
      continue;
    }
    targetCodeOwners.set(targetCodeKey, String(user._id));

    if (
      String(user.code || "") !== identifier.code ||
      String(user.employeeNumber || "") !== identifier.employeeNumber
    ) {
      changes.push({
        userId: user._id,
        previousCode: String(user.code || ""),
        employeeNumber: identifier.employeeNumber,
        code: identifier.code,
      });
    }
  }

  const companyUserIds = new Set(users.map((user: any) => String(user._id)));
  const externalCodeOwners = await User.collection
    .find({ _id: { $nin: users.map((user: any) => user._id) } })
    .project({ _id: 1, code: 1 })
    .toArray();
  for (const user of externalCodeOwners) {
    const code = String(user.code || "").toUpperCase();
    const targetOwner = targetCodeOwners.get(code);
    if (code && targetOwner && !companyUserIds.has(String(user._id))) {
      errors.push(
        `Canonical employee code ${code} conflicts with non-company user ${user._id}`
      );
    }
  }
  const companyCodeChanges = companies.filter(
    (company: any) =>
      String(company.companyCode || "") !== normalizeCompanyCode(company.companyCode)
  );

  console.log(
    `${applyChanges ? "Applying" : "Dry run for"} employee code migration: ` +
      `${users.length} company-scoped users inspected, ${changes.length} user updates and ` +
      `${companyCodeChanges.length} company-code normalizations required.`
  );

  if (errors.length > 0) {
    errors.slice(0, 25).forEach((error) => console.error(`- ${error}`));
    throw new Error(
      `Employee code migration blocked by ${errors.length} validation error(s)`
    );
  }

  if (!applyChanges) {
    changes.slice(0, 10).forEach((change) =>
      console.log(
        `- ${change.previousCode || "(missing)"} -> ${change.code} (employeeNumber=${change.employeeNumber})`
      )
    );
    console.log("No data changed. Run the apply command after reviewing this result.");
    return;
  }

  if (companyCodeChanges.length > 0) {
    await Company.collection.bulkWrite(
      companyCodeChanges.map((company: any) => ({
        updateOne: {
          filter: { _id: company._id },
          update: {
            $set: {
              companyCode: normalizeCompanyCode(company.companyCode),
              updatedAt: new Date(),
            },
          },
        },
      })),
      { ordered: true }
    );
  }

  const codeChanges = changes.filter(
    (change) => change.previousCode !== change.code
  );
  if (codeChanges.length > 0) {
    await User.collection.bulkWrite(
      codeChanges.map((change) => ({
        updateOne: {
          filter: { _id: change.userId },
          update: {
            $set: {
              code: `MIG-${String(change.userId).toUpperCase()}`,
              employeeNumber: change.employeeNumber,
            },
          },
        },
      })),
      { ordered: true }
    );
  }

  if (changes.length > 0) {
    await User.collection.bulkWrite(
      changes.map((change) => ({
        updateOne: {
          filter: { _id: change.userId },
          update: {
            $set: {
              employeeNumber: change.employeeNumber,
              code: change.code,
              updatedAt: new Date(),
            },
          },
        },
      })),
      { ordered: true }
    );
    await ProfileDetails.collection.bulkWrite(
      changes.map((change) => ({
        updateOne: {
          filter: { user: change.userId },
          update: { $set: { "personalInfo.code": change.code } },
        },
      })),
      { ordered: false }
    );
  }

  await User.collection.createIndex(
    { company: 1, employeeNumber: 1 },
    {
      name: "company_1_employeeNumber_1",
      unique: true,
      partialFilterExpression: {
        company: { $type: "objectId" },
        employeeNumber: { $type: "string" },
      },
    }
  );
  await Company.collection.createIndex(
    { companyCode: 1 },
    { name: "companyCode_1", unique: true }
  );

  console.log(
    `Employee code migration complete. Updated ${changes.length} users, normalized ${companyCodeChanges.length} company codes, and verified identifier indexes.`
  );
}

migrate()
  .catch((error) => {
    console.error("Employee code migration failed:", error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
