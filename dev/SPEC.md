# MIKO.MD 笔记 —— 实现契约（后端与 UI 共同遵守）

插件 id `miko.md.notes`，版本 `0.1.0`。两个实现方（Go Sidecar / 沙箱 UI）只通过本文件定义的 JSON-RPC 交互。
任何一方需要偏离，先改本文件再改代码。

## 0. 平台事实（不要推翻）

- Sidecar 走 `stdio-jsonl`：一行一条 JSON-RPC 2.0 消息，单条 ≤8 MiB。**stdout 只允许协议消息**，日志一律 stderr。
- 插件 UI 在 sandbox iframe 里：无网络、无 `localStorage`、无 `navigator.clipboard`、无 `alert/confirm/prompt`。
- UI 只能通过这些对象跨边界：`dbxPlugin.invoke/notify/ready/context/onContext/locale/theme/storage/setTitle/getTitle/openFilesystem/fileTransfer/copy/readAssetUrl/capabilities`。
- 不做构建步骤：`ui/index.html` + `ui/app.js` + `ui/markdown.js` + `ui/style.css` 直接就是产物，无 npm、无打包、无 CDN、无外部字体。

## 1. 消息形态

请求：`{"jsonrpc":"2.0","id":<number>,"method":"<m>","params":{...}}`
成功：`{"jsonrpc":"2.0","id":<number>,"result":{...}}`
失败：`{"jsonrpc":"2.0","id":<number>,"error":{"code":<int>,"message":"<CODE>: 说明"}}`

错误码约定：

| code | 用途 |
| --- | --- |
| -32601 | 未知方法 |
| -32602 | 参数非法 / 缺字段 |
| -32000 | 运行时错误（文件系统、zip、冲突、越界访问） |
| -32001 | 找不到会话（连接未打开） |

参数**形态**错误（含 `PATH_INVALID`、`PATH_OUTSIDE_VAULT` 这类越界/非法路径）回 `-32602`；真正的运行期失败（文件不存在、冲突、zip 损坏、IO）回 `-32000`。**UI 一律按 message 前缀判读，不依赖 code 数值**（两种 code 都可能出现）。

`message` 必须以稳定前缀开头，UI 用它做本地化：`VAULT_NOT_FOUND`、`VAULT_NOT_DIR`、`PATH_INVALID`、`PATH_OUTSIDE_VAULT`、`NOT_FOUND`、`ALREADY_EXISTS`、`CONFLICT`、`NOT_A_NOTE`、`NOT_A_DIR`、`IO_ERROR`、`ZIP_INVALID`、`SESSION_MISSING`、`HANDLE_MISSING`、`PAYLOAD_TOO_LARGE`、`UNSUPPORTED`。
格式：`"NOT_FOUND: 笔记不存在: a/b.md"`。

## 2. 路径与数据约定

- **笔记库内路径**（下文叫 `path`/`dir`）：一律 `/` 分隔、相对笔记库根、不以 `/` 开头、不含 `..`、不含反斜杠、不含 NUL。空字符串表示根目录。
- 任何解析后的绝对路径必须落在笔记库根之内（含符号链接解析后的结果），否则 `PATH_OUTSIDE_VAULT`。
- 笔记 = 扩展名 `.md` 或 `.markdown`（大小写不敏感）。**其他文件照常列出但标记为非笔记**（`kind: "file"`），可在文件系统视图里读写，编辑器只处理笔记。
- 隐藏项：以 `.` 开头的目录与文件（`.trash`、`.obsidian`、`.git` 等）默认**不**出现在 `notes/tree`、`notes/list`、`notes/search` 中；文件系统视图里正常出现。
- `modifiedAt` 用**epoch 毫秒**（number）。`size` 用字节（number）。
- 时间字符串不参与传输，UI 自己格式化。

## 3. 连接生命周期（Host → Sidecar）

连接表单里声明了三个 `config` 字段（DBX 存进 `external_config`）：`vault_path`、`assets_dir`（默认 `_assets`）、`trash_enabled`（默认 `true`）。

读取配置的兜底顺序（后端实现要求）：`params.connection.external_config[key]` → `params.connection[key]` → 默认值。
`vault_path` 支持 `~` 前缀展开与绝对路径；相对路径按 Sidecar 进程当前工作目录解析。

