#!/usr/bin/env python3
"""kb-hub-notify.py v2 —— 事件驱动的记忆 hub 通知服务。

因果链（没有任何轮询）：
    git push 落到 bare 仓库
      └─ git 自动执行 hooks/post-receive           ← 事件源
           └─ POST /publish {rev}                   ← 钩子把新 rev 交给服务
                └─ 服务唤醒所有挂起中的 /wait        ← 条件变量，不是定时检查
                     └─ 设备立刻 pull + apply

/wait 是长轮询（客户端只发一个请求挂着，不发周期请求）；服务端不再定时 rev-parse，
只在 startup 读一次 HEAD，之后完全由 /publish 驱动。
"""
import argparse
import hmac
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ARGS = None
STATE = {"rev": "", "seq": 0}
COND = threading.Condition()


def read_head() -> str:
    try:
        out = subprocess.run(
            ["git", "--git-dir", ARGS.repo, "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def publish(rev: str) -> int:
    with COND:
        STATE["rev"] = rev or read_head()
        STATE["seq"] += 1
        COND.notify_all()
        return STATE["seq"]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if ARGS.verbose:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self, query) -> bool:
        token = (query.get("token") or [""])[0]
        if ARGS.header_token:
            token = self.headers.get("X-KB-Token", token)
        return hmac.compare_digest(token, ARGS.token)

    def do_POST(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if not self._authed(query):
            return self._send(403, {"ok": False, "error": "bad token"})
        if url.path != "/publish":
            return self._send(404, {"ok": False, "error": "unknown path"})
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode() or "{}")
        except Exception:
            payload = {}
        rev = str(payload.get("rev") or "").strip()
        seq = publish(rev)
        return self._send(200, {"ok": True, "rev": STATE["rev"], "seq": seq})

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path == "/health":
            return self._send(200, {"ok": True, "rev": STATE["rev"]})
        if not self._authed(query):
            return self._send(403, {"ok": False, "error": "bad token"})
        if url.path == "/rev":
            return self._send(200, {"rev": STATE["rev"]})
        if url.path == "/wait":
            since = (query.get("rev") or [""])[0]
            deadline = time.time() + ARGS.wait_seconds
            with COND:
                start_seq = STATE["seq"]
                while STATE["rev"] == since or STATE["seq"] == start_seq:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        return self._send(200, {"rev": since, "changed": False, "timeout": True})
                    COND.wait(min(remaining, 30.0))
                return self._send(200, {"rev": STATE["rev"], "changed": True, "seq": STATE["seq"]})
        return self._send(404, {"ok": False, "error": "unknown path"})


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--port", type=int, default=7392)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--token", default=None)
    ap.add_argument("--token-file", default=None)
    ap.add_argument("--wait-seconds", type=int, default=55)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--header-token", action="store_true", help="优先读 X-KB-Token 头")
    ARGS = ap.parse_args()
    if not ARGS.token and ARGS.token_file:
        with open(ARGS.token_file, "r", encoding="utf-8") as handle:
            ARGS.token = handle.read().strip()
    if not ARGS.token:
        ap.error("需要 --token 或 --token-file")
    STATE["rev"] = read_head()
    server = ThreadingHTTPServer((ARGS.bind, ARGS.port), Handler)
    server.daemon_threads = True
    print(f"kb-hub-notify v2 on {ARGS.bind}:{ARGS.port} repo={ARGS.repo} rev={STATE['rev'][:8]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
