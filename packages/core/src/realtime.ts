import { redis } from "./redis";

/**
 * Realtime events are published on Redis and fanned out to WebSocket clients by every API instance.
 * Channels: deployment:<id>, service:<id>, project:<id>, team:<id>, user:<id>, database:<id>.
 */
export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export const CHANNEL_PREFIX = "sh:rt:";

export async function publish(channel: string, event: RealtimeEvent) {
  await redis().publish(CHANNEL_PREFIX + channel, JSON.stringify({ channel, ...event, at: new Date().toISOString() }));
}
