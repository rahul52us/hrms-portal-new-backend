import { StatutoryProvider } from "./statutoryProvider.types";
import { calculateIndiaStatutoryContributions } from "./indiaStatutoryContributionCalculator";

const fields: StatutoryProvider["fields"] = [
  {
    key: "registeredLegalName",
    label: "Registered legal name",
    required: true,
    maxLength: 160,
    placeholder: "Legal employer name used for statutory filings",
    helpText: "Use the employer name shown on statutory registrations.",
  },
  {
    key: "registrationState",
    label: "Registration state or UT",
    required: true,
    maxLength: 80,
    placeholder: "Example: Delhi",
    helpText: "Company registration reference. Employee PT and LWF use the employee's snapshotted office state.",
  },
  {
    key: "taxDeductionAccountNumber",
    label: "Tax deduction account number",
    required: false,
    maxLength: 40,
    placeholder: "Employer tax-withholding registration",
    helpText: "Required before tax-withholding filing exports are enabled.",
    transform: "uppercase" as const,
  },
  {
    key: "incomeTaxDefaultRegime",
    label: "Default income-tax regime",
    required: false,
    maxLength: 3,
    placeholder: "New",
    helpText: "Used when an employee has no verified declaration for the payroll tax year.",
    defaultValue: "new",
    options: [
      { value: "new", label: "New tax regime - default" },
      { value: "old", label: "Old tax regime" },
    ],
  },
  {
    key: "providentFundEstablishmentCode",
    label: "Provident fund establishment code",
    required: false,
    maxLength: 60,
    placeholder: "Employer provident-fund registration",
    helpText: "Required when the provident-fund module is enabled for filing.",
    transform: "uppercase" as const,
  },
  {
    key: "providentFundContributionRate",
    label: "Provident-fund contribution rate",
    required: false,
    maxLength: 2,
    placeholder: "12",
    helpText: "Use the standard 12% rate unless the establishment is legally eligible for the reduced 10% rate.",
    defaultValue: "12",
    options: [
      { value: "12", label: "12% - standard rate" },
      { value: "10", label: "10% - eligible reduced rate" },
    ],
  },
  {
    key: "employeeStateInsuranceCode",
    label: "Employee state insurance code",
    required: false,
    maxLength: 60,
    placeholder: "Employer insurance registration",
    helpText: "Required when the employee-state-insurance module is enabled for filing.",
    transform: "uppercase" as const,
  },
  {
    key: "professionalTaxRegistrationNumber",
    label: "Professional tax registration",
    required: false,
    maxLength: 60,
    placeholder: "State professional-tax registration",
    helpText: "Employer registration reference for professional-tax reporting. Calculation uses each employee's office state.",
    transform: "uppercase" as const,
  },
  {
    key: "labourWelfareFundRegistrationNumber",
    label: "Labour welfare fund registration",
    required: false,
    maxLength: 60,
    placeholder: "State labour-welfare registration",
    helpText: "Employer registration reference for labour-welfare reporting. Calculation uses each employee's office state.",
    transform: "uppercase" as const,
  },
];

const modules = [
  { key: "income_tax_withholding", label: "Income tax withholding", description: "Projected salary tax withholding using dated India rules and verified declarations." },
  { key: "provident_fund", label: "Provident fund", description: "Employee and employer provident-fund rules." },
  { key: "employee_state_insurance", label: "Employee state insurance", description: "Employee and employer insurance rules." },
  { key: "professional_tax", label: "Professional tax", description: "Uses the employee's snapshotted office state. Initial rule packs cover Maharashtra, Karnataka, and Delhi." },
  { key: "labour_welfare_fund", label: "Labour welfare fund", description: "Uses the employee's snapshotted office state and the applicable contribution month for Maharashtra, Karnataka, or Delhi." },
];

