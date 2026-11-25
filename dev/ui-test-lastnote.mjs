// 验证「回到上次打开的笔记」
import jsdomPkg from "jsdom";
const { JSDOM, VirtualConsole } = jsdomPkg;
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { readFileSync as readManifest } from "node:fs";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.MIKO_BIN || path.join(PROJECT, "bin/miko-md-notes");
const UI = path.join(PROJECT, "ui");
const MANIFEST = JSON.parse(readManifest(path.join(PROJECT, "manifest.json"), "utf8"));
const PLUGIN_ID = MANIFEST.id, PLUGIN_VERSION = MANIFEST.version;
const CID = "conn-last";
const results = [];
const ok = (n, c, d = "") => results.push({ n, pass: !!c, d: String(d).slice(0, 300) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(path.join(tmpdir(), "miko-md-last-"));
const vault = path.join(root, "vault");
mkdirSync(path.join(vault, "工作"), { recursive: true });
writeFileSync(path.join(vault, "首页.md"), "# 首页\n");
writeFileSync(path.join(vault, "工作", "周报.md"), "# 周报\n\n本周完成了管道重构。\n");

const proc = spawn(BIN, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: path.join(root, "pd") }, stdio: ["pipe", "pipe", "pipe"] });
mkdirSync(path.join(root, "pd"), { recursive: true });
const waiters = new Map();
let seq = 0;
createInterface({ input: proc.stdout }).on("line", (l) => {
  const msg = JSON.parse(l);
  const w = waiters.get(msg.id);
  if (w) { waiters.delete(msg.id); w(msg); }
});
const rpc = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  waiters.set(id, res);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const invoke = async (m, p) => { const r = await rpc(m, p); if (r.error) throw new Error(r.error.message); return r.result; };

await invoke("plugin/initialize", { plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION }, host: { protocolVersions: [1] } });
await invoke("connection/connect", { connection: { id: CID, external_config: { vault_path: vault, assets_dir: "_assets" } } });

const storage = new Map([["miko.md.notes.last." + CID, "工作/周报.md"]]);
const errs = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errs.push(e.message));

const dom = await JSDOM.fromFile(path.join(UI, "index.html"), {
  runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
  url: "file://" + path.join(UI, "index.html"), virtualConsole: vc,
  beforeParse(win) {
    win.dbxPlugin = {
      ready: Promise.resolve({}), contributionId: "miko.md.notes.workbench",
      context: { connectionId: CID, workbenchId: "wb", surface: "tab" },
      locale: "zh-CN", theme: { appearance: "light", tokens: {} },
      capabilities: { storage: true, workbenchTitle: true },
      onContext: () => () => {}, onEvent: () => () => {},
      invoke: (m, p) => invoke(m, { connectionId: CID, ...(p || {}) }),
      notify: async () => true,
      storage: { get: async (k) => (storage.has(k) ? storage.get(k) : null), set: async (k, v) => { storage.set(k, v); return true; }, delete: async (k) => { storage.delete(k); return true; } },
      setTitle: async () => true, copy: async () => true, openFilesystem: async () => true, readAssetUrl: async () => "data:,",
    };
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    win.URL.createObjectURL = () => "blob:mock";
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  },
});

const win = dom.window;
const $ = (s) => win.document.querySelector(s);
for (let i = 0; i < 120 && !$("#editor").value; i++) await sleep(50);

ok("自动打开上次的笔记", $("#editor").value.includes("本周完成了管道重构"), $("#editor").value.slice(0, 80));
ok("标题与路径同步", $("#doc-title").textContent.includes("周报") && $("#status-path").textContent.includes("周报"),
  $("#doc-title").textContent + " | " + $("#status-path").textContent);
ok("树里能看到并选中当前笔记", $("#tree").textContent.includes("周报") && !!$(".tree-row.is-current"), $("#tree").textContent.slice(0, 120));
ok("打开后记住新的 last", storage.get("miko.md.notes.last." + CID) === "工作/周报.md", storage.get("miko.md.notes.last." + CID));
ok("无未捕获错误", errs.length === 0, errs.join(" | "));

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.n}${r.pass ? "" : "  → " + r.d}`);
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`);
proc.stdin.end();
rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
