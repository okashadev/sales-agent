import pg from "pg";
import type { Pool as PgPool } from "pg";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

// Secrets live in mcp-server/.env (agent role only; the admin password never reaches this process).
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // No .env file: fall back to variables already present in the environment.
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

/** Pool for the least-privilege `sales_agent` role. Password is injectable for tests. */
export function createPool(password: string = required("SALES_AGENT_DB_PASSWORD")): PgPool {
  return new Pool({
    host: process.env["DB_HOST"] ?? "127.0.0.1",
    port: Number(process.env["DB_PORT"] ?? 5433),
    database: process.env["DB_NAME"] ?? "sales",
    user: "sales_agent",
    password,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "hermes-sales-mcp",
  });
}