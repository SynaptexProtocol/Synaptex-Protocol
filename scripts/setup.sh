#!/usr/bin/env bash
# Setup script - installs all dependencies

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== BNB Trading Agent Setup ==="
echo "Project root: $PROJECT_ROOT"
cd "$PROJECT_ROOT"

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not found. Please install Node.js >= 22"
  exit 1
fi
echo "Node.js: $(node --version)"

# Check pnpm
if ! command -v pnpm &> /dev/null; then
  echo "Installing pnpm..."
  npm install -g pnpm
fi
echo "pnpm: $(pnpm --version)"

# Check Python
if ! command -v python3 &> /dev/null && ! command -v python &> /dev/null; then
  echo "ERROR: Python not found. Please install Python >= 3.11"
  exit 1
fi
PYTHON=$(command -v python3 || command -v python)
echo "Python: $($PYTHON --version)"

# Install TypeScript packages
echo ""
echo "--- Installing TypeScript dependencies ---"
pnpm install

# Build TypeScript packages
echo ""
echo "--- Building TypeScript packages ---"
pnpm build

# Setup Python virtual environment
echo ""
echo "--- Setting up Python environment ---"
cd "$PROJECT_ROOT/python"

if [ ! -d ".venv" ]; then
  $PYTHON -m venv .venv
fi

source .venv/bin/activate 2>/dev/null || source .venv/Scripts/activate 2>/dev/null

pip install -r requirements.txt -q

echo ""
echo "--- Setup complete! ---"
echo ""
echo "Next steps:"
echo "  1. Copy .env.example to .env and fill in your keys"
echo "  2. Run: mp login --email you@example.com  (MoonPay authentication)"
echo "  3. Run: mp wallet create --name main      (Create BNB wallet)"
echo "  4. Run: bash scripts/start-agent.sh       (Start the agent)"
