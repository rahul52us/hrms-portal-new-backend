export type StatutoryProviderFieldDefinition = {
  key: string;
  label: string;
  required: boolean;
  maxLength: number;
  placeholder: string;
  helpText: string;
  transform?: "uppercase";
  defaultValue?: string;
  options?: Array<{ value: string; label: string }>;
};

export type StatutoryProviderModuleDefinition = {
  key: string;
  label: string;
  description: string;
};

export type EmployeeStatutoryFieldDefinition = {
  key: string;
  label: string;
  maxLength: number;
  placeholder: string;
  helpText: string;
  sensitive?: boolean;
  transform?: "uppercase" | "lowercase" | "digits";
  pattern?: string;
  requiredForModule?: string;
  requiredWhenApplicable?: string;
};

export type EmployeeStatutoryApplicabilityDefinition = {
  key: string;
  label: string;
  moduleKey: string;
  helpText: string;
};

export type EmployeeTaxDeclarationFieldDefinition = {
  key: string;
  label: string;
  helpText: string;
  type: "currency";
};

export type StatutoryProviderValidationResult = {
  configuration: Record<string, string>;
  enabledModules: string[];
  errors: string[];
};

export type EmployeeStatutoryValidationResult = {
  identifiers: Record<string, string>;
  applicability: Record<string, boolean>;
  errors: string[];
};

export type EmployeeTaxDeclarationValidationResult = {
  taxRegime: string;
  declarations: Record<string, number>;
  errors: string[];
};

export type StatutoryContributionSide = "employee_deduction" | "employer_contribution";

export type StatutoryContributionLine = {
  providerKey: string;
  providerImplementationVersion: string;
  moduleKey: string;
  code: string;
  name: string;
  side: StatutoryContributionSide;
  wageBaseMinor: number;
  rateBps: number;
  amountMinor: number;
  roundingMode: "nearest_major_unit" | "ceil_major_unit";
  ruleVersion: string;
  ruleEffectiveFrom: string;
  metadata?: Record<string, string | number | boolean>;
};

export type StatutoryContributionIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
};

export type StatutoryContributionInput = {
  cycleEndDate: string;
  currency: string;
  currencyMinorUnits: number;
  enabledModules: string[];
  configuration: Record<string, string>;
  applicability: Record<string, boolean>;
  recurringComponents: Array<{
    componentCode: string;
    category: string;
    payableAmountMinor: number;
    statutoryWageBases?: string[];
  }>;
  oneTimeInputs: Array<{
    componentCode: string;
    inputType: string;
    amountMinor: number;
    statutoryWageBases?: string[];
  }>;
  payrollDays: { paidDays: number; unpaidDays: number; totalDays: number };
  employee?: {
    gender?: number;
    officeState?: string;
    officeCountry?: string;
  };
  taxWithholding?: {
    taxYear: string;
    taxRegime?: string;
    declarationVersion?: number;
    declarations?: Record<string, number>;
    hasPan: boolean;
    employeeDateOfBirth?: string;
    priorTaxableEarningsMinor: number;
    priorTaxWithheldMinor: number;
    currentTaxableEarningsMinor: number;
    projectedFutureRecurringTaxableEarningsMinor: number;
    remainingPayrollPeriods: number;
  };
};

export type StatutoryContributionResult = {
  providerKey: string;
  providerImplementationVersion: string;
  ruleVersion?: string;
  lines: StatutoryContributionLine[];
  issues: StatutoryContributionIssue[];
};

export type StatutoryProvider = {
  key: string;
  implementationVersion: string;
  countryCode: string;
  countryName: string;
  currencyCode: string;
  currencyMinorUnits: number;
  label: string;
  description: string;
  fields: StatutoryProviderFieldDefinition[];
  modules: StatutoryProviderModuleDefinition[];
  employeeIdentifierFields: EmployeeStatutoryFieldDefinition[];
  employeeApplicability: EmployeeStatutoryApplicabilityDefinition[];
  taxRegimes: Array<{ key: string; label: string; description: string }>;
  taxDeclarationFields: EmployeeTaxDeclarationFieldDefinition[];
  validateAndNormalize: (input: {
    configuration: unknown;
    enabledModules: unknown;
    forPublish: boolean;
  }) => StatutoryProviderValidationResult;
  validateEmployeeStatutory: (input: {
    identifiers: unknown;
    applicability: unknown;
    enabledModules: unknown;
  }) => EmployeeStatutoryValidationResult;
  validateTaxDeclaration: (input: {
    taxRegime: unknown;
    declarations: unknown;
    forSubmit: boolean;
  }) => EmployeeTaxDeclarationValidationResult;
  calculateContributions?: (input: StatutoryContributionInput) => StatutoryContributionResult;
};
