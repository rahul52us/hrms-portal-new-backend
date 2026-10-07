import { indiaStatutoryProvider } from "./indiaStatutory.provider";
import { StatutoryProvider } from "./statutoryProvider.types";

const providers = new Map<string, StatutoryProvider>([
  [indiaStatutoryProvider.key, indiaStatutoryProvider],
]);

export function getStatutoryProvider(key: unknown) {
  return providers.get(String(key || "").trim().toLowerCase()) || null;
}

export function listStatutoryProviders() {
  return [...providers.values()].map((provider) => ({
    key: provider.key,
    implementationVersion: provider.implementationVersion,
    countryCode: provider.countryCode,
    countryName: provider.countryName,
    currencyCode: provider.currencyCode,
    currencyMinorUnits: provider.currencyMinorUnits,
    label: provider.label,
    description: provider.description,
    fields: provider.fields,
    modules: provider.modules,
    employeeIdentifierFields: provider.employeeIdentifierFields,
    employeeApplicability: provider.employeeApplicability,
    taxRegimes: provider.taxRegimes,
    taxDeclarationFields: provider.taxDeclarationFields,
  }));
}
