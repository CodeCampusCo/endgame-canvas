# Branch protection ruleset

`protect-master.json` is the branch-protection ruleset for the default branch (`master`),
kept here as config-as-code. It is **not applied automatically** — apply it once, after the
setup steps below.

## What it enforces (on `master`)

- **No deletion** and **no force-push** — `master` can't be deleted or rewritten.
- **Pull request required** before merging (external contributions go through a PR), with
  **0 required approvals** — a solo maintainer can still merge their own PRs (merging isn't
  approving), and there's no lock-out.
- **All review threads must be resolved** before merging — nothing merges with an open review
  conversation (the review bots' threads must be resolved or replied-to first).
- **Status check `check` must pass** — the `check` job in `.github/workflows/ci.yml`
  (install + test + tsc + build). Non-strict, so a branch doesn't have to be up to date first.
- **No linear-history / signed-commit requirement** — merge commits and unsigned commits are
  allowed, matching the current workflow.
- **Empty bypass list** — nobody is exempt. If you want a direct-push escape hatch, add
  yourself (Repository admin) to the bypass list in the UI later.

## Apply it — do this AFTER, in this order

1. **Merge the PR stack** so `master` actually contains `.github/workflows/ci.yml`. If you
   require the `check` status before CI has ever run on a branch, that branch can't be merged —
   so protection must come after CI exists on `master`.
2. **Make the repository public** (rulesets are free on public repos; on a private repo they may
   require a paid org plan).
3. **Apply the ruleset**, either way:

   **Via the GitHub UI** — Settings → Rules → Rulesets → *New ruleset* → *Import a ruleset* →
   upload `protect-master.json`.

   **Via the API** (or ask the assistant to run it once the repo is public):
   ```bash
   gh api repos/CodeCampusCo/endgame-canvas/rulesets \
     --method POST --input .github/rulesets/protect-master.json
   ```

## Note on the required check name

The required check is `check` — the job name in `ci.yml`. If the UI asks you to pick the check
from a list, choose the **`check`** job under the GitHub Actions integration. If the API call
reports the check can't be found, it's because CI hasn't run on `master` yet (do step 1 first).

To change the ruleset later, edit `protect-master.json` and re-apply, or edit it in the UI and
re-export it here to keep this file in sync.
