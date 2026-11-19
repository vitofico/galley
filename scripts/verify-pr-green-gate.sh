#!/usr/bin/env bash
# Exit successfully only when Actions can prove that CI tested the release tree.
set -euo pipefail

repo=${GITHUB_REPOSITORY:?}
sha=$(git rev-parse HEAD)
tree=$(git rev-parse 'HEAD^{tree}')
base=$(jq -er 'select(.ref == "refs/heads/main" and .forced == false).before' "${GITHUB_EVENT_PATH:?}")

# Restrict reuse to a single squash merge, against the previous main tree.
# Only trust evidence written by the CI workflow already on main.
[[ "$(git show -s --format=%P HEAD)" == "$base" ]]
git diff --quiet "$base" HEAD -- .github/workflows/

pulls=$(gh api "repos/$repo/commits/$sha/pulls")
pull=$(jq -ce --arg repo "$repo" --arg sha "$sha" '
  map(select(.merged_at != null and .merge_commit_sha == $sha
      and .base.repo.full_name == $repo and .base.ref == "main"
      and .head.repo.full_name == $repo))
  | if length == 1 then .[0] else empty end
' <<< "$pulls")
number=$(jq -er '.number | numbers' <<< "$pull")
head=$(jq -er '.head.sha | strings | select(test("^[a-f0-9]{40}$"))' <<< "$pull")

# Run metadata has the PR head SHA. The proof records the synthetic merge
# checkout, which is the commit actions/checkout supplied to the full gate.
runs=$(gh api --method GET "repos/$repo/actions/workflows/ci.yml/runs" \
  -f event=pull_request -f head_sha="$head" -F per_page=2)
run=$(jq -ce --arg head "$head" --arg repo "$repo" '
  select(.total_count == 1 and (.workflow_runs | length) == 1)
  | .workflow_runs[0]
  | select(.event == "pull_request" and .path == ".github/workflows/ci.yml"
      and .head_sha == $head and .head_repository.full_name == $repo
      and .status == "completed" and .conclusion == "success")
' <<< "$runs")
run_id=$(jq -er '.id | numbers' <<< "$run")
attempt=$(jq -er '.run_attempt | numbers' <<< "$run")

# A skipped docs-only job must never pass as full-gate evidence.
jobs=$(gh api "repos/$repo/actions/runs/$run_id/attempts/$attempt/jobs")
jq -e '
  [.jobs[] | select(.name == "Typecheck + unit (Docker)")] as $gate
  | ($gate | length) == 1 and $gate[0].conclusion == "success"
    and any($gate[0].steps[]; .name == "Record tested merge tree" and .conclusion == "success")
    and any($gate[0].steps[]; .name == "Run the full green-gate" and .conclusion == "success")
    and any($gate[0].steps[]; .name == "Upload tested merge tree" and .conclusion == "success")
' <<< "$jobs" > /dev/null

proof_dir=$(mktemp -d)
trap 'rm -rf "$proof_dir"' EXIT
gh run download "$run_id" --repo "$repo" --name "full-green-gate-tree-$attempt" --dir "$proof_dir"
proof="$proof_dir/full-green-gate-tree"
tested_sha=$(sed -n '2p' "$proof")
[[ "$tested_sha" =~ ^[a-f0-9]{40}$ ]]
printf '%s\n' "$number" "$tested_sha" "$tree" | cmp -s - "$proof"

# Independently resolve the recorded checkout through GitHub. A branch head,
# a stale merge checkout, or a different tree must all run the release gate.
gh api "repos/$repo/git/commits/$tested_sha" | jq -e \
  --arg sha "$tested_sha" --arg base "$base" --arg head "$head" --arg tree "$tree" '
    .sha == $sha and .tree.sha == $tree and [.parents[].sha] == [$base, $head]
' > /dev/null
