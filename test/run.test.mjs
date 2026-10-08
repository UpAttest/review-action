import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/run.mjs";
import { parseInputs } from "../src/payload.mjs";
import { selectDiff, sha256Hex } from "../src/diff.mjs";
import { summarize } from "../src/summary.mjs";
import { createGitHub, createUpAttest } from "../src/clients.mjs";

const DIFF = "diff --git a/auth/session.ts b/auth/session.ts\n--- a/auth/session.ts\n+++ b/auth/session.ts\n@@ -1 +1,2 @@\n x\n+revoke(old)\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n";
const HASH = sha256Hex(selectDiff(DIFF, ["auth/session.ts"]));
const pull = { number: 5, title: "Rotate tokens", head: { sha: "h".repeat(40) }, base: { sha: "b".repeat(40), repo: { id: 77, private: true } } };
const inputs = (over = {}) => parseInputs((n) => ({ "api-key": "upa_x", paths: "auth/**\n*.sql", "max-price": "200", ...over })[n]);

function fakeGitHub({ files = [{ filename: "auth/session.ts" }, { filename: "README.md" }], diff = DIFF, open = [pull] } = {}) {
  const statuses = [];
  return {
    statuses,
    listPullFiles: async () => files,
    compareDiff: async (_o, _r, base, head) => { assert.equal(base, pull.base.sha); assert.equal(head, pull.head.sha); return diff; },
    listOpenPulls: async () => open,
    createStatus: async (_o, _r, sha, s) => { statuses.push({ sha, ...s }); },
  };
}

function fakeUpAttest({ requests = [], quote = { estimate: { quote_cents: 15000 }, fees: { requester_total_cents: 16200 } }, publicResults = [], attestation, created = { status: 201 } } = {}) {
  const calls = [];
  const rec = (name, r) => async (input) => { calls.push({ name, input }); return typeof r === "function" ? r(input) : r; };
  return {
    calls,
    message: (r) => r.body?.error?.message ?? `status ${r.status}`,
    listRequests: rec("listRequests", { status: 200, body: { requests } }),
    requestAttestation: rec("requestAttestation", attestation ?? { status: 409, body: null }),
    verifyHash: rec("verifyHash", { status: 200, body: { count: publicResults.length, results: publicResults } }),
    quote: rec("quote", { status: 200, body: quote }),
    registerArtifact: rec("registerArtifact", (input) => ({ status: 201, body: { artifact: { id: "art_1", hash: HASH, size_bytes: Buffer.from(input.content_base64, "base64").length } } })),
    createRequest: rec("createRequest", (input) => ({ status: created.status, body: created.status < 300 ? { request: { id: "req_1", status: "open", idempotency_key: input.idempotency_key }, idempotent_replay: false } : { error: { message: created.message } } })),
  };
}

const base = { eventName: "pull_request", event: { pull_request: pull }, owner: "o", repo: "r", runUrl: "https://github.com/o/r/actions/runs/1" };

test("no matching path: no request, and a passing status so a required check never blocks", async () => {
  const github = fakeGitHub({ files: [{ filename: "README.md" }] });
  const upattest = fakeUpAttest();
  const { results } = await run({ ...base, inputs: inputs(), github, upattest });
  assert.equal(results[0].state, "not_required");
  assert.equal(upattest.calls.length, 0);
  assert.deepEqual(github.statuses.map((s) => s.state), ["success"]);
  assert.equal(github.statuses[0].context, "UpAttest / software.change_review");
});

test("matching change: quote with real size, register only matched files, request a limit order, pending status", async () => {
  const github = fakeGitHub();
  const upattest = fakeUpAttest();
  const { results } = await run({ ...base, inputs: inputs(), github, upattest });
  const r = results[0];
  assert.equal(r.state, "requested");
  assert.equal(r.artifact_hash, HASH);
  assert.deepEqual(upattest.calls.map((c) => c.name), ["listRequests", "verifyHash", "quote", "registerArtifact", "createRequest"]);
  const sent = Buffer.from(upattest.calls[3].input.content_base64, "base64").toString();
  assert.ok(sent.includes("auth/session.ts") && !sent.includes("README.md"), "only matched files leave the runner");
  assert.equal(upattest.calls[2].input.size_bytes, Buffer.byteLength(sent));
  const req = upattest.calls[4].input;
  assert.equal(req.budget_cents, 15000);
  assert.equal(req.metadata.diff_sha256, HASH);
  assert.equal(req.attestation_type.variables.purpose, "Rotate tokens");
  assert.deepEqual(github.statuses.map((s) => s.state), ["pending"]);
  assert.match(github.statuses[0].target_url, /workspace\?role=customer&request=req_1/);
  assert.match(github.statuses[0].description, /\$162\.00/);
  assert.match(summarize({ mode: "request", results, inputs: inputs() }), /req_1/);
});

test("over the cap: nothing registered or requested, failing status with the reason", async () => {
  const github = fakeGitHub();
  const upattest = fakeUpAttest({ quote: { estimate: { quote_cents: 19500 }, fees: { requester_total_cents: 21060 } } });
  const { results } = await run({ ...base, inputs: inputs(), github, upattest });
  assert.equal(results[0].state, "refused");
  assert.ok(!upattest.calls.some((c) => c.name === "registerArtifact" || c.name === "createRequest"));
  assert.equal(github.statuses[0].state, "failure");
  assert.match(github.statuses[0].description, /above max-price \$200\.00/);
});

