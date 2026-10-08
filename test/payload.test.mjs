import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInputs, resolveMode, idempotencyKey, quoteInput, priceDecision, artifactInput, requestInput, attestationSelection, statusForAttestation, statusContext, clip } from "../src/payload.mjs";

const getter = (over = {}) => (name) => ({ "api-key": "upa_test", paths: "auth/**", "max-price": "250", ...over })[name];

test("inputs: defaults, dollars to cents, verdict list", () => {
  const i = parseInputs(getter({ "fail-on-verdicts": "fail, no_opinion" }));
  assert.equal(i.maxTotalCents, 25000);
  assert.equal(i.required, true);
  assert.equal(i.mode, "auto");
  assert.equal(i.rubric, "code.security");
  assert.equal(i.apiUrl, "https://api.upattest.com");
  assert.deepEqual(i.failOn, ["fail", "no_opinion"]);
  assert.equal(parseInputs(getter({ "max-price": "$99.5" })).maxTotalCents, 9950);
  assert.equal(parseInputs(getter({ required: "false" })).required, false);
});

test("inputs: refuses what would be unsafe or ambiguous", () => {
  for (const bad of ["", "0", "-5", "abc", "10.555"]) assert.throws(() => parseInputs(getter({ "max-price": bad })), /max-price/);
  assert.throws(() => parseInputs(getter({ "api-key": "" })), /UPATTEST_API_KEY/);
  assert.throws(() => parseInputs(getter({ paths: " " })), /paths is empty/);
  assert.throws(() => parseInputs(getter({ mode: "merge" })), /mode/);
  assert.throws(() => parseInputs(getter({ "fail-on-verdicts": "rejected" })), /unknown verdict/);
  assert.throws(() => parseInputs(getter({ "attestation-variables": "[1]" })), /JSON object/);
  assert.throws(() => parseInputs(getter({ "attestation-variables": '{"a":1}' })), /strings/);
});

test("mode auto: request on pull requests, check otherwise", () => {
  assert.equal(resolveMode("auto", "pull_request"), "request");
  assert.equal(resolveMode("auto", "pull_request_target"), "request");
  assert.equal(resolveMode("auto", "schedule"), "check");
  assert.equal(resolveMode("auto", "workflow_dispatch"), "check");
  assert.equal(resolveMode("check", "pull_request"), "check");
});

test("idempotency key is stable per repo, PR, diff and type", () => {
  const k = idempotencyKey({ repoId: 7, pr: 12, hash: "a".repeat(64), attestationType: "software.change_review", rubric: "code.security" });
  assert.equal(k, `gha:7:12:${"a".repeat(32)}:software.change_review`);
  assert.ok(k.length <= 120);
  assert.equal(idempotencyKey({ repoId: 7, pr: 12, hash: "a".repeat(64), attestationType: "", rubric: "code.security" }), `gha:7:12:${"a".repeat(32)}:code.security`);
});

test("quote asks for the credential and the real size", () => {
  const i = parseInputs(getter());
  assert.deepEqual(quoteInput(i, 4096), { scope: { rubric: "code.security" }, credential_requirement: { level: "credential", type: "staff_engineer" }, size_bytes: 4096 });
  assert.deepEqual(quoteInput(parseInputs(getter({ "credential-type": "" })), 1).credential_requirement, { level: "identity" });
});

test("price cap includes the requester fee", () => {
  assert.deepEqual(priceDecision({ estimate: { quote_cents: 15000 }, fees: { requester_total_cents: 16200 } }, 20000), { ok: true, priceCents: 15000, totalCents: 16200 });
  const over = priceDecision({ estimate: { quote_cents: 19000 }, fees: { requester_total_cents: 20520 } }, 20000);
  assert.equal(over.ok, false);
  assert.match(over.reason, /\$205\.20, is above max-price \$200\.00/);
  // Without itemized fees the 8% fee is assumed, so the cap is never exceeded by the fee.
  assert.equal(priceDecision({ estimate: { quote_cents: 18600 }, fees: null }, 20000).ok, false);
  assert.equal(priceDecision({ estimate: { quote_cents: 18500 }, fees: null }, 20000).ok, true);
  assert.match(priceDecision({ estimate: { quote_cents: null, reason: "no eligible reviewers" } }, 20000).reason, /no eligible reviewers/);
});

