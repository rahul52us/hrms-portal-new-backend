#!/usr/bin/env node
/**
 * Turns reports/api-results.json (npm run test:api:report) into reports/api-failures.md:
 * a ready-to-share list of failed API tests for the developers.
 */
const fs = require("fs");
const path = require("path");

const input = path.join(__dirname, "..", "reports", "api-results.json");
if (!fs.existsSync(input)) {
  console.error("reports/api-results.json not found. Run: npm run test:api:report");
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(input, "utf8"));
const rows = [];
for (const file of data.testResults) {
  for (const t of file.assertionResults) {
    rows.push({
      file: path.relative(path.join(__dirname, ".."), file.name),
      name: t.fullName || t.title,
      status: t.status,
      message: (t.failureMessages || []).join("\n").replace(/\u001b\[[0-9;]*m/g, ""),
    });
  }
}
const failed = rows.filter((r) => r.status === "failed");
const passed = rows.filter((r) => r.status === "passed").length;
const out = [];
out.push("# API test failures", "");
out.push(`Run: ${new Date().toISOString()}  |  Total: ${rows.length}  |  Passed: ${passed}  |  Failed: ${failed.length}`, "");
if (!failed.length) out.push("No failures.");
failed.forEach((r, i) => {
  const id = (r.name.match(/\b([A-Z]{2,5}-\d{3}[A-Z]?)\b/) || [])[1] || "-";
  out.push(`## ${i + 1}. ${r.name}`, "", `- QA sheet ID: ${id}`, `- File: ${r.file}`, "- Details:", "", "```", r.message.split("\n").slice(0, 25).join("\n"), "```", "");
});
fs.mkdirSync(path.join(__dirname, "..", "reports"), { recursive: true });
const target = path.join(__dirname, "..", "reports", "api-failures.md");
fs.writeFileSync(target, out.join("\n"));
console.log(`Wrote ${target} (${failed.length} failed of ${rows.length})`);
