import type { DatabaseEngine, ServiceType } from "./constants";

export interface TemplateService {
  name: string;
  type: ServiceType;
  source: { kind: "image"; image: string } | { kind: "git"; repo: string; branch?: string; rootDir?: string };
  port?: number;
  startCommand?: string;
  healthcheckPath?: string;
  /** Values may use ${{db.KEY}} references, or "@secret" to generate a random secret at creation time. */
  env?: Record<string, string>;
  volumes?: Array<{ name: string; mountPath: string; sizeMb: number }>;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  tags: string[];
  services: TemplateService[];
  databases: Array<{ name: string; engine: DatabaseEngine; connectTo: string[] }>;
}

/** Repository that hosts the starters' source code (the templates/ folder of SKYHOST). Overridable with SKYHOST_TEMPLATES_REPO. */
export const DEFAULT_TEMPLATES_REPO = "https://github.com/syrixpierre-creator/skyhost";

export const TEMPLATES: Template[] = [
  {
    id: "nextjs-postgres",
    name: "Next.js + PostgreSQL",
    description: "Next.js app router starter connected to a managed PostgreSQL database.",
    tags: ["node", "react", "fullstack"],
    services: [
      {
        name: "web",
        type: "web",
        source: { kind: "git", repo: DEFAULT_TEMPLATES_REPO, rootDir: "templates/nextjs-postgres" },
        port: 3000,
        env: { DATABASE_URL: "${{db.DATABASE_URL}}" },
      },
    ],
    databases: [{ name: "db", engine: "postgres", connectTo: ["web"] }],
  },
  {
    id: "express-redis",
    name: "Express API + Redis",
    description: "Minimal Express REST API with a Redis cache.",
    tags: ["node", "api"],
    services: [
      {
        name: "api",
        type: "web",
        source: { kind: "git", repo: DEFAULT_TEMPLATES_REPO, rootDir: "templates/express-redis" },
        port: 3000,
        healthcheckPath: "/health",
        env: { REDIS_URL: "${{cache.REDIS_URL}}" },
      },
    ],
    databases: [{ name: "cache", engine: "redis", connectTo: ["api"] }],
  },
  {
    id: "whatsapp-bot",
    name: "WhatsApp bot",
    description: "Node.js WhatsApp bot worker with persistent session storage.",
    tags: ["node", "bot"],
    services: [
      {
        name: "bot",
        type: "worker",
        source: { kind: "git", repo: DEFAULT_TEMPLATES_REPO, rootDir: "templates/whatsapp-bot" },
        env: { SESSION_DIR: "/data/session" },
        volumes: [{ name: "session", mountPath: "/data", sizeMb: 512 }],
      },
    ],
    databases: [],
  },
  {
    id: "wordpress",
    name: "WordPress",
    description: "WordPress with a MariaDB database and persistent uploads.",
    tags: ["php", "cms"],
    services: [
      {
        name: "wordpress",
        type: "docker",
        source: { kind: "image", image: "wordpress:6-apache" },
        port: 80,
        env: {
          WORDPRESS_DB_HOST: "${{db.DB_HOST}}:${{db.DB_PORT}}",
          WORDPRESS_DB_USER: "${{db.DB_USER}}",
          WORDPRESS_DB_PASSWORD: "${{db.DB_PASSWORD}}",
          WORDPRESS_DB_NAME: "${{db.DB_NAME}}",
        },
        volumes: [{ name: "wp-content", mountPath: "/var/www/html/wp-content", sizeMb: 2048 }],
      },
    ],
    databases: [{ name: "db", engine: "mariadb", connectTo: ["wordpress"] }],
  },
  {
    id: "n8n",
    name: "n8n",
    description: "Workflow automation with n8n, backed by PostgreSQL.",
    tags: ["automation"],
    services: [
      {
        name: "n8n",
        type: "docker",
        source: { kind: "image", image: "n8nio/n8n:latest" },
        port: 5678,
        healthcheckPath: "/healthz",
        env: {
          DB_TYPE: "postgresdb",
          DB_POSTGRESDB_HOST: "${{db.DB_HOST}}",
          DB_POSTGRESDB_PORT: "${{db.DB_PORT}}",
          DB_POSTGRESDB_DATABASE: "${{db.DB_NAME}}",
          DB_POSTGRESDB_USER: "${{db.DB_USER}}",
          DB_POSTGRESDB_PASSWORD: "${{db.DB_PASSWORD}}",
          N8N_ENCRYPTION_KEY: "@secret",
        },
        volumes: [{ name: "n8n-data", mountPath: "/home/node/.n8n", sizeMb: 1024 }],
      },
    ],
    databases: [{ name: "db", engine: "postgres", connectTo: ["n8n"] }],
  },
  {
    id: "static-site",
    name: "Static site (Vite)",
    description: "Vite + React static site served with SPA fallback and cache headers.",
    tags: ["static", "react"],
    services: [
      {
        name: "site",
        type: "static",
        source: { kind: "git", repo: DEFAULT_TEMPLATES_REPO, rootDir: "templates/vite-react" },
      },
    ],
    databases: [],
  },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
