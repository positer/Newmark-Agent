#!/usr/bin/env bash
set -euo pipefail

echo '========================================'
echo ' Newmark Agent - Setup (Linux/macOS)'
echo '========================================'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$ROOT/DESKTOP"

if ! command -v node >/dev/null 2>&1; then
  echo 'Missing prerequisite: Node.js. Install it from https://nodejs.org.' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo 'Missing prerequisite: npm. Reinstall Node.js with npm enabled.' >&2
  exit 1
fi
if [[ ! -f "$DESKTOP_ROOT/package.json" ]]; then
  echo "DESKTOP/package.json was not found under $ROOT" >&2
  exit 1
fi

echo "Node: $(node --version)"
echo "npm: $(npm --version)"
echo 'Installing TypeScript/Electron dependencies...'

(
  cd "$DESKTOP_ROOT"
  npm install
  npm run build
)

echo
echo 'Setup complete.'
echo 'Desktop development: cd DESKTOP && npm run start:dev'
echo 'TypeScript CLI:      cd DESKTOP && npm run start:cli'
echo 'Linux package:       cd DESKTOP && npm run dist:linux'
echo 'Mutable application state is stored under ~/.Newmark.'
