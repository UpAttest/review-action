import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatterns, globToRegExp, compileMatcher, matchChangedFiles } from "../src/paths.mjs";

test("parses newline and comma lists, keeping commas inside braces", () => {
  assert.deepEqual(parsePatterns("infra/**, auth/**\n*.sql\n\n# comment\n  {a,b}/x.ts  "), ["infra/**", "auth/**", "*.sql", "{a,b}/x.ts"]);
});

test("directory globs match everything below, and only below", () => {
  const m = compileMatcher("infra/**");
  assert.ok(m("infra/main.tf"));
  assert.ok(m("infra/modules/vpc/main.tf"));
  assert.ok(!m("src/infra/main.tf"), "anchored at the repository root");
  assert.ok(!m("infrastructure/main.tf"));
});

test("a trailing slash means the whole directory", () => {
  const m = compileMatcher("auth/");
  assert.ok(m("auth/session.ts"));
  assert.ok(m("auth/deep/x.ts"));
  assert.ok(!m("authz/x.ts"));
});

test("patterns without a slash match the file name at any depth", () => {
  const m = compileMatcher("*.sql");
  assert.ok(m("schema.sql"));
  assert.ok(m("db/migrations/001_init.sql"));
  assert.ok(!m("db/migrations/001.sql.bak"));
  assert.ok(!m("notes/sql.md"));
});

test("** in the middle spans zero or more directories", () => {
  const m = compileMatcher("src/**/auth/*.ts");
  assert.ok(m("src/auth/session.ts"));
  assert.ok(m("src/a/b/auth/session.ts"));
  assert.ok(!m("src/auth/deep/session.ts"));
});

test("? and braces", () => {
  const m = compileMatcher("{api,web}/v?/*.{ts,tsx}");
  assert.ok(m("api/v1/routes.ts"));
  assert.ok(m("web/v2/page.tsx"));
  assert.ok(!m("api/v10/routes.ts"));
  assert.ok(!m("worker/v1/routes.ts"));
});

test("negation excludes, and later patterns win", () => {
  const m = compileMatcher("infra/**\n!infra/**/*.md\ninfra/README.md");
  assert.ok(m("infra/main.tf"));
  assert.ok(!m("infra/docs/notes.md"));
  assert.ok(m("infra/README.md"));
});

test("dots and regex characters in patterns are literal", () => {
  const m = compileMatcher(".github/workflows/*.yml");
  assert.ok(m(".github/workflows/ci.yml"));
  assert.ok(!m("xgithub/workflows/ci.yml"));
  assert.ok(!globToRegExp("a+b.txt").test("aab.txt"));
});

test("Windows separators in patterns and paths are normalized", () => {
  assert.ok(compileMatcher("infra\\**")("infra/x.tf"));
  assert.ok(compileMatcher("infra/**")("infra\\x.tf"));
});

test("only negations is a configuration error", () => {
  assert.throws(() => compileMatcher("!docs/**"), /at least one pattern/);
  assert.throws(() => compileMatcher("  \n# nothing"), /at least one pattern/);
});

test("renames count when either side matches", () => {
  const files = [
    { filename: "src/session.ts", previous_filename: "auth/session.ts", status: "renamed" },
    { filename: "README.md" },
    { filename: "db/002.sql", status: "added" },
  ];
  assert.deepEqual(matchChangedFiles(files, "auth/**\n*.sql"), ["src/session.ts", "db/002.sql"]);
});
