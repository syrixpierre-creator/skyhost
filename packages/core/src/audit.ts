import { auditLogs, getDb } from "@skyhost/db";

export interface Actor {
  userId?: string | null;
  apiKeyId?: string | null;
  impersonatorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Records an audit event. Metadata must never contain secrets: values of variables, passwords and tokens
 * are not logged, only their keys.
 */
export async function audit(actor: Actor | null, teamId: string | null, action: string, target?: { type: string; id: string } | null, metadata: Record<string, unknown> = {}) {
  await getDb()
    .insert(auditLogs)
    .values({
      teamId,
      actorUserId: actor?.userId ?? null,
      actorApiKeyId: actor?.apiKeyId ?? null,
      impersonatorId: actor?.impersonatorId ?? null,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      metadata,
      ip: actor?.ip ?? null,
      userAgent: actor?.userAgent?.slice(0, 300) ?? null,
    });
}
