# API tests

These tests start the real Express app against a **temporary in-memory MongoDB**. No real database is touched
(the harness refuses to run unless the database URI is `mongodb://127.0.0.1:...`). E-mails are mocked.

## Run

```bash
npm install
npm run test:api            # run everything
npm run test:api:report     # run everything and write reports/api-results.json
npm run test:api:summary    # turn that into reports/api-failures.md (share this with the developers)
```

The first run downloads a MongoDB binary (~100 MB) once; after that it is cached.
Run a single file: `npx jest --config jest.config.js tests/api/auth.test.ts --runInBand`

## What is covered

| File | What |
|---|---|
| `auth.test.ts` | login, account states, tokens, forgot/reset/set/change password, first Super Admin |
| `organization.test.ts` | office locations and departments (validation, permissions, closure) |
| `routes-security.test.ts` | every protected route returns 401 without a token; lists endpoints with no authentication |
| `routes-smoke.test.ts` | every endpoint of every HRMS router: no crashes (5xx) on GET or on an empty body; employees cannot use payroll admin APIs |

Test names start with the TC ID from `docs/qa/HRMS_Test_Cases.xlsx` (on the `qa-test-cases` branch) where one exists.
LMS routers (courses, scorm, batches, certificates) are not covered.
