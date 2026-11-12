import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dbErrorMessage, toolError, toolJson, withTx } from "../dbutil.js";

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const httpUrl = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

async function audit(
  c: PoolClient,
  action: string,
  entity: string,
  entityId: string,
  detail: unknown,
): Promise<void> {
  await c.query(
    `INSERT INTO audit_log(actor, action, entity, entity_id, detail) VALUES ('agent', $1, $2, $3, $4)`,
    [action, entity, entityId, JSON.stringify(detail)],
  );
}

async function isSuppressed(c: PoolClient, email: string): Promise<boolean> {
  const domain = email.split("@")[1] ?? "";
  const r = await c.query(
    `SELECT 1 FROM suppressions WHERE (kind = 'email' AND value = $1) OR (kind = 'domain' AND value = $2) LIMIT 1`,
    [email, domain],
  );
  return (r.rowCount ?? 0) > 0;
}

export function registerOutreachTools(server: McpServer, pool: Pool): void {
  server.registerTool(
    "contact_upsert",
    {
      title: "Add or enrich a contact",
      description:
        "Record a public business contact email for a lead. The email must come from a public page; give that page as source_url. Returns whether the address is suppressed. Never moves an existing email to a different lead.",
      inputSchema: z.object({
        lead_id: z.uuid(),
        email: z.string().min(3).max(320),
        full_name: z.string().max(200).optional(),
        role_title: z.string().max(200).optional(),
        entity_type: z
          .enum(["company", "sole_trader", "unknown"])
          .default("unknown"),
        source_url: httpUrl.describe("Public page where this email was found"),
      }),
      annotations: WRITE,
    },
    async (a) => {
      const email = a.email.trim().toLowerCase();
      if (!EMAIL.test(email)) return toolError("Invalid email address.");
      try {
        const out = await withTx(pool, async (c) => {
          const lead = await c.query(`SELECT 1 FROM leads WHERE id = $1`, [
            a.lead_id,
          ]);
          if (lead.rowCount === 0)
            return { error: "No lead with that id." } as const;

          const ins = await c.query<{ id: string }>(
            `INSERT INTO contacts(lead_id, email, full_name, role_title, entity_type, source_url)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (email) DO NOTHING RETURNING id`,
            [
              a.lead_id,
              email,
              a.full_name ?? null,
              a.role_title ?? null,
              a.entity_type,
              a.source_url,
            ],
          );
          let id = ins.rows[0]?.id;
          const created = id !== undefined;
          if (!id) {
            const ex = await c.query<{ id: string; lead_id: string }>(
              `SELECT id, lead_id FROM contacts WHERE email = $1`,
              [email],
            );
            const row = ex.rows[0];
            if (!row) throw new Error("contact vanished after conflict");
            if (row.lead_id !== a.lead_id)
              return {
                error: "This email already belongs to a different lead.",
              } as const;
            await c.query(
              `UPDATE contacts SET full_name = COALESCE($2, full_name), role_title = COALESCE($3, role_title),
                      entity_type = CASE WHEN entity_type = 'unknown' THEN $4 ELSE entity_type END
                WHERE id = $1`,
              [
                row.id,
                a.full_name ?? null,
                a.role_title ?? null,
                a.entity_type,
              ],
            );
            id = row.id;
          }
          const suppressed = await isSuppressed(c, email);
          await audit(c, "contact_upsert", "contact", id, {
            created,
            lead_id: a.lead_id,
            source_url: a.source_url,
          });
          return { id, created, email, suppressed } as const;
        });
        return "error" in out ? toolError(out.error) : toolJson(out);
      } catch (err) {
        return toolError(dbErrorMessage(err));
      }
    },
  );

  server.registerTool(
    "draft_create",
    {
      title: "Create an outreach draft",
      description:
        "Create a DRAFT email for a contact. This sends nothing and cannot send anything. Refused if the recipient is suppressed or the lead status does not fit. initial -> sequence_step 0; follow_up -> step 1 or higher. If a live message already exists for that contact and step, it is returned unchanged.",
      inputSchema: z.object({
        contact_id: z.uuid(),
        kind: z.enum(["initial", "follow_up"]),
        sequence_step: z.number().int().min(0).max(5).default(0),
        subject: z.string().min(3).max(150),
        body: z.string().min(20).max(4000),
      }),
      annotations: WRITE,
    },
    async (a) => {
      if (a.kind === "initial" && a.sequence_step !== 0)
        return toolError("An initial email must use sequence_step 0.");
      if (a.kind === "follow_up" && a.sequence_step < 1)
        return toolError("A follow_up must use sequence_step 1 or higher.");
      try {
        const out = await withTx(pool, async (c) => {
          const r = await c.query<{
            lead_id: string;
            email: string;
            lead_status: string;
          }>(
            `SELECT c.lead_id, c.email, l.status AS lead_status
               FROM contacts c JOIN leads l ON l.id = c.lead_id WHERE c.id = $1`,
            [a.contact_id],
          );
          const ctx = r.rows[0];
          if (!ctx) return { error: "No contact with that id." } as const;
          if (await isSuppressed(c, ctx.email)) {
            return {
              error:
                "Recipient is on the suppression list. Do not draft anything for them.",
            } as const;
          }
          const allowed =
            a.kind === "initial"
              ? ["qualified", "outreach_pending"]
              : ["contacted", "follow_up_due"];
          if (!allowed.includes(ctx.lead_status)) {
            return {
              error: `Lead status '${ctx.lead_status}' does not allow a '${a.kind}' draft (needs one of: ${allowed.join(", ")}).`,
            } as const;
          }
          const ins = await c.query<{ id: string }>(
            `INSERT INTO outbound_messages(lead_id, contact_id, kind, sequence_step, subject, body, idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (contact_id, kind, sequence_step) WHERE status NOT IN ('rejected','failed') DO NOTHING
             RETURNING id`,
            [
              ctx.lead_id,
              a.contact_id,
              a.kind,
              a.sequence_step,
              a.subject,
              a.body,
              `draft:${randomUUID()}`,
            ],
          );
          const made = ins.rows[0];
          if (made) {
            await audit(c, "draft_create", "outbound_message", made.id, {
              contact_id: a.contact_id,
              kind: a.kind,
              step: a.sequence_step,
            });
            return { id: made.id, status: "draft", created: true } as const;
          }
          const ex = await c.query<{ id: string; status: string }>(
            `SELECT id, status FROM outbound_messages
              WHERE contact_id = $1 AND kind = $2 AND sequence_step = $3 AND status NOT IN ('rejected','failed')`,
            [a.contact_id, a.kind, a.sequence_step],
          );
          const row = ex.rows[0];
          if (!row) throw new Error("conflicting message vanished");
          return {
            id: row.id,
            status: row.status,
            created: false,
            note: "A live message for this contact and step already exists; it was not changed.",
          } as const;
        });
        return "error" in out ? toolError(out.error) : toolJson(out);
      } catch (err) {
        return toolError(dbErrorMessage(err));
      }
    },
  );

  server.registerTool(
    "draft_submit",
    {
      title: "Submit a draft for operator approval",
      description:
        "Move a draft to pending_approval. After this the content is frozen and only the human operator can approve or reject it. You cannot approve or send.",
      inputSchema: z.object({ message_id: z.uuid() }),
      annotations: WRITE,
    },
    async ({ message_id }) => {
      try {
        const out = await withTx(pool, async (c) => {
          const u = await c.query<{ id: string; content_sha256: string }>(
            `UPDATE outbound_messages SET status = 'pending_approval'
              WHERE id = $1 AND status = 'draft' RETURNING id, content_sha256`,
            [message_id],
          );
          const row = u.rows[0];
          if (!row) {
            const cur = await c.query<{ status: string }>(
              `SELECT status FROM outbound_messages WHERE id = $1`,
              [message_id],
            );
            const s = cur.rows[0]?.status;
            return {
              error: s
                ? `Message is '${s}'; only drafts can be submitted.`
                : "No message with that id.",
            } as const;
          }
          await audit(c, "draft_submit", "outbound_message", row.id, {
            content_sha256: row.content_sha256,
          });
          return {
            id: row.id,
            status: "pending_approval",
            content_sha256: row.content_sha256,
            next: "Waiting for the human operator. You cannot approve or send.",
          } as const;
        });
        return "error" in out ? toolError(out.error) : toolJson(out);
      } catch (err) {
        return toolError(dbErrorMessage(err));
      }
    },
  );
}
