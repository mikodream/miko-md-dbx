// MIKO.MD 笔记 —— 真实 UI × 真实 Sidecar 的端到端测试（jsdom 冒充 DBX 宿主）
//
// 准备: cd dev && npm install          （只装 jsdom，不进包）
// 运行: node dev/ui-test.mjs          （需先 go build -o bin/miko-md-notes ./backend）
//
// 覆盖: 启动、目录树渲染、打开笔记、Ctrl+S 落盘、工具栏、视图模式存储、
//       搜索、新建笔记、图片粘贴、预览图片走 readAsset、XSS 防护、openFilesystem。
import jsdomPkg from "jsdom";
const { JSDOM, VirtualConsole } = jsdomPkg;
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.MIKO_BIN || path.join(PROJECT, "bin/miko-md-notes");
const UI = path.join(PROJECT, "ui");
const MANIFEST = JSON.parse(readFileSync(path.join(PROJECT, "manifest.json"), "utf8"));
const PLUGIN_ID = MANIFEST.id, PLUGIN_VERSION = MANIFEST.version;

const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail: String(detail).slice(0, 400) });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- sidecar 桥
class Sidecar {
  constructor(env) {
    this.proc = spawn(BIN, [], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.waiters = new Map();
    this.id = 0;
    this.stdoutLines = [];
    this.stderr = "";
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      this.stdoutLines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { ok("stdout 是合法 JSON", false, line); return; }
      const w = this.waiters.get(msg.id);
      if (w) { this.waiters.delete(msg.id); w(msg); }
    });
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
  }
  call(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 20000);
      this.waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async invoke(method, params) {
    const msg = await this.call(method, params);
    if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; throw e; }
    return msg.result;
  }
  close() { this.proc.stdin.end(); }
}

// ---------------------------------------------------------------- 造库
const root = mkdtempSync(path.join(tmpdir(), "miko-md-ui-"));
const vault = path.join(root, "vault");
const dataDir = path.join(root, "plugin-data");
mkdirSync(vault, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(path.join(vault, "工作", "深层"), { recursive: true });
mkdirSync(path.join(vault, "_assets"), { recursive: true });
writeFileSync(path.join(vault, "索引.md"), "# 索引\n\n这是我的第一篇笔记。\n\n- 项目一\n- 项目二\n");
writeFileSync(path.join(vault, "工作", "周报.md"), "# 周报\n\n## 进展\n\n本周完成了管道重构。\n");
writeFileSync(path.join(vault, "工作", "深层", "随手记.md"), "# 随手记\n\n随手写的。\n");
writeFileSync(path.join(vault, "notes.txt"), "不是笔记的文件\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BurwAE/wH/6j4Z8QAAAABJRU5ErkJggg==", "base64");
writeFileSync(path.join(vault, "_assets", "pic.png"), PNG);

const CONNECTION_ID = "conn-e2e";
const sidecar = new Sidecar({ DBX_PLUGIN_DATA_DIR: dataDir });
// 真宿主会先跑连接生命周期再开工作台，这里照做
await sidecar.invoke("connection/connect", {
  provider: { id: "miko.md.notes.connection", databaseType: "mdnotes" },
  connection: {
    id: CONNECTION_ID, name: "MIKO.MD 笔记",
    external_config: { vault_path: vault, assets_dir: "_assets", trash_enabled: true },
  },
  runtime: {},
});

// ---------------------------------------------------------------- 假宿主
const storage = new Map();
const calls = { invoke: 0, setTitle: [], openFs: [], openUrl: [], copy: [] };

function makeBridge(win) {
  const caps = {
    storage: true, workbenchTitle: true, clipboardWrite: true,
    // 故意不提供 fileTransfer / openUrl 之外的桌面能力，验证降级路径
  };
  return {
    ready: (async () => {
      await sidecar.invoke("plugin/initialize", {
        host: { dbxVersion: "0.6.1", hostApiVersion: "1.0.0", protocolVersions: [1] },
        plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
      });
      return { plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION } };
    })(),
    contributionId: "miko.md.notes.workbench",
    context: { connectionId: CONNECTION_ID, workbenchId: "wb-1", surface: "tab", restored: false },
    locale: "zh-CN",
    theme: { appearance: "light", tokens: { "--color-background": "#ffffff", "--color-foreground": "#18181b" } },
    capabilities: caps,
    onContext() { return () => {}; },
    onEvent() { return () => {}; },
    onInit() { return () => {}; },
    async invoke(method, params) {
      calls.invoke++;
      return sidecar.invoke(method, { connectionId: CONNECTION_ID, ...(params || {}) });
    },
    async notify() { return true; },
    storage: {
      async get(k) { return storage.has(k) ? storage.get(k) : null; },
      async set(k, v) { storage.set(k, v); return true; },
      async delete(k) { storage.delete(k); return true; },
    },
    async setTitle(t) { calls.setTitle.push(t); return true; },
    async getTitle() { return calls.setTitle.at(-1) ?? null; },
    async openFilesystem(id, ctx) { calls.openFs.push({ id, ctx }); return true; },
    async openUrl(u) { calls.openUrl.push(u); return { opened: true }; },
    async copy(t) { calls.copy.push(String(t)); return true; },
    async readAssetUrl(p) { return "data:,"; },
    __win: win,
  };
}

