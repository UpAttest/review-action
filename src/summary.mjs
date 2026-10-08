import { usd, VERDICT_WORDS } from "./payload.mjs";
import { requestLink } from "./run.mjs";

/** Job summary in Markdown. Never includes the diff, findings or any secret. */
export function summarize({ mode, results, inputs }) {
  const lines = [`### UpAttest human review (${mode})`, "", "| PR | Matched files | State | Detail |", "|---|---|---|---|"];
  for (const r of results) {
    const detail = r.state === "attested" ? `[record](${inputs.siteUrl}/a/${r.attestation_id})${r.verdict ? `: ${VERDICT_WORDS[r.verdict] ?? r.verdict}` : ""}`
      : r.state === "requested" ? `[request ${r.request_id}](${requestLink(inputs, r.request_id)}) at ${usd(r.total_cents)} incl. fee${r.replay ? " (existing request)" : ""}`
      : r.state === "pending" ? (r.request_id ? `[request ${r.request_id}](${requestLink(inputs, r.request_id)})` : "waiting for a review of this diff")
      : r.state === "refused" ? r.reason
      : r.state === "failed" ? (r.status?.description ?? "failed")
      : "no configured path changed";
    lines.push(`| #${r.pr} | ${r.matched_files?.length ?? 0} | ${r.state} | ${String(detail).replace(/\|/g, "\\|")} |`);
  }
  lines.push("", "_A completed review is a named professional's signed opinion about this exact diff. It is not a merge decision._");
  return lines.join("\n");
}
