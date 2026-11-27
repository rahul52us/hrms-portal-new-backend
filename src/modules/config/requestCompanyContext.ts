const authenticatedCompanies = new WeakMap<object, any>();

export function setAuthenticatedCompany(req: object, company: any) {
  if (company) authenticatedCompanies.set(req, company);
}

// Reuse only this request's authenticated tenant, never a cross-request permission cache.
export function getAuthenticatedCompany(req: object, companyId: string) {
  const company = authenticatedCompanies.get(req);
  return company && String(company._id) === companyId && company.deletedAt === undefined ? company : null;
}
