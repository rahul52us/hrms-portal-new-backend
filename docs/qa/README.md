# HRMS QA test cases

- `HRMS_Test_Cases.xlsx` - main sheet (Test Cases, Summary, How to use). Fill the yellow columns: Status, Actual Result, Tester, Date, Bug ID.
- `HRMS_Test_Cases.csv` - same test cases as plain CSV (easy to diff in Git).

286 manual QA cases for the HRMS portal: authentication, employees, profile, roles/permissions, organization setup, attendance, WFH, calendar/policy, leave, comp-off and payroll. LMS features are not covered.

Each case has: TC ID, module, scenario, type, priority (P0-P3), role, preconditions, steps, test data, expected result and the source file it was derived from.

Status note: rows marked Pass by "Claude (auto)" were verified only by running backend logic (calculators, validators, rules). Screens, API calls and database flows are still "Not Run".
