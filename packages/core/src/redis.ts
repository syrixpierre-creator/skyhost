import { Redis } from "ioredis";
import { serverConfig } from "./config";

let client: Redis | null = null;
let subscriber: Redis | null = null;

export function redis(): Redis {
  client ??= new Redis(serverConfig().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  return client;
}

/** Dedicated connection for pub/sub subscriptions. */
export function redisSubscriber(): Redis {
  subscriber ??= new Redis(serverConfig().REDIS_URL, { maxRetriesPerRequest: null });
  return subscriber;
}

export function newRedisConnection(): Redis {
  return new Redis(serverConfig().REDIS_URL, { maxRetriesPerRequest: null });
}

export async function closeRedis() {
  await Promise.all([client?.quit().catch(() => {}), subscriber?.quit().catch(() => {})]);
  client = null;
  subscriber = null;
}
