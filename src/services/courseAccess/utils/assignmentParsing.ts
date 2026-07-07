import mongoose from "mongoose";
import ExcelJS from "exceljs";
import User from "../../../schemas/User/User";
import { ActorContext, resolveUserDepartmentRecord, toObjectId } from "./accessControl";

const PHONE_REGEX = /^[0-9+()\-\s]{7,20}$/;

export function parsePossibleArray(value: any) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return trimmed
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    }

    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

export function parseCsv(text: string) {
  const rows: string[][] = [];
  let currentValue = "";
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      currentValue += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentValue.trim());
      currentValue = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }

      currentRow.push(currentValue.trim());
      if (currentRow.some((item) => item !== "")) {
        rows.push(currentRow);
      }
      currentValue = "";
      currentRow = [];
      continue;
    }

    currentValue += char;
  }

  if (currentValue.length || currentRow.length) {
    currentRow.push(currentValue.trim());
    if (currentRow.some((item) => item !== "")) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function normalizeCellValue(value: any): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value === "object") {
    if ("text" in value && value.text) {
      return String(value.text).trim();
    }

    if ("result" in value && value.result !== undefined && value.result !== null) {
      return String(value.result).trim();
    }
  }

  return String(value ?? "").trim();
}

function isLegacyExcelFile(fileName: string) {
  return fileName.endsWith(".xls") && !fileName.endsWith(".xlsx");
}

function isCsvUpload(fileName: string, mimeType: string) {
  return (
    fileName.endsWith(".csv") ||
    mimeType.includes("text/csv") ||
    mimeType.includes("application/csv")
  );
}

export async function parseWorkbookSheetsFromFile(options: {
  fileBuffer: any;
  fileName?: string;
  mimeType?: string;
}) {
  const normalizedFileName = String(options.fileName || "").trim().toLowerCase();
  const normalizedMimeType = String(options.mimeType || "").trim().toLowerCase();

  if (isCsvUpload(normalizedFileName, normalizedMimeType)) {
    throw new Error("Batch upload requires an .xlsx workbook with separate Courses and Users sheets.");
  }

  if (isLegacyExcelFile(normalizedFileName)) {
    throw new Error("Legacy .xls files are not supported. Please upload a .xlsx workbook.");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(options.fileBuffer);

  if (!workbook.worksheets.length) {
    throw new Error("Spreadsheet must include at least one worksheet");
  }

  return workbook.worksheets.map((worksheet) => {
    const rows: string[][] = [];

    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values)
        ? row.values.slice(1).map((value) => normalizeCellValue(value))
        : [];

      if (values.some((value) => value !== "")) {
        rows.push(values);
      }
    });

    return {
      name: String(worksheet.name || "").trim(),
      rows,
    };
  });
}

export async function parseTabularRowsFromFile(options: {
  fileBuffer: any;
  fileName?: string;
  mimeType?: string;
}) {
  const normalizedFileName = String(options.fileName || "").trim().toLowerCase();
  const normalizedMimeType = String(options.mimeType || "").trim().toLowerCase();
  const isCsvFile = isCsvUpload(normalizedFileName, normalizedMimeType);

  if (isCsvFile) {
    return parseCsv(options.fileBuffer.toString("utf-8"));
  }

  if (isLegacyExcelFile(normalizedFileName)) {
    throw new Error("Legacy .xls files are not supported. Please upload a .xlsx or .csv file.");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(options.fileBuffer);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    throw new Error("Spreadsheet must include at least one worksheet");
  }

  const rows: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values)
      ? row.values.slice(1).map((value) => normalizeCellValue(value))
      : [];

    if (values.some((value) => value !== "")) {
      rows.push(values);
    }
  });

  return rows;
}

export async function resolveUploadedUsers(options: {
  fileBuffer: any;
  fileName?: string;
  mimeType?: string;
  actor: ActorContext;
  actorDepartment: any;
  departmentLookup: Map<string, any>;
  companyId?: string;
  requirePhone?: boolean;
}) {
  const rows = await parseTabularRowsFromFile(options);

  if (rows.length < 2) {
    throw new Error("Upload must include a header row and at least one data row");
  }

  const headers = rows[0].map((header) => String(header || "").trim().toLowerCase());
  const getColumnIndex = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const userIdIndex = getColumnIndex("userid", "user_id", "user id");
  const phoneIndex = getColumnIndex(
    "phone",
    "phone number",
    "phonenumber",
    "mobile",
    "mobile number",
    "mobilenumber",
    "contact number",
    "contactnumber"
  );
  const codeIndex = getColumnIndex(
    "code",
    "employee code",
    "employee_code",
    "employee id",
    "employee_id",
    "employeeid",
    "employeecode"
  );

  const failures: any[] = [];
  const matchedUsers: any[] = [];
  const seenUsers = new Set<string>();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const userId = userIdIndex >= 0 ? String(row[userIdIndex] || "").trim() : "";
    const phone = phoneIndex >= 0 ? String(row[phoneIndex] || "").trim() : "";
    const code = codeIndex >= 0 ? String(row[codeIndex] || "").trim() : "";

    if (options.requirePhone && !phone) {
      failures.push({
        phone: "",
        rowNumber: rowIndex + 1,
        reason: "Phone number is required",
      });
      continue;
    }

    if (phone && !PHONE_REGEX.test(phone)) {
      failures.push({
        phone,
        rowNumber: rowIndex + 1,
        reason: "Invalid phone number format",
      });
      continue;
    }

    if (!userId && !phone && !code) {
      failures.push({
        phone: "",
        rowNumber: rowIndex + 1,
        reason: "Missing userId, phone number, or code",
      });
      continue;
    }

    const match: any = {
      deletedAt: { $exists: false },
    };

    const scopedCompanyId = options.companyId || options.actor.companyId;
    if (scopedCompanyId) {
      match.company = toObjectId(scopedCompanyId);
    }

    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      match._id = toObjectId(userId);
    } else if (phone) {
      match.$or = [{ mobileNumber: phone }, { username: phone }];
    } else if (code) {
      match.code = code;
    }

    const user = await User.findOne(match).lean();

    if (!user) {
      failures.push({
        phone,
        rowNumber: rowIndex + 1,
        reason: "User not found in the permitted scope",
        reference: phone || code || userId,
      });
      continue;
    }

    if (options.actor.role === "departmenthead") {
      const userDepartment = resolveUserDepartmentRecord(user, options.departmentLookup);
      if (!userDepartment || String(userDepartment._id) !== String(options.actorDepartment?._id)) {
        failures.push({
          phone,
          rowNumber: rowIndex + 1,
          reason: "User is outside your department scope",
          reference: phone || code || String(user._id),
        });
        continue;
      }
    }

    if (!seenUsers.has(String(user._id))) {
      seenUsers.add(String(user._id));
      matchedUsers.push(user);
    }
  }

  return { matchedUsers, failures };
}
