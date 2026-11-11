const HOSTNAME =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export interface NormalizedSite {
  domain: string;
  url: string;
}

/** Accepts "https://www.Foo.com/about" or "foo.com"; returns null for anything that is not a public hostname. */
export function normalizeWebsite(input: string): NormalizedSite | null {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const domain = host.replace(/^www\./, "");
  if (!HOSTNAME.test(domain)) return null; // rejects IPs, localhost, single-label hosts

  return { domain, url: `${url.protocol}//${host}` };
}

export function normalizeDomainOnly(input: string): string | null {
  return normalizeWebsite(input)?.domain ?? null;
}