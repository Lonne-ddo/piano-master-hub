#!/usr/bin/env bash
# Sondage complet Master Hub — wrapper du harness Node.
# Usage :
#   ./tools/test-sondage.sh                # prod par défaut
#   SONDAGE_BASE=https://preview... ./tools/test-sondage.sh
#   ./tools/test-sondage.sh --static-only  # audit repo seul (sans réseau)
#
# Le vrai harness est tools/test-sondage.mjs (cross-platform, Node 18+).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/tools/test-sondage.mjs" "$@"