### 3.1 `connection/test`

params: `{ provider, connection, runtime }`（`connection.id` 可能不存在）
result: `{ success: true, message: "<可直接展示的说明>", vault: { path, exists, noteCount } }`
校验：目录存在且是目录（不存在 → `VAULT_NOT_FOUND`；是文件 → `VAULT_NOT_DIR`）、可读、可写（用临时文件探测后删除）。
不创建目录。

### 3.2 `connection/connect`

params: 同上
result: `{ success: true, vault: { path, name, noteCount, folderCount } }`
建立会话：`sessions[connection.id] = vault`。重复 connect 幂等（覆盖同一 key）。

### 3.3 `connection/disconnect`

params: `{ provider, connection, runtime }`
result: `{ success: true }`；删除会话，幂等。

### 3.4 `connection/action`

params: `{ provider, connection, runtime, action: { id } }`
**只支持** `id == "create-vault"`：按 `vault_path` 递归创建目录（含父级），写入一篇 `README.md`（仅当不存在时），result `{ success: true, message, fieldValues: { vault_path: "<解析后的绝对路径>" } }`。
其他 id → `UNSUPPORTED`。

## 4. 笔记 API（UI → Sidecar）

除特别说明，`params.connectionId` 必需（字符串，来自 `dbxPlugin.context.connectionId`）。会话不存在 → `-32001 SESSION_MISSING: 连接未打开`。

### 4.1 `notes/info`

params: `{ connectionId }`
result:

```json
{
  "vault": { "path": "/abs/path", "name": "notes", "assetsDir": "_assets", "trashEnabled": true,
             "uriRoot": "mdnotes://vault/" },
  "stats": { "notes": 12, "folders": 3, "bytes": 48213, "images": 4 },
  "plugin": { "id": "miko.md.notes", "version": "0.1.0" }
}
```

`stats` 递归统计（跳过隐藏项）。`images` 统计 `assetsDir` 与笔记同目录图片（`.png .jpg .jpeg .gif .webp .svg .bmp .avif`）。

### 4.2 `notes/tree`

params: `{ connectionId, dir?: "", depth?: 6 }`
result: `{ nodes: [Node] }`

```json
Node = {
  "name": "子目录名或文件名",
  "path": "相对/路径.md",
  "kind": "dir" | "note" | "file",
  "size": 1234,                  // file/note
  "modifiedAt": 1764150000000,   // file/note
  "noteCount": 5,                // dir：该子树中的笔记数
  "children": [Node]             // dir：展开；超过 depth 时省略并置 "truncated": true
}
```

排序：目录在前、笔记其次、其他文件最后；同类按 `name` 不区分大小写升序。隐藏项不返回。
单层最多返回 2000 个节点（超出截断并置 `"truncated": true`）。

### 4.3 `notes/list`

params: `{ connectionId, dir?: "" }`
result: `{ entries: [ { name, path, kind, size, modifiedAt } ] }`（规则同 4.2 的排序与隐藏项）

### 4.4 `notes/read`

params: `{ connectionId, path }`
result: `{ path, name, content, size, modifiedAt }`
`content` 必须是 UTF-8 文本；非法 UTF-8 字节用 U+FFFD 替换而不报错。>4 MiB 的笔记 → `PAYLOAD_TOO_LARGE`。

### 4.5 `notes/write`

params: `{ connectionId, path, content, expectedModifiedAt?: number }`
result: `{ path, size, modifiedAt, created: boolean }`
- 父目录不存在时自动创建。
- 原子写：写 `<name>.tmp-<rand>` 后 `rename` 覆盖；保留原文件权限位。
- 传了 `expectedModifiedAt` 且与磁盘当前 `modifiedAt` 不一致 → `-32000 CONFLICT: 文件已被外部修改`，不写入。

### 4.6 `notes/create`

params: `{ connectionId, dir?: "", title?: "未命名笔记" }`
result: `{ path, name, content, modifiedAt }`
在 `dir` 下创建空的 `.md`。文件名 = 去除 `/ \ : * ? " < > |` 与控制字符后的标题，去空白；空标题用 `Untitled`。
重名时追加 ` 2`、` 3`…（在扩展名之前）。父目录自动创建。

