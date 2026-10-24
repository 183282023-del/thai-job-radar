#!/bin/zsh
cd "$(dirname "$0")"

if curl -fsS "http://127.0.0.1:8765/api/health" >/dev/null 2>&1; then
  open "http://127.0.0.1:8765"
  exit 0
fi

python3 server.py &
server_pid=$!

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:8765/api/health" >/dev/null 2>&1; then
    open "http://127.0.0.1:8765"
    break
  fi
  sleep 0.25
done

wait "$server_pid"
