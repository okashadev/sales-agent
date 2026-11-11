import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "pg";
import { z } from "zod";
import { normalizeDomainOnly, normalizeWebsite } from "../domain.js";
import { dbErrorMessage, toolError, toolJson, withTx } from "../dbutil.js";

const LEAD_STATUSES = [
  "discovered", "researching", "qualified", "outreach_pending", "contacted",
  "follow_up_due", "replied", "interested", "meeting_scheduled", "proposal_sent",
  "negotiation", "won", "lost", "unsubscribed",
] as const;

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

export function registerLeadTools(server: McpServer, pool: Pool): void {
  server.registerTool(
    "suppression_check",
    {
      title: "Check suppression list",
      description:
        "Check whether an email address or domain is on the do-not-contact list. Always call this before drafting any outreach.",
      inputSchema: z.object({
        email: z.string().max(320).optional(),
        domain: z.string().max(253).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ email, domain }) => {
      if (!email && !domain) return toolError("Provide an email, a domain, or both.");
      const e = email ? email.trim().toLowerCase() : null;
      const emailDomain = e && e.includes("@") ? (e.split("@").pop() ?? null) : null;
      const d = domain ? normalizeDomainOnly(domain) : emailDomain;
      if (domain && !d) return toolError("Invalid domain.");
      try {
        const { rows } = await pool.query(
          `SELECT kind, value, reason FROM suppressions
            WHERE (kind = 'email' AND value = $1) OR (kind = 'domain' AND value = $2)`,
          [e, d],
        );
        return toolJson({ suppressed: rows.length > 0, matches: rows });
      } catch (err) {
        return toolError(dbErrorMessage(err));
      }
    },
  );

  server.registerTool(
    "lead_upsert",
    {
      title: "Create or enrich a lead",
      description:
        "Create a lead, or enrich the existing one if this domain is already known (deduplicated by domain). Never changes lead status. Requires the public source URL where the business was found.",
      inputSchema: z.object({
        business_name: z.string().min(1).max(200),
        website: z.string().min(3).max(2048).describe("Business website URL or bare domain"),
        source_url: httpUrl.describe("Public page where this business was found"),
        country: z.string().max(100).optional(),
        industry: z.string().max(200).optional(),
        tech_stack: z.string().max(500).optional(),
        site_issues: z.string().max(2000).optional(),
        opportunity: z.string().max(2000).optional(),
        recommended_service: z.string().max(200).optional(),
        score: z.number().int().min(0).max(100).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const site = normalizeWebsite(a.website);
      if (!site) return toolError("website is not a valid public domain or http(s) URL.");
      try {
        const out = await withTx(pool, async (c) => {
          const r = await c.query<{ id: string; status: string; created: boolean }>(
            `INSERT INTO leads (business_name, website_url, domain, country, industry, tech_stack,
                                site_issues, opportunity, recommended_service, score, source_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (domain) DO UPDATE SET
               website_url         = COALESCE(EXCLUDED.website_url, leads.website_url),
               country             = COALESCE(EXCLUDED.country, leads.country),
               industry            = COALESCE(EXCLUDED.industry, leads.industry),
               tech_stack          = COALESCE(EXCLUDED.tech_stack, leads.tech_stack),
               site_issues         = COALESCE(EXCLUDED.site_issues, leads.site_issues),
               opportunity         = COALESCE(EXCLUDED.opportunity, leads.opportunity),
               recommended_service = COALESCE(EXCLUDED.recommended_service, leads.recommended_service),
               score               = COALESCE(EXCLUDED.score, leads.score)
             RETURNING id, status, (xmax = 0) AS created`,
            [
              a.business_name, site.url, site.domain, a.country ?? null, a.industry ?? null,
              a.tech_stack ?? null, a.site_issues ?? null, a.opportunity ?? null,
              a.recommended_service ?? null, a.score ?? null, a.source_url,
            ],
          );
          const row = r.rows[0];
          if (!row) throw new Error("upsert returned no row");
          await c.query(
            `INSERT INTO audit_log(actor, action, entity, entity_id, detail)
             VALUES ('agent', 'lead_upsert', 'lead', $1, $2)`,
            [row.id, JSON.stringify({ created: row.created, domain: site.domain, source_url: a.source_url })],
          );
          const sup = await c.query(
            `SELECT 1 FROM suppressions WHERE kind = 'domain' AND value = $1 LIMIT 1`,
            [site.domain],
          );
          return { ...row, domain: site.domain, domain_suppressed: sup.rowCount === 1 };
        });
        return toolJson(out);
      } catch (err) {
        return toolError(dbErrorMessage(err));
      }
    },
  );

  server.registerTool(
    "lead_set_status",
    {
      title: "Move a lead to a new status",
      description:
        "Change a lead's lifecycle status. The database only allows legal transitions (for example discovered -> won is rejected). A reason is required and is written to the audit log.",
      inputSchema: z.object({
        lead_id: z.uuid(),
        new_status: z.enum(LEAD_STATUSES),
        reason: z.string().min(3).max(500),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ lead_id, new_status, reason }) => {
      try {
        const out = await withTx(pool, async (c) => {
          const cur = await c.query<{ status: string }>(
            `SELECT status FROM leads WHERE id = $1 FOR UPDATE`,
            [lead_id],
          );
          const from = cur.rows[0]?.status;
          if (!from) return null;
          if (from === new_status) return { lead_id, from, to: from, unchanged: true };
          await c.query(`UPDATE leads SET status = $2 WHERE id = $1`, [lead_id, new_status]);
          await c.query(
            `INSERT INTO audit_log(actor, action, entity, entity_id, detail)
             VALUES ('agent', 'lead_set_status', 'lead', $1, $2)`,
            [lead_id, JSON.stringify({ from, to: new_status, reason })],
          );
          return { lead_id, from, to: new_status, unchanged: false };
        });
        return out ? toolJson(out) : toolError("No lead with that id.");
      } catch (err) {
        return toolError(dbErrorMessage(err));
      }
    },
  );
}