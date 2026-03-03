#!/usr/bin/env bash
# Start both Python strategy engine and TypeScript agent

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="${1:-config/agent.yaml}"
MODE="${2:-paper}"

echo "=== Starting BNB Trading Agent (mode: $MODE) ==="
cd "$PROJECT_ROOT"

# Activate Python venv
VENV="$PROJECT_ROOT/python/.venv"
if [ -f "$VENV/bin/activate" ]; then
  source "$VENV/bin/activate"
elif [ -f "$VENV/Scripts/activate" ]; then
  source "$VENV/Scripts/activate"
else
  echo "ERROR: Python venv not found. Run scripts/setup.sh first"
  exit 1
fi

# Start Python strategy engine in background
echo "Starting Python strategy engine..."
cd "$PROJECT_ROOT/python"
python main.py --config "../$CONFIG" &
PYTHON_PID=$!
echo "Python PID: $PYTHON_PID"

# Wait for Python to be ready
sleep 2

# Start TypeScript agent
echo "Starting TypeScript agent..."
cd "$PROJECT_ROOT"
node cli/dist/index.js start --config "$CONFIG" --mode "$MODE" &
TS_PID=$!
echo "TypeScript PID: $TS_PID"

# Trap shutdown
cleanup() {
  echo ""
  echo "Shutting down..."
  kill $PYTHON_PID 2>/dev/null || true
  kill $TS_PID 2>/dev/null || true
  echo "Stopped."
}
trap cleanup SIGINT SIGTERM

echo ""
echo "Agent running. Press Ctrl+C to stop."
echo "Logs: tail -f logs/agent.log"
echo ""

# Wait for both processes
wait $TS_PID
wait $PYTHON_PID
