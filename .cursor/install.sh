#!/usr/bin/env bash
# Idempotent dependency refresh for the checked-out source. Runs after
# checkout (and once when a build snapshots the baseline). Must terminate:
# no long-running servers, migrations, or tests here.
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

bun install