const employeeIdentifierFields = [
  {
    key: "panNumber",
    label: "PAN",
    maxLength: 10,
    placeholder: "ABCDE1234F",
    helpText: "Permanent Account Number used for income-tax withholding.",
    sensitive: true,
    transform: "uppercase" as const,
    pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$",
    requiredForModule: "income_tax_withholding",
  },
  {
    key: "nameAsPerPan",
    label: "Name as per PAN",
    maxLength: 120,
    placeholder: "Name printed on PAN",
    helpText: "Used for tax records and filing validation.",
  },
  {
    key: "aadhaarNumber",
    label: "Aadhaar number",
    maxLength: 12,
    placeholder: "12 digit Aadhaar number",
    helpText: "Employee identity reference. Store only with the required organizational safeguards.",
    sensitive: true,
    transform: "digits" as const,
    pattern: "^[0-9]{12}$",
  },
  {
    key: "nameAsPerAadhaar",
    label: "Name as per Aadhaar",
    maxLength: 120,
    placeholder: "Name printed on Aadhaar",
    helpText: "Used when the Aadhaar identity reference is supplied.",
  },
  {
    key: "uan",
    label: "UAN",
    maxLength: 12,
    placeholder: "12 digit Universal Account Number",
    helpText: "Provident-fund member identifier.",
    sensitive: true,
    transform: "digits" as const,
    pattern: "^[0-9]{12}$",
    requiredWhenApplicable: "providentFund",
  },
  {
    key: "nameAsPerUan",
    label: "Name as per UAN",
    maxLength: 120,
    placeholder: "Member name shown in EPFO",
    helpText: "Used as the member name in the EPFO ECR return file.",
    requiredWhenApplicable: "providentFund",
  },
  {
    key: "pfMemberId",
    label: "PF member ID",
    maxLength: 40,
    placeholder: "Establishment-specific PF member ID",
    helpText: "Member ID linked to the employer provident-fund establishment.",
    sensitive: true,
    transform: "uppercase" as const,
    pattern: "^[A-Z0-9/_-]{5,40}$",
  },
  {
    key: "esiInsuranceNumber",
    label: "ESI insurance number",
    maxLength: 10,
    placeholder: "10 digit insurance number",
    helpText: "Employee State Insurance identity number.",
    sensitive: true,
    transform: "digits" as const,
    pattern: "^[0-9]{10}$",
    requiredWhenApplicable: "employeeStateInsurance",
  },
  {
    key: "nameAsPerEsi",
    label: "Name as per ESIC",
    maxLength: 120,
    placeholder: "Insured person name shown in ESIC",
    helpText: "Used as the insured person name in the ESIC monthly contribution file.",
    pattern: "^[A-Za-z ]+$",
    requiredWhenApplicable: "employeeStateInsurance",
  },
  {
    key: "nationality",
    label: "Nationality",
    maxLength: 80,
    placeholder: "Example: Indian",
    helpText: "Nationality used in statutory employee records.",
    transform: "lowercase" as const,
  },
];

const employeeApplicability = [
  {
    key: "providentFund",
    label: "Provident fund applies",
    moduleKey: "provident_fund",
    helpText: "Include the employee in provident-fund processing when contribution rules are added.",
  },
  {
    key: "providentFundHigherWages",
    label: "PF on actual wages above the ceiling",
    moduleKey: "provident_fund",
    helpText: "Use the full configured PF wage base instead of limiting it to the statutory monthly ceiling.",
  },
  {
    key: "employeesPensionScheme",
    label: "Employees' Pension Scheme (EPS) applies",
    moduleKey: "provident_fund",
    helpText: "Enable only when the employee is an EPS member. This controls the employer pension split used in EPFO ECR.",
  },
  {
    key: "employeeStateInsurance",
    label: "Employee State Insurance applies",
    moduleKey: "employee_state_insurance",
    helpText: "Include the employee in ESI processing when contribution rules are added.",
  },
  {
    key: "professionalTax",
    label: "Professional tax applies",
    moduleKey: "professional_tax",
    helpText: "Include the employee in professional-tax processing using the employee's effective office location state.",
  },
  {
    key: "labourWelfareFund",
    label: "Labour welfare fund applies",
    moduleKey: "labour_welfare_fund",
    helpText: "Include the employee in labour-welfare-fund processing using the employee's effective office location state.",
  },
];

