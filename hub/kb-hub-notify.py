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
import os
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



PANEL_HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>记忆网络 · 面板</title>
<style>
:root{color-scheme:dark}body{font:14px/1.6 -apple-system,"Segoe UI","Noto Sans SC",sans-serif;margin:0;padding:24px;background:#0f1115;color:#e6e8eb}
h1{font-size:18px;margin:0 0 4px}.sub{color:#8b93a1;font-size:12px;margin-bottom:18px}
.card{background:#171a21;border:1px solid #262b36;border-radius:10px;padding:14px 16px;margin-bottom:14px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #22262f;font-size:13px}
th{color:#8b93a1;font-weight:500}.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px}
.on{background:#12301c;color:#3fb950}.stale{background:#3a2a12;color:#ffc46b}.muted{color:#6b7280}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.dev{background:#12151b;border:1px solid #232833;border-radius:8px;padding:10px 12px}
.dev b{font-size:13px}.dev div{font-size:11px;color:#8b93a1}
</style></head><body>
<h1>记忆网络</h1><div class="sub" id="sub">加载中…</div>
<div class="card"><div style="font-size:12px;color:#8b93a1;margin-bottom:8px">知识库同步状态</div>
<table><thead><tr><th>知识库</th><th>最新同步者</th><th>同步时间</th><th>分片设备</th><th>条数</th></tr></thead><tbody id="spaces"></tbody></table></div>
<div class="card"><div style="font-size:12px;color:#8b93a1;margin-bottom:8px">设备</div><div class="grid" id="devices"></div></div>
<script>
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const ago = (iso) => { if(!iso) return '—'; const d=(Date.now()-new Date(iso).getTime())/1000; if(d<90) return '刚刚'; if(d<3600) return Math.round(d/60)+' 分钟前'; if(d<86400) return Math.round(d/3600)+' 小时前'; return Math.round(d/86400)+' 天前'; };
async function load(){
  const r = await fetch('/api/overview?token=' + encodeURIComponent(TOKEN), {cache:'no-store'});
  if(!r.ok){ document.getElementById('sub').textContent = '鉴权失败：请用 ?token=… 打开'; return; }
  const d = await r.json();
  document.getElementById('sub').textContent = 'HEAD ' + d.head + ' · 设备 ' + d.devices.length + ' 台 · 空间 ' + d.spaces.length + ' 个 · ' + new Date().toLocaleTimeString();
  document.getElementById('spaces').innerHTML = d.spaces.map(s => '<tr><td>' + s.space + '</td><td>' + (s.lastDevice||'—') + '</td><td>' + (s.lastSync? new Date(s.lastSync).toLocaleString():'—') + ' <span class="muted">'+ago(s.lastSync)+'</span></td><td>' + s.devices + '</td><td>' + s.records + '</td></tr>').join('');
  document.getElementById('devices').innerHTML = d.devices.map(x => '<div class="dev"><b>' + x.device + '</b> <span class="pill ' + (x.fresh?'on':'stale') + '">' + (x.fresh?'在线':'离线') + '</span><div>' + (x.host||'') + ' · ' + (x.version||'') + '</div><div>上次同步：' + (x.lastSync? new Date(x.lastSync).toLocaleString():'—') + '（'+ago(x.lastSync)+'）</div><div>HEAD ' + (x.head||'—') + '</div></div>').join('');
}
load(); setInterval(load, 15000);
</script></body></html>"""


def git_out(args):
    try:
        out = subprocess.run(["git", "--git-dir", ARGS.repo] + args, capture_output=True, text=True, timeout=15)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def list_tree(prefix):
    out = git_out(["ls-tree", "--name-only", "HEAD:" + prefix])
    return [line for line in out.splitlines() if line.strip()]


def show_file(path):
    try:
        out = subprocess.run(["git", "--git-dir", ARGS.repo, "show", "HEAD:" + path], capture_output=True, text=True, timeout=20)
        return out.stdout if out.returncode == 0 else ""
    except Exception:
        return ""


def overview():
    head = git_out(["rev-parse", "--short", "HEAD"])
    devices = []
    for name in list_tree("devices"):
        if not name.endswith(".json"):
            continue
        try:
            item = json.loads(show_file("devices/" + name) or "{}")
        except Exception:
            continue
        last = item.get("lastSync")
        fresh = False
        if isinstance(last, str):
            try:
                from datetime import datetime, timezone
                ts = datetime.fromisoformat(last.replace("Z", "+00:00"))
                fresh = (datetime.now(timezone.utc) - ts).total_seconds() < 3600
            except Exception:
                fresh = False
        devices.append({"device": item.get("device") or name[:-5], "host": item.get("host"), "version": item.get("version"), "lastSync": last, "head": item.get("head"), "fresh": fresh})
    spaces = []
    for name in list_tree("spaces"):
        files = list_tree("spaces/" + name)
        shards = [f for f in files if f.endswith(".jsonl")]
        log = git_out(["log", "-1", "--format=%cI%x09%s", "--", "spaces/" + name])
        last_sync, message = "", ""
        if log:
            parts = log.split("\t", 1)
            last_sync = parts[0]
            message = parts[1] if len(parts) > 1 else ""
        device = ""
        if message.startswith("kb-sync: "):
            device = message[len("kb-sync: "):].split(" @ ")[0].strip()
        if not device:
            changed = git_out(["log", "-1", "--name-only", "--format=", "--", "spaces/" + name])
            for line in changed.splitlines():
                base = os.path.basename(line.strip())
                if base.endswith(".jsonl"):
                    device = base[:-6]
                    break
        records = 0
        for shard in shards:
            records += sum(1 for line in show_file("spaces/" + name + "/" + shard).splitlines() if line.strip())
        spaces.append({"space": name, "lastDevice": device, "lastSync": last_sync, "devices": len(shards), "records": records})
    return {"repo": os.path.basename(ARGS.repo), "head": head, "devices": devices, "spaces": spaces}


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
        if url.path == "/":
            body = PANEL_HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == "/api/overview":
            return self._send(200, overview())
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
