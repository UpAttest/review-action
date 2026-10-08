import { createHash } from "node:crypto";

/** UpAttest's direct upload limit (docs/74 row 16). Larger diffs need narrower `paths`. */
export const DIRECT_UPLOAD_LIMIT_BYTES = 262144;

/** The `git-diff-unified-lf` canonicalization: LF line endings, so the hash does not depend on the runner's OS. */
export const normalizeLf = (text) => String(text).replace(/\r\n?/g, "\n");

export const sha256Hex = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const unquote = (p) => (p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) : p);
const stripPrefix = (p) => p.replace(/^[ab]\//, "");

/** Split a unified git diff into per-file sections with their old and new paths. */
export function splitDiff(diff) {
  const text = normalizeLf(diff);
  const sections = [];
  const starts = [...text.matchAll(/^diff --git .*$/gm)].map((m) => m.index);
  for (let i = 0; i < starts.length; i++) {
    const body = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : text.length);
    let oldPath, newPath;
    for (const line of body.split("\n")) {
      if (line.startsWith("@@")) break;
      if (line.startsWith("--- ")) { const p = unquote(line.slice(4).trim()); if (p !== "/dev/null") oldPath = stripPrefix(p); }
      else if (line.startsWith("+++ ")) { const p = unquote(line.slice(4).trim()); if (p !== "/dev/null") newPath = stripPrefix(p); }
      else if (line.startsWith("rename from ")) oldPath = line.slice(12);
      else if (line.startsWith("rename to ")) newPath = line.slice(10);
    }
    if (!oldPath && !newPath) {
      // Binary or mode-only change: fall back to the header, which is unambiguous when the paths have no spaces.
      const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(body);
      if (m) { oldPath = m[1]; newPath = m[2]; }
    }
    sections.push({ oldPath: oldPath ?? newPath, newPath: newPath ?? oldPath, text: body });
  }
  return sections;
}

/** Keep only the sections for files that matched, in the order git produced them. */
export function selectDiff(diff, matchedFiles, scope = "matched") {
  const text = normalizeLf(diff);
  if (scope === "all") return text;
  const wanted = new Set(matchedFiles);
  return splitDiff(text).filter((s) => wanted.has(s.newPath) || wanted.has(s.oldPath)).map((s) => s.text).join("");
}

// Same patterns as apps/mcp/src/guidance.ts scanForSecrets (kept in step by integrations/integrations.test.mjs).
export const SECRET_PATTERNS = [
  { kind: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: "Stripe secret key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { kind: "OpenAI or Anthropic API key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/ },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "UpAttest credential", re: /\bupa_[a-z0-9]{32}\b|\b(?:uaa|uar|dmo)_[a-f0-9]{64}\b/ },
  { kind: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: "connection string with password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{6,}@[^\s]+/i },
  { kind: "assigned secret", re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i },
];
const PLACEHOLDER = /REDACTED|<[^>]*>|\$\{[^}]*\}|process\.env|example|changeme|placeholder|xxxx|\*\*\*\*/i;

/** Likely credentials in the diff, by diff line number and kind. Never returns the matched values. */
export function scanForSecrets(text) {
  const out = [];
  normalizeLf(text).split("\n").forEach((line, i) => {
    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(line);
      if (m && !PLACEHOLDER.test(m[0])) { out.push({ line: i + 1, kind: p.kind }); break; }
    }
  });
  return out.slice(0, 50);
}
