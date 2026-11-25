// 无 connectionId（例如从宿主别处打开）时的降级路径测试
import jsdomPkg from "jsdom";
const { JSDOM, VirtualConsole } = jsdomPkg;
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(PROJECT, "ui");
const results = [];
const ok = (n, c, d = "") => results.push({ n, pass: !!c, d: String(d).slice(0, 300) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const calls = { copy: [] };
const virtualConsole = new VirtualConsole();
const errs = [];
virtualConsole.on("jsdomError", (e) => errs.push(e.message));

const dom = await JSDOM.fromFile(path.join(UI, "index.html"), {
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  url: "file://" + path.join(UI, "index.html"),
  virtualConsole,
  beforeParse(win) {
    win.dbxPlugin = {
      ready: Promise.resolve({}),
      contributionId: "miko.md.notes.workbench",
      context: { workbenchId: "wb-x", surface: "tab" },   // 故意没有 connectionId
      locale: "zh-CN",
      theme: { appearance: "light", tokens: {} },
      capabilities: { storage: true },
      onContext: () => () => {},
      onEvent: () => () => {},
      invoke: async () => { throw new Error("不应该在没有连接时调用 RPC"); },
      notify: async () => true,
      storage: { get: async () => null, set: async () => true, delete: async () => true },
      setTitle: async () => true,
      copy: async (t) => { calls.copy.push(String(t)); return true; },
      readAssetUrl: async () => "data:,",
    };
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    win.URL.createObjectURL = () => "blob:mock";
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  },
});

const win = dom.window;
const $ = (s) => win.document.querySelector(s);
await sleep(500);

ok("无 connectionId 时显示提示页", !$("#nocontext").hidden, "hidden=" + $("#nocontext").hidden);
ok("提示页有标题与说明", $("#noc-title").textContent.length > 0 && $("#noc-body").textContent.length > 0,
  $("#noc-title").textContent + " | " + $("#noc-body").textContent);
ok("提示页给出线索", $("#noc-hint").textContent.length > 0, $("#noc-hint").textContent);
$("#noc-copy").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
await sleep(200);
ok("复制按钮走 dbxPlugin.copy", calls.copy.length === 1, JSON.stringify(calls.copy));
ok("无未捕获错误（也没乱发 RPC）", errs.length === 0, errs.join(" | "));

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.n}${r.pass ? "" : "  → " + r.d}`);
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`);
process.exit(failed.length ? 1 : 0);