### 4.7 `notes/rename`

params: `{ connectionId, path, newName }`
result: `{ path, name }`
`newName` 是**单段名称**（`/`、`\`、`..` → `PATH_INVALID`）。目标已存在 → `ALREADY_EXISTS`。
允许改扩展名（`.md` ↔ `.markdown`），但改名后不是笔记也不报错。

### 4.8 `notes/move`

params: `{ connectionId, path, targetDir }`
result: `{ path }`；`targetDir` 为空串表示根。目标内已有同名 → `ALREADY_EXISTS`。
禁止把目录移进自己的子树 → `PATH_INVALID`。

### 4.9 `notes/mkdir`

params: `{ connectionId, dir, name }`
result: `{ path }`；已存在且是目录 → 直接返回成功（幂等）。

### 4.10 `notes/delete`

params: `{ connectionId, path, permanent?: false }`
result: `{ path, trashedTo?: "相对路径" }`
- `trash_enabled`（连接配置）为真且 `permanent != true`：移动到 `<vault>/.trash/<yyyymmdd-HHMMSS>-<name>`，返回 `trashedTo`。
- 否则永久删除（目录递归）。
- 根目录（空 path）→ `PATH_INVALID`。

### 4.11 `notes/search`

params: `{ connectionId, query, limit?: 50 }`
result: `{ hits: [ { path, name, title, line, text, snippet } ] }`

- 大小写不敏感的子串匹配；扫 `.md`/`.markdown`，跳过隐藏项与 `.trash`。
- 每篇最多贡献 3 条命中；`line` 为 1 起的行号；`text` 为该行裁剪到 ≤200 字符；`snippet` 为命中前后各 40 字符。
- `title` 取首个 `# ` 标题，没有则用文件名（去扩展名）。
- 结果总数上限 `min(limit, 200)`；`query` 空 → 返回空数组。

### 4.12 `notes/saveImage`

params: `{ connectionId, notePath?: "", name?: "", dataBase64, mimeType?: "" }`
result: `{ path, name, markdown, bytes }`

- 落盘到 `<vault>/<assetsDir>/`；`assetsDir` 为空则用笔记所在目录（`notePath` 的目录），再不行用根。
- 文件名：给 `name` 就用（清洗），否则 `<yyyymmdd-HHMMSS>-<8 位随机>`；扩展名按 `mimeType` 或嗅探字节（PNG/JPEG/GIF/WebP/AVIF/BMP/SVG），未知则 `.bin`。
- 重名追加 `-2`、`-3`…
- `markdown` = 从 `notePath` 所在目录指向该图片的相对路径（`/` 分隔），形式 `![name](rel)`，路径含空格时用 `<...>` 包裹。
- 单图 ≤8 MiB（解码后）→ 超限 `PAYLOAD_TOO_LARGE`。

### 4.13 `notes/importFile`

params: `{ connectionId, name, relativePath?: "", targetDir?: "", dataBase64, overwrite?: false }`
result: `{ path }`

- 目标路径 = `targetDir` + (`relativePath` 若非空，否则 `name`)。`relativePath` 来自拖入文件夹展开，可能含 `/`。
- 已存在且 `overwrite != true` → 追加 ` 2`、` 3`… 而不是报错（导入是批量操作，不要中断）。
- 父目录自动创建。

### 4.14 `notes/importFolder`

params: `{ connectionId, sourcePath, targetDir?: "" }`
result: `{ targetDir, imported, skipped, bytes }`

- `sourcePath` 可以是绝对路径（通常在笔记库外），也可以是笔记库内相对路径。
- 递归复制 `.md`/`.markdown` 与常见图片；**跳过**隐藏项、`node_modules`、`.git`、`.trash`、`dist`、以及 >16 MiB 的单个文件（计入 `skipped`）。
- 目标 = `targetDir` + 源目录名；同名文件不覆盖，追加 ` 2`…（计入 `imported`）。
- 目录不存在 → `PATH_INVALID`。

### 4.15 `notes/readAsset`

