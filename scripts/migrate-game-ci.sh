#!/usr/bin/env bash
# Migrate every sibling game under ~/dev/stores/fgs/games/* to call the
# centralized reusable workflow at freegamestore-online/freegamestore.
# Idempotent: re-run safely. Skips a repo if its deploy.yml already
# matches the new shape.
#
# Usage:
#   scripts/migrate-game-ci.sh [--push]      # default: dry-run
#   scripts/migrate-game-ci.sh --push        # also commits + pushes
#   scripts/migrate-game-ci.sh --only=name,name  # subset of games
#
# Per-game CF project name follows the convention free<game>app. Override
# by setting the variable in CF_PROJECT_OVERRIDES below for any exception.

set -eo pipefail

PUSH=0
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# Per-game CF project name. Convention is free<game>app; override here for
# games where the project name in Cloudflare Pages was registered differently.
cf_project_for() {
  case "$1" in
    puzzle) echo "freepuzzle" ;;
    *)      echo "free$1app" ;;
  esac
}

GAMES_DIR="${HOME}/dev/stores/fgs/games"
if [ ! -d "$GAMES_DIR" ]; then
  echo "games dir not found: $GAMES_DIR" >&2
  exit 1
fi

read_only_set() {
  if [ -z "$ONLY" ]; then return 1; fi
  IFS=',' read -ra arr <<< "$ONLY"
  for x in "${arr[@]}"; do
    if [ "$x" = "$1" ]; then return 0; fi
  done
  return 1
}

render_workflow() {
  local cf_project="$1"
  cat <<EOF
name: CI / Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# Most-recent push/PR for a ref wins; older runs are cancelled so a deploy
# never wins a race against a fresh build of the same branch.
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci-and-deploy:
    uses: freegamestore-online/freegamestore/.github/workflows/game-ci.yml@main
    with:
      cf_project: ${cf_project}
    permissions:
      contents: read
      deployments: write
    secrets: inherit
EOF
}

migrated=0
skipped=0
failed=0

for repo in "$GAMES_DIR"/*/; do
  name=$(basename "$repo")
  if [ -n "$ONLY" ] && ! read_only_set "$name"; then continue; fi

  cf_project=$(cf_project_for "$name")

  if [ ! -d "$repo/.git" ]; then
    echo "skip $name (not a git repo)"
    skipped=$((skipped+1))
    continue
  fi

  mkdir -p "$repo/.github/workflows"
  new_yaml=$(render_workflow "$cf_project")
  existing=""
  [ -f "$repo/.github/workflows/deploy.yml" ] && existing=$(cat "$repo/.github/workflows/deploy.yml")

  if [ "$existing" = "$new_yaml" ]; then
    echo "skip $name (already migrated)"
    skipped=$((skipped+1))
    continue
  fi

  echo "→ $name  (cf_project=$cf_project)"
  printf '%s\n' "$new_yaml" > "$repo/.github/workflows/deploy.yml"

  # Remove redundant old workflows — typecheck-on-PR ci.yml and grep-based
  # compliance.yml are both superseded by the centralized pipeline.
  rm -f "$repo/.github/workflows/ci.yml" "$repo/.github/workflows/compliance.yml"

  if [ "$PUSH" = "1" ]; then
    pushd "$repo" >/dev/null
    git add .github/workflows/
    if git diff --cached --quiet; then
      echo "   (no changes to commit)"
      popd >/dev/null
      skipped=$((skipped+1))
      continue
    fi
    if ! git commit -m "ci: switch deploy.yml to reusable game-ci workflow

Caller for freegamestore-online/freegamestore's reusable workflow.
Pipeline definition is centralized; per-game file is just the
cf_project plumbing." >/dev/null 2>&1; then
      echo "   commit FAILED"
      failed=$((failed+1))
      popd >/dev/null
      continue
    fi
    if git push origin main >/dev/null 2>&1; then
      echo "   pushed"
    else
      echo "   push FAILED"
      failed=$((failed+1))
    fi
    popd >/dev/null
  else
    echo "   (dry-run; pass --push to commit + push)"
  fi
  migrated=$((migrated+1))
done

echo
echo "summary: $migrated migrated, $skipped skipped, $failed failed"
if [ "$PUSH" = "0" ] && [ "$migrated" -gt 0 ]; then
  echo "re-run with --push to commit + push these changes."
fi
