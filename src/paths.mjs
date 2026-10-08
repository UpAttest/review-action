// Path matching for the `paths` input. Dependency-free and deliberately small:
//   **      any number of path segments (including none)
//   *       any characters except "/"
//   ?       one character except "/"
//   {a,b}   alternatives
//   !p      exclude what p matches (later patterns win, as in .gitignore)
// A pattern without "/" matches the file name at any depth ("*.sql" matches "db/m/001.sql").
// A pattern ending in "/" matches everything below that directory ("auth/" is "auth/**").

/** Split the input on newlines and commas outside braces; drop blanks and # comments. */
export function parsePatterns(input) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of String(input ?? "")) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if ((ch === "\n" || ch === "\r" || (ch === "," && depth === 0))) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p && !p.startsWith("#"));
}

function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  return m[1].split(",").flatMap((alt) => expandBraces(pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length)));
}

const escape = (s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

/** Compile one glob (without "!") to a RegExp over a forward-slash relative path. */
export function globToRegExp(glob) {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (g.endsWith("/")) g += "**";
  const anchored = g.includes("/");
  const alts = expandBraces(g).map((p) => {
    let re = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "*" && p[i + 1] === "*") {
        const slashAfter = p[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += escape(c);
    }
    return re;
  });
  const body = alts.length === 1 ? alts[0] : `(?:${alts.join("|")})`;
  return new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`);
}

/** Compile the `paths` input into a matcher. Later patterns override earlier ones. */
export function compileMatcher(input) {
  const rules = parsePatterns(input).map((p) => {
    const negate = p.startsWith("!");
    return { negate, re: globToRegExp(negate ? p.slice(1) : p), source: p };
  });
  if (!rules.some((r) => !r.negate)) throw new Error("paths must include at least one pattern to match (for example infra/** or *.sql)");
  return (file) => {
    const f = String(file).replace(/\\/g, "/");
    let hit = false;
    for (const r of rules) if (r.re.test(f)) hit = !r.negate;
    return hit;
  };
}

/**
 * Which changed files need review. A renamed file counts when either its old or new path matches, so moving a
 * file out of a protected directory still requires review.
 */
export function matchChangedFiles(files, pathsInput) {
  const match = compileMatcher(pathsInput);
  return files.filter((f) => match(f.filename) || (f.previous_filename && match(f.previous_filename))).map((f) => f.filename);
}
