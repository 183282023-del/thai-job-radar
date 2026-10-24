#!/usr/bin/env python3
"""Local web server for 泰语工作雷达.

Run from this directory:
    python3 server.py

The server binds to localhost, refreshes once per day at 08:00 Asia/Shanghai,
and keeps the last successful result on disk if a job site temporarily blocks
the request.
"""

from __future__ import annotations

import json
import mimetypes
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlparse

from scraper import CHINA_TZ, scrape_all


ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / "data" / "state.json"
SEED_PATH = ROOT / "seed.js"
HOST = os.environ.get("JOB_RADAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("JOB_RADAR_PORT", "8765"))
SCHEDULE_HOUR = 8
REFRESH_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
STOP_EVENT = threading.Event()


def load_seed() -> Dict[str, Any]:
    source = SEED_PATH.read_text(encoding="utf-8")
    marker = "window.SEED_DATA"
    if marker not in source:
        raise RuntimeError("seed.js is not in the expected format")
    json_text = source.split("=", 1)[1].strip().rstrip(";")
    return json.loads(json_text)


def load_state() -> Dict[str, Any]:
    with STATE_LOCK:
        if STATE_PATH.exists():
            try:
                return json.loads(STATE_PATH.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pass
        return load_seed()


def save_state(payload: Dict[str, Any]) -> None:
    with STATE_LOCK:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = STATE_PATH.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, STATE_PATH)


def next_schedule(now: Optional[datetime] = None) -> datetime:
    now = now or datetime.now(CHINA_TZ)
    target = now.replace(hour=SCHEDULE_HOUR, minute=0, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return target


def refresh_state(trigger: str = "manual") -> Dict[str, Any]:
    if not REFRESH_LOCK.acquire(blocking=False):
        return {"ok": False, "message": "检索正在进行，请稍候", "state": load_state()}

    try:
        previous = load_state()
        result = scrape_all(previous)
        meta = result.setdefault("meta", {})
        meta["trigger"] = trigger
        meta["next_run_at"] = next_schedule().isoformat()
        meta["schedule"] = f"每日 {SCHEDULE_HOUR:02d}:00"
        save_state(result)
        return {
            "ok": True,
            "message": meta.get("message", "检索完成"),
            "state": result,
        }
    except Exception as exc:
        previous = load_state()
        meta = previous.setdefault("meta", {})
        meta["last_attempt"] = datetime.now(CHINA_TZ).isoformat()
        meta["status"] = "error"
        meta["message"] = f"本次检索失败：{exc}"
        meta["trigger"] = trigger
        meta["next_run_at"] = next_schedule().isoformat()
        return {"ok": False, "message": meta["message"], "state": previous}
    finally:
        REFRESH_LOCK.release()


def scheduler_worker() -> None:
    """Run once daily at 08:00. Failures wait at least an hour before retrying."""
    last_attempt_date: Optional[str] = None
    while not STOP_EVENT.is_set():
        now = datetime.now(CHINA_TZ)
        today = now.date().isoformat()
        due = now.hour > SCHEDULE_HOUR or (
            now.hour == SCHEDULE_HOUR and now.minute >= 0
        )
        if due and last_attempt_date != today:
            last_attempt_date = today
            refresh_state(trigger="schedule")
            STOP_EVENT.wait(60)
            continue

        target = next_schedule(now)
        seconds = max(15, min(300, int((target - now).total_seconds())))
        STOP_EVENT.wait(seconds)


class AppHandler(BaseHTTPRequestHandler):
    server_version = "ThaiJobRadar/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            state = load_state()
            meta = state.setdefault("meta", {})
            meta["next_run_at"] = next_schedule().isoformat()
            meta["schedule"] = f"每日 {SCHEDULE_HOUR:02d}:00"
            self.send_json({"ok": True, "state": state})
            return
        if parsed.path == "/api/health":
            self.send_json(
                {
                    "ok": True,
                    "time": datetime.now(CHINA_TZ).isoformat(),
                    "schedule": f"{SCHEDULE_HOUR:02d}:00 Asia/Shanghai",
                }
            )
            return
        if parsed.path == "/api/refresh":
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Use POST to refresh")
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/refresh":
            self.send_json({"ok": False, "message": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length:
                self.rfile.read(min(length, 65536))
            result = refresh_state(trigger="manual")
            self.send_json(result)
        except Exception as exc:
            self.send_json(
                {"ok": False, "message": f"刷新失败：{exc}"},
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    def serve_static(self, raw_path: str) -> None:
        request_path = unquote(raw_path).lstrip("/") or "index.html"
        if request_path == "favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return

        candidate = (ROOT / request_path).resolve()
        try:
            candidate.relative_to(ROOT)
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.exists() or not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if candidate.name in ("server.py", "scraper.py") or "/data/" in str(candidate):
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        content = candidate.read_bytes()
        mime_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix == ".js":
            mime_type = "text/javascript; charset=utf-8"
        elif candidate.suffix in (".html", ".css"):
            mime_type = f"{mime_type}; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, payload: Dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def main() -> None:
    thread = threading.Thread(target=scheduler_worker, name="daily-scheduler", daemon=True)
    thread.start()
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"泰语工作雷达已启动：http://{HOST}:{PORT}")
    print("自动检索：每日 08:00（Asia/Shanghai）")
    print("按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止服务…")
    finally:
        STOP_EVENT.set()
        server.server_close()


if __name__ == "__main__":
    main()
