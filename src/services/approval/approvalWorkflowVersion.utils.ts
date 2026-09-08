export interface ApprovalWorkflowVersionValue {
  status?: string;
  versionNumber?: number;
  effectiveFrom?: Date | string | null;
  publishedAt?: Date | string | null;
  createdAt?: Date | string | null;
  applicableTo?: string[] | null;
  [key: string]: any;
}

export function approvalWorkflowVersionRequestTypes(
  version: ApprovalWorkflowVersionValue | null | undefined,
  legacyWorkflowTypes: string[] = []
) {
  const versionTypes = Array.isArray(version?.applicableTo)
    ? version.applicableTo.filter(Boolean)
    : [];
  return Array.from(new Set(versionTypes.length ? versionTypes : legacyWorkflowTypes.filter(Boolean)));
}

export function approvalWorkflowVersionSupportsRequestType(
  version: ApprovalWorkflowVersionValue | null | undefined,
  legacyWorkflowTypes: string[],
  requestType: string
) {
  return approvalWorkflowVersionRequestTypes(version, legacyWorkflowTypes).includes(requestType);
}

export function missingApprovalWorkflowRequestTypes(requiredTypes: string[], proposedTypes: string[]) {
  const proposed = new Set(proposedTypes);
  return Array.from(new Set(requiredTypes)).filter((requestType) => !proposed.has(requestType));
}

function validTime(value: Date | string | null | undefined) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

export function approvalWorkflowVersionEffectiveTime(version: ApprovalWorkflowVersionValue) {
  return (
    validTime(version.effectiveFrom) ??
    validTime(version.publishedAt) ??
    validTime(version.createdAt)
  );
}

export function selectEffectiveApprovalWorkflowVersion<T extends ApprovalWorkflowVersionValue>(
  versions: T[],
  at = new Date()
) {
  const atTime = at.getTime();
  if (Number.isNaN(atTime)) return null;

  return (
    (versions || [])
      .filter((version) => version.status === "published")
      .map((version) => ({
        version,
        effectiveTime: approvalWorkflowVersionEffectiveTime(version),
      }))
      .filter(
        (item): item is { version: T; effectiveTime: number } =>
          item.effectiveTime !== null && item.effectiveTime <= atTime
      )
      .sort(
        (left, right) =>
          right.effectiveTime - left.effectiveTime ||
          Number(right.version.versionNumber || 0) - Number(left.version.versionNumber || 0)
      )[0]?.version || null
  );
}
