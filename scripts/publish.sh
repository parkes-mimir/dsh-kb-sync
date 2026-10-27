#!/usr/bin/env bash
# 发布 dsh-kb-sync 到 npm（占住包名）
#   前置：npm login（或 ~/.npmrc 里已有 //registry.npmjs.org/:_authToken）
#   用法：./scripts/publish.sh [--otp 123456]
set -euo pipefail
cd "$(dirname "$0")/.."

WHO=$(npm whoami 2>/dev/null || true)
if [ -z "$WHO" ]; then
  echo "还没登录 npm。先执行： npm login --auth-type=web"
  exit 1
fi
echo "已登录：$WHO"

VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
echo "准备发布 $NAME@$VERSION"

# 本地校验：tarball 内容 + 语法
node --check index.mjs
npm pack --dry-run >/dev/null

npm publish --access public "$@"
echo "--- 校验 ---"
npm view "$NAME" version dist.tarball
