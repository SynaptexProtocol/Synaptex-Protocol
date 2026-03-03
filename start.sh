#!/bin/sh
# Make libstdc++ findable at runtime (required by numpy on NixOS)
export LD_LIBRARY_PATH=$(find /nix/store -name "libstdc++.so.6" 2>/dev/null | head -1 | xargs dirname 2>/dev/null):$LD_LIBRARY_PATH

# Start Python IPC engine in background
python -u python/main.py &
PYTHON_PID=$!

# Wait for Python IPC to be ready
sleep 3

# Start Node arena (foreground)
node cli/dist/index.js arena start

# If Node exits, kill Python too
kill $PYTHON_PID
