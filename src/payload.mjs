// Pure builders for everything the action sends. No I/O here, so every payload is unit-tested.

/** UpAttest's requester fee (docs/23): used only when a quote does not itemize fees, to stay on the safe side. */
export const REQUESTER_FEE_RATE = 0.08;
export const VERDICT_WORDS = { pass: "Supported", qualified: "Supported with qualifications", fail: "Not supported", no_opinion: "No opinion" };
const VERDICTS = Object.keys(VERDICT_WORDS);

const truthy = (v) => /^(true|yes|1|on)$/i.test(String(v ?? "").trim());

/** Parse and validate the action inputs. Throws with a message a person can act on. */
export function parseInputs(get) {
  const maxPrice = String(get("max-price") ?? "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(maxPrice) || Number(maxPrice) <= 0) throw new Error(`max-price must be a positive dollar amount such as 250 (got "${get("max-price") ?? ""}")`);
  const maxTotalCents = Math.round(Number(maxPrice) * 100);
  const mode = (get("mode") || "auto").trim();
  if (!["auto", "request", "check"].includes(mode)) throw new Error(`mode must be auto, request or check (got "${mode}")`);
  const diffScope = (get("diff-scope") || "matched").trim();
  if (!["matched", "all"].includes(diffScope)) throw new Error(`diff-scope must be matched or all (got "${diffScope}")`);
  const rubric = (get("rubric") || "code.security").trim();
  if (!/^[a-z][a-z0-9_.-]{1,60}$/.test(rubric)) throw new Error(`rubric "${rubric}" is not a rubric id such as code.security`);
  const failOn = String(get("fail-on-verdicts") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const v of failOn) if (!VERDICTS.includes(v)) throw new Error(`fail-on-verdicts: unknown verdict "${v}" (use ${VERDICTS.join(", ")})`);
  let variables = {};
  const rawVars = String(get("attestation-variables") ?? "").trim();
  if (rawVars) {
    try { variables = JSON.parse(rawVars); } catch { throw new Error("attestation-variables must be a JSON object"); }
    if (!variables || typeof variables !== "object" || Array.isArray(variables) || Object.values(variables).some((v) => typeof v !== "string")) throw new Error("attestation-variables must be a JSON object of strings");
  }
  const apiKey = String(get("api-key") ?? "").trim();
  if (!apiKey) throw new Error("api-key is empty: add the repository secret UPATTEST_API_KEY and pass it as api-key");
  const paths = String(get("paths") ?? "");
  if (!paths.trim()) throw new Error("paths is empty: list the paths that need human review, for example infra/** and *.sql");
  return {
    apiKey, paths, rubric, mode, diffScope, maxTotalCents, failOn, variables,
    // Absent means the action.yml default; an explicit empty string means "none".
    attestationType: (get("attestation-type") ?? "software.change_review").trim(),
    credentialType: (get("credential-type") ?? "staff_engineer").trim(),
    required: get("required") === undefined || get("required") === "" ? true : truthy(get("required")),
    apiUrl: (get("api-url") || "https://api.upattest.com").replace(/\/+$/, ""),
    siteUrl: (get("site-url") || "https://upattest.com").replace(/\/+$/, ""),
  };
}

/** Request on pull_request events, check on everything else (schedule, workflow_dispatch, repository_dispatch). */
export function resolveMode(mode, eventName) {
  if (mode !== "auto") return mode;
  return eventName === "pull_request" || eventName === "pull_request_target" ? "request" : "check";
}

export const credentialRequirement = (inputs) => (inputs.credentialType ? { level: "credential", type: inputs.credentialType } : { level: "identity" });

/** One review per repository, pull request, exact diff and attestation type: retries and re-runs collapse. */
export function idempotencyKey({ repoId, pr, hash, attestationType, rubric }) {
  return `gha:${repoId}:${pr}:${hash.slice(0, 32)}:${attestationType || rubric}`.slice(0, 120);
}

export function quoteInput(inputs, sizeBytes) {
  return { scope: { rubric: inputs.rubric }, credential_requirement: credentialRequirement(inputs), size_bytes: sizeBytes };
}

/**
 * Decide whether the quoted price fits the cap. The cap is the total the repository pays, fee included.
 * Returns the reviewer price to post as a limit order (never accept_quote, so the price cannot drift up).
 */
export function priceDecision(quote, maxTotalCents) {
  const priceCents = quote?.estimate?.quote_cents;
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    return { ok: false, reason: `no price is available${quote?.estimate?.reason ? `: ${quote.estimate.reason}` : ""}` };
  }
  const itemized = quote?.fees?.requester_total_cents;
  const totalCents = Number.isSafeInteger(itemized) && itemized >= priceCents ? itemized : Math.ceil(priceCents * (1 + REQUESTER_FEE_RATE));
  if (totalCents > maxTotalCents) return { ok: false, priceCents, totalCents, reason: `the current total, ${usd(totalCents)}, is above max-price ${usd(maxTotalCents)}` };
  return { ok: true, priceCents, totalCents };
}

