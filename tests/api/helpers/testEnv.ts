/**
 * Test environment for the HRMS API tests.
 *
 * - Starts a TEMPORARY in-memory MongoDB (mongodb-memory-server). No real database is ever used.
 * - Loads the real Express app from src/index.ts (VERCEL=1 stops it from listening / starting schedulers).
 * - Provides seed helpers (companies, users per role) and a token helper.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import request from "supertest";

export const DEFAULT_PASSWORD = "Test@1234";

let mongod: MongoMemoryReplSet | null = null;
let app: any = null;
let seq = 0;

export async function startTestEnv() {
  // Replica set (single node) because the app uses MongoDB transactions, which a standalone server rejects.
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongod.getUri("hrms_test");
  // Safety: the URI must point to the temporary local server, never a real database.
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri)) {
    throw new Error(`Refusing to run: unexpected test database URI ${uri}`);
  }
  process.env.MONGODB_URI = uri;
  process.env.VERCEL = "1";
  process.env.NODE_ENV = "test";
  process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret-key";
  delete process.env.SUPERADMIN_SETUP_KEY;

  const connectToDatabase = (await import("../../../src/db/db")).default;
  await connectToDatabase();
  app = (await import("../../../src/index")).default;
  return app;
}

export async function stopTestEnv() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  mongod = null;
}

export async function resetDatabase() {
  const collections = await mongoose.connection.db!.collections();
  for (const c of collections) await c.deleteMany({});
}

export const http = () => request(app);

export async function createCompany(overrides: Record<string, any> = {}) {
  const Company = (await import("../../../src/schemas/company/Company")).default;
  seq += 1;
  return Company.create({
    company_name: `Test Company ${seq}`,
    companyCode: `TC${seq}`,
    ...overrides,
  } as any);
}

export type SeedUserOptions = {
  role?: string;
  company?: any;
  username?: string;
  name?: string;
  password?: string | null; // null => invited user without password (PENDING)
  enabled?: boolean;
  deleted?: boolean;
  extra?: Record<string, any>;
};

export async function createUser(opts: SeedUserOptions = {}) {
  const User = (await import("../../../src/schemas/User/User")).default;
  seq += 1;
  const password = opts.password === undefined ? DEFAULT_PASSWORD : opts.password;
  return User.create({
    name: opts.name || `Test User ${seq}`,
    username: (opts.username || `user${seq}@test.com`).toLowerCase(),
    code: `U${seq}${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
    role: opts.role || "user",
    company: opts.company?._id || opts.company,
    is_enabled: opts.enabled !== false,
    ...(password ? { password: await bcrypt.hash(password, 4) } : {}),
    ...(opts.deleted ? { deletedAt: new Date() } : {}),
    ...(opts.extra || {}),
  } as any);
}

export async function tokenFor(user: any) {
  const generateToken = (await import("../../../src/config/helper/generateToken")).default;
  return generateToken({ userId: user._id });
}

export async function authHeader(user: any) {
  return { Authorization: `Bearer ${await tokenFor(user)}` };
}

export async function login(username: string, password: string) {
  return http().post("/api/auth/login/password").send({ username, password });
}

/** Seeds one company with one user for each common role and returns tokens. */
export async function seedRoles() {
  const company = await createCompany();
  const roles = ["admin", "hradmin", "hr", "manager", "user", "payrollexecutive"] as const;
  const users: Record<string, any> = {};
  for (const role of roles) users[role] = await createUser({ role, company, username: `${role}@test.com` });
  users.superadmin = await createUser({ role: "superadmin", username: "superadmin@test.com" });
  const headers: Record<string, any> = {};
  for (const [role, user] of Object.entries(users)) headers[role] = await authHeader(user);
  return { company, users, headers };
}
