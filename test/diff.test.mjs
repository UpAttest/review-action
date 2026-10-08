import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDiff, selectDiff, normalizeLf, sha256Hex, scanForSecrets } from "../src/diff.mjs";

const DIFF = [
  "diff --git a/auth/session.ts b/auth/session.ts",
  "index 1111111..2222222 100644",
  "--- a/auth/session.ts",
  "+++ b/auth/session.ts",
  "@@ -1,2 +1,3 @@",
  " export function rotate() {",
  "+  revoke(old);",
  " }",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/db/old.sql b/db/new.sql",
  "similarity index 90%",
  "rename from db/old.sql",
  "rename to db/new.sql",
  "diff --git a/infra/gone.tf b/infra/gone.tf",
  "deleted file mode 100644",
  "--- a/infra/gone.tf",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-resource {}",
  "",
].join("\n");

test("splits per file with old and new paths, including renames and deletions", () => {
  const s = splitDiff(DIFF);
  assert.deepEqual(s.map((x) => [x.oldPath, x.newPath]), [
    ["auth/session.ts", "auth/session.ts"],
    ["README.md", "README.md"],
    ["db/old.sql", "db/new.sql"],
    ["infra/gone.tf", "infra/gone.tf"],
  ]);
  assert.equal(s.map((x) => x.text).join(""), DIFF, "sections reassemble to the original diff");
});

test("selects only the matched files, in git's order", () => {
  const out = selectDiff(DIFF, ["infra/gone.tf", "auth/session.ts"]);
  assert.ok(out.startsWith("diff --git a/auth/session.ts"));
  assert.ok(out.includes("infra/gone.tf"));
  assert.ok(!out.includes("README.md"));
  assert.equal(selectDiff(DIFF, [], "all"), DIFF);
});

test("CRLF and LF diffs hash identically (git-diff-unified-lf)", () => {
  const crlf = DIFF.replace(/\n/g, "\r\n");
  assert.equal(normalizeLf(crlf), DIFF);
  assert.equal(sha256Hex(selectDiff(crlf, ["auth/session.ts"])), sha256Hex(selectDiff(DIFF, ["auth/session.ts"])));
  assert.match(sha256Hex("x"), /^[a-f0-9]{64}$/);
});

test("quoted paths with spaces are read from the ---/+++ lines", () => {
  const d = 'diff --git "a/auth/my file.ts" "b/auth/my file.ts"\n--- "a/auth/my file.ts"\n+++ "b/auth/my file.ts"\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(splitDiff(d)[0].newPath, "auth/my file.ts");
  assert.equal(selectDiff(d, ["auth/my file.ts"]), d);
});

test("secret scan reports line and kind only, and ignores placeholders", () => {
  // Fake values assembled at run time so the file itself never looks like it holds a credential.
  const d = `+const key = '${"AKIA" + "ABCDEFGHIJKLMNOP"}';\n+password = "\${DB_PASSWORD}"\n+token: "${"ghp" + "_" + "abcdefghijklmnopqrstuvwxyz0123456789"}"\n`;
  const found = scanForSecrets(d);
  assert.deepEqual(found, [{ line: 1, kind: "AWS access key" }, { line: 3, kind: "GitHub token" }]);
  assert.ok(!JSON.stringify(found).includes("AKIA"));
});
