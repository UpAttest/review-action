import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getInput, setOutput } from "../src/core.mjs";

const main = fileURLToPath(new URL("../src/main.mjs", import.meta.url));

test("inputs and outputs follow the runner's file protocol", () => {
  assert.equal(getInput("max-price", { "INPUT_MAX-PRICE": " 250 " }), "250");
  assert.equal(getInput("paths", {}), undefined);
  const dir = mkdtempSync(path.join(tmpdir(), "gha-"));
  const out = path.join(dir, "out");
  writeFileSync(out, "");
  setOutput("state", "requested", { GITHUB_OUTPUT: out });
  assert.match(readFileSync(out, "utf8"), /^state<<ghadelimiter_[0-9a-f-]+\nrequested\nghadelimiter_[0-9a-f-]+\n$/);
});

test("the entry point masks the key and fails with guidance on bad configuration", () => {
  const r = spawnSync(process.execPath, [main], { encoding: "utf8", env: { PATH: process.env.PATH, "INPUT_API-KEY": "upa_secret_value", INPUT_PATHS: "auth/**", "INPUT_MAX-PRICE": "nope" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::add-mask::upa_secret_value/);
  assert.match(r.stdout, /::error::max-price must be a positive dollar amount/);
  const missing = spawnSync(process.execPath, [main], { encoding: "utf8", env: { PATH: process.env.PATH, INPUT_PATHS: "auth/**", "INPUT_MAX-PRICE": "100" } });
  assert.match(missing.stdout, /UPATTEST_API_KEY/);
});
