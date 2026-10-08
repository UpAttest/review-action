// Minimal REST clients. `fetch` is injectable so tests run against fakes; no SDK dependency keeps the action
// runnable straight from a checkout (GitHub runs `node src/main.mjs` without installing anything).

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: { code: "bad_response", message: text.slice(0, 200) } }; }
}

export function createGitHub({ token, apiUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  const headers = (accept = "application/vnd.github+json") => ({ accept, authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "upattest-review-action" });
  const call = async (method, path, body, accept) => {
    const res = await fetch(apiUrl + path, { method, headers: { ...headers(accept), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) { const b = await readJson(res); throw new Error(`GitHub ${method} ${path} returned ${res.status}: ${b?.message ?? "error"}`); }
    return res;
  };
  return {
    /** Every changed file of a pull request (GitHub caps this listing at 3000 files). */
    async listPullFiles(owner, repo, pr) {
      const files = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await (await call("GET", `/repos/${owner}/${repo}/pulls/${pr}/files?per_page=100&page=${page}`)).json();
        files.push(...batch.map((f) => ({ filename: f.filename, previous_filename: f.previous_filename, status: f.status })));
        if (batch.length < 100) break;
      }
      return files;
    },
    /** The diff between exactly these two commits, so a later push cannot slip a newer diff under this sha. */
    async compareDiff(owner, repo, base, head) {
      return (await call("GET", `/repos/${owner}/${repo}/compare/${base}...${head}`, undefined, "application/vnd.github.diff")).text();
    },
    async getPull(owner, repo, pr) { return (await call("GET", `/repos/${owner}/${repo}/pulls/${pr}`)).json(); },
    async listOpenPulls(owner, repo) {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await (await call("GET", `/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`)).json();
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
    },
    async createStatus(owner, repo, sha, status) { await call("POST", `/repos/${owner}/${repo}/statuses/${sha}`, status); },
  };
}

export function createUpAttest({ apiUrl, apiKey, fetch = globalThis.fetch }) {
  const call = async (method, path, body, auth = true) => {
    const res = await fetch(apiUrl + path, {
      method,
      headers: { accept: "application/json", "user-agent": "upattest-review-action", ...(auth ? { authorization: `Bearer ${apiKey}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await readJson(res) };
  };
  const message = (r) => r.body?.error?.message ?? `UpAttest API returned ${r.status}`;
  return {
    message,
    quote: (input) => call("POST", "/v1/quotes", input),
    registerArtifact: (input) => call("POST", "/v1/artifacts", input),
    createRequest: (input) => call("POST", "/v1/attestation-requests", input),
    listRequests: (status) => call("GET", `/v1/attestation-requests${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    requestAttestation: (id) => call("GET", `/v1/attestation-requests/${encodeURIComponent(id)}/attestation`),
    /** Public records only: private records are never listed by hash. */
    verifyHash: (hash) => call("GET", `/v1/verify?hash=${hash}`, undefined, false),
  };
}
