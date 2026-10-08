// The few GitHub Actions runtime features the action needs, without @actions/core.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** INPUT_<NAME> with spaces as underscores, upper-cased, as the runner sets them. */
export const getInput = (name, env = process.env) => {
  const v = env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return v === undefined ? undefined : v.trim();
};

export function setOutput(name, value, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  const text = String(value ?? "");
  if (!file) return;
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

export function appendSummary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown + "\n");
}

const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export const mask = (secret) => { if (secret) process.stdout.write(`::add-mask::${escapeData(secret)}\n`); };
export const info = (msg) => process.stdout.write(`${msg}\n`);
export const warning = (msg) => process.stdout.write(`::warning::${escapeData(msg)}\n`);
export const fail = (msg) => { process.stdout.write(`::error::${escapeData(msg)}\n`); process.exitCode = 1; };
