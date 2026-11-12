import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

// The operator password lives only in operator.env at the project root.
// The MCP server never imports this file or reads that env file.
try {
  process.loadEnvFile(
    fileURLToPath(new URL("../../operator.env", import.meta.url)),
  );
} catch {
  // fall back to variables already present in the environment
}

const password = process.env["SALES_OPERATOR_DB_PASSWORD"];
if (!password) {
  console.error(
    "SALES_OPERATOR_DB_PASSWORD is missing (expected in operator.env at the project root).",
  );
  process.exit(1);
}

const pool = new pg.Pool({
  host: process.env["DB_HOST"] ?? "127.0.0.1",
  port: Number(process.env["DB_PORT"] ?? 5433),
  database: process.env["DB_NAME"] ?? "sales",
  user: "sales_operator",
  password,
  max: 2,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  application_name: "sales-operator-cli",
});

interface MessageView {
  id: string;
  status: string;
  kind: string;
  sequence_step: number;
  subject: string;
  body: string;
  content_sha256: string | null;
  to_email: string;
  contact_source_url: string;
  entity_type: string;
  business_name: string;
  domain: string;
  lead_status: string;
}

/** Must match the database trigger: sha256(subject \n body \n recipient email). */
function contentHash(subject: string, body: string, email: string): string {
  return createHash("sha256")
    .update(`${subject}\n${body}\n${email}`, "utf8")
    .digest("hex");
}

async function suppressionsFor(email: string): Promise<string[]> {
  const domain = email.split("@")[1] ?? "";
  const { rows } = await pool.query<{
    kind: string;
    value: string;
    reason: string;
  }>(
    `SELECT kind, value, reason FROM suppressions
      WHERE (kind = 'email' AND value = $1) OR (kind = 'domain' AND value = $2)`,
    [email, domain],
  );
  return rows.map((r) => `${r.kind}:${r.value} (${r.reason})`);
}

async function load(prefix: string | undefined): Promise<MessageView> {
  if (!prefix || !/^[0-9a-f-]{4,36}$/.test(prefix)) {
    throw new Error(
      "Give a message id (the first 4 or more characters are enough).",
    );
  }
  const { rows } = await pool.query<MessageView>(
    `SELECT m.id, m.status, m.kind, m.sequence_step, m.subject, m.body, m.content_sha256,
            c.email AS to_email, c.source_url AS contact_source_url, c.entity_type,
            l.business_name, l.domain, l.status AS lead_status
       FROM outbound_messages m
       JOIN contacts c ON c.id = m.contact_id
       JOIN leads l ON l.id = m.lead_id
      WHERE m.id::text LIKE $1
      LIMIT 2`,
    [`${prefix}%`],
  );
  const row = rows[0];
  if (!row) throw new Error("No message with that id.");
  if (rows.length > 1)
    throw new Error("That id prefix is ambiguous; type more characters.");
  return row;
}

async function show(m: MessageView): Promise<string[]> {
  const warnings: string[] = [];
  const emailDomain = m.to_email.split("@")[1] ?? "";
  if (emailDomain !== m.domain && !emailDomain.endsWith(`.${m.domain}`)) {
    warnings.push(
      `recipient domain (${emailDomain}) differs from the lead domain (${m.domain})`,
    );
  }
  if (m.entity_type !== "company") {
    warnings.push(
      `recipient entity type is '${m.entity_type}' (sole traders/individuals have stricter outreach rules in the UK/EU)`,
    );
  }
  const suppressed = await suppressionsFor(m.to_email);
  if (suppressed.length > 0)
    warnings.push(`SUPPRESSED: ${suppressed.join(", ")}`);
  if (
    m.content_sha256 &&
    m.content_sha256 !== contentHash(m.subject, m.body, m.to_email)
  ) {
    warnings.push("stored content hash does not match the content shown");
  }

  const line = "-".repeat(70);
  console.log("");
  console.log(
    `Message   ${m.id}  [${m.status}]  ${m.kind} step ${m.sequence_step}`,
  );
  console.log(
    `Lead      ${m.business_name}  (${m.domain})  status: ${m.lead_status}`,
  );
  console.log(`To        ${m.to_email}  (${m.entity_type})`);
  console.log(`Found at  ${m.contact_source_url}`);
  console.log(`Subject   ${m.subject}`);
  console.log(line);
  console.log(m.body);
  console.log(line);
  console.log(`Hash      ${m.content_sha256 ?? "(none)"}`);
  for (const w of warnings) console.log(`WARNING   ${w}`);
  return warnings;
}

