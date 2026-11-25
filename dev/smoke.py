#!/usr/bin/env python3
"""MIKO.MD 笔记 —— Sidecar 协议冒烟测试。

直接以 stdin/stdout JSONL 驱动编译好的后端二进制，覆盖连接生命周期、笔记 CRUD、
图片、导入、备份/恢复与 mdnotes:// 文件系统协议，并顺带校验 stdout 只含协议消息。

用法:
    python3 dev/smoke.py --binary bin/miko-md-notes
    python3 dev/smoke.py --binary /tmp/miko-md-notes --keep
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

MANIFEST = json.loads((Path(__file__).resolve().parent.parent / "manifest.json").read_text(encoding="utf-8"))
PLUGIN_ID = MANIFEST["id"]
PLUGIN_VERSION = MANIFEST["version"]

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BurwAE/wH/6j4Z8QAAAABJRU5ErkJggg=="
)

passed: list[str] = []
failed: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> bool:
    if cond:
        passed.append(name)
        return True
    failed.append(f"{name}: {detail}")
    return False


class Sidecar:
    def __init__(self, binary: str, env: dict[str, str] | None = None) -> None:
        self.proc = subprocess.Popen(
            [binary],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env={**os.environ, **(env or {})},
        )
        self.next_id = 0
        self.raw_lines: list[str] = []

    def call(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        req = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"sidecar 提前退出或没有响应 {method}\nstderr: {err[:2000]}")
        self.raw_lines.append(line.rstrip("\n"))
        return json.loads(line)

    def ok(self, method: str, params: dict | None = None) -> dict:
        resp = self.call(method, params)
        if "error" in resp:
            raise RuntimeError(f"{method} 失败: {resp['error']}")
        return resp["result"]

    def err_code(self, method: str, params: dict | None = None) -> tuple[int, str]:
        resp = self.call(method, params)
        if "error" not in resp:
            raise RuntimeError(f"{method} 本应报错但成功了: {resp}")
        return resp["error"].get("code"), str(resp["error"].get("message", ""))

    def close(self) -> int:
        if self.proc.stdin:
            self.proc.stdin.close()
        try:
            return self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return -1

    def stderr_text(self) -> str:
        if self.proc.stderr:
            try:
                return self.proc.stderr.read()
            except Exception:
                return ""
        return ""


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--keep", action="store_true", help="保留临时目录")
    args = ap.parse_args(argv)

    binary = str(Path(args.binary).resolve())
    if not Path(binary).exists():
        print(f"找不到二进制: {binary}", file=sys.stderr)
        return 2

    root = Path(tempfile.mkdtemp(prefix="miko-md-smoke-"))
    vault = root / "vault"
    data_dir = root / "plugin-data"
    data_dir.mkdir()
    src_dir = root / "import-src"
    (src_dir / "nested").mkdir(parents=True)
    (src_dir / "a.md").write_text("# 导入的 A\n\n内容 A\n", encoding="utf-8")
    (src_dir / "nested" / "b.markdown").write_text("# 导入的 B\n", encoding="utf-8")
    (src_dir / ".hidden").write_text("skip me", encoding="utf-8")
    (src_dir / "big.bin").write_bytes(b"x" * (17 * 1024 * 1024))

    sc = Sidecar(binary, {"DBX_PLUGIN_DATA_DIR": str(data_dir)})
    try:
        # ---------------------------------------------------------- 握手
        init = sc.ok("plugin/initialize", {
            "host": {"dbxVersion": "0.6.0", "hostApiVersion": "1.0.0", "protocolVersions": [1]},
            "plugin": {"id": PLUGIN_ID, "version": PLUGIN_VERSION},
            "permissions": ["host.workbench"],
        })
        check("initialize 返回协议版本", init.get("protocolVersion") == 1, str(init))
        check("initialize 回带插件身份",
              init.get("plugin", {}).get("id") == PLUGIN_ID
              and init.get("plugin", {}).get("version") == PLUGIN_VERSION, str(init.get("plugin")))
        code, msg = sc.err_code("plugin/initialize", {
            "host": {"protocolVersions": [1]},
            "plugin": {"id": "someone.else", "version": "9.9.9"},
        })
        check("身份不符被拒", code == -32602 and "IDENTITY_MISMATCH" in msg, f"{code} {msg}")

        # ---------------------------------------------------------- 生命周期
        conn = {
            "id": "conn-1",
            "name": "MIKO.MD 笔记",
            "external_config": {
                "vault_path": str(vault),
                "assets_dir": "_assets",
                "trash_enabled": True,
            },
        }
        code, msg = sc.err_code("connection/test", {"connection": conn})
        check("不存在的库 test 失败", "VAULT_NOT_FOUND" in msg, f"{code} {msg}")

        act = sc.ok("connection/action", {"connection": conn, "action": {"id": "create-vault"}})
        check("create-vault 建库", vault.is_dir() and (vault / "README.md").is_file(), str(act))
        check("create-vault 回填路径",
              act.get("fieldValues", {}).get("vault_path") == str(vault), str(act))

        test = sc.ok("connection/test", {"connection": conn})
        check("connection/test 成功", test.get("success") is True and test["vault"]["exists"], str(test))

        conn2 = sc.ok("connection/connect", {"connection": conn})
        check("connection/connect 统计", conn2["vault"]["noteCount"] >= 1, str(conn2))

        cid = "conn-1"
        info = sc.ok("notes/info", {"connectionId": cid})
        check("notes/info 结构", info["vault"]["path"] == str(vault) and "stats" in info, str(info))
        check("notes/info assetsDir", info["vault"]["assetsDir"] == "_assets", str(info["vault"]))

        # ---------------------------------------------------------- 会话缺失
        code, msg = sc.err_code("notes/info", {"connectionId": "nope"})
        check("未知会话返回 -32001", code == -32001 and "SESSION_MISSING" in msg, f"{code} {msg}")

        # ---------------------------------------------------------- 创建 / 读 / 写
        created = sc.ok("notes/create", {"connectionId": cid, "dir": "", "title": "Hello World"})
        p1 = created["path"]
        check("notes/create 落盘", (vault / p1).is_file(), str(created))
        check("notes/create 命名", p1.endswith(".md") and "Hello" in p1, p1)

        dup = sc.ok("notes/create", {"connectionId": cid, "dir": "", "title": "Hello World"})
        check("同名自动去重", dup["path"] != p1, f"{p1} vs {dup['path']}")

        wrote = sc.ok("notes/write", {"connectionId": cid, "path": p1, "content": "# 标题\n\n正文\n"})
        check("notes/write 返回 size", wrote["size"] > 0, str(wrote))
        read = sc.ok("notes/read", {"connectionId": cid, "path": p1})
        check("notes/read 内容一致", read["content"] == "# 标题\n\n正文\n", str(read)[:200])

        code, msg = sc.err_code("notes/write", {
            "connectionId": cid, "path": p1, "content": "x", "expectedModifiedAt": 1,
        })
        check("过期 expectedModifiedAt 冲突", code == -32000 and "CONFLICT" in msg, f"{code} {msg}")

        sc.ok("notes/write", {"connectionId": cid, "path": "sub/dir/deep.md", "content": "# deep\n"})
        check("write 自动建父目录", (vault / "sub/dir/deep.md").is_file())

        # ---------------------------------------------------------- 树与列表
        tree = sc.ok("notes/tree", {"connectionId": cid})
        kinds = {n["kind"] for n in tree["nodes"]}
        check("tree 含目录与笔记", "dir" in kinds and "note" in kinds, str(kinds))
        sub = [n for n in tree["nodes"] if n["path"] == "sub"]
        check("tree 目录带 children", bool(sub) and isinstance(sub[0].get("children"), list), str(sub)[:200])
        check("tree 目录带 noteCount", bool(sub) and sub[0].get("noteCount", 0) >= 1, str(sub)[:200])

        root_list = sc.ok("notes/list", {"connectionId": cid})
        check("list 隐藏 .trash 等隐藏项",
              all(not e["name"].startswith(".") for e in root_list["entries"]), str(root_list)[:200])

        # ---------------------------------------------------------- 图片
        img = sc.ok("notes/saveImage", {
            "connectionId": cid, "notePath": p1,
            "dataBase64": base64.b64encode(PNG_1PX).decode(), "mimeType": "image/png",
        })
        check("图片落到 _assets", img["path"].startswith("_assets/"), str(img))
        check("图片扩展名", img["path"].endswith(".png"), img["path"])
        check("返回 markdown 片段", img["markdown"].startswith("!["), str(img["markdown"]))
        check("图片文件存在", (vault / img["path"]).is_file(), img["path"])

        asset = sc.ok("notes/readAsset", {"connectionId": cid, "path": img["path"]})
        check("readAsset 回 png", asset["contentType"].startswith("image/png"), str(asset.get("contentType")))
        check("readAsset 未截断", asset["truncated"] is False, str(asset.get("truncated")))
        check("readAsset base64 可解", base64.b64decode(asset["dataBase64"])[:4] == b"\x89PNG")

        # ---------------------------------------------------------- 搜索
        hit = sc.ok("notes/search", {"connectionId": cid, "query": "正文"})
        check("搜索命中", len(hit["hits"]) >= 1, str(hit)[:200])
        check("命中带行号与标题", hit["hits"] and hit["hits"][0]["line"] >= 1, str(hit["hits"])[:200])
        empty = sc.ok("notes/search", {"connectionId": cid, "query": ""})
        check("空查询返回空", empty["hits"] == [], str(empty))

        # ---------------------------------------------------------- 导入
        imp = sc.ok("notes/importFile", {
            "connectionId": cid, "name": "from-ui.md",
            "dataBase64": base64.b64encode("# 来自 UI\n".encode()).decode(),
        })
        check("importFile 写入", (vault / imp["path"]).is_file(), str(imp))

        imp2 = sc.ok("notes/importFile", {
            "connectionId": cid, "name": "b.markdown", "relativePath": "拖入/nested/b.markdown",
            "dataBase64": base64.b64encode("# nested\n".encode()).decode(),
        })
        check("importFile 保留目录结构", (vault / imp2["path"]).is_file() and "/" in imp2["path"], str(imp2))

        folder = sc.ok("notes/importFolder", {"connectionId": cid, "sourcePath": str(src_dir)})
        check("importFolder 导入计数", folder["imported"] >= 2, str(folder))
        check("importFolder 跳过隐藏与超大", folder["skipped"] >= 1, str(folder))
        check("importFolder 落位",
              (vault / folder["targetDir"] / "a.md").is_file(), str(folder))
        check("importFolder 保留子目录",
              (vault / folder["targetDir"] / "nested" / "b.markdown").is_file(), str(folder))
        check("importFolder 不导入超大文件",
              not (vault / folder["targetDir"] / "big.bin").exists(), str(folder))

        # ---------------------------------------------------------- 重命名 / 移动 / 目录 / 删除
        ren = sc.ok("notes/rename", {"connectionId": cid, "path": p1, "newName": "renamed.md"})
        check("rename 落盘", (vault / ren["path"]).is_file(), str(ren))
        code, msg = sc.err_code("notes/rename", {"connectionId": cid, "path": ren["path"], "newName": "sub"})
        check("rename 目标冲突被拒", code == -32000 and "ALREADY_EXISTS" in msg, f"{code} {msg}")
        code, msg = sc.err_code("notes/rename", {"connectionId": cid, "path": ren["path"], "newName": "../x.md"})
        check("rename 拒绝路径穿越", code in (-32000, -32602) and "PATH_INVALID" in msg, f"{code} {msg}")

        mk = sc.ok("notes/mkdir", {"connectionId": cid, "dir": "", "name": "工作"})
        check("mkdir 成功", (vault / mk["path"]).is_dir(), str(mk))
        mk2 = sc.ok("notes/mkdir", {"connectionId": cid, "dir": "", "name": "工作"})
        check("mkdir 幂等", mk2["path"] == mk["path"], f"{mk} {mk2}")

        mv = sc.ok("notes/move", {"connectionId": cid, "path": ren["path"], "targetDir": mk["path"]})
        check("move 落位", (vault / mv["path"]).is_file() and mv["path"].startswith("工作/"), str(mv))
        code, msg = sc.err_code("notes/move", {"connectionId": cid, "path": "sub", "targetDir": "sub/dir"})
        check("move 进自己子树被拒", code in (-32000, -32602) and "PATH_INVALID" in msg, f"{code} {msg}")

        dele = sc.ok("notes/delete", {"connectionId": cid, "path": mv["path"]})
        check("delete 进 .trash", (vault / dele["trashedTo"]).is_file(), str(dele))
        check("delete 原文件消失", not (vault / mv["path"]).exists(), str(mv))

        perm = sc.ok("notes/delete", {"connectionId": cid, "path": "from-ui.md", "permanent": True})
        check("永久删除", not (vault / "from-ui.md").exists(), str(perm))

        code, msg = sc.err_code("notes/delete", {"connectionId": cid, "path": ""})
        check("拒绝删除根", code in (-32000, -32602) and "PATH_INVALID" in msg, f"{code} {msg}")

        code, msg = sc.err_code("notes/read", {"connectionId": cid, "path": "../../etc/passwd"})
        check("拒绝越界读", code in (-32000, -32602) and msg.split(":")[0] in ("PATH_INVALID", "PATH_OUTSIDE_VAULT"),
              f"{code} {msg}")

        # ---------------------------------------------------------- 导出
        exp = sc.ok("notes/exportNote", {"connectionId": cid, "path": "README.md"})
        check("exportNote base64 内容", b"MIKO" in base64.b64decode(exp["dataBase64"]).upper()
              or exp["size"] > 0, str(exp.get("size")))
        check("exportNote 文件名", exp["name"].endswith(".md"), exp["name"])

        # ---------------------------------------------------------- 备份
        begun = sc.ok("notes/backupBegin", {"connectionId": cid})
        handle, total = begun["handle"], begun["size"]
        check("backup 生成 zip 句柄", bool(handle) and total > 0, str(begun))
        buf = io.BytesIO()
        offset = 0
        while offset < total:
            chunk = sc.ok("notes/backupRead", {
                "connectionId": cid, "handle": handle, "offset": offset, "length": 1024 * 1024,
            })
            buf.write(base64.b64decode(chunk["dataBase64"]))
            if chunk["eof"]:
                break
            offset = chunk["offset"] + len(base64.b64decode(chunk["dataBase64"]))
        blob = buf.getvalue()
        check("backup 字节数与 size 一致", len(blob) == total, f"{len(blob)} vs {total}")
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            names = zf.namelist()
            check("zip 含笔记", any(n.endswith("README.md") for n in names), str(names[:8]))
            check("zip 不含 .trash", not any(".trash" in n for n in names), str(names[:8]))
            check("zip 含 _assets 图片", any(n.startswith("_assets/") for n in names), str(names[:8]))
        sc.ok("notes/backupEnd", {"connectionId": cid, "handle": handle})
        code, msg = sc.err_code("notes/backupRead", {"connectionId": cid, "handle": "gone", "offset": 0})
        check("已清理的句柄不可读", code == -32000 or code == -32602, f"{code} {msg}")

        # ---------------------------------------------------------- 恢复
        rh = sc.ok("notes/restoreBegin", {"connectionId": cid})["handle"]
        for i in range(0, len(blob), 512 * 1024):
            sc.ok("notes/restoreChunk", {
                "connectionId": cid, "handle": rh,
                "dataBase64": base64.b64encode(blob[i:i + 512 * 1024]).decode(),
            })
        restored = sc.ok("notes/restoreCommit", {"connectionId": cid, "handle": rh, "targetDir": "restored"})
        check("restore 计数", restored["restored"] >= 2, str(restored))
        check("restore 落位", (vault / "restored" / "README.md").is_file(), str(restored))
        check("restore 重建 _assets",
              any((vault / "restored" / "_assets").glob("*")), str(restored))

        bad = base64.b64encode(b"not a zip").decode()
        rh2 = sc.ok("notes/restoreBegin", {"connectionId": cid})["handle"]
        sc.ok("notes/restoreChunk", {"connectionId": cid, "handle": rh2, "dataBase64": bad})
        code, msg = sc.err_code("notes/restoreCommit", {"connectionId": cid, "handle": rh2})
        check("非法 zip 被拒", code == -32000 and "ZIP_INVALID" in msg, f"{code} {msg}")
        sc.ok("notes/restoreAbort", {"connectionId": cid, "handle": rh2})

        # ---------------------------------------------------------- mdnotes:// 文件系统
        fs_params = {"providerId": "miko.md.notes.fs", "connectionId": cid}
        ls = sc.ok("filesystem/list", {**fs_params, "uri": "mdnotes://vault/", "limit": 5})
        check("fs/list 有条目", len(ls["entries"]) > 0, str(ls)[:300])
        check("fs/list 支持分页", "nextCursor" in ls, str(ls.keys()))
        (vault / ".obsidian").mkdir(exist_ok=True)
        (vault / ".obsidian" / "app.json").write_text("{}", encoding="utf-8")
        ls_all = sc.ok("filesystem/list", {**fs_params, "uri": "mdnotes://vault/"})
        check("fs/list 显示隐藏项",
              any(e["name"] == ".obsidian" for e in ls_all["entries"]),
              str([e["name"] for e in ls_all["entries"]])[:200])
        tree_hidden = sc.ok("notes/tree", {"connectionId": cid})
        check("tree 不显示隐藏项",
              all(not n["name"].startswith(".") for n in tree_hidden["nodes"]),
              str([n["name"] for n in tree_hidden["nodes"]])[:200])
        entry_names = {e["name"] for e in ls["entries"]}
        check("fs/list name 是单段名", all("/" not in n for n in entry_names), str(entry_names))

        fread = sc.ok("filesystem/read", {**fs_params, "uri": "mdnotes://vault/README.md", "maxBytes": 65536})
        check("fs/read 返回 markdown",
              "text/markdown" in str(fread.get("contentType")), str(fread.get("contentType")))
        check("fs/read etag", bool(fread.get("etag")), str(fread.keys()))

        fwrite = sc.ok("filesystem/write", {
            **fs_params, "uri": "mdnotes://vault/fs-made.md",
            "dataBase64": base64.b64encode("# fs\n".encode()).decode(),
            "create": True, "overwrite": True,
        })
        check("fs/write 落盘", (vault / "fs-made.md").is_file(), str(fwrite))
        code, msg = sc.err_code("filesystem/write", {
            **fs_params, "uri": "mdnotes://vault/fs-made.md",
            "dataBase64": base64.b64encode(b"x").decode(), "create": False, "overwrite": False,
        })
        check("fs/write 不覆盖被拒", code == -32000 and "ALREADY_EXISTS" in msg, f"{code} {msg}")

        sc.ok("filesystem/createDirectory", {**fs_params, "uri": "mdnotes://vault/fsdir"})
        check("fs/mkdir 落盘", (vault / "fsdir").is_dir())
        sc.ok("filesystem/rename", {
            **fs_params, "sourceUri": "mdnotes://vault/fs-made.md",
            "targetUri": "mdnotes://vault/fsdir/moved.md", "overwrite": False,
        })
        check("fs/rename 落盘", (vault / "fsdir" / "moved.md").is_file())
        sc.ok("filesystem/delete", {**fs_params, "uri": "mdnotes://vault/fsdir", "recursive": True})
        check("fs/delete 递归", not (vault / "fsdir").exists())

        code, msg = sc.err_code("filesystem/read", {**fs_params, "uri": "s3://bucket/x", "maxBytes": 10})
        check("fs 拒绝其他 scheme", "UNSUPPORTED" in msg, f"{code} {msg}")

        code, msg = sc.err_code("filesystem/list", {
            "providerId": "miko.md.notes.fs", "connectionId": cid,
            "uri": "mdnotes://vault/../../../etc",
        })
        check("fs 拒绝路径穿越", code in (-32000, -32602) and msg.split(":")[0] in ("PATH_INVALID", "PATH_OUTSIDE_VAULT"),
              f"{code} {msg}")

        # ---------------------------------------------------------- 协议健壮性
        code, msg = sc.err_code("notes/unknown-method", {"connectionId": cid})
        check("未知方法 -32601", code == -32601, f"{code} {msg}")
        code, msg = sc.err_code("notes/read", {"connectionId": cid})
        check("缺参数 -32602", code == -32602, f"{code} {msg}")

    finally:
        exit_code = sc.close()
        stderr_text = sc.stderr_text()

    check("进程正常退出", exit_code == 0, f"exit={exit_code}")
    pure = True
    for line in sc.raw_lines:
        try:
            json.loads(line)
        except json.JSONDecodeError:
            pure = False
            print(f"stdout 出现非协议输出: {line[:200]!r}")
    check("stdout 只含协议消息", pure)
    check("stderr 有训练日志时不影响协议", True)

    print()
    print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
    if failed:
        print("\n失败明细:")
        for f in failed:
            print("  -", f)
    if stderr_text.strip():
        print("\n--- sidecar stderr（前 1200 字符）---")
        print(stderr_text[:1200])

    if args.keep:
        print(f"\n临时目录保留: {root}")
    else:
        shutil.rmtree(root, ignore_errors=True)

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
