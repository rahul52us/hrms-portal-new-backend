import mongoose from "mongoose";
import { AssetCategory as Category, BUILTIN_ASSET_CATEGORIES } from "../../schemas/Assets/AssetCategory.schema";
import { generateError } from "../../config/Error/functions";
import { hasPermission, PERMISSION_KEYS } from "../permissions/permission.utils";
import { AssetContext, canViewAssets, pagination, searchRegex, text } from "./asset.utils";

export const canManageAssetCategories = (ctx: AssetContext) => canViewAssets(ctx) && hasPermission(ctx.actor, PERMISSION_KEYS.MANAGE_ASSET_CATEGORIES);
export const categoryNameKey = (name: string) => name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export function categoryName(value: unknown) {
  const name = text(value, "Category name", 2, 80).replace(/\s+/g, " ");
  if (Object.values(BUILTIN_ASSET_CATEGORIES).some((label) => categoryNameKey(label) === categoryNameKey(name))) throw generateError("That name belongs to a built-in category", 422);
  return name;
}
export function categoryDto(ctx: AssetContext, row: any) { return { _id: row._id, code: row.code, name: row.name, state: row.state, revision: row.revision, builtin: false, canManage: canManageAssetCategories(ctx), createdAt: row.createdAt, updatedAt: row.updatedAt }; }
export type CategoryValue = { code: string; name: string; revision: number | null; builtin: boolean };
/** Resolve only the supplied page/import/template codes; this never downloads a company's complete catalog. */
export async function categoryValues(company: any, codes: string[], session?: mongoose.ClientSession, includeArchived = false) {
  const values = new Map<string, CategoryValue>();
  for (const code of codes) if (BUILTIN_ASSET_CATEGORIES[code]) values.set(code, { code, name: BUILTIN_ASSET_CATEGORIES[code], revision: null, builtin: true });
  const custom = [...new Set(codes.filter((code) => !BUILTIN_ASSET_CATEGORIES[code]))];
  if (custom.length) {
    const rows: any[] = await Category.find({ company, code: { $in: custom }, ...(!includeArchived ? { state: "active" } : {}) }).select("code name revision").session(session || null).lean();
    rows.forEach((row) => values.set(row.code, { code: row.code, name: row.name, revision: row.revision, builtin: false }));
  }
  return values;
}
/** New classifications fence the same document as archive/rename; existing unchanged historical classifications are allowed. */
export async function resolveAssetCategories(company: any, codes: string[], session: mongoose.ClientSession, expected?: Map<string, { revision: number | null; name: string }>) {
  const unique = [...new Set(codes)], values = await categoryValues(company, unique, session);
  for (const code of unique) {
    const value = values.get(code), reviewed = expected?.get(code);
    if (!value) throw generateError(expected ? "A reviewed asset category was archived or is unavailable. Prepare a new preview." : "Choose an active asset category from this company", expected ? 409 : 422);
    if (reviewed && (reviewed.revision !== value.revision || reviewed.name !== value.name)) throw generateError("A reviewed asset category changed. Prepare a new preview.", 409);
  }
  const writes = [...values.values()].filter((value) => !value.builtin).map((value) => ({ updateOne: { filter: { company, code: value.code, revision: value.revision, state: "active" }, update: { $inc: { useFence: 1 } }, timestamps: false } }));
  if (writes.length) {
    const locked = await Category.bulkWrite(writes, { session, ordered: true, timestamps: false });
    if (locked.matchedCount !== writes.length) throw generateError("Asset category changed. Reload before continuing.", 409);
  }
  return values;
}
export async function resolveAssetCategory(company: any, code: string, session: mongoose.ClientSession, expected?: { revision: number | null; name: string }) {
  return (await resolveAssetCategories(company, [code], session, expected ? new Map([[code, expected]]) : undefined)).get(code)!;
}
export async function resolveTaskAssetCategories(company: any, tasks: any[], session: mongoose.ClientSession) {
  const codes: string[] = [...new Set<string>(tasks.filter((task) => task.kind === "asset_provisioning").map((task) => task.assetRequirement.category))];
  const values = await resolveAssetCategories(company, codes, session);
  tasks.forEach((task) => { if (task.kind === "asset_provisioning") task.assetRequirement.categoryName = values.get(task.assetRequirement.category)!.name; });
}
/** Built-ins occupy a small fixed prefix; custom results are paginated in the database, never sliced from a full catalog. */
export async function categoryPage(company: any, query: any) {
  const { page, limit, skip } = pagination(query), search = searchRegex(query.search), state = query.state || "active";
  if (!["all", "active", "archived"].includes(state)) throw generateError("Invalid category state", 400);
  const builtins = state === "archived" ? [] : Object.entries(BUILTIN_ASSET_CATEGORIES).filter(([code, name]) => !search || search.test(code) || search.test(name)).map(([code, name]) => ({ _id: code, code, name, state: "active", revision: null, builtin: true, canManage: false }));
  const prefix = builtins.slice(skip, skip + limit), customLimit = limit - prefix.length;
  const match = { company, ...(state === "all" ? {} : { state }), ...(search ? { $or: [{ code: search }, { name: search }] } : {}) };
  const rows = customLimit ? await Category.find(match).sort({ nameKey: 1, _id: 1 }).skip(Math.max(0, skip - builtins.length)).limit(customLimit).lean() : [];
  const total = builtins.length + await Category.countDocuments(match);
  return { data: [...prefix, ...rows.map((row: any) => ({ _id: row._id, code: row.code, name: row.name, state: row.state, revision: row.revision, builtin: false, canManage: false, createdAt: row.createdAt, updatedAt: row.updatedAt }))], pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}
