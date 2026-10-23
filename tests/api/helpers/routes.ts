import * as fs from "fs";
import * as path from "path";

export const SAMPLE_ID = "507f1f77bcf86cd799439011";
const ROUTING_DIR = path.join(__dirname, "../../../src/routing");
const SKIP_FILES = /(course|scorm|certificate|batch|student|testimonial)/i;

export type RouteInfo = { method: string; url: string; protectedRoute: boolean; file: string };


function readMounts(): { file: string; mount: string }[] {
  const index = fs.readFileSync(path.join(ROUTING_DIR, "routingIndex.ts"), "utf8");
  const imports: Record<string, string> = {};
  for (const m of index.matchAll(/import\s+(\w+)\s+from\s+["']\.\/([^"']+)["']/g)) imports[m[1]] = m[2];
  const mounts: { file: string; mount: string }[] = [];
  for (const m of index.matchAll(/app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\w+)\s*\)/g)) {
    if (imports[m[2]]) mounts.push({ file: imports[m[2]], mount: m[1] });
  }
  return mounts;
}

export function collectRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const seen = new Set<string>();
  for (const { file, mount } of readMounts()) {
    if (SKIP_FILES.test(file)) continue;
    const full = path.join(ROUTING_DIR, file.endsWith(".ts") ? file : `${file}.ts`);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, "utf8");
    // router variables that apply `authenticate` to everything registered after the .use() call
    const useAuth: Record<string, number> = {};
    for (const m of src.matchAll(/(\w+)\.use\(\s*authenticate\s*\)/g)) useAuth[m[1]] = m.index as number;
    const re = /(\w+)\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]*)[`'"]/g;
    const matches = [...src.matchAll(re)];
    matches.forEach((m, i) => {
      const [, router, method, route] = m;
      const start = m.index as number;
      const end = i + 1 < matches.length ? (matches[i + 1].index as number) : src.length;
      const snippet = src.slice(start, Math.min(end, start + 400));
      const protectedRoute = /authenticate/.test(snippet) || (router in useAuth && useAuth[router] < start);
      const url = (mount + (route === "/" ? "" : route)).replace(/\/+/g, "/").replace(/:[A-Za-z_]+\??/g, SAMPLE_ID);
      const key = `${method} ${url} ${protectedRoute}`;
      if (seen.has(key)) return;
      seen.add(key);
      routes.push({ method, url, protectedRoute, file });
    });
  }
  return routes;
}

