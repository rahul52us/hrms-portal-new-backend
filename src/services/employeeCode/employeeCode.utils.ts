export const COMPANY_CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const EMPLOYEE_NUMBER_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export const MAX_COMPANY_CODE_LENGTH = 20;
export const MAX_EMPLOYEE_NUMBER_LENGTH = 40;

function normalizeIdentifierPart(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

export function normalizeCompanyCode(value: unknown) {
  return normalizeIdentifierPart(value);
}

export function normalizeEmployeeNumber(value: unknown, companyCode?: unknown) {
  const normalizedValue = normalizeIdentifierPart(value);
  const normalizedCompanyCode = normalizeCompanyCode(companyCode);
  const companyPrefix = normalizedCompanyCode ? `${normalizedCompanyCode}-` : "";

  if (companyPrefix && normalizedValue.startsWith(companyPrefix)) {
    return normalizedValue.slice(companyPrefix.length);
  }

  return normalizedValue;
}

export function isValidCompanyCode(value: unknown) {
  const normalizedValue = normalizeCompanyCode(value);
  return (
    normalizedValue.length >= 2 &&
    normalizedValue.length <= MAX_COMPANY_CODE_LENGTH &&
    COMPANY_CODE_PATTERN.test(normalizedValue)
  );
}

export function isValidEmployeeNumber(value: unknown) {
  const normalizedValue = normalizeIdentifierPart(value);
  return (
    normalizedValue.length >= 1 &&
    normalizedValue.length <= MAX_EMPLOYEE_NUMBER_LENGTH &&
    EMPLOYEE_NUMBER_PATTERN.test(normalizedValue)
  );
}

export function buildEmployeeIdentifier(companyCode: unknown, employeeNumberOrCode: unknown) {
  const normalizedCompanyCode = normalizeCompanyCode(companyCode);
  const employeeNumber = normalizeEmployeeNumber(
    employeeNumberOrCode,
    normalizedCompanyCode
  );

  if (
    !isValidCompanyCode(normalizedCompanyCode) ||
    !isValidEmployeeNumber(employeeNumber)
  ) {
    return null;
  }

  return {
    companyCode: normalizedCompanyCode,
    employeeNumber,
    code: `${normalizedCompanyCode}-${employeeNumber}`,
  };
}