test("artifact is the LF diff as a code_diff with a commit-bound label", () => {
  const a = artifactInput({ diff: "+x\n", owner: "o", repo: "r", pr: 3, headSha: "0123456789abcdef0123" });
  assert.deepEqual(a, { type: "code_diff", content_base64: Buffer.from("+x\n").toString("base64"), canonicalization: "git-diff-unified-lf", label: "o/r#3@0123456789ab" });
});

test("software.change_review gets change_ref and purpose from the PR; explicit variables win", () => {
  const i = parseInputs(getter({ "attestation-variables": '{"security_standard":"OWASP ASVS 4.0"}' }));
  const sel = attestationSelection(i, { owner: "o", repo: "r", pr: 3, title: "Rotate tokens", headSha: "abcdef1234567890" });
  assert.deepEqual(sel, { type_id: "software.change_review", variables: { change_ref: "o/r#3 at abcdef123456", purpose: "Rotate tokens", security_standard: "OWASP ASVS 4.0" } });
  assert.equal(attestationSelection(parseInputs(getter({ "attestation-type": "" })), { owner: "o", repo: "r", pr: 3, headSha: "a" }), undefined);
  assert.deepEqual(attestationSelection(parseInputs(getter({ "attestation-type": "legal.document_review" })), { owner: "o", repo: "r", pr: 3, headSha: "a" }).variables, {});
});

test("request is a limit order at the quoted price, private by default, with traceable metadata", () => {
  const i = parseInputs(getter());
  const r = requestInput(i, { artifactId: "art_1", priceCents: 15000, hash: "b".repeat(64), owner: "o", repo: "r", repoId: 9, pr: 4, headSha: "c".repeat(40), isPrivate: true, matchedFiles: ["auth/a.ts"], runUrl: "https://github.com/o/r/actions/runs/1", title: "Auth" });
  assert.equal(r.budget_cents, 15000);
  assert.equal(r.accept_quote, undefined, "never a market order");
  assert.deepEqual(r.policy, { data_class: "confidential", publication_allowed: false });
  assert.equal(r.metadata.artifact_hash, "b".repeat(64));
  assert.equal(r.metadata.source, "github-action");
  assert.equal(r.attestation_type.type_id, "software.change_review");
  assert.match(r.scope.description, /auth\/a\.ts/);
  assert.equal(requestInput(i, { artifactId: "a", priceCents: 1, hash: "b".repeat(64), owner: "o", repo: "r", repoId: 9, pr: 4, headSha: "c", isPrivate: false, matchedFiles: [], title: "" }).policy.data_class, "public");
});

test("status for a record: exists means success unless the repo opted to fail on that verdict", () => {
  const i = parseInputs(getter({ "fail-on-verdicts": "fail" }));
  assert.equal(statusContext(i), "UpAttest / software.change_review");
  assert.deepEqual(statusForAttestation(i, { status: "active", verdict: "qualified", attestationId: "att_1" }), { state: "success", description: "Signed review exists: Supported with qualifications", target_url: "https://upattest.com/a/att_1" });
  assert.equal(statusForAttestation(i, { status: "active", verdict: "fail", attestationId: "att_1" }).state, "failure");
  assert.equal(statusForAttestation(i, { status: "revoked", verdict: "pass", attestationId: "att_1" }).state, "failure");
  assert.equal(statusForAttestation(i, { status: "disputed", verdict: "pass", attestationId: "att_1" }).state, "pending");
  assert.equal(clip("x".repeat(200)).length, 140);
});
