#!/usr/bin/env bash
# 迭代发布：升版本号 → 同步后端身份 → 构建 → 冒烟 → 打包。
# 实现在本仓库 dev/bump-release.sh，不依赖任何外部目录。
#
#   ./dev/release.sh                 # patch +1，例如 0.1.0 -> 0.1.1
#   ./dev/release.sh --minor
#   ./dev/release.sh --major
#   ./dev/release.sh --set 0.2.0
#   ./dev/release.sh --target linux-x64 --no-test
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/dev/bump-release.sh" "$ROOT" "$@"
