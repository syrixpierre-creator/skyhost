import { z } from "zod";
import { DATABASE_ENGINES, ENVIRONMENT_TYPES, SERVICE_TYPES } from "./constants";
import { API_KEY_SCOPES, ROLES } from "./rbac";
import { ENV_KEY_RE } from "./env";

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), "Password must contain letters and numbers");

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, digits and dashes");

export const nameSchema = z.string().trim().min(1).max(80);

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the Terms of Service" }) }),
  referralCode: z.string().max(32).optional(),
  deviceId: z.string().max(128).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  deviceId: z.string().max(128).optional(),
});

export const roleSchema = z.enum(ROLES);

export const healthcheckSchema = z.object({
  path: z.string().startsWith("/").max(512).default("/"),
  port: z.number().int().min(1).max(65535).optional(),
  intervalSeconds: z.number().int().min(1).max(300).default(5),
  timeoutSeconds: z.number().int().min(1).max(120).default(5),
  retries: z.number().int().min(1).max(60).default(12),
  enabled: z.boolean().default(true),
});

export const resourcesSchema = z.object({
  cpu: z.number().min(0.1).max(64).default(0.5),
  memoryMb: z.number().int().min(64).max(262144).default(512),
  replicas: z.number().int().min(1).max(20).default(1),
});

export const cronSchema = z.object({
  schedule: z.string().min(9).max(120),
  timezone: z.string().max(64).default("UTC"),
  timeoutSeconds: z.number().int().min(10).max(86400).default(900),
  enabled: z.boolean().default(true),
});

export const protectionSchema = z.object({
  mode: z.enum(["none", "basic", "password", "ip"]).default("none"),
  basicUser: z.string().max(64).optional(),
  basicPassword: z.string().max(128).optional(),
  password: z.string().max(128).optional(),
  ipAllowlist: z.array(z.string().max(64)).max(100).default([]),
  applyToPreviews: z.boolean().default(true),
});

export const wafRuleSchema = z.object({
  id: z.string().max(64),
  action: z.enum(["block", "allow"]),
  match: z.object({
    ip: z.array(z.string().max(64)).optional(),
    country: z.array(z.string().length(2)).optional(),
    pathPrefix: z.string().max(256).optional(),
    userAgentContains: z.string().max(128).optional(),
  }),
});

export const wafSchema = z.object({
  enabled: z.boolean().default(false),
  blockBots: z.boolean().default(false),
  rateLimitPerMinute: z.number().int().min(0).max(1_000_000).default(0),
  rules: z.array(wafRuleSchema).max(100).default([]),
});

export const serviceConfigSchema = z.object({
  runtime: z.string().max(32).optional(),
  framework: z.string().max(64).optional(),
  packageManager: z.string().max(32).optional(),
  rootDir: z.string().max(512).default("."),
  dockerfilePath: z.string().max(512).optional(),
  installCommand: z.string().max(1000).optional(),
  buildCommand: z.string().max(1000).optional(),
  startCommand: z.string().max(1000).optional(),
  testCommand: z.string().max(1000).optional(),
  outputDirectory: z.string().max(512).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  runtimeVersion: z.string().max(32).optional(),
  spaFallback: z.boolean().default(true),
  healthcheck: healthcheckSchema.default({}),
  resources: resourcesSchema.default({}),
  cron: cronSchema.optional(),
  autoDeploy: z.boolean().default(true),
  waitForCi: z.boolean().default(false),
  previews: z.boolean().default(false),
  sleepAfterMinutes: z.number().int().min(0).max(10080).default(0),
  gracefulShutdownSeconds: z.number().int().min(0).max(600).default(30),
  protection: protectionSchema.default({}),
  /** Maintenance page: traffic gets a 503 page with this message while the deployment keeps running. */
  maintenance: z.object({ enabled: z.boolean().default(false), message: z.string().max(500).default("") }).default({}),
  waf: wafSchema.default({}),
  screenshotPaths: z.array(z.string().startsWith("/").max(256)).max(10).default(["/"]),
  autoScreenshots: z.boolean().default(true),
  watchPaths: z.array(z.string().max(256)).max(50).default([]),
});
export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["github", "gitlab", "bitbucket"]),
    repo: z.string().regex(/^[\w.-]+\/[\w./-]+$/, "Expected owner/repo"),
    branch: z.string().max(255).optional(),
    installationId: z.string().max(64).optional(),
  }),
  z.object({ kind: z.literal("git"), url: z.string().url().max(2048), branch: z.string().max(255).optional() }),
  z.object({ kind: z.literal("zip"), uploadId: z.string().max(64) }),
  z.object({ kind: z.literal("image"), image: z.string().min(1).max(512).regex(/^[\w.\-/:@]+$/), registryAuth: z.string().max(2048).optional() }),
]);
export type ServiceSource = z.infer<typeof sourceSchema>;

export const createProjectSchema = z.object({
  teamId: z.string().uuid(),
  name: nameSchema,
  description: z.string().max(500).optional(),
  region: z.string().max(32).optional(),
});

export const createServiceSchema = z.object({
  name: z.string().trim().min(1).max(48).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/),
  type: z.enum(SERVICE_TYPES),
  source: sourceSchema,
  config: serviceConfigSchema.partial().default({}),
  deploy: z.boolean().default(true),
});

export const variableInputSchema = z.object({
  key: z.string().regex(ENV_KEY_RE).max(256),
  value: z.string().max(32 * 1024),
  secret: z.boolean().default(false),
  sealed: z.boolean().default(false),
});

export const bulkVariablesSchema = z.object({
  environmentId: z.string().uuid(),
  serviceId: z.string().uuid().nullable().default(null),
  variables: z.array(variableInputSchema).max(500),
  /** When true, keys not present in the payload are deleted (replace semantics used by the editor). */
  replace: z.boolean().default(false),
});

export const createDatabaseSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(48).regex(/^[a-z0-9][a-z0-9-]*$/),
  engine: z.enum(DATABASE_ENGINES),
  version: z.string().max(16).optional(),
  region: z.string().max(32).optional(),
  storageMb: z.number().int().min(256).max(1_048_576).default(1024),
});

export const createEnvironmentSchema = z.object({
  name: z.string().trim().min(1).max(48),
  type: z.enum(ENVIRONMENT_TYPES),
  cloneFrom: z.string().uuid().optional(),
  cloneDatabases: z.boolean().default(false),
  anonymize: z.boolean().default(false),
});

export const createApiKeySchema = z.object({
  name: nameSchema,
  teamId: z.string().uuid(),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  projectId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export const domainSchema = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Invalid domain name"),
  redirectTo: z.string().max(253).optional(),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(128).optional(),
});
