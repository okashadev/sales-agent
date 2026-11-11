import type { Pool, PoolClient } from "pg";

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function toolJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Full error goes to the server log; the model only sees a safe summary. */
export function dbErrorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  console.error("[mcp-server] db error:", err);
  switch (e.code) {
    case "23514":
      return `Rejected by database rule: ${e.message ?? "constraint violated"}`;
    case "23505":
      return "Rejected: this record already exists (unique rule).";
    case "42501":
      return "Rejected: the agent role is not permitted to do that.";
    default:
      return "Database error; the action was not completed.";
  }
}