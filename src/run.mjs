import { matchChangedFiles } from "./paths.mjs";
import { selectDiff, sha256Hex, scanForSecrets, DIRECT_UPLOAD_LIMIT_BYTES } from "./diff.mjs";
import { resolveMode, quoteInput, priceDecision, artifactInput, requestInput, statusContext, statusForAttestation, clip, usd } from "./payload.mjs";

const CLOSED = new Set(["cancelled", "expired", "rejected"]);

/**
 * One run of the action. Everything external is injected: `github` and `upattest` clients, `log`, and `report`
 * (outputs and summary). Returns one result per pull request handled.
 */
export async function run({ inputs, eventName, event, owner, repo, runUrl, github, upattest, log = () => {} }) {
  const mode = resolveMode(inputs.mode, eventName);
  let pulls;
  if (event?.pull_request) pulls = [event.pull_request];
  else if (mode === "check") pulls = await github.listOpenPulls(owner, repo);
  else throw new Error(`mode "request" needs a pull_request event; this run was triggered by "${eventName}". Use mode: check on schedules.`);
  const results = [];
  for (const pull of pulls) results.push(await handlePull({ inputs, mode, pull, owner, repo, runUrl, github, upattest, log }));
  return { mode, results };
}

async function handlePull({ inputs, mode, pull, owner, repo, runUrl, github, upattest, log }) {
  const pr = pull.number;
  const headSha = pull.head.sha;
  const context = statusContext(inputs);
  const result = { pr, head_sha: headSha, matched: false, state: "not_required" };
  const setStatus = async (state, description, target_url) => {
    if (!inputs.required) return;
    await github.createStatus(owner, repo, headSha, { state, context, description: clip(description), ...(target_url ? { target_url } : {}) });
    result.status = { state, description: clip(description) };
  };

  const files = await github.listPullFiles(owner, repo, pr);
  const matched = matchChangedFiles(files, inputs.paths);
  result.matched_files = matched;
  if (!matched.length) {
    log(`#${pr}: no changed file matches paths; no review needed.`);
    await setStatus("success", "No paths that need human review changed");
    return result;
  }
  result.matched = true;

  const diff = selectDiff(await github.compareDiff(owner, repo, pull.base.sha, headSha), matched, inputs.diffScope);
  if (!diff.trim()) {
    result.state = "failed";
    await setStatus("failure", "Matched files have no textual diff to review (binary or mode-only changes)");
    return result;
  }
  const hash = sha256Hex(diff);
  const sizeBytes = Buffer.byteLength(diff, "utf8");
  Object.assign(result, { artifact_hash: hash, size_bytes: sizeBytes });
  log(`#${pr}: ${matched.length} file(s) need review; diff ${sizeBytes} bytes, sha256 ${hash}.`);

  // 1. Is there already a signed record or an open request for this exact diff?
  const found = await findExisting(upattest, hash);
  if (found.attestation) {
    Object.assign(result, { state: "attested", request_id: found.requestId, attestation_id: found.attestation.id, verdict: found.attestation.verdict });
    const s = statusForAttestation(inputs, { status: found.attestation.status, verdict: found.attestation.verdict, attestationId: found.attestation.id });
    await setStatus(s.state, s.description, s.target_url);
    return result;
  }
  if (found.openRequest) {
    Object.assign(result, { state: "pending", request_id: found.openRequest.id });
    await setStatus("pending", `Human review requested (${found.openRequest.status}); waiting for the signed attestation`, requestLink(inputs, found.openRequest.id));
    return result;
  }
  if (mode === "check") {
    result.state = "pending";
    await setStatus("pending", "Waiting for an UpAttest review of this diff");
    return result;
  }

  // 2. Request a review. Nothing leaves the runner if it looks like it holds secrets or is too large.
  const refuse = async (reason, extra = {}) => {
    Object.assign(result, { state: "refused", reason, ...extra });
    log(`#${pr}: review not requested: ${reason}`);
    await setStatus("failure", `Review not requested: ${reason}`);
    return result;
  };
  const secrets = scanForSecrets(diff);
  if (secrets.length) return refuse(`possible secrets on diff line(s) ${secrets.map((s) => s.line).join(", ")} (${[...new Set(secrets.map((s) => s.kind))].join(", ")}); nothing was sent. Remove and rotate them`, { secrets });
  if (sizeBytes > DIRECT_UPLOAD_LIMIT_BYTES) return refuse(`the diff is ${Math.ceil(sizeBytes / 1024)} KiB, above the ${DIRECT_UPLOAD_LIMIT_BYTES / 1024} KiB limit; narrow paths`);

  const quote = await upattest.quote(quoteInput(inputs, sizeBytes));
  if (quote.status !== 200) return refuse(`no quote: ${upattest.message(quote)}`);
  const decision = priceDecision(quote.body, inputs.maxTotalCents);
  if (!decision.ok) return refuse(decision.reason, { total_cents: decision.totalCents });

  const artifact = await upattest.registerArtifact(artifactInput({ diff, owner, repo, pr, headSha }));
  if (artifact.status !== 201 && artifact.status !== 200) return refuse(`UpAttest did not accept the diff: ${upattest.message(artifact)}`);
  const artifactId = artifact.body?.artifact?.id;
  if (artifact.body?.artifact?.hash && artifact.body.artifact.hash !== hash) log(`#${pr}: warning: UpAttest hashed the artifact as ${artifact.body.artifact.hash}, expected ${hash}.`);

  const request = await upattest.createRequest(requestInput(inputs, {
    artifactId, priceCents: decision.priceCents, hash, owner, repo, repoId: pull.base?.repo?.id ?? 0, pr, headSha,
    isPrivate: !!pull.base?.repo?.private, matchedFiles: matched, runUrl, title: pull.title,
  }));
  if (request.status !== 201 && request.status !== 200) return refuse(`UpAttest did not accept the request: ${upattest.message(request)}`);
  const rec = request.body.request;
  Object.assign(result, { state: "requested", request_id: rec.id, price_cents: decision.priceCents, total_cents: decision.totalCents, replay: !!request.body.idempotent_replay });
  log(`#${pr}: review requested (${rec.id}) at ${usd(decision.priceCents)} (${usd(decision.totalCents)} with fee).`);
  await setStatus("pending", `Human review requested at ${usd(decision.totalCents)}; waiting for the signed attestation`, requestLink(inputs, rec.id));
  return result;
}

export const requestLink = (inputs, id) => `${inputs.siteUrl}/workspace?role=customer&request=${encodeURIComponent(id)}`;

/** The newest signed record for this diff hash (own requests first, then public records), or an open request. */
export async function findExisting(upattest, hash) {
  const mine = await upattest.listRequests();
  if (mine.status === 401 || mine.status === 403) throw new Error(`UpAttest refused the api-key (${mine.status}): ${upattest.message(mine)}. Create an agent key with requests:read, requests:write and artifacts:write.`);
  const requests = mine.status === 200 ? (mine.body?.requests ?? []).filter((r) => r.metadata?.artifact_hash === hash) : [];
  requests.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const r of requests.filter((x) => x.status === "attested")) {
    const a = await upattest.requestAttestation(r.id);
    if (a.status === 200 && a.body?.attestation) {
      return { requestId: r.id, attestation: { id: a.body.attestation.id ?? r.attestation_id, status: a.body.status ?? a.body.attestation.status, verdict: a.body.attestation.verdict } };
    }
  }
  const pub = await upattest.verifyHash(hash);
  const active = pub.status === 200 ? (pub.body?.results ?? []).filter((x) => !x.private && x.valid !== false) : [];
  if (active.length) {
    const best = active.find((x) => x.status === "active") ?? active[0];
    return { attestation: { id: best.id, status: best.status, verdict: best.verdict } };
  }
  const open = requests.find((r) => r.status !== "attested" && !CLOSED.has(r.status));
  return open ? { openRequest: open } : {};
}