params: `{ connectionId, path, maxBytes?: 4194304 }`
result: `{ path, contentType, dataBase64, truncated, size }`
用于预览里的图片。超过 `maxBytes` 时返回前 `maxBytes` 字节并 `truncated: true`。
非图片扩展名也允许（`contentType` 按扩展名猜，猜不到 `application/octet-stream`）。

### 4.16 `notes/exportNote`

params: `{ connectionId, path }`
result: `{ name, contentType: "text/markdown; charset=utf-8", dataBase64, size }`（>8 MiB → `PAYLOAD_TOO_LARGE`）

## 5. 备份与恢复（zip，流式分块）

备份产物是一个 zip，解压后回到笔记库结构（含 `_assets`）。**备份文件本身写进 Sidecar 的数据目录**（`DBX_PLUGIN_DATA_DIR`，未设置时用 `os.TempDir()`），不污染笔记库。

### 5.1 `notes/backupBegin`

params: `{ connectionId, includeTrash?: false }`
result: `{ handle, name, size, entries }`
`name` = `<vaultName>-backup-<yyyymmdd-HHMMSS>.zip`。跳过隐藏项（`.trash` 仅当 `includeTrash`）；跳过 >64 MiB 的单文件（计入日志，不中断）。

### 5.2 `notes/backupRead`

params: `{ connectionId, handle, offset, length?=1048576 }`
result: `{ dataBase64, offset, eof }`
`length` 夹在 1..4 MiB。offset 越界 → `PATH_INVALID`。

### 5.3 `notes/backupEnd`

params: `{ connectionId, handle }`
result: `{ success: true }`；删除临时 zip。handle 不存在 → `HANDLE_MISSING`。

### 5.4 `notes/restoreBegin`

params: `{ connectionId }`
result: `{ handle }`

### 5.5 `notes/restoreChunk`

params: `{ connectionId, handle, dataBase64 }`
result: `{ received }`（累计字节数）。累计 >256 MiB → `PAYLOAD_TOO_LARGE`。

### 5.6 `notes/restoreCommit`

params: `{ connectionId, handle, targetDir?: "", overwrite?: false }`
result: `{ restored, skipped, targetDir }`
校验 zip（不是 zip → `ZIP_INVALID`）；拒绝包含 `..`、绝对路径、符号链接的条目（跳过并计入 `skipped`）。
同名：`overwrite` 为真则覆盖，否则跳过。恢复完删除临时文件。**不要**恢复 `.trash`。

### 5.7 `notes/restoreAbort`

params: `{ connectionId, handle }`
result: `{ success: true }`

## 6. 文件系统协议（Host → Sidecar，`mdnotes://`）

URI：`mdnotes://vault/<相对路径>`；根是 `mdnotes://vault/`（也接受 `mdnotes://vault` 与 `mdnotes:///<相对路径>`）。
Host 可能不传 `connectionId`：此时若只存在一个会话就用它，否则 `SESSION_MISSING`。

| 方法 | params | result |
| --- | --- | --- |
| `filesystem/list` | `providerId`、`connectionId?`、`uri`、`cursor?`、`limit?` | `{ entries: [ { name, uri, kind, size?, modifiedAt?, contentType? } ], nextCursor? }` |
| `filesystem/read` | 同身份字段、`uri`、`maxBytes` | `{ dataBase64, contentType?, truncated, etag? }` |
| `filesystem/write` | `uri`、`dataBase64`、`create`、`overwrite`、`etag?` | `{ success, message?, entry? }` |
| `filesystem/createDirectory` | `uri` | `{ success, message?, entry? }` |
| `filesystem/delete` | `uri`、`recursive` | `{ success, message? }` |
| `filesystem/rename` | `sourceUri`、`targetUri`、`overwrite` | `{ success, message?, entry? }` |

