export type UserAccountStatus = "PENDING" | "ACTIVE" | "INACTIVE" | "DELETED";

export const ACTIVE_USER_PASSWORD_MATCH = {
  $exists: true,
  $nin: [null, ""],
};

export function hasUserPassword(user: any) {
  return Boolean(String(user?.password || "").trim());
}

export function getUserAccountStatus(user: any): UserAccountStatus {
  if (user?.deletedAt) return "DELETED";
  if (user?.is_enabled === false) return "INACTIVE";
  return hasUserPassword(user) ? "ACTIVE" : "PENDING";
}

export function isUserAccountActive(user: any) {
  return getUserAccountStatus(user) === "ACTIVE";
}

export function canUserLogin(user: any) {
  return isUserAccountActive(user);
}
