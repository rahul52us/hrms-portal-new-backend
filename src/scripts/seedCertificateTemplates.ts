import AdmZip from "adm-zip";
import dotenv from "dotenv";
import fs from "fs";
import mongoose from "mongoose";
import path from "path";
import connectToDatabase from "../db/db";
import CertificateTemplate from "../schemas/course/CertificateTemplate";

dotenv.config();

const DEFAULT_TEMPLATE_DIR = path.join(__dirname, "..", "certificate-templates");

function normalizeName(fileName: string) {
  return path
    .basename(fileName, path.extname(fileName))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizePlaceholders(html: string) {
  const matches = Array.from(html.matchAll(/%([a-zA-Z0-9_]+)%/g)).map((match) => match[1]);
  return Array.from(new Set(matches.length ? matches : ["student_name", "course_name", "issued_on"]));
}

function extractBackgroundAssetUrl(html: string) {
  const match = html.match(/background(?:-image)?\s*:\s*url\((["']?)(.*?)\1\)/i);
  return String(match?.[2] || "").trim();
}

function loadTemplatesFromZip(zipPath: string) {
  const zip = new AdmZip(zipPath);
  return zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".html"))
    .map((entry) => ({
      name: normalizeName(entry.entryName),
      html: entry.getData().toString("utf8"),
    }));
}

function loadTemplatesFromDirectory(templateDir: string) {
  return fs
    .readdirSync(templateDir)
    .filter((fileName) => fileName.toLowerCase().endsWith(".html"))
    .map((fileName) => ({
      name: normalizeName(fileName),
      html: fs.readFileSync(path.join(templateDir, fileName), "utf8"),
    }));
}

async function main() {
  const zipPath = process.argv[2] || process.env.CERTIFICATE_TEMPLATE_ZIP || "";
  const companyId = process.env.CERTIFICATE_TEMPLATE_COMPANY_ID || "";
  const templates =
    zipPath && fs.existsSync(zipPath)
      ? loadTemplatesFromZip(zipPath)
      : loadTemplatesFromDirectory(DEFAULT_TEMPLATE_DIR);

  if (!templates.length) {
    throw new Error("No certificate HTML templates found to seed.");
  }

  await connectToDatabase();

  const normalizedCompanyId =
    companyId && mongoose.Types.ObjectId.isValid(companyId)
      ? new mongoose.Types.ObjectId(companyId)
      : null;

  for (const template of templates) {
    await CertificateTemplate.findOneAndUpdate(
      {
        name: template.name,
        companyId: normalizedCompanyId,
      },
      {
        $set: {
          html: template.html,
          placeholders: normalizePlaceholders(template.html),
          backgroundAssetUrl: extractBackgroundAssetUrl(template.html),
          status: "active",
        },
        $setOnInsert: {
          name: template.name,
          companyId: normalizedCompanyId,
          version: 1,
        },
      },
      {
        new: true,
        upsert: true,
      }
    );
    console.log(`Seeded certificate template: ${template.name}`);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Failed to seed certificate templates:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
