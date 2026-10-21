import { generateError } from "../../config/Error/functions";

export function assertUserStatusChangeAllowed(options: {
  requesterId: unknown;
  targetUserId: unknown;
  nextStatus: boolean;
}) {
  if (
    options.nextStatus === false &&
    String(options.requesterId || "") &&
    String(options.requesterId) === String(options.targetUserId || "")
  ) {
    throw generateError("You cannot deactivate your own account", 400);
  }
}