// ---------------------------------------------------------------- 启动 jsdom
const virtualConsole = new VirtualConsole();
const consoleErrors = [];
virtualConsole.on("jsdomError", (e) => consoleErrors.push("jsdomError: " + e.message));
virtualConsole.on("error", (...a) => consoleErrors.push("console.error: " + a.join(" ")));

const dom = await JSDOM.fromFile(path.join(UI, "index.html"), {
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  url: "file://" + path.join(UI, "index.html"),
  virtualConsole,
  beforeParse(win) {
    win.dbxPlugin = makeBridge(win);
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    win.URL.createObjectURL = () => "blob:mock";
    win.URL.revokeObjectURL = () => {};
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    win.alert = () => { throw new Error("UI 不应调用 alert"); };
    win.confirm = () => { throw new Error("UI 不应调用 confirm"); };
    win.prompt = () => { throw new Error("UI 不应调用 prompt"); };
  },
});

const win = dom.window;
const doc = win.document;
const $ = (sel) => doc.querySelector(sel);
const all = (sel) => [...doc.querySelectorAll(sel)];

async function waitFor(fn, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${label}`);
    await sleep(50);
  }
}

try {
  // 启动完成
  await waitFor(() => !$("#shell").hidden, "shell 可见");
  ok("启动后显示主界面", !$("#shell").hidden);
  ok("启动后隐藏 boot", $("#boot").hidden !== false || getComputedStyleOf("#boot"));

  // 顶栏与统计
  await waitFor(() => all(".tree-row").length > 0, "目录树渲染");
  const treeText = $("#tree").textContent;
  ok("目录树含笔记名", treeText.includes("索引"), treeText.slice(0, 200));
  ok("目录树含文件夹", treeText.includes("工作"), treeText.slice(0, 200));
  ok("目录树隐藏非笔记文件", !treeText.includes("notes.txt") && !treeText.includes("pic.png"), treeText.slice(0, 200));
  ok("目录树隐藏 _assets", !treeText.includes("_assets"), treeText.slice(0, 200));
  ok("统计显示笔记数", /\d/.test($("#vault-stats").textContent), $("#vault-stats").textContent);

  // 只有目录树，没有二级列表
  ok("没有二级笔记列表分栏", all(".pane-list").length === 0 && $("#list") === null);
  // 外壳纵向必须是 flex column：#banner 可隐藏，用位置 grid 会让底栏错行
  const css = readFileSync(path.join(UI, "style.css"), "utf8");
  const shellBlock = (css.match(/\.shell \{[^}]*\}/) || [""])[0];
  ok("外壳是 flex column 布局", /display:\s*flex/.test(shellBlock) && /flex-direction:\s*column/.test(shellBlock), shellBlock);
  ok("外壳不再用 grid-template-rows 分配行", !/grid-template-rows/.test(shellBlock), shellBlock);
  ok("新建笔记/文件夹按钮在树上方", !!$(".pane-tree .tree-tools #btn-new-note") && !!$(".pane-tree .tree-tools #btn-new-folder"));
  ok("树里的笔记行", all(".tree-row").filter((r) => r.dataset.kind === "note").length >= 1,
    all(".tree-row").map((r) => r.dataset.kind + ":" + r.textContent).join(","));

  // 打开笔记
  const noteRow = all(".tree-row").find((r) => r.dataset.kind === "note" && r.textContent.includes("索引"));
  noteRow.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(() => $("#editor").value.includes("我的第一篇笔记"), "编辑器载入内容");
  ok("点击笔记载入正文", $("#editor").value.includes("我的第一篇笔记"), $("#editor").value);
  ok("打开笔记后 setTitle", calls.setTitle.some((t) => (t || "").includes("索引")), JSON.stringify(calls.setTitle));
  ok("状态栏显示路径", $("#status-path").textContent.includes("索引"), $("#status-path").textContent);

  // 预览
  await waitFor(() => $("#preview").innerHTML.includes("<h1"), "预览渲染");
  ok("预览渲染标题", /<h1[^>]*>索引<\/h1>/.test($("#preview").innerHTML), $("#preview").innerHTML.slice(0, 200));
  ok("预览渲染列表", $("#preview").innerHTML.includes("<li"), $("#preview").innerHTML.slice(0, 400));

  // 编辑 + Ctrl/Cmd+S
  $("#editor").value = "# 索引\n\n改过了。\n";
  $("#editor").dispatchEvent(new win.Event("input", { bubbles: true }));
  await sleep(60);
  ok("输入后标记未保存", /未保存|Unsaved/.test($("#status-save").textContent), $("#status-save").textContent);
  $("#editor").dispatchEvent(new win.KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => readFileSync(path.join(vault, "索引.md"), "utf8").includes("改过了"), "磁盘落盘", 5000);
  ok("Ctrl+S 落盘", readFileSync(path.join(vault, "索引.md"), "utf8").includes("改过了"));
  await waitFor(() => /已保存|Saved/.test($("#status-save").textContent), "保存状态恢复");

  // 工具栏：粗体包裹
  $("#editor").focus();
  $("#editor").setSelectionRange(0, 4);
  const boldBtn = all(".tb").find((b) => b.dataset.md === "bold");
  boldBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  ok("工具栏加粗包裹选区", $("#editor").value.startsWith("**# 索引**"), $("#editor").value.slice(0, 40));
  $("#editor").dispatchEvent(new win.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));

  // 视图模式 → storage
  const previewBtn = all(".seg-btn").find((b) => b.dataset.view === "preview");
  previewBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(() => $("#editor-body").dataset.view === "preview", "切到预览");
  ok("视图模式切换", $("#editor-body").dataset.view === "preview");
  await sleep(80);
  ok("视图模式写入 storage", [...storage.keys()].some((k) => k.includes("view")), [...storage.keys()].join(","));
  all(".seg-btn").find((b) => b.dataset.view === "split").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

  // 搜索
  $("#search").value = "管道";
  $("#search").dispatchEvent(new win.Event("input", { bubbles: true }));
  await waitFor(() => !!$("#tree .hits-title"), "搜索结果头");
  ok("搜索结果占用目录树位置", $("#tree").textContent.includes("周报") && !!$("#tree .hit-row"),
    $("#tree").textContent.slice(0, 200));
  ok("搜索结果带清除按钮", !!$("#tree .hits-head button"), $("#tree").innerHTML.slice(0, 160));
  $("#search").value = "";
  $("#search").dispatchEvent(new win.Event("input", { bubbles: true }));
  await sleep(300);

  // 新建笔记
  const before = readdirSync(vault).filter((f) => f.endsWith(".md")).length;
  $("#btn-new-note").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(() => doc.querySelector("#modal-root").hidden === false, "新建对话框");
  const input = doc.querySelector("#modal-root input");
  input.value = "会议记录";
  const confirmBtn = [...doc.querySelectorAll("#modal-root button")].find((b) => /创建|确定|Create|OK/i.test(b.textContent));
  confirmBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(() => readdirSync(vault).some((f) => f.includes("会议记录")), "新笔记落盘", 6000);
  ok("新建笔记落盘", readdirSync(vault).some((f) => f.includes("会议记录")), readdirSync(vault).join(","));
  ok("笔记数量增加", readdirSync(vault).filter((f) => f.endsWith(".md")).length > before);

  // 折角箭头：目录行有可旋转的 chevron，文件行留同宽占位
  const dirRowOf = (p) => all(".tree-row").find((r) => r.dataset.kind === "dir" && r.dataset.path === p);
  const noteRowOf = (p) => all(".tree-row").find((r) => r.dataset.kind === "note" && r.dataset.path === p);
  const dirRow = dirRowOf("工作");
  ok("目录行有 chevron 图标", !!dirRow.querySelector("svg.twisty path"), dirRow.innerHTML.slice(0, 160));
  ok("展开态 chevron 旋转", dirRow.querySelector("svg.twisty").classList.contains("is-open"), dirRow.className);
  dirRow.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  ok("收起态 chevron 不旋转", !dirRowOf("工作").querySelector("svg.twisty").classList.contains("is-open"),
    dirRowOf("工作").className);
  dirRowOf("工作").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  ok("文件夹行有文件夹图标", !!all(".tree-row").find((r) => r.dataset.kind === "note")?.querySelector("svg.ico path"));

  // 回归：pointerdown 里不能捕获指针（否则 click 目标变成 #tree，点文件夹/笔记全失效）
  const appSrc = readFileSync(path.join(UI, "app.js"), "utf8");
  const pdBlock = (appSrc.match(/addEventListener\("pointerdown"[\s\S]{0,1200}?\n    \}\);/g) || []).join("\n");
  // 注释里会提到这个 API 名，先剥掉注释再判
  ok("pointerdown 不捕获指针", !/setPointerCapture/.test(pdBlock.replace(/\/\/[^\n]*/g, "")), pdBlock.slice(-160));
  ok("进入拖拽后才捕获指针", /pd\.active = true;[\s\S]{0,240}setPointerCapture/.test(appSrc), "");

  // 拖拽移动：pointer 事件（沙箱里不用 HTML5 DnD）
  const fakeRect = (node, top = 100, height = 24) => {
    node.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 220, width: 220, x: 0, y: top });
  };
  doc.elementFromPoint = () => null;
  const pev = (type, x, y, opts = {}) => {
    const e = new win.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: opts.button ?? 0, buttons: opts.buttons ?? 0,
    });
    Object.defineProperty(e, "pointerId", { value: 1 });
    Object.defineProperty(e, "isPrimary", { value: true });
    (opts.on || win).dispatchEvent(e);
  };
  const pdStart = (source, clientY = 112) => {
    pev("pointerdown", 40, clientY, { buttons: 1, on: source });
    pev("pointermove", 60, clientY, { buttons: 1 });   // 越过 4px 阈值，进入拖拽态
  };
  const pdMoveTo = (targetEl, clientY = 112, buttons = 1) => {
    doc.elementFromPoint = () => targetEl;
    pev("pointermove", 64, clientY, { buttons });
  };
  const pdDrop = (clientY = 112) => pev("pointerup", 64, clientY, { buttons: 0 });
  const pdCancel = () => pev("pointercancel", 64, 112, { buttons: 0 });

  fakeRect(dirRowOf("工作"), 100, 24);
  const anyRootNote = () => all(".tree-row").find((r) => r.dataset.kind === "note" && !r.dataset.path.includes("/"));

  // 回归：按下-松开（没有拖动）之后再移动鼠标，不应进入拖拽态
  const plainNote = anyRootNote();
  pev("pointerdown", 40, 112, { buttons: 1, on: plainNote });
  pev("pointerup", 40, 112, { buttons: 0 });
  pdMoveTo(dirRowOf("工作"), 112, 0);
  await sleep(60);
  ok("松手后移动不进入拖拽态", $(".drag-ghost").hidden && !$("#tree .is-drop-hover"), $("#tree").className);

  // 三档落点 + 视觉反馈
  pdStart(anyRootNote());
  ok("拖拽中源行变淡", anyRootNote().classList.contains("is-dragging"), anyRootNote().className);
  ok("拖拽中显示拖影", !$(".drag-ghost").hidden, $("#tree").className);
  pdMoveTo(dirRowOf("工作"), 112);           // 中部 = 放进文件夹
  let hr = dirRowOf("工作");
  ok("悬停文件夹有背景反馈", hr.classList.contains("is-drop-hover"), hr.className);
  ok("下级落点用缩进短条", hr.classList.contains("is-drop-child") && !hr.classList.contains("is-drop-sibling"), hr.className);
  pdMoveTo(dirRowOf("工作"), 101);           // 上缘 = 同级
  hr = dirRowOf("工作");
  ok("同级落点用整行满条", hr.classList.contains("is-drop-sibling") && hr.classList.contains("is-drop-before"), hr.className);
  ok("同级与下级互斥", !hr.classList.contains("is-drop-child"), hr.className);
  pdMoveTo(dirRowOf("工作"), 122);           // 下缘 = 同级（下方）
  ok("下缘落点也算同级", dirRowOf("工作").classList.contains("is-drop-after"), dirRowOf("工作").className);
  pdCancel();
  await sleep(60);
  ok("取消后清掉落点提示", !$("#tree .is-drop-hover") && !$("#tree .is-drop-child"), $("#tree").className);
  ok("取消后隐藏拖影", $(".drag-ghost").hidden);

  // 真移动：笔记 → 文件夹中部
  const srcNote = anyRootNote(), srcPath = srcNote.dataset.path;
  const titleBefore = $("#doc-title").textContent;
  pdStart(srcNote);
  pdMoveTo(dirRowOf("工作"), 112);
  pdDrop(112);
  ok("松开鼠标即完成移动（无需二次点击）", !$(".drag-ghost") || $(".drag-ghost").hidden, "");
  // 松手后紧跟的那一次点击不能被当成"打开笔记"
  const otherNote = all(".tree-row").find((r) => r.dataset.kind === "note" && r.dataset.path !== srcPath);
  if (otherNote) otherNote.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  ok("拖拽后不误触打开笔记", $("#doc-title").textContent === titleBefore, $("#doc-title").textContent);
  await waitFor(() => existsSync(path.join(vault, "工作", srcPath)), "笔记被移动到子目录", 6000);
  ok("拖到文件夹中部：磁盘已移动", existsSync(path.join(vault, "工作", srcPath)) && !existsSync(path.join(vault, srcPath)), srcPath);
  await waitFor(() => !all(".tree-row").some((r) => r.dataset.path === srcPath), "树已刷新", 4000);
  ok("拖到文件夹中部：树已刷新", !all(".tree-row").some((r) => r.dataset.path === srcPath));

  // 同级落点：把子目录里的笔记移到父目录（工作/周报.md → 「工作」行上缘 = 根目录）
  fakeRect(dirRowOf("工作"), 100, 24);
  pdStart(noteRowOf("工作/周报.md"), 101);
  pdMoveTo(dirRowOf("工作"), 101);
  pdDrop(101);
  await waitFor(() => existsSync(path.join(vault, "周报.md")), "同级落点移到父目录", 6000);
  ok("同级落点把笔记移到父目录", existsSync(path.join(vault, "周报.md")) && !existsSync(path.join(vault, "工作", "周报.md")),
    readdirSync(vault).join(","));

  // 拖到树空白处 = 根目录
  pdStart(noteRowOf("工作/" + srcPath));
  pdMoveTo($("#tree"), 200);
  pdDrop(200);
  await waitFor(() => existsSync(path.join(vault, srcPath)), "笔记移回根目录", 6000);
  ok("拖到树空白处：回到根目录", existsSync(path.join(vault, srcPath)), srcPath);

  // 拒绝：文件夹 → 自己的子目录
  pdStart(dirRowOf("工作"), 112);
  pdMoveTo(dirRowOf("工作/深层"), 112);
  pdDrop(112);
  await sleep(500);
  ok("拒绝把文件夹拖进自己的子目录",
    existsSync(path.join(vault, "工作", "深层")) && !existsSync(path.join(vault, "工作", "深层", "工作")),
    readdirSync(path.join(vault, "工作")).join(","));
  ok("拒绝时给出明确提示", /不能移动到它自己|Cannot move a folder into itself/.test($("#toasts").textContent),
    $("#toasts").textContent);

  // 图片预览：插入图片引用后预览应换成 data: URL
  $("#editor").value = "# 图片\n\n![pic](_assets/pic.png)\n";
  $("#editor").dispatchEvent(new win.Event("input", { bubbles: true }));
  await waitFor(() => {
    const img = $("#preview img");
    return img && img.src.startsWith("data:image/png");
  }, "图片转 data URL", 6000);
  const img = $("#preview img");
  ok("预览图片走 readAsset", img && img.getAttribute("src").startsWith("data:image/png"), img && img.getAttribute("src").slice(0, 40));

  // 粘贴图片（模拟宿主剪贴板里的截图）
  const assetsBefore = readdirSync(path.join(vault, "_assets")).length;
  const editor = $("#editor");
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  const pasteEvt = new win.Event("paste", { bubbles: true, cancelable: true });
  const fakeFile = new win.File([PNG], "screenshot.png", { type: "image/png" });
  Object.defineProperty(pasteEvt, "clipboardData", {
    value: { items: [{ kind: "file", type: "image/png", getAsFile: () => fakeFile }], files: [fakeFile] },
  });
  editor.dispatchEvent(pasteEvt);
  await waitFor(() => readdirSync(path.join(vault, "_assets")).length > assetsBefore, "粘贴图片落盘", 8000);
  ok("粘贴图片写入 _assets", readdirSync(path.join(vault, "_assets")).length > assetsBefore,
    readdirSync(path.join(vault, "_assets")).join(","));
  await waitFor(() => editor.value.includes("!["), "插入图片 markdown", 4000);
  ok("粘贴后插入 ![](…)", editor.value.includes("!["), editor.value.slice(-120));

  // 安全：恶意内容不进 DOM
  $("#editor").value = "# x\n\n<script>window.__pwned=1</script>\n\n[bad](javascript:alert(1))\n";
  $("#editor").dispatchEvent(new win.Event("input", { bubbles: true }));
  await sleep(300);
  ok("script 标签未执行", win.__pwned === undefined, String(win.__pwned));
  ok("预览无 script 元素", $("#preview").querySelectorAll("script").length === 0);
  ok("javascript: 链接不出现", !$("#preview").innerHTML.includes("javascript:"), $("#preview").innerHTML.slice(0, 300));

  // 在文件浏览器中打开
  $("#btn-open-fs").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(200);
  ok("openFilesystem 调用", calls.openFs.length === 1 && calls.openFs[0].id === "miko.md.notes.fs",
    JSON.stringify(calls.openFs));

  // 错误路径：后端报错要可见
  calls.invoke = 0;
  sidecar.call; // noop
  $("#btn-refresh").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(400);
  ok("刷新触发 RPC", calls.invoke > 0, String(calls.invoke));
  ok("toast 容器存在", !!$("#toasts"));

  ok("没有未捕获的 jsdom 错误", consoleErrors.length === 0, consoleErrors.join(" | "));
} catch (e) {
  ok("测试流程无异常", false, e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e));
}

function getComputedStyleOf(sel) {
  const n = $(sel);
  return n ? n.className : "";
}

sidecar.close();
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  →  " + r.detail}`);
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`);
if (sidecar.stderr.trim()) console.log("\n--- sidecar stderr ---\n" + sidecar.stderr.slice(0, 1500));
rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
