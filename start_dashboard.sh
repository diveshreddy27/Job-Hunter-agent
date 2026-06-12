#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV_PYTHON="$ROOT/venv/bin/python"
FRONTEND_DIR="$ROOT/dashboard/frontend"

# Trap to kill both background processes on exit
cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$FLASK_PID" "$VITE_PID" 2>/dev/null
  wait "$FLASK_PID" "$VITE_PID" 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

# Start Flask API
echo "Starting Flask API on http://localhost:5000 ..."
"$VENV_PYTHON" "$ROOT/dashboard/app.py" &
FLASK_PID=$!

# Start Vite dev server
echo "Starting React dev server on http://localhost:5173 ..."
cd "$FRONTEND_DIR"
npm run dev -- --host 0.0.0.0 &
VITE_PID=$!

echo ""
echo "  Flask API  →  http://localhost:5000"
echo "  React UI   →  http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both servers."

# Wait for either process to exit
wait "$FLASK_PID" "$VITE_PID"