test("secrets in the matched diff: nothing is sent", async () => {
  const leaky = DIFF.replace("+revoke(old)", `+const k = '${"AKIA" + "ABCDEFGHIJKLMNOP"}'`);
  const github = fakeGitHub({ diff: leaky });
  const upattest = fakeUpAttest();
  const { results } = await run({ ...base, inputs: inputs(), github, upattest });
  assert.equal(results[0].state, "refused");
  assert.match(results[0].reason, /AWS access key/);
  assert.ok(!results[0].reason.includes("AKIA"));
  assert.ok(!upattest.calls.some((c) => ["quote", "registerArtifact", "createRequest"].includes(c.name)));
});

test("an existing own signed record for the same diff: success, no new request", async () => {
  const github = fakeGitHub();
  const upattest = fakeUpAttest({
    requests: [{ id: "req_old", status: "attested", attestation_id: "att_9", created_at: "2026-10-01", metadata: { diff_sha256: HASH } }],
    attestation: { status: 200, body: { attestation: { id: "att_9", verdict: "pass" }, status: "active", private: true } },
  });
  const { results } = await run({ ...base, inputs: inputs(), github, upattest });
  assert.equal(results[0].state, "attested");
  assert.equal(results[0].attestation_id, "att_9");
  assert.ok(!upattest.calls.some((c) => c.name === "createRequest"));
  assert.deepEqual(github.statuses[0], { sha: pull.head.sha, state: "success", context: "UpAttest / software.change_review", description: "Signed review exists: Supported", target_url: "https://upattest.com/a/att_9" });
});

test("a public record by hash also satisfies the check; fail-on-verdicts turns it into a failure", async () => {
  const github = fakeGitHub();
  const upattest = fakeUpAttest({ publicResults: [{ id: "att_p", private: false, status: "active", verdict: "fail", valid: true }] });
  const { results } = await run({ ...base, inputs: inputs({ "fail-on-verdicts": "fail" }), github, upattest });
  assert.equal(results[0].state, "attested");
  assert.equal(github.statuses[0].state, "failure");
});

test("an open request for the same diff is not duplicated", async () => {
  const github = fakeGitHub();
  const upattest = fakeUpAttest({ requests: [{ id: "req_open", status: "in_review", created_at: "2026-10-02", metadata: { artifact_hash: HASH } }, { id: "req_cancel", status: "cancelled", created_at: "2026-10-03", metadata: { diff_sha256: HASH } }] });
  const { results } = await run({ ...base, inputs: inputs(), github, upattest });
  assert.equal(results[0].state, "pending");
  assert.equal(results[0].request_id, "req_open");
  assert.ok(!upattest.calls.some((c) => c.name === "createRequest"));
  assert.equal(github.statuses[0].state, "pending");
});

test("check mode on a schedule visits open PRs and never creates a request", async () => {
  const github = fakeGitHub();
  const upattest = fakeUpAttest();
  const { mode, results } = await run({ ...base, eventName: "schedule", event: {}, inputs: inputs(), github, upattest });
  assert.equal(mode, "check");
  assert.equal(results[0].state, "pending");
  assert.ok(!upattest.calls.some((c) => ["quote", "registerArtifact", "createRequest"].includes(c.name)));
  assert.equal(github.statuses[0].description, "Waiting for an UpAttest review of this diff");
});

test("required: false posts no status", async () => {
  const github = fakeGitHub();
  const { results } = await run({ ...base, inputs: inputs({ required: "false" }), github, upattest: fakeUpAttest() });
  assert.equal(results[0].state, "requested");
  assert.equal(github.statuses.length, 0);
});

test("a rejected key stops the run with guidance", async () => {
  const upattest = { ...fakeUpAttest(), listRequests: async () => ({ status: 401, body: { error: { message: "invalid key" } } }) };
  await assert.rejects(run({ ...base, inputs: inputs(), github: fakeGitHub(), upattest }), /refused the api-key \(401\)/);
});

test("request mode without a pull request event is a configuration error", async () => {
  await assert.rejects(run({ ...base, eventName: "push", event: {}, inputs: inputs({ mode: "request" }), github: fakeGitHub(), upattest: fakeUpAttest() }), /needs a pull_request event/);
});

test("HTTP clients send the right requests", async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, init }); return new Response(url.includes("/files") ? "[]" : url.includes("compare") ? DIFF : "{}", { status: url.includes("/statuses/") ? 201 : 200 }); };
  const gh = createGitHub({ token: "t", fetch });
  await gh.listPullFiles("o", "r", 5);
  assert.equal(await gh.compareDiff("o", "r", "b1", "h1"), DIFF);
  await gh.createStatus("o", "r", "h1", { state: "pending", context: "c" });
  assert.equal(seen[1].init.headers.accept, "application/vnd.github.diff");
  assert.equal(seen[1].url, "https://api.github.com/repos/o/r/compare/b1...h1");
  assert.equal(JSON.parse(seen[2].init.body).state, "pending");
  const up = createUpAttest({ apiUrl: "https://api.example", apiKey: "upa_k", fetch });
  await up.verifyHash("a".repeat(64));
  await up.quote({});
  assert.equal(seen[3].init.headers.authorization, undefined, "public verification carries no key");
  assert.equal(seen[4].init.headers.authorization, "Bearer upa_k");
});
