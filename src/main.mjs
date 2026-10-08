// Entry point GitHub runs (`runs.main` in action.yml). Wires the runner environment to run().
import { readFileSync } from "node:fs";
import { getInput, setOutput, appendSummary, mask, info, warning, fail } from "./core.mjs";
import { parseInputs } from "./payload.mjs";
import { createGitHub, createUpAttest } from "./clients.mjs";
import { run } from "./run.mjs";
import { summarize } from "./summary.mjs";

async function main() {
  const apiKey = getInput("api-key");
  mask(apiKey);
  const inputs = parseInputs(getInput);
  const [owner, repo] = String(process.env.GITHUB_REPOSITORY ?? "/").split("/");
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  const github = createGitHub({ token: getInput("github-token") ?? "", apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com" });
  const upattest = createUpAttest({ apiUrl: inputs.apiUrl, apiKey: inputs.apiKey });

  const { mode, results } = await run({ inputs, eventName: process.env.GITHUB_EVENT_NAME, event, owner, repo, runUrl, github, upattest, log: info });
  const first = results[0] ?? { matched: false, state: "not_required" };
  setOutput("matched", String(results.some((r) => r.matched)));
  setOutput("artifact-hash", first.artifact_hash ?? "");
  setOutput("request-id", first.request_id ?? "");
  setOutput("attestation-id", first.attestation_id ?? "");
  setOutput("state", first.state);
  appendSummary(summarize({ mode, results, inputs }));
  for (const r of results) if (r.state === "refused") warning(`#${r.pr}: review not requested: ${r.reason}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