const taxRegimes = [
  { key: "new", label: "New tax regime", description: "Use current new-regime slabs, rebate, standard deduction, surcharge, and cess." },
  { key: "old", label: "Old tax regime", description: "Use age-based old-regime slabs and HR-verified eligible deductions." },
];

const taxDeclarationFields = [
  { key: "otherIncomeMinor", label: "Other taxable income", helpText: "Estimated taxable income outside this employer.", type: "currency" as const },
  { key: "previousEmployerIncomeMinor", label: "Previous employer taxable income", helpText: "Taxable income earned from a previous employer in this tax year.", type: "currency" as const },
  { key: "previousEmployerTaxWithheldMinor", label: "Previous employer tax withheld", helpText: "Income tax already withheld by a previous employer.", type: "currency" as const },
  { key: "section80CMinor", label: "Section 80C declaration", helpText: "Verified eligible amount. The statutory limit is applied during payroll calculation.", type: "currency" as const },
  { key: "section80DMinor", label: "Section 80D declaration", helpText: "Declared eligible medical-insurance amount.", type: "currency" as const },
  { key: "section80CCD1BMinor", label: "Additional NPS declaration", helpText: "Verified additional NPS deduction. The statutory limit is applied during calculation.", type: "currency" as const },
  { key: "homeLoanInterestMinor", label: "Home-loan interest declaration", helpText: "Declared eligible home-loan interest amount.", type: "currency" as const },
  { key: "annualRentPaidMinor", label: "Annual rent paid", helpText: "Evidence for HR review only. Rent is not deducted directly from taxable income.", type: "currency" as const },
  { key: "hraExemptionMinor", label: "Verified HRA exemption", helpText: "HRA exemption verified by HR from salary, rent, and city evidence. Used only under the old regime.", type: "currency" as const },
];

