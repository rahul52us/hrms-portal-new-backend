# Feature check: frontend calls vs backend routes

Static check (no app was run). Every `axios.<method>('/path')` call in the frontend was matched, by method and path, with the routes registered in the backend (`src/routing/*`, mounted under `/api`). Matching is case-insensitive and treats `${...}` and `:param` as wildcards.

- Frontend API calls with a literal path: **371** (+ 2 built from a variable, not checked)
- Matched to a backend route: **313**
- LMS / legacy calls with no HRMS route (ignored): **39**
- HRMS-looking calls with a problem: see below

## Calls that do not match a backend route

| Severity | Frontend call | Where | Problem |
|---|---|---|---|
| Medium | GET /dashboard/counts, /dashboard/user-count, /dashboard/admin-summary, /dashboard/admin-level-count, POST /dashboard/getPatientDashboardCount | app/store/dashboardStore/dashboardStore.ts:157-267 ; used by app/dashboard/components/Dashboard/PatientDashboard.tsx | Backend dashboard only has /summary, /hr-summary and /hr-employee-stats. These five calls return 404 (legacy 'Patient' dashboard code). If any screen renders them it shows empty data/errors. |
| Low | GET/PUT /user/settings, PUT /user/preferences | app/store/userStore/userStore.ts:55,583,598 | No such backend routes. GET /user/settings even falls into the public route GET /api/User/:_id with id='settings'. No component calls these store methods, so it is dead code. |
| Low | GET /admin/users/courses/:id/users | app/store/userStore/userStore.ts:559 | Not found in the backend (LMS leftover). |

Checked and fine: `PATCH /payroll/statutory/tax-declarations/:id` (flagged by the script, backend has it); `/projects...` calls are built from a variable path.

## Result

All HRMS screens' API calls (attendance, leave, WFH, comp-off, payroll, approvals, organization, users, profile) have a matching backend route. The only broken-looking calls are legacy dashboard / settings code listed above.

## Backend routes that no frontend call uses

91 HRMS backend routes were not found in any literal frontend call (calls built from variables, e.g. the projects module, cannot be matched, so some of these are false positives). They are either unused APIs or features without a screen. Grouped by router file:

### User (7)
- `GET /api/auth/verify-email/:id`
- `POST /api/auth/bootstrap/superadmin`
- `POST /api/auth/contact/mail`
- `POST /api/auth/create`
- `POST /api/auth/get/users`
- `POST /api/auth/processResume`
- `PUT /api/auth`

### approvalWorkflows.routing (1)
- `GET /api/approval-workflows/:id`

### attendance.routing (1)
- `GET /api/attendance/regularization/requests/:id`

### compOff.routing (1)
- `GET /api/comp-off/claims/:id`

### company.routing (10)
- `GET /api/company/policy/holidays`
- `GET /api/company/policy/workLocations`
- `GET /api/company/policy/workTiming`
- `POST /api/company/create`
- `POST /api/company/single/create`
- `PUT /api/company/policy/holidays`
- `PUT /api/company/policy/holidays/excel`
- `PUT /api/company/policy/workLocation`
- `PUT /api/company/policy/workLocations/excel`
- `PUT /api/company/policy/workTiming`

### file.routing (1)
- `GET /api/file/view/:id`

### leave.routing (4)
- `GET /api/leave/balances`
- `GET /api/leave/cancellation-requests/:id`
- `GET /api/leave/requests/:id`
- `POST /api/leave/accruals/run`

### notification/notification.routing (7)
- `GET /api/notifications`
- `GET /api/notifications/users`
- `PATCH /api/notifications/:id/read`
- `PATCH /api/notifications/read-all`
- `POST /api/notifications/send`
- `PUT /api/notification`
- `PUT /api/notifications`

### payroll.routing (11)
- `GET /api/payroll/runs/:id`
- `GET /api/payroll/statutory/employees/:id`
- `PATCH /api/payroll/statutory/tax-declarations/:id`
- `POST /api/payroll/runs/:id/finalize`
- `POST /api/payroll/runs/:id/reopen`
- `POST /api/payroll/runs/:id/review-decision`
- `POST /api/payroll/runs/:id/submit-review`
- `POST /api/payroll/statutory/employee-assignments/:id/cancel`
- `POST /api/payroll/statutory/tax-declarations/:id/cancel`
- `POST /api/payroll/statutory/tax-declarations/:id/review`
- `POST /api/payroll/statutory/tax-declarations/:id/submit`

### projects.routing (15)
- `GET /api/projects`
- `GET /api/projects/:id`
- `GET /api/projects/:id/assignments`
- `GET /api/projects/:id/audit`
- `GET /api/projects/:id/work-types`
- `GET /api/projects/options`
- `GET /api/projects/people`
- `POST /api/projects`
- `POST /api/projects/:id/archive`
- `POST /api/projects/:id/assignments`
- `POST /api/projects/:id/assignments/:id/end`
- `POST /api/projects/:id/restore`
- `POST /api/projects/:id/work-types`
- `PUT /api/projects/:id`
- `PUT /api/projects/:id/work-types/:id`

### remoteWork.routing (1)
- `GET /api/remote-work/requests/:id`

### token/token.routing (1)
- `POST /api/token/verify`

### users.routing (18)
- `GET /api/User/companydetails/:id`
- `GET /api/User/designation/count`
- `GET /api/User/get/roles/count`
- `GET /api/User/getManagers/:id`
- `GET /api/User/info/Subordinate/:id`
- `GET /api/User/managers/:id`
- `GET /api/User/users/roles`
- `POST /api/User/info/Subordinate`
- `POST /api/User/managers/Users/count`
- `POST /api/User/salaryStructure`
- `POST /api/User/total/count`
- `PUT /api/User/bankDetails/:id`
- `PUT /api/User/companyDetails/:id`
- `PUT /api/User/familyDetails/:id`
- `PUT /api/User/permissions/:id`
- `PUT /api/User/qualifications/:id`
- `PUT /api/User/salaryStructure/:id`
- `PUT /api/User/workExperience/:id`

### workforcePolicies.routing (13)
- `GET /api/workforce-policies/attendance/:id`
- `GET /api/workforce-policies/holiday-calendars/:id`
- `GET /api/workforce-policies/leave-policies/:id`
- `GET /api/workforce-policies/remote-work-policies/:id`
- `GET /api/workforce-policies/work-schedules/:id`
- `POST /api/workforce-policies/attendance/:id/archive`
- `POST /api/workforce-policies/holiday-calendars/:id/archive`
- `POST /api/workforce-policies/remote-work-policies/:id/archive`
- `POST /api/workforce-policies/work-schedules/:id/archive`
- `PUT /api/workforce-policies/attendance/:id`
- `PUT /api/workforce-policies/leave-policies/:id`
- `PUT /api/workforce-policies/remote-work-policies/:id`
- `PUT /api/workforce-policies/work-schedules/:id`
