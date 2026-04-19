#!/bin/zsh

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

echo "Starting backend on http://127.0.0.1:5001 ..."
node "$ROOT_DIR/ai-tutor-backend/server.js" &
BACKEND_PID=$!

sleep 2

echo "Starting frontend on http://127.0.0.1:5173 ..."
npm --prefix "$ROOT_DIR/ai-tutor-frontend" run dev -- --host 127.0.0.1 &
FRONTEND_PID=$!

wait
