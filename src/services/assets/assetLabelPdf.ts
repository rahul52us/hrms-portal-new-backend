import bwipjs from "bwip-js";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { ASSET_LABELS_PER_SHEET, AssetLabelOptions, assetLabelCode } from "./assetLabel.utils";

const mm = (value: number) => value * 72 / 25.4;
const WIDTH = mm(90), HEIGHT = mm(42);

/** Standard PDF fonts cannot encode every script; keep unsupported display glyphs from breaking a scannable label. */
function printable(value: string, font: PDFFont) {
  return Array.from(String(value || "").replace(/[\r\n\t]+/g, " ")).map((character) => {
    try { font.encodeText(character); return character; } catch { return "?"; }
  }).join("");
}

function lines(value: string, font: PDFFont, size: number, width: number, maximum: number) {
  const result: string[] = []; let current = "";
  for (const character of printable(value, font)) {
    if (current && font.widthOfTextAtSize(current + character, size) > width) { result.push(current); current = character; }
    else current += character;
  }
  if (current) result.push(current);
  if (result.length <= maximum) return result;
  let last = result[maximum - 1];
  while (last && font.widthOfTextAtSize(last + "...", size) > width) last = last.slice(0, -1);
  return [...result.slice(0, maximum - 1), last + "..."];
}

export async function renderAssetLabels(company: string, companyName: string, assets: { _id: any; tag: string; name: string }[], options: AssetLabelOptions) {
  const pdf = await PDFDocument.create(), regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle("Asset labels"); pdf.setCreator("HRMS Assets"); pdf.setProducer("HRMS Assets");
  let page: PDFPage | undefined;
  for (let index = 0; index < assets.length; index++) {
    const position = options.layout === "single" ? 0 : index + options.startPosition - 1, slot = position % ASSET_LABELS_PER_SHEET;
    if (!page || slot === 0) page = pdf.addPage(options.layout === "single" ? [WIDTH, HEIGHT] : [mm(210), mm(297)]);
    const x = options.layout === "single" ? 0 : mm(12 + slot % 2 * 96), y = options.layout === "single" ? 0 : mm(297 - 12 - Math.floor(slot / 2) * 45 - 42);
    const unit = assets[index];
    // Four-module padding preserves QR quiet space. The encoder runs locally; no asset data leaves the backend.
    // QR-specific BWIPP options are supported by the encoder but absent from its generic RenderOptions type.
    const barcodeOptions = { bcid: "qrcode", text: assetLabelCode(company, unit._id), eclevel: "M", scale: 4, padding: 4, backgroundcolor: "FFFFFF" };
    const png = await bwipjs.toBuffer(barcodeOptions);
    const qr = await pdf.embedPng(png);
    page.drawRectangle({ x: x + 0.5, y: y + 0.5, width: WIDTH - 1, height: HEIGHT - 1, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.4 });
    page.drawImage(qr, { x: x + mm(3), y: y + mm(5), width: mm(32), height: mm(32) });
    const left = x + mm(39), top = y + HEIGHT - mm(5), textWidth = mm(48);
    lines(companyName || "Company asset", regular, 8, textWidth, 2).forEach((line, row) => page!.drawText(line, { x: left, y: top - row * 9, size: 8, font: regular }));
    // Forty permitted tag characters fit in three fixed-size lines; the permanent tag must not be shortened.
    lines(unit.tag, bold, 9, textWidth, 3).forEach((line, row) => page!.drawText(line, { x: left, y: top - 27 - row * 10, size: 9, font: bold }));
    lines(unit.name, regular, 7.5, textWidth, 2).forEach((line, row) => page!.drawText(line, { x: left, y: top - 65 - row * 9, size: 7.5, font: regular }));
  }
  return { bytes: Buffer.from(await pdf.save()), pages: pdf.getPageCount() };
}