export const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

export function artifactInput({ diff, owner, repo, pr, headSha }) {
  return {
    type: "code_diff",
    content_base64: Buffer.from(diff, "utf8").toString("base64"),
    canonicalization: "git-diff-unified-lf",
    label: `${owner}/${repo}#${pr}@${headSha.slice(0, 12)}`,
  };
}

/** The attestation selection. software.change_review takes its two required inputs from the pull request. */
export function attestationSelection(inputs, { owner, repo, pr, title, headSha }) {
  if (!inputs.attestationType) return undefined;
  const auto = inputs.attestationType === "software.change_review"
    ? { change_ref: `${owner}/${repo}#${pr} at ${headSha.slice(0, 12)}`.slice(0, 200), purpose: (title?.trim() || `Pull request #${pr}`).slice(0, 600) }
    : {};
  return { type_id: inputs.attestationType, variables: { ...auto, ...inputs.variables } };
}

export function requestInput(inputs, ctx) {
  const { artifactId, priceCents, hash, owner, repo, repoId, pr, headSha, isPrivate, matchedFiles, runUrl, title } = ctx;
  const selection = attestationSelection(inputs, { owner, repo, pr, title, headSha });
  const description = `Review the changes to ${matchedFiles.length} file(s) in ${owner}/${repo}#${pr} that this repository marks as needing human review: ${matchedFiles.slice(0, 20).join(", ")}${matchedFiles.length > 20 ? ", …" : ""}. Pull request: ${title || "(no title)"}.`;
  return {
    artifact_id: artifactId,
    scope: { rubric: inputs.rubric, description: description.slice(0, 2000) },
    credential_requirement: credentialRequirement(inputs),
    budget_cents: priceCents,
    idempotency_key: idempotencyKey({ repoId, pr, hash, attestationType: inputs.attestationType, rubric: inputs.rubric }),
    policy: { data_class: isPrivate ? "confidential" : "public", publication_allowed: false },
    ...(selection ? { attestation_type: selection } : {}),
    metadata: { source: "github-action", owner, repo, repo_id: repoId, pr, head_sha: headSha, diff_sha256: hash, run_url: runUrl, matched_files: matchedFiles.length },
  };
}

export const statusContext = (inputs) => `UpAttest / ${inputs.attestationType || inputs.rubric}`;

/** Commit status for an existing record. A completed review means "a signed review of this diff exists", not approval. */
export function statusForAttestation(inputs, { status, verdict, attestationId }) {
  const word = verdict ? VERDICT_WORDS[verdict] ?? verdict : undefined;
  const target = `${inputs.siteUrl}/a/${attestationId}`;
  if (status === "revoked") return { state: "failure", description: "The UpAttest record for this diff was revoked", target_url: target };
  if (status === "disputed") return { state: "pending", description: "The UpAttest record for this diff is disputed", target_url: target };
  if (verdict && inputs.failOn.includes(verdict)) return { state: "failure", description: `Reviewed: ${word}. This repository fails on that conclusion`, target_url: target };
  return { state: "success", description: word ? `Signed review exists: ${word}` : "Signed review exists for this diff", target_url: target };
}

/** GitHub limits status descriptions to 140 characters. */
export const clip = (s) => (s.length > 140 ? s.slice(0, 139) + "…" : s);