async function list(): Promise<void> {
  const { rows } = await pool.query<{
    id: string;
    to_email: string;
    domain: string;
    subject: string;
  }>(
    `SELECT m.id, c.email AS to_email, l.domain, m.subject
       FROM outbound_messages m
       JOIN contacts c ON c.id = m.contact_id
       JOIN leads l ON l.id = m.lead_id
      WHERE m.status = 'pending_approval'
      ORDER BY m.created_at`,
  );
  if (rows.length === 0) {
    console.log("Nothing waiting for approval.");
    return;
  }
  for (const r of rows)
    console.log(
      `${r.id.slice(0, 8)}  ${r.to_email}  [${r.domain}]  ${r.subject}`,
    );
}

async function decide(
  m: MessageView,
  newStatus: "approved" | "rejected",
  action: string,
  detail: Record<string, unknown>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query(
      newStatus === "approved"
        ? `UPDATE outbound_messages SET status = 'approved', approved_at = now()
            WHERE id = $1 AND status = 'pending_approval' AND content_sha256 = $2 RETURNING id`
        : `UPDATE outbound_messages SET status = 'rejected'
            WHERE id = $1 AND status = 'pending_approval' AND content_sha256 IS NOT DISTINCT FROM $2 RETURNING id`,
      [m.id, m.content_sha256],
    );
    if (u.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO audit_log(actor, action, entity, entity_id, detail)
       VALUES ('operator', $1, 'outbound_message', $2, $3)`,
      [action, m.id, JSON.stringify(detail)],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function approve(prefix: string | undefined): Promise<void> {
  const m = await load(prefix);
  const warnings = await show(m);
  if (m.status !== "pending_approval")
    throw new Error(
      `Message is '${m.status}', not pending_approval. Nothing changed.`,
    );
  if (!m.content_sha256)
    throw new Error("Message has no content hash. Nothing changed.");
  if (
    warnings.some(
      (w) => w.startsWith("SUPPRESSED") || w.startsWith("stored content hash"),
    )
  ) {
    throw new Error("Blocking warning above. Nothing changed.");
  }
  const code = m.content_sha256.slice(0, 8);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (
    await rl.question(
      `\nThis only marks it approved; nothing is sent. Type ${code} to approve: `,
    )
  ).trim();
  rl.close();
  if (typed !== code) {
    console.log("Code did not match. Nothing changed.");
    return;
  }
  const ok = await decide(m, "approved", "draft_approve", {
    to: m.to_email,
    content_sha256: m.content_sha256,
  });
  console.log(
    ok
      ? "Approved. Nothing has been sent (no sender exists yet)."
      : "Nothing changed: the message is no longer pending or its content changed.",
  );
}

async function reject(
  prefix: string | undefined,
  reason: string,
): Promise<void> {
  const m = await load(prefix);
  if (m.status !== "pending_approval")
    throw new Error(
      `Message is '${m.status}', not pending_approval. Nothing changed.`,
    );
  const ok = await decide(m, "rejected", "draft_reject", {
    to: m.to_email,
    reason: reason.slice(0, 300),
  });
  console.log(
    ok ? "Rejected." : "Nothing changed: the message is no longer pending.",
  );
}

async function main(): Promise<void> {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "list":
      return list();
    case "show":
      await show(await load(arg));
      return;
    case "approve":
      return approve(arg);
    case "reject":
      return reject(arg, rest.join(" "));
    default:
      console.log(
        "usage: operator <list | show ID | approve ID | reject ID [reason]>",
      );
  }
}

main()
  .catch((err: unknown) => {
    const e = err as { code?: string; message?: string };
    console.error(
      `Error${e.code ? ` [${e.code}]` : ""}: ${e.message ?? String(err)}`,
    );
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
