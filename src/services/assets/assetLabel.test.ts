import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { assetLabelCode, assetLabelOptions, assetScanMatch } from "./assetLabel.utils";
import { renderAssetLabels } from "./assetLabelPdf";

const company = "a".repeat(24), asset = "b".repeat(24), another = "c".repeat(24);
const code = assetLabelCode(company, asset);
assert.equal(code, `HRMS-ASSET:1:${company}:${asset}`);
const scanned = assetScanMatch(company, ` ${code}\r\n`);
assert.equal(String(scanned.company), company); assert.equal(String(scanned._id), asset);
assert.deepEqual(assetScanMatch(company, " ast-qa.01/test_2 "), { company, tag: "AST-QA.01/TEST_2" });
assert.throws(() => assetScanMatch(another, code), /Asset not found/);
for (const value of [null, 123, [], { $ne: null }, "", "*", "https://example.test/asset", `HRMS-ASSET:2:${company}:${asset}`, "x".repeat(121)]) assert.throws(() => assetScanMatch(company, value));
assert.deepEqual(assetLabelOptions({ assetIds: [asset.toUpperCase()] }), { assetIds: [asset], layout: "a4", startPosition: 1 });
assert.deepEqual(assetLabelOptions({ assetIds: [asset], layout: "single", startPosition: 1 }).assetIds, [asset]);
for (const body of [null, {}, { assetIds: [] }, { assetIds: [asset, asset.toUpperCase()] }, { assetIds: ["not-an-id"] }, { assetIds: Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(24, "0")) }, ...[0, 13, "1", 1.5].map(startPosition => ({ assetIds: [asset], startPosition })), { assetIds: [asset], layout: "unknown" }, { assetIds: [asset, another], layout: "single" }, { assetIds: [asset], layout: "single", startPosition: 2 }]) assert.throws(() => assetLabelOptions(body));

// Memory-only fixture: page geometry and skipped positions, never a company database or external QR service.
async function pdfCases() {
  for (const count of [1, 12, 13]) {
    const options = { assetIds: Array.from({ length: count }, (_, index) => index.toString(16).padStart(24, "0")), layout: "a4" as const, startPosition: 1 };
    const units = options.assetIds.map(_id => ({ _id, tag: "W".repeat(40), name: "Long display name ".repeat(8) }));
    const result = await renderAssetLabels(company, "Company label ".repeat(10), units, options), pdf = await PDFDocument.load(result.bytes);
    assert.equal(result.pages, Math.ceil(count / 12)); assert.equal(pdf.getPageCount(), result.pages);
    assert.ok(Math.abs(pdf.getPages()[0].getWidth() - 210 * 72 / 25.4) < 0.01);
  }
  const units = [asset, another].map(_id => ({ _id, tag: "AST-QA", name: "Fixture laptop" }));
  const skipped = await renderAssetLabels(company, "Company", units, { assetIds: [asset, another], layout: "a4", startPosition: 12 }); assert.equal(skipped.pages, 2);
  const single = await renderAssetLabels(company, "Company", units.slice(0, 1), { assetIds: [asset], layout: "single", startPosition: 1 }), page = (await PDFDocument.load(single.bytes)).getPages()[0];
  assert.ok(Math.abs(page.getWidth() - 90 * 72 / 25.4) < 0.01); assert.ok(Math.abs(page.getHeight() - 42 * 72 / 25.4) < 0.01);
}
pdfCases().then(() => console.log("Asset label validation and in-memory PDF cases passed")).catch(error => { console.error(error); process.exitCode = 1; });
