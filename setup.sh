#!/usr/bin/env bash
set -e

echo "========================================"
echo " Newmark Agent - One-click Setup (Linux/macOS)"
echo "========================================"
echo ""

ROOT=$(pwd)

# =========================
# [1/7] Check prerequisites
# =========================
echo "[1/7] Checking prerequisites..."

missing=()

if ! command -v node &>/dev/null; then
    missing+=("Node.js (https://nodejs.org)")
fi
if ! command -v npm &>/dev/null; then
    missing+=("npm")
fi
if ! command -v dotnet &>/dev/null; then
    echo "  [WARN] .NET SDK not found - CLI build will be skipped"
    echo "  Install: https://dotnet.microsoft.com/download"
fi

if [ ${#missing[@]} -gt 0 ]; then
    echo "[ERROR] Missing prerequisites:"
    for m in "${missing[@]}"; do echo "  - $m"; done
    echo ""
    echo "Please install the missing prerequisites and re-run this script."
    exit 1
fi

echo "  Node: $(node --version)"
echo "  npm: $(npm --version)"
if command -v dotnet &>/dev/null; then
    echo "  .NET: $(dotnet --version)"
fi
echo "  [OK]"

# =========================
# [2/7] Initialize project directories
# =========================
echo "[2/7] Initializing project directories..."

Ensure_Dir() {
    if [ ! -d "$1" ]; then
        mkdir -p "$1"
        echo "  [CREATE] $1"
    fi
}

Ensure_Dir "$ROOT/CLI/Newmark"
Ensure_Dir "$ROOT/DESKTOP/src"
Ensure_Dir "$ROOT/WEB"
Ensure_Dir "$ROOT/SCRIPTS"
Ensure_Dir "$ROOT/WORK"
Ensure_Dir "$ROOT/FLOW"
Ensure_Dir "$ROOT/SKILLS"
Ensure_Dir "$ROOT/ARCHIVE"

# =========================
# [3/7] Verify config files
# =========================
echo "[3/7] Verifying config files..."

if [ ! -f "$ROOT/config.json" ]; then
    echo "[ERROR] config.json not found! Run from project root."
    exit 1
fi
if [ ! -f "$ROOT/agent.md" ]; then
    echo "[WARN] agent.md not found, creating default..."
    cat > "$ROOT/agent.md" << 'EOF'
# Newmark Agent

You are Newmark Agent, a powerful coding assistant.
EOF
fi
if [ ! -f "$ROOT/PC_Hash.config" ]; then
    echo "$(hostname)|$(uname -s)|$(uname -m)" > "$ROOT/PC_Hash.config"
    echo "  [CREATE] PC_Hash.config"
fi

# Initialize WORK registry files
if [ ! -f "$ROOT/WORK/Local.json" ]; then echo '[]' > "$ROOT/WORK/Local.json"; echo "  [CREATE] WORK/Local.json"; fi
if [ ! -f "$ROOT/WORK/External.json" ]; then echo '[]' > "$ROOT/WORK/External.json"; echo "  [CREATE] WORK/External.json"; fi

# Initialize Flow guide
if [ ! -f "$ROOT/FLOW/Flow.md" ]; then
    cat > "$ROOT/FLOW/Flow.md" << 'EOF'
# Newmark Flow Format Guide

Flow files are stored in the `Flow/` directory with naming pattern `{name}.Flow.json`.

## Component Types
- **Dialog**: `{ type: "dialog", id, mode: "Build"|"Plan"|"Goal", prompt }`
- **Logic**: `{ type: "logic", id, prompt, goto_true, goto_false }`

Use `{#prompt#}` as placeholder for user input in dialog/logic components.
EOF
    echo "  [CREATE] FLOW/Flow.md"
fi

# =========================
# [4/7] Install DESKTOP dependencies
# =========================
echo "[4/7] Installing DESKTOP dependencies..."
if [ -f "$ROOT/DESKTOP/package.json" ]; then
    (cd "$ROOT/DESKTOP" && npm install)
    if [ $? -ne 0 ]; then
        echo "[ERROR] npm install failed in DESKTOP/"
        exit 1
    fi
    echo "  [OK] DESKTOP dependencies installed"
else
    echo "  [SKIP] No package.json in DESKTOP/"
fi

# =========================
# [5/7] Build CLI (C# .NET)
# =========================
echo "[5/7] Building CLI (C# .NET)..."
csproj="$ROOT/CLI/Newmark/Newmark.csproj"
if [ -f "$csproj" ] && command -v dotnet &>/dev/null; then
    dotnet restore "$csproj"
    dotnet build "$csproj" -c Release
    if [ $? -ne 0 ]; then
        echo "[WARN] CLI build had issues (non-fatal)"
    else
        echo "  [OK] CLI built successfully"
    fi
else
    echo "  [SKIP] No C# project or .NET SDK"
fi

# =========================
# [6/7] Create launcher scripts
# =========================
echo "[6/7] Creating launcher scripts..."

if [ ! -f "$ROOT/newmark" ]; then
    cat > "$ROOT/newmark" << 'LAUNCHER'
#!/usr/bin/env bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
    --cli)
        dotnet run --project "$ROOT/CLI/Newmark/Newmark.csproj" "${@:2}"
        ;;
    --desktop|"")
        cd "$ROOT/DESKTOP"
        npm run start:dev
        ;;
    --help)
        echo "Newmark Agent Launcher"
        echo "Usage: ./newmark [--cli] [--desktop] [--help]"
        ;;
esac
LAUNCHER
    chmod +x "$ROOT/newmark"
    echo "  [CREATE] newmark (launcher)"
fi

# =========================
# [7/7] Done
# =========================
echo "[7/7] Setup complete!"
echo ""
echo "========================================" 
echo " Newmark Agent is ready!"
echo "========================================"
echo ""
echo "Quick start:"
echo "  ./newmark --cli         Start CLI mode"
echo "  ./newmark --desktop     Start Desktop UI"
echo "  ./newmark               Start Desktop UI (default)"
echo ""
echo "DESKTOP development:"
echo "  cd DESKTOP"
echo "  npm run dev            Start dev server"
echo "  npm run build          Build for production"
echo ""
echo "CLI development:"
echo "  cd CLI/Newmark"
echo "  dotnet run             Run CLI"