- `kind` ∈ `file` / `directory` / `symlink` / `other`；`name` 是单段名，不含 `/`、`\`、`.`、`..`。
- 隐藏项**要**出现在这一层（用户就是在看真实目录）。
- 分页：`limit` 默认 200、上限 500；`nextCursor` 为不透明字符串（比如已返回条数的十进制），最后一页省略。
- `etag` 用 `size + "-" + modifiedAt`；`write` 传了 `etag` 且不匹配 → `CONFLICT`。
- `write` 时 `create == false` 且文件不存在 → `NOT_FOUND`；`overwrite == false` 且已存在 → `ALREADY_EXISTS`。
- 内联读写上限 4 MiB（超出 `PAYLOAD_TOO_LARGE`）。
- `contentType` 按扩展名猜：`.md`/`.markdown` → `text/markdown; charset=utf-8`，图片按类型，其余 `application/octet-stream` 或 `text/plain; charset=utf-8`（文本类扩展名）。

## 7. UI 行为要求

### 7.1 外壳

- 纵向结构：`.shell` 用 **flex column**（topbar / banner / workspace / statusbar），workspace 吃掉剩余高度（`flex: 1 1 auto; min-height: 0`），statusbar `flex: 0 0 auto` 且固定 26px。**不要改回按位置分配行的 `grid-template-rows`**：`#banner` 是 `hidden`（`display:none`）时不占行，grid 会把 workspace 挤进 `auto` 行、statusbar 挤进 `1fr` 行，表现为底栏被撑高或挤出视口。
- **两栏**：左「目录树」+ 右「编辑器/预览」。**没有二级笔记列表**——全部导航靠树形展开；点文件夹是展开/收起并把它作为新建笔记的落点，点笔记直接打开。窄屏（<900px）折叠成单栏 + 返回按钮（`data-pane` 只有 `tree` / `editor`）。
- 「新建笔记」「新建文件夹」固定在**目录树面板上方**（`.pane-tree > .tree-tools`），不占顶栏。
- 顶栏：笔记库名、统计、搜索框、按钮组（导入 .md / 导入文件夹 / 备份 / 恢复 / 在文件浏览器中打开 / 刷新）。
- 搜索结果占用目录树的位置（含「搜索结果 · N」与「清除」），不再另开一栏。
- **目录树的图标契约**：目录行用 14px 线描 chevron（`svg.twisty`，展开态加 `.is-open` 旋转 90°，`transition 120ms`），文件行放同宽空 `span.twisty` 占位以对齐标签；行内再放 13px 线描文件夹/笔记图标（`svg.ico`，`stroke: currentColor`）。不要用 `▸ / ▾` 文字符号——字重、基线和不同平台的字体回退都不一致。
- **拖拽移动用 pointer 事件自绘，不要用 HTML5 DnD**：沙箱 iframe（Tauri/WKWebView）里 `dataTransfer` 经常收不到 `dragover`/`drop`，表现为"能拖但放不下、也没有反馈"。做法：`#tree` 上 `pointerdown` 记录起点与行，`window` 上 `pointermove` 超过 4px 阈值才算拖拽（`S.drag` + `.is-dragging` + 跟随指针的 `.drag-ghost` 胶囊），用 `document.elementFromPoint` + `closest(".tree-row")` 反查目标行；`pointerup` 落点、`pointercancel`/`Esc`/`window.blur` 取消。拖完 350ms 内抑制 click，避免顺手把笔记打开。系统文件拖入仍走 `fileTransfer.onDrop` 或 `dataTransfer.files`，两套互不干扰。
- **三档落点**（按指针在目标行内的垂直位置）：上 1/3 = 放到该行上方（同级）、下 1/3 = 放到该行下方（同级）、中间 1/3 = 放进该文件夹（下级）；指针不在任何行上 = 根目录。同级落点的目录是**目标行的父目录**，下级落点是**目标目录本身**。
- **视觉反馈**：悬停行加 `.is-drop-hover`（主色 14% 背景）；插入条是行内 `::after` 的 2px 主色条——同级 `.is-drop-sibling` + `.is-drop-before`/`.is-drop-after`（条占满整行，贴在行的上/下缘），下级 `.is-drop-child`（条从 `left:17px` 起，短一档＝再深一层）。非法落点用 `.is-drop-invalid`（危险色）。根目录落点用 `.tree.is-drop-root`。
- **拒绝规则**：文件夹拖进自己或自己的子孙、落到它当前所在的目录 → 不执行，给 toast 说明原因。
- 移动成功后刷新树、展开目标目录；被移动的正是当前打开的笔记（或因父目录被移动而受影响）时 `S.note.path` 跟着改而编辑器内容不动。内部拖拽必须 `stopPropagation()`，否则会冒泡到系统文件导入逻辑。
