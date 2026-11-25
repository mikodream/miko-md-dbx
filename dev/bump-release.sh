#!/usr/bin/env bash
# 迭代发布一个 DBX 插件：自动递增版本号 → 同步后端身份 → 构建 → 冒烟 → 打包。
#
# 为什么需要它：DBX 按 id + version 记账，已安装版本目录不可变，
# 同一个版本重复安装会被直接跳过（页面看起来"没更新"）。所以每次要真机验证就必须换版本号。
#
#   bump-release.sh                 # 在插件项目根目录跑：patch +1
#   bump-release.sh ~/proj/plugin   # 指定项目目录
#   bump-release.sh --minor         # 0.1.1 -> 0.2.0（也接受 --major / --set 0.3.7）
#   bump-release.sh --target linux-x64
#   bump-release.sh --no-test --no-package
#
# 自动同步的版本落点：
#   manifest.json          version（必需）
#   backend/**/*.go        字符串字面量里的旧版本号（Go Sidecar 通常在 initialize 校验）
#   backend/Cargo.toml     [package] version（Rust Sidecar 用 env!("CARGO_PKG_VERSION")）
# 两处对不上时插件能装上但握手报 IDENTITY_MISMATCH，所以必须一起改。
set -euo pipefail

PROJECT="."
BUMP="patch"
EXPLICIT=""
TARGET="${DBX_PLUGIN_TARGET:-}"
DO_TEST=1
DO_PACKAGE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --patch) BUMP="patch"; shift ;;
    --minor) BUMP="minor"; shift ;;
    --major) BUMP="major"; shift ;;
    --set)   EXPLICIT="${2:?--set 需要版本号}"; shift 2 ;;
    --target) TARGET="${2:?--target 需要三元组}"; shift 2 ;;
    --no-test) DO_TEST=0; shift ;;
    --no-package) DO_PACKAGE=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*)
      echo "未知参数: $1" >&2; exit 2 ;;
    *) PROJECT="$1"; shift ;;
  esac
done

PROJECT="$(cd "$PROJECT" && pwd)"
cd "$PROJECT"
if [[ ! -f manifest.json ]]; then
  echo "不是插件项目（找不到 manifest.json）: $PROJECT" >&2
  exit 2
fi

# ---------------------------------------------------------------- 版本递增
read -r OLD_VERSION NEW_VERSION CHANGED < <(python3 - "$BUMP" "$EXPLICIT" <<'PY'
import json, re, sys, pathlib

bump, explicit = sys.argv[1], sys.argv[2]
path = pathlib.Path("manifest.json")
raw = path.read_text(encoding="utf-8")
data = json.loads(raw)
current = data.get("version", "")
base = current.split("+")[0].split("-")[0]
try:
    major, minor, patch = (int(x) for x in base.split("."))
except ValueError:
    sys.exit(f"manifest.version 不是语义化版本: {current!r}")

if explicit:
    new = explicit
elif bump == "major":
    new = f"{major + 1}.0.0"
elif bump == "minor":
    new = f"{major}.{minor + 1}.0"
else:
    new = f"{major}.{minor}.{patch + 1}"

if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", new):
    sys.exit(f"版本号不合法: {new}")
if new == current:
    sys.exit(f"新版本与旧版本相同（{current}）：DBX 不会覆盖已安装的同一版本")

data["version"] = new
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

changed = []
# Go：把旧版本号的字符串字面量换掉（pluginVersion / Version: "x.y.z" 等）
for go in pathlib.Path("backend").rglob("*.go") if pathlib.Path("backend").is_dir() else []:
    text = go.read_text(encoding="utf-8")
    if f'"{current}"' not in text:
        continue
    go.write_text(text.replace(f'"{current}"', f'"{new}"'), encoding="utf-8")
    changed.append(str(go))

# Rust：Cargo.toml 的 [package] version
cargo = pathlib.Path("backend/Cargo.toml")
if cargo.is_file():
    text = cargo.read_text(encoding="utf-8")
    new_text, n = re.subn(r'(?m)^(version\s*=\s*)"[^"]*"', rf'\1"{new}"', text, count=1)
    if n:
        cargo.write_text(new_text, encoding="utf-8")
        changed.append(str(cargo))

print(current, new, ",".join(changed) if changed else "-")
PY
)

echo "==> 版本 $OLD_VERSION -> $NEW_VERSION"
if [[ "$CHANGED" == "-" ]]; then
  echo "    注意：后端里没找到旧版本号字面量。若 Sidecar 会把版本回报给 Host，"
  echo "    确认它取自 manifest 或 Cargo.toml，否则握手会报 IDENTITY_MISMATCH。"
else
  echo "    已同步后端: $CHANGED"
fi

# ---------------------------------------------------------------- 构建
BACKEND_DIR="backend"
if [[ -d "$BACKEND_DIR" ]]; then
  if [[ -f "$BACKEND_DIR/go.mod" ]]; then
    echo "==> 构建 Go 后端"
    ( cd "$BACKEND_DIR" && gofmt -l . && go vet ./... )
    BIN_NAME="$(grep -o 'binary = "[^"]*"' dbx-plugin.toml 2>/dev/null | head -1 | sed 's/.*"\(.*\)"/\1/')"
    BIN_NAME="${BIN_NAME:-$(basename "$PROJECT")}"
    mkdir -p bin
    ( cd "$BACKEND_DIR" && go build -o "../bin/$BIN_NAME" . )
  elif [[ -f "$BACKEND_DIR/Cargo.toml" ]]; then
    echo "==> 构建 Rust 后端"
    ( cd "$BACKEND_DIR" && cargo build --release )
  fi
fi

# ---------------------------------------------------------------- 冒烟
if [[ $DO_TEST -eq 1 && -f dev/smoke.py ]]; then
  BIN_PATH="$(ls bin/* 2>/dev/null | head -1 || true)"
  if [[ -n "${BIN_PATH:-}" ]]; then
    echo "==> 协议冒烟"
    python3 dev/smoke.py --binary "$BIN_PATH" | tail -3
  fi
fi

# ---------------------------------------------------------------- 打包
if [[ $DO_PACKAGE -eq 0 ]]; then
  echo "==> 跳过打包"
  exit 0
fi

if ! command -v dbx-plugin >/dev/null 2>&1; then
  echo "==> 没装 dbx-plugin，跳过打包：npm install --global @dbx-app/plugin-cli" >&2
  exit 0
fi

PLUGIN_ID="$(python3 -c 'import json;print(json.load(open("manifest.json"))["id"])')"
if [[ -z "$TARGET" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) TARGET="darwin-arm64" ;;
    Darwin-x86_64) TARGET="darwin-x64" ;;
    Linux-x86_64) TARGET="linux-x64" ;;
    Linux-aarch64) TARGET="linux-arm64" ;;
    *) TARGET="universal" ;;
  esac
fi
rm -f "dist/${PLUGIN_ID}-${NEW_VERSION}-${TARGET}.dbxp" "dist/${PLUGIN_ID}-${NEW_VERSION}-${TARGET}.artifact.json"

echo "==> 打包 $TARGET"
dbx-plugin package . --target "$TARGET" | tail -3

echo
echo "包: dist/${PLUGIN_ID}-${NEW_VERSION}-${TARGET}.dbxp   版本 ${NEW_VERSION}"
echo "装进 DBX 会新增一个版本目录，旧版本保留可回滚；只调 UI 时用 dbx-plugin dev 更快，不必装。"