export const indiaStatutoryProvider: StatutoryProvider = {
  key: "india_standard",
  implementationVersion: "1.6.0",
  countryCode: "IN",
  countryName: "India",
  currencyCode: "INR",
  currencyMinorUnits: 2,
  label: "India standard payroll",
  description: "Company registrations and enabled statutory modules for Indian payroll.",
  fields,
  modules,
  employeeIdentifierFields,
  employeeApplicability,
  taxRegimes,
  taxDeclarationFields,
  validateAndNormalize(input) {
    const raw = input.configuration && typeof input.configuration === "object" && !Array.isArray(input.configuration)
      ? input.configuration as Record<string, unknown>
      : {};
    const configuration: Record<string, string> = {};
    const errors: string[] = [];
    for (const field of fields) {
      let value = String(raw[field.key] ?? field.defaultValue ?? "").trim();
      if (field.transform === "uppercase") value = value.toUpperCase();
      if (field.required && !value) errors.push(`${field.label} is required`);
      if (value.length > field.maxLength) errors.push(`${field.label} cannot exceed ${field.maxLength} characters`);
      configuration[field.key] = value;
    }
    if (!["10", "12"].includes(configuration.providentFundContributionRate)) {
      errors.push("Provident-fund contribution rate must be 10% or 12%");
    }
    if (!["new", "old"].includes(configuration.incomeTaxDefaultRegime)) {
      errors.push("Default income-tax regime must be new or old");
    }
    const requestedModules = Array.isArray(input.enabledModules)
      ? input.enabledModules.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    const allowedModules = new Set(modules.map((module) => module.key));
    const enabledModules = [...new Set(requestedModules)];
    const unsupported = enabledModules.filter((module) => !allowedModules.has(module));
    if (unsupported.length) errors.push(`Unsupported statutory module: ${unsupported.join(", ")}`);
    if (input.forPublish && enabledModules.length === 0) errors.push("Enable at least one statutory module before publishing");
    return { configuration, enabledModules: enabledModules.filter((module) => allowedModules.has(module)), errors };
  },
  validateEmployeeStatutory(input) {
    const rawIdentifiers = input.identifiers && typeof input.identifiers === "object" && !Array.isArray(input.identifiers)
      ? input.identifiers as Record<string, unknown>
      : {};
    const rawApplicability = input.applicability && typeof input.applicability === "object" && !Array.isArray(input.applicability)
      ? input.applicability as Record<string, unknown>
      : {};
    const enabledModules = new Set(
      Array.isArray(input.enabledModules)
        ? input.enabledModules.map((value) => String(value || "").trim()).filter(Boolean)
        : []
    );
    const identifiers: Record<string, string> = {};
    const applicability: Record<string, boolean> = {};
    const errors: string[] = [];

    for (const field of employeeIdentifierFields) {
      let value = String(rawIdentifiers[field.key] ?? "").trim();
      if (field.transform === "uppercase") value = value.toUpperCase();
      if (field.transform === "lowercase") value = value.toLowerCase();
      if (field.transform === "digits") value = value.replace(/\s+/g, "");
      if (value.length > field.maxLength) errors.push(field.label + " cannot exceed " + field.maxLength + " characters");
      if (value && field.pattern && !new RegExp(field.pattern).test(value)) errors.push(field.label + " has an invalid format");
      if (field.requiredForModule && enabledModules.has(field.requiredForModule) && !value) {
        errors.push(field.label + " is required while " + field.requiredForModule.replace(/_/g, " ") + " is enabled");
      }
      if (field.requiredWhenApplicable && rawApplicability[field.requiredWhenApplicable] === true && !value) {
        errors.push(field.label + " is required when " + field.requiredWhenApplicable + " applies");
      }
      identifiers[field.key] = value;
    }

    for (const definition of employeeApplicability) {
      const value = rawApplicability[definition.key] === true;
      if (value && !enabledModules.has(definition.moduleKey)) {
        errors.push(definition.label + " cannot be enabled because the company module is not enabled");
      }
      applicability[definition.key] = value && enabledModules.has(definition.moduleKey);
    }
    if (applicability.providentFundHigherWages && !applicability.providentFund) {
      errors.push("PF on actual wages requires provident fund applicability");
      applicability.providentFundHigherWages = false;
    }
    if (applicability.employeesPensionScheme && !applicability.providentFund) {
      errors.push("EPS membership requires provident fund applicability");
      applicability.employeesPensionScheme = false;
    }
    return { identifiers, applicability, errors };
  },
  validateTaxDeclaration(input) {
    const taxRegime = String(input.taxRegime || "").trim().toLowerCase();
    const raw = input.declarations && typeof input.declarations === "object" && !Array.isArray(input.declarations)
      ? input.declarations as Record<string, unknown>
      : {};
    const declarations: Record<string, number> = {};
    const errors: string[] = [];
    if (taxRegime && !taxRegimes.some((regime) => regime.key === taxRegime)) errors.push("Unsupported tax regime");
    if (input.forSubmit && !taxRegime) errors.push("Tax regime is required before submission");
    for (const field of taxDeclarationFields) {
      const value = raw[field.key] === undefined || raw[field.key] === "" ? 0 : Number(raw[field.key]);
      if (!Number.isSafeInteger(value) || value < 0) errors.push(field.label + " must be a non-negative minor-unit integer");
      declarations[field.key] = Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }
    return { taxRegime, declarations, errors };
  },
  calculateContributions(input) {
    return calculateIndiaStatutoryContributions(input, indiaStatutoryProvider.implementationVersion);
  },
};
