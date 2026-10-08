# UpAttest Human Review

**Require a verified human professional's sign-off on the risky parts of a pull request.**

When a pull request touches the paths you mark as sensitive (infrastructure, authentication, database migrations…),
this action asks UpAttest for a review by a credentialed engineer within the price you set, and posts a commit
status that stays **pending until a signed attestation exists for that exact diff**. Make the status a required
check and nothing merges unreviewed.

- Only the matched files' diff leaves the runner, and nothing at all if it looks like it contains secrets.
- One review per exact diff: re-runs, new commits that do not change the matched files, and retries reuse the
  same request and the same record.
- Never above your cap: the price is checked before anything is sent and the request is a limit order at that price.
- The record is private by default. The status links to the signed record.

> A completed review is a named professional's signed opinion about this exact diff. **It is not a merge
> decision.** By default any completed review satisfies the check; use `fail-on-verdicts` if your team wants a
> "Not supported" conclusion to fail it.

## Usage

```yaml
# .github/workflows/upattest.yml
name: Human review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  schedule:
    - cron: "*/30 * * * *"   # re-check open PRs so the status turns green when the record is signed
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read
  statuses: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: upattest/review-action@v1
        with:
          api-key: ${{ secrets.UPATTEST_API_KEY }}
          paths: |
            infra/**
            auth/**
            *.sql
          max-price: 250
```

Then in **Settings → Branches → Branch protection** (or a ruleset) add `UpAttest / software.change_review` as a
required status check.

No checkout step is needed: the action reads the diff through the GitHub API and never runs repository code.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `api-key` | required | UpAttest agent key (`artifacts:write`, `requests:write`, `requests:read`). Store as the secret `UPATTEST_API_KEY`. |
| `paths` | required | Globs, one per line or comma-separated. `infra/**` (directory), `*.sql` (any depth), `!docs/**` (exclude; later lines win). A renamed file counts if either name matches. |
| `max-price` | required | Maximum **total** per review in US dollars, including UpAttest's requester fee. |
| `attestation-type` | `software.change_review` | What the reviewer signs. List types at `https://api.upattest.com/v1/attestation-types`. Empty for a plain rubric review. |
| `attestation-variables` | — | JSON object of extra template inputs. For `software.change_review`, `change_ref` and `purpose` come from the PR. |
| `rubric` | `code.security` | `code.security` or `code.correctness`. |
| `credential-type` | `staff_engineer` | Credential the reviewer must hold. Empty for identity-verified reviewers. |
| `required` | `true` | Post the commit status. `false` only requests the review. |
| `fail-on-verdicts` | — | Verdicts that fail the status: `pass`, `qualified`, `fail`, `no_opinion`. |
| `mode` | `auto` | `request` on `pull_request`, `check` on schedules and manual runs. `check` never creates a request. |
| `diff-scope` | `matched` | `all` sends the whole PR diff instead of only matched files. |
| `api-url` | `https://api.upattest.com` | `https://api-sandbox.upattest.com` for the sandbox (simulated payments). |
| `site-url` | `https://upattest.com` | Website used in links. |
| `github-token` | `${{ github.token }}` | Reads the PR and posts the status. |

## Outputs

`matched`, `artifact-hash` (sha256 of the LF diff sent), `request-id`, `attestation-id`, `state`
(`not_required`, `requested`, `pending`, `attested`, `refused`, `failed`).

## Status meanings

| Status | When |
|---|---|
| success "No paths that need human review changed" | Nothing matched. |
| pending "Human review requested at $X" | A request exists for this diff; waiting for the signed record. |
| success "Signed review exists: <verdict>" | A record exists for this diff's hash (yours, or a public one). |
| failure "Review not requested: …" | Over `max-price`, no reviewer available, possible secrets, diff above 256 KiB, or the API refused. Nothing was charged. |
| failure "…revoked" | The record for this diff was revoked. |

## Forks

Secrets are not passed to workflows on pull requests from forks. To review fork PRs, run the action on
`pull_request_target`. This action never checks out or executes PR code, so that is safe **only if your job has
no step that checks out the PR head**.

## Action or GitHub App?

UpAttest also has a GitHub App: someone with write access comments `/upattest review` and the result comes back
as a neutral check run with the record link. Choose the App for on-demand reviews without storing a key in the
repository. Choose this action for automatic, path-based review requirements in your own workflows.

## Data handling

Sent to UpAttest: the matched files' diff (or the whole diff with `diff-scope: all`), the PR number, title, head
commit and repository name, and the run URL. Diffs with likely credentials are refused before upload; the
summary lists line numbers and kinds only. Private repositories are classed confidential.

License: see the repository. UpAttest: <https://upattest.com>.
