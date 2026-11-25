#!/usr/bin/env bash
# 迭代发布包装：真正的实现在 skill 里，避免两份脚本各说各话。
#   实现在 ../../.agents/skills/dbx-plugin-dev/scripts/bump-release.sh
#   可用 MIKO_DBX_BUMP_SCRIPT 覆盖路径
#
#   ./dev/release.sh                 # patch +1，构建 + 冒烟 + 打包
#   ./dev/release.sh --minor
#   ./dev/release.sh --set 0.2.0
#   ./dev/release.sh --no-test
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_SCRIPT="${MIKO_DBX_BUMP_SCRIPT:-$ROOT/../.agents/skills/dbx-plugin-dev/scripts/bump-release.sh}"

if [[ ! -f "$SKILL_SCRIPT" ]]; then
  cat >&2 <<EOF
找不到 skill 里的发布脚本: $SKILL_SCRIPT

两种补救：
  1. 用环境变量指过去：MIKO_DBX_BUMP_SCRIPT=/path/to/bump-release.sh ./dev/release.sh
  2. 装好 dbx-plugin-dev skill（本仓库会出现在 .agents/skills/dbx-plugin-dev/）
EOF
  exit 2
fi

exec bash "$SKILL_SCRIPT" "$ROOT" "$@"
