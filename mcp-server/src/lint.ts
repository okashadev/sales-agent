export interface LintResult {
  ok: boolean;
  problems: string[];
}

const RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: "placeholder text",
    re: /\[[^\]\n]{1,40}\]|\{\{[^}]*\}\}|<\s*(your|name|company)[^>]*>|lorem ipsum|\bTODO\b|\bXXX+\b/i,
  },
  {
    name: "price or currency",
    re: /[$£€]\s?\d|\b\d+\s?(usd|gbp|eur|dollars|pounds|euros)\b|\bper hour\b|\bhourly rate\b|\bdiscount\b|\bquote\b|\bfree of charge\b/i,
  },
  {
    name: "absolute or unverifiable claim",
    re: /\bguarantee[ds]?\b|\b100\s?%|\b#\s?1\b|\bbest in\b|\bnumber one\b|\bwe (increased|boosted|doubled|tripled|helped)\b|\bour (clients|customers)\b|\btrusted by\b|\bproven\b/i,
  },
  {
    name: "pressure or fake urgency",
    re: /\blimited[- ]time\b|\bact now\b|\blast chance\b|\bdon'?t miss\b|\bhurry\b|\bexpires?\b/i,
  },
  {
    name: "link",
    re: /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|io|dev|app|net|org|co|uk)\b/i,
  },
  {
    name: "signature, unsubscribe or address text (added automatically later)",
    re: /\bunsubscribe\b|\bopt[- ]out\b|\bsent from\b|^\s*(best|kind|warm)?\s*(regards|wishes)\s*,?\s*$/im,
  },
];

export function lintDraft(subject: string, body: string): LintResult {
  const problems: string[] = [];
  const text = `${subject}\n${body}`;
  for (const rule of RULES) {
    if (rule.re.test(text)) problems.push(rule.name);
  }
  if (/^\s*(re|fwd?)\s*:/i.test(subject))
    problems.push("subject pretends to be a reply or forward");
  const letters = subject.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 6 && letters === letters.toUpperCase())
    problems.push("subject is all capitals");
  const words = body.trim().split(/\s+/).length;
  if (words < 15) problems.push("body is too short to be a real message");
  if (words > 200) problems.push("body is too long (max 200 words)");
  return { ok: problems.length === 0, problems };
}
