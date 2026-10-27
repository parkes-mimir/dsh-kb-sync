#!/usr/bin/env bash
# sync-to-profile.sh —— 把本仓库的文件同步到已安装的插件目录（两处版本必须一致）
#   用法： ./scripts/sync-to-profile.sh [目标目录]
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${1:-$HOME/.dsh/plugins/dsh-kb-sync}"
[ -d "$DST" ] || { echo "目标不存在：$DST" >&2; exit 1; }
for f in index.mjs package.json cordis.patch.yml README.md LICENSE lib/client.js; do
  [ -f "$SRC/$f" ] && install -m 644 "$SRC/$f" "$DST/$f" && echo "synced $f"
done
mkdir -p "$DST/node_modules/@deepseek-ai"
ln -sfn "$HOME/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery" "$DST/node_modules/@deepseek-ai/schemastery"

# 版本一致性校验：仓库 vs 已安装 vs profile 锁
A=$(node -p "require('$SRC/package.json').version")
B=$(node -p "require('$DST/package.json').version")
echo "repo=$A installed=$B"
[ "$A" = "$B" ] || { echo "版本不一致，请先同步后再发布" >&2; exit 2; }

# 语法与 schema 自检
node --check "$DST/index.mjs"
node --input-type=module -e "const m = await import('file://$DST/index.mjs'); m.Config({}); console.log('config ok');"
echo "done. 重启 dsh 后生效：systemctl --user restart dsh-web.service"
