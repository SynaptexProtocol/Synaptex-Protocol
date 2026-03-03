#!/bin/sh
# Start Python IPC engine in background, then Node arena
python -u python/main.py &
PYTHON_PID=$!

# Wait for Python IPC to be ready
sleep 3

# Start Node arena (foreground, Railway monitors this)
node cli/dist/index.js arena start

# If Node exits, kill Python too
kill $PYTHON_PID
