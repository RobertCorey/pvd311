#!/bin/zsh
# Deploy Firebase Hosting from a clean checkout of HEAD (never from the shared working tree,
# which may hold other agents' uncommitted edits). Usage: scripts/deploy-clean.sh [ref]
set -e
REF="${1:-HEAD}"
ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
W="$(mktemp -d /tmp/pvd311-deploy.XXXXXX)"
git -C "$ROOT" worktree add -q --detach "$W" "$REF"
ln -s "$ROOT/app/node_modules" "$W/app/node_modules"
( cd "$W/app" && npm run build >/dev/null )
( cd "$W" && firebase deploy --only hosting 2>&1 | grep -E "Deploy complete|rror" )
echo "deployed $(git -C "$W" rev-parse --short HEAD)"
git -C "$ROOT" worktree remove --force "$W"
