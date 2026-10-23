import { slugify } from "@skyhost/shared";

export { assertQuota, audit, badRequest, conflict, enqueue, notify, serverConfig, serviceHostname } from "@skyhost/core";

export function slugifySafe(s: string) {
  return slugify(s, 48);
}
