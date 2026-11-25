/* MIKO.MD 笔记 —— 工作台应用逻辑
 * 沙箱没有网络 / localStorage / 剪贴板 / 原生弹窗，跨边界只走 window.dbxPlugin；
 * DOM 一律 createElement + textContent，唯一允许的 HTML 注入点是 MikoMarkdown.render()。 */
(function () {
  "use strict";

  /* ── 文案字典：所有可见字符串都在这里 ── */
  const I18N = {
    zh: {
      searchPlaceholder: "搜索笔记内容…", newNote: "新建笔记", newFolder: "新建文件夹", importMd: "导入 .md", importFolder: "导入文件夹",
      backup: "备份", restore: "恢复", openFs: "文件浏览器", refresh: "刷新", exportNote: "导出", treeTitle: "目录", backToTree: "返回目录", resultsTitle: "搜索结果", clearSearch: "清除",
      viewEdit: "编辑", viewSplit: "分屏", viewPreview: "预览", treeEmpty: "笔记库还是空的", listEmpty: "从左边目录树选一篇笔记",
      movedTo: "已移动到 {dir}", moveSelf: "不能移动到它自己或它的子目录", moveSameDir: "已经在这个目录里了", noResults: "没有匹配的内容",
      statusSaved: "已保存", statusUnsaved: "未保存", statusSaving: "保存中…", statusFailed: "保存失败", autoSave: "自动保存", words: "字",
      backToList: "返回列表", back: "返回", copy: "复制", copied: "已复制到剪贴板", cancel: "取消", ok: "确定",
      tbPara: "正文", tbBold: "粗", tbItalic: "斜", tbCode: "代码", tbCodeBlock: "代码块", tbLink: "链接", tbUl: "列表", tbTask: "任务",
      tbQuote: "引用", tbHr: "分隔线", tbImage: "图片", dropHint: "松开导入：图片插入到光标处，Markdown 导入笔记库，文件夹保留目录结构",
      noContextTitle: "请从连接列表打开 MIKO.MD 笔记库", noContextHint: "connectionId: （未提供）\nworkbench: miko.md.notes.workbench",
      noContextBody: "这个工作台需要插件连接上下文才能读写笔记。在 DBX 的连接列表里选择一条 MIKO.MD 笔记连接，再打开它的工作台。",
      emptyTitle: "笔记库是空的", emptyBody: "新建第一篇笔记，或者把已有的 .md 文件拖进来。", generateFirst: "新建第一篇笔记",
      deleteTitle: "删除", deletePermanent: "永久删除（不进 .trash）", renameTitle: "重命名", renameLabel: "新名称",
      newFolderTitle: "新建文件夹", newFolderLabel: "文件夹名称", newNoteTitle: "新建笔记", newNoteLabel: "笔记标题",
      deleteNoteBody: "笔记“{name}”将被删除。", deleteDirBody: "文件夹“{name}”及其内容将被删除。",
      menuOpen: "打开", menuRename: "重命名", menuDelete: "删除", menuExport: "导出为文件", menuCopyPath: "复制路径",
      menuNewNote: "在这里新建笔记", menuNewFolder: "在这里新建文件夹", menuCollapse: "折叠", menuExpand: "展开",
      conflictTitle: "磁盘上的文件已变化", conflictSaveTitle: "保存冲突：文件已被外部修改", conflictDeleted: "这篇笔记已从磁盘上删除或重命名。",
      conflictReload: "重新加载", conflictKeep: "保留我的修改", importFolderTitle: "导入文件夹", importFolderLabel: "文件夹绝对路径",
      importFolderHint: "桌面端也可以直接把文件夹拖进来。", importing: "正在导入…", exportDone: "已导出 {name}",
      backupRunning: "正在备份…", backupDone: "备份完成：{name}", restoreTitle: "恢复备份", restoreRunning: "正在恢复…",
      restoreBody: "把 zip 里的笔记恢复到笔记库。建议先做一次备份。", overwriteLabel: "覆盖同名文件",
      restoreDone: "恢复完成：{restored} 个，跳过 {skipped} 个", cancelled: "已取消", importDone: "已导入 {n} 个文件",
      importSkipped: "跳过 {n} 个（不是 Markdown）", noNote: "先打开一篇笔记", imageInserted: "已插入图片 {name}", imagePathLabel: "图片相对路径",
      fileTooLarge: "文件太大，单条消息放不下（上限约 5 MB）：{name}",
      errors: { VAULT_NOT_FOUND: "笔记库目录不存在", VAULT_NOT_DIR: "笔记库路径不是目录", PATH_INVALID: "路径不合法",
        PATH_OUTSIDE_VAULT: "路径超出笔记库范围", NOT_FOUND: "找不到文件", ALREADY_EXISTS: "同名文件已存在",
        CONFLICT: "文件已被外部修改", NOT_A_NOTE: "不是 Markdown 笔记", NOT_A_DIR: "不是目录", IO_ERROR: "读写失败",
        ZIP_INVALID: "不是有效的 zip 备份", SESSION_MISSING: "连接未打开", HANDLE_MISSING: "句柄已失效",
        PAYLOAD_TOO_LARGE: "文件太大", UNSUPPORTED: "当前环境不支持这个操作", TIMEOUT: "操作超时", UNKNOWN: "未知错误" }
    },
    en: {
      searchPlaceholder: "Search notes…", newNote: "New note", newFolder: "New folder", importMd: "Import .md", importFolder: "Import folder",
      backup: "Backup", restore: "Restore", openFs: "File browser", refresh: "Refresh", exportNote: "Export", treeTitle: "Folders", backToTree: "Back to folders", resultsTitle: "Results", clearSearch: "Clear",
      viewEdit: "Edit", viewSplit: "Split", viewPreview: "Preview", treeEmpty: "The vault is empty", listEmpty: "Pick a note from the folder tree",
      movedTo: "Moved to {dir}", moveSelf: "Cannot move a folder into itself", moveSameDir: "Already in this folder", noResults: "No matches",
      statusSaved: "Saved", statusUnsaved: "Unsaved", statusSaving: "Saving…", statusFailed: "Save failed", autoSave: "Auto save", words: "words",
      backToList: "Back to list", back: "Back", copy: "Copy", copied: "Copied to clipboard", cancel: "Cancel", ok: "OK",
      tbPara: "Text", tbBold: "B", tbItalic: "I", tbCode: "Code", tbCodeBlock: "Block", tbLink: "Link", tbUl: "List", tbTask: "Task",
      tbQuote: "Quote", tbHr: "Rule", tbImage: "Image", dropHint: "Drop to import: images go to the caret, Markdown into the vault, folders keep their structure",
      noContextTitle: "Open a MIKO.MD vault from the connection list", noContextHint: "connectionId: (missing)\nworkbench: miko.md.notes.workbench",
      noContextBody: "This workbench needs a plugin connection to read and write notes. Pick a MIKO.MD connection in DBX, then open its workbench.",
      emptyTitle: "The vault is empty", emptyBody: "Write the first note, or drop your existing .md files here.", generateFirst: "Create the first note",
      deleteTitle: "Delete", deletePermanent: "Delete permanently (skip .trash)", renameTitle: "Rename", renameLabel: "New name",
      newFolderTitle: "New folder", newFolderLabel: "Folder name", newNoteTitle: "New note", newNoteLabel: "Note title",
      deleteNoteBody: "The note “{name}” will be deleted.", deleteDirBody: "The folder “{name}” and its contents will be deleted.",
      menuOpen: "Open", menuRename: "Rename", menuDelete: "Delete", menuExport: "Export as file", menuCopyPath: "Copy path",
      menuNewNote: "New note here", menuNewFolder: "New folder here", menuCollapse: "Collapse", menuExpand: "Expand",
      conflictTitle: "The file changed on disk", conflictSaveTitle: "Save conflict: file changed on disk", conflictDeleted: "This note was deleted or renamed on disk.",
      conflictReload: "Reload", conflictKeep: "Keep my changes", importFolderTitle: "Import folder", importFolderLabel: "Absolute folder path",
      importFolderHint: "On desktop you can also drag the folder in.", importing: "Importing…", exportDone: "Exported {name}",
      backupRunning: "Backing up…", backupDone: "Backup finished: {name}", restoreTitle: "Restore backup", restoreRunning: "Restoring…",
      restoreBody: "Restore the notes inside the zip into the vault. A fresh backup first is a good idea.", overwriteLabel: "Overwrite files with the same name",
      restoreDone: "Restored {restored}, skipped {skipped}", cancelled: "Cancelled", importDone: "Imported {n} file(s)",
      importSkipped: "Skipped {n} file(s) (not Markdown)", noNote: "Open a note first", imageInserted: "Inserted image {name}", imagePathLabel: "Image relative path",
      fileTooLarge: "File too large for one message (about 5 MB max): {name}",
      errors: { VAULT_NOT_FOUND: "The vault folder does not exist", VAULT_NOT_DIR: "The vault path is not a folder", PATH_INVALID: "Invalid path",
        PATH_OUTSIDE_VAULT: "Path escapes the vault", NOT_FOUND: "File not found", ALREADY_EXISTS: "A file with that name already exists",
        CONFLICT: "The file changed on disk", NOT_A_NOTE: "Not a Markdown note", NOT_A_DIR: "Not a folder", IO_ERROR: "Read/write failed",
        ZIP_INVALID: "Not a valid zip backup", SESSION_MISSING: "Connection is not open", HANDLE_MISSING: "Handle is gone",
        PAYLOAD_TOO_LARGE: "Payload too large", UNSUPPORTED: "Not supported in this environment", TIMEOUT: "Timed out", UNKNOWN: "Unknown error" }
    }
  };

  /* ── 状态 ── */
  const T_NORMAL = 30000, T_LONG = 300000, VIEW_KEY = "miko.md.notes.view.";
  const LAST_KEY = "miko.md.notes.last.";
  // 单条 JSON-RPC 消息 ≤8 MiB，base64 有 4/3 膨胀，超过 5 MiB 的文件预先拒绝而不是等传输失败
  const MAX_UPLOAD = 5 * 1024 * 1024;
  const SAVE_LABEL = { saved: "statusSaved", unsaved: "statusUnsaved", saving: "statusSaving", failed: "statusFailed" };
  const S = {
    locale: "zh", connectionId: null, booted: false, vault: null, stats: null, tree: [], collapsed: new Set(), currentDir: "", entries: [],
    note: { path: "", name: "", modifiedAt: 0, dirty: false }, hits: null, searchTimer: null, viewMode: "split", autoSave: true,
    saveState: "saved", saveTimer: null, savingHandle: null, previewTimer: null, cursor: new Map(), bannerAction: null,
    pane: "tree", previewToken: 0, dragDepth: 0, lastError: "", drag: null, pd: null, dropHint: null,
    moveTarget: "", suppressClickUntil: 0
  };
  const dom = {};
  const lang = () => I18N[S.locale] || I18N.zh;

  function t(key, vars) {
    let s = lang()[key] == null ? String(key) : lang()[key];
    if (vars) for (const k in vars) s = s.split("{" + k + "}").join(String(vars[k]));
    return s;
  }

  /* ── 平台访问：能力位先探测，不靠试调用 ── */
  const plugin = () => window.dbxPlugin || null;
  const caps = () => (plugin() && plugin().capabilities) || {};
  const ft = () => { const p = plugin(); return p && p.fileTransfer ? p.fileTransfer : null; };
  const canFT = (sub) => { const c = caps().fileTransfer; return !!(ft() && c) && (typeof c === "boolean" ? c : !!c[sub]); };
  const canStorage = () => !!(plugin() && plugin().storage && caps().storage);

  function errInfo(e) {
    const raw = (e && (e.message || (e.error && e.error.message))) || String(e == null ? "" : e);
    const m = /^\s*([A-Z][A-Z0-9_]+)\s*:\s*/.exec(raw);
    let code = m ? m[1] : "";
    if (!code && /timeout|timed out/i.test(raw)) code = "TIMEOUT";
    const table = lang().errors, known = table[code];
    if (!known) return { code: code || "UNKNOWN", raw, message: raw || table.UNKNOWN };
    const detail = m ? raw.slice(m[0].length) : "";
    return { code, raw, message: detail ? known + " — " + detail : known };
  }
  function reportError(info) { S.lastError = info.message; renderStatus(); toast(info.message, "error"); }

  // 所有 RPC 的唯一入口：自动补 connectionId、统一超时、统一错误上报
  async function call(method, params, opts) {
    const o = opts || {}, p = Object.assign({}, params);
    if (S.connectionId && p.connectionId === undefined) p.connectionId = S.connectionId;
    const api = plugin();
    if (!api) throw errInfo(new Error("UNSUPPORTED: dbxPlugin unavailable"));
    try { return (await api.invoke(method, p, { timeoutMs: o.timeoutMs || T_NORMAL })) || {}; }
    catch (e) { const info = errInfo(e); if (!o.silent) reportError(info); throw info; }
  }

  /* ── DOM 小工具 ── */
  const $ = (id) => document.getElementById(id);
  const on = (id, ev, fn) => { const n = $(id); if (n) n.addEventListener(ev, fn); };

  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k === "dataset") Object.assign(n.dataset, v);
      else if (k === "value") n.value = v;
      else if (k === "checked") n.checked = !!v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    if (kids) (Array.isArray(kids) ? kids : [kids]).forEach((c) => {
      if (c != null && c !== false) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function toast(message, kind) {
    const node = el("div", { class: "toast" + (kind ? " is-" + kind : ""), text: message });
    node.addEventListener("click", () => node.remove());
    dom.toasts.appendChild(node);
    while (dom.toasts.children.length > 4) dom.toasts.firstChild.remove();
    setTimeout(() => node.remove(), kind === "error" ? 8000 : 4000);
  }

  /* ── 自制对话框：沙箱里没有 alert / confirm / prompt ── */
  const closeModal = () => { dom.modalRoot.hidden = true; dom.modalRoot.textContent = ""; };

  function showDialog(opts) {
    return new Promise((resolve) => {
      let inputEl = null, checkEl = null;
      const card = el("div", { class: "modal-card", role: "dialog", "aria-modal": "true" }, [el("h2", { class: "modal-title", text: opts.title || "" })]);
      if (opts.message) card.appendChild(el("p", { class: "modal-msg", text: opts.message }));
      if (opts.input) {
        card.appendChild(el("label", { class: "modal-label", text: opts.input.label || "" }));
        inputEl = el("input", { class: "modal-input", type: "text", value: opts.input.value || "", spellcheck: "false" });
        card.appendChild(inputEl);
      }
      if (opts.checkbox) {
        checkEl = el("input", { type: "checkbox", checked: !!opts.checkbox.checked });
        card.appendChild(el("label", { class: "modal-check" }, [checkEl, el("span", { text: opts.checkbox.label || "" })]));
      }
      const cancelBtn = el("button", { class: "btn", type: "button", text: t("cancel") });
      const okBtn = el("button", { class: "btn " + (opts.danger ? "btn-danger" : "btn-primary"), type: "button", text: opts.okText || t("ok") });
      card.appendChild(el("div", { class: "modal-actions" }, [cancelBtn, okBtn]));
      dom.modalRoot.textContent = "";
      dom.modalRoot.appendChild(el("div", { class: "modal-backdrop" }, card));
      dom.modalRoot.hidden = false;

      const finish = (ok) => {
        document.removeEventListener("keydown", onKey, true);
        closeModal();
        resolve({ ok: !!ok, value: inputEl ? inputEl.value.trim() : "", checked: checkEl ? checkEl.checked : false });
      };
      function onKey(e) {
        if (e.key === "Escape") { e.stopPropagation(); finish(false); }
        else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
      }
      document.addEventListener("keydown", onKey, true);
      cancelBtn.addEventListener("click", () => finish(false));
      okBtn.addEventListener("click", () => finish(true));
      if (inputEl) { inputEl.focus(); inputEl.select(); } else okBtn.focus();
    });
  }

  const askText = async (title, label, value) => {
    const r = await showDialog({ title, input: { label, value: value || "" } });
    return r.ok ? r.value : null;
  };
  async function askConfirm(title, message, opts) {
    const o = opts || {};
    const r = await showDialog({ title, message, checkbox: o.checkbox, danger: o.danger, okText: o.okText });
    return r.ok ? r : null;
  }

  // 长任务进度卡片：取消信号交给调用方决定收尾（backupEnd / restoreAbort）
  function showProgress(title, onCancel) {
    let cancelled = false;
    const fill = el("div", { class: "bar-fill" }), label = el("p", { class: "progress-label", text: "" });
    const btn = el("button", { class: "btn", type: "button", text: t("cancel") });
    const card = el("div", { class: "modal-card" }, [
      el("h2", { class: "modal-title", text: title }), el("div", { class: "bar" }, fill), label, el("div", { class: "modal-actions" }, btn)
    ]);
    dom.modalRoot.textContent = "";
    dom.modalRoot.appendChild(el("div", { class: "modal-backdrop" }, card));
    dom.modalRoot.hidden = false;
    btn.addEventListener("click", () => { cancelled = true; btn.disabled = true; if (onCancel) onCancel(); });
    return {
      get cancelled() { return cancelled; },
      set(pct, text) {
        if (typeof pct === "number") fill.style.width = Math.max(0, Math.min(100, pct)) + "%"; else fill.classList.add("is-indeterminate");
        if (text != null) label.textContent = text;
      },
      close: closeModal
    };
  }

  /* ── 自制右键菜单 ── */
  function menuOut(e) { if (!dom.menuRoot.contains(e.target)) hideMenu(); }
  const hideMenu = () => { dom.menuRoot.hidden = true; dom.menuRoot.textContent = ""; window.removeEventListener("mousedown", menuOut, true); };

  function showMenu(x, y, items) {
    hideMenu();
    const list = el("div", { class: "menu" });
    items.forEach((it) => {
      if (it.sep) return list.appendChild(el("div", { class: "menu-sep" }));
      const b = el("button", { class: "menu-item" + (it.danger ? " is-danger" : ""), type: "button", text: it.label });
      b.addEventListener("click", () => { hideMenu(); it.action(); });
      list.appendChild(b);
    });
    dom.menuRoot.appendChild(list);
    dom.menuRoot.hidden = false;
    const r = list.getBoundingClientRect();
    list.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + "px";
    list.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + "px";
    setTimeout(() => window.addEventListener("mousedown", menuOut, true), 0);
  }

  /* ── 路径 / 编码 / 计数 ── */
  const dirname = (p) => { const i = (p || "").lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };

  function resolveRel(baseDir, rel) {
    const parts = baseDir ? baseDir.split("/") : [];
    rel.split("/").forEach((seg) => {
      if (!seg || seg === ".") return;
      if (seg === "..") { parts.pop(); return; }
      parts.push(seg);
    });
    return parts.join("/");
  }

  function bytesToBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64 || ""), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function concatBytes(list) {
    let len = 0, off = 0;
    list.forEach((b) => { len += b.length; });
    const out = new Uint8Array(len);
    list.forEach((b) => { out.set(b, off); off += b.length; });
    return out;
  }
  function fmtBytes(n) {
    if (!n) return "0 B";
    if (n < 1024) return n + " B";
    return n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
  }
  // 中日韩按字、拉丁按词，混排两种都要计入
  function countWords(text) {
    const s = String(text || ""), cjkRe = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
    return (s.match(cjkRe) || []).length + (s.replace(cjkRe, " ").match(/[A-Za-z0-9_-]+/g) || []).length;
  }

  /* ── 渲染：静态文案 / 状态栏 / 顶栏 ── */
  function applyStaticI18n() {
    document.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = t(n.dataset.i18n); });
    document.querySelectorAll("[data-i18n-ph]").forEach((n) => { n.setAttribute("placeholder", t(n.dataset.i18nPh)); });
    document.querySelectorAll("[data-i18n-title]").forEach((n) => { n.setAttribute("title", t(n.dataset.i18nTitle)); });
    dom.nocTitle.textContent = t("noContextTitle");
    dom.nocBody.textContent = t("noContextBody");
    dom.nocHint.textContent = t("noContextHint");
    renderStatus(); renderViewButtons(); renderDocTitle();
  }
  const setSaveState = (next) => { S.saveState = next; renderStatus(); };

  function renderStatus() {
    if (!dom.statusPath) return;
    dom.statusPath.textContent = "/" + (S.note.path || S.currentDir);
    dom.statusWords.textContent = countWords(dom.editor.value) + " " + lang().words;
    dom.statusSave.textContent = t(SAVE_LABEL[S.saveState] || "statusSaved");
    dom.statusSave.className = "st-save" + (S.saveState === "failed" ? " is-error" : S.saveState === "unsaved" ? " is-dirty" : "");
    dom.statusMsg.textContent = S.lastError || "";
    dom.statusMsg.classList.toggle("is-error", !!S.lastError);
  }

  function renderViewButtons() {
    dom.viewButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.view === S.viewMode));
    dom.editorBody.dataset.view = S.viewMode;
  }

  function renderDocTitle() {
    if (!dom.docTitle) return;
    const has = !!S.note.path, empty = !S.stats || !S.stats.notes;
    dom.docTitle.textContent = S.note.path;
    dom.editor.disabled = !has; dom.placeholder.hidden = has; dom.exportBtn.disabled = !has;
    if (has) return;
    dom.phTitle.textContent = empty ? t("emptyTitle") : t("listEmpty");
    dom.phBody.textContent = empty ? t("emptyBody") : "";
    $("ph-import").hidden = !empty;
  }

  function renderTopbar() {
    if (!dom.vaultName) return;
    if (S.vault) dom.vaultName.textContent = S.vault.name || "MIKO.MD";
    const st = S.stats;
    dom.vaultStats.textContent = st ? st.notes + " · " + st.folders + " · " + fmtBytes(st.bytes) : "";
    dom.treeCount.textContent = String(S.hits ? S.hits.length : (st ? st.notes : 0));
  }

  /* ── 渲染：目录树 ── */
  function renderTree() {
    if (!dom.tree) return;
    dom.tree.textContent = "";
    if (S.hits) return renderHits();
    if (!S.tree.length) return dom.tree.appendChild(el("div", { class: "empty-hint", text: t("treeEmpty") }));
    const frag = document.createDocumentFragment();
    S.tree.forEach((n) => frag.appendChild(treeNode(n)));
    dom.tree.appendChild(frag);
  }

  // DBX 风格折角箭头：12px 线描 chevron，展开时旋转 90°
  const SVG_NS = "http://www.w3.org/2000/svg";
  function chevron(open) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "twisty" + (open ? " is-open" : ""));
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M6 3.75 10.25 8 6 12.25");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.7");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function lineIcon(kind) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "ico");
    svg.setAttribute("aria-hidden", "true");
    const d = kind === "dir"
      ? "M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.2 1.6h5.2A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
      : "M4 2.5h5l3 3v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Zm5 .5v3h3";
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.3");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function treeNode(node) {
    const isDir = node.kind === "dir", collapsed = isDir && S.collapsed.has(node.path);
    const row = el("div", {
      class: "tree-row" + (node.path === S.note.path ? " is-current" : "")
        + (node.kind === "file" ? " is-muted" : "") + (isDir ? " is-dir" : "") + (isDir && !collapsed ? " is-open" : ""),
      dataset: { path: node.path, kind: node.kind }
    }, [
      isDir ? chevron(!collapsed) : el("span", { class: "twisty" }),
      lineIcon(isDir ? "dir" : "note"),
      el("span", { class: "label", text: node.name }),
      isDir && node.noteCount ? el("span", { class: "node-count", text: String(node.noteCount) }) : null
    ]);
    row.addEventListener("click", () => {
      if (Date.now() < (S.suppressClickUntil || 0)) return;   // 刚拖完，别顺手把笔记打开
      onTreeActivate(node);
    });
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, node); });

    // 拖拽移动走 pointer 事件（见 bindTreeDrag）：沙箱 iframe 里的 HTML5 DnD 在 WebKit 上不可靠
    const wrap = el("div", {}, row);
    if (isDir && !collapsed && node.children && node.children.length) {
      const kids = el("div", { class: "tree-kids" });
      node.children.forEach((c) => kids.appendChild(treeNode(c)));
      wrap.appendChild(kids);
    } else if (isDir && !collapsed && node.truncated) wrap.appendChild(el("div", { class: "tree-kids empty-hint", text: "…" }));
    return wrap;
  }

  function clearDropHints() {
    if (!dom.tree) return;
    dom.tree.querySelectorAll(".is-drop-hover, .is-drop-child, .is-drop-sibling, .is-drop-before, .is-drop-after, .is-drop-invalid")
      .forEach((n) => n.classList.remove("is-drop-hover", "is-drop-child", "is-drop-sibling", "is-drop-before", "is-drop-after", "is-drop-invalid"));
    dom.tree.classList.remove("is-drop-root");
  }

  // 不能把文件夹拖进自己或自己的子孙；不能落到它当前所在的目录
  function canDropInto(drag, targetDir) {
    if (!drag || !drag.path) return false;
    if (drag.kind === "dir" && (targetDir === drag.path || targetDir.indexOf(drag.path + "/") === 0)) return false;
    if (dirname(drag.path) === targetDir) return false;
    return true;
  }

  function dropRejectReason(drag, targetDir) {
    if (drag.kind === "dir" && (targetDir === drag.path || targetDir.indexOf(drag.path + "/") === 0)) return t("moveSelf");
    return t("moveSameDir");
  }

  function rowFromEvent(e) {
    const raw = e.target;
    const node = raw && raw.nodeType === 3 ? raw.parentElement : raw;
    return node && node.closest ? node.closest(".tree-row") : null;
  }

  // 指针在目标行内的垂直位置决定三档：上 1/3 = 放到同级（父目录）、下 1/3 = 同级、
  // 中间 1/3 = 放进这个文件夹（下级）。不在任何行上 = 根目录。
  function hintFor(rowEl, clientY) {
    const drag = S.drag;
    if (!drag) return null;
    if (!rowEl) {
      const ok = canDropInto(drag, "");
      return { row: null, targetDir: "", mode: "root", valid: ok, reason: ok ? "" : dropRejectReason(drag, "") };
    }
    const path = rowEl.dataset.path || "";
    const kind = rowEl.dataset.kind || "";
    const rect = rowEl.getBoundingClientRect ? rowEl.getBoundingClientRect() : { top: 0, height: 0 };
    const h = rect.height || 0;
    // 没有布局信息（测试环境）时按"放进这个文件夹"处理
    const ratio = h > 0 ? (clientY - rect.top) / h : 0.5;
    let mode, targetDir;
    if (kind === "dir" && ratio > 0.3 && ratio < 0.7) {
      mode = "child";
      targetDir = path;
    } else {
      mode = ratio < 0.5 ? "sibling-before" : "sibling-after";
      targetDir = dirname(path);
    }
    const valid = canDropInto(drag, targetDir);
    return { row: rowEl, targetDir, mode, valid, reason: valid ? "" : dropRejectReason(drag, targetDir) };
  }

  function paintDropHint(hint) {
    clearDropHints();
    if (!hint) return;
    if (!hint.row) { dom.tree.classList.add("is-drop-root"); return; }
    hint.row.classList.add("is-drop-hover");
    if (hint.mode === "child") hint.row.classList.add("is-drop-child");
    else {
      hint.row.classList.add("is-drop-sibling");
      hint.row.classList.add(hint.mode === "sibling-before" ? "is-drop-before" : "is-drop-after");
    }
    if (!hint.valid) hint.row.classList.add("is-drop-invalid");
  }

  async function moveNode(drag, targetDir) {
    if (!canDropInto(drag, targetDir)) {
      const self = drag.kind === "dir" && (targetDir === drag.path || targetDir.indexOf(drag.path + "/") === 0);
      toast(self ? t("moveSelf") : t("moveSameDir"), "error");
      return;
    }
    try {
      const res = await call("notes/move", { path: drag.path, targetDir });
      const movedPath = res.path || joinRelPath(targetDir, drag.path.split("/").pop());
      // 当前打开的笔记被移动（或是被移动文件夹里的笔记）时跟着换路径，编辑内容不动
      if (S.note.path === drag.path || S.note.path.indexOf(drag.path + "/") === 0) {
        S.note.path = movedPath + S.note.path.slice(drag.path.length);
        S.currentDir = dirname(S.note.path);
      } else {
        S.currentDir = targetDir;
      }
      S.collapsed.delete(targetDir);
      await refreshTree();
      renderTopbar(); renderStatus(); renderDocTitle();
      toast(t("movedTo", { dir: targetDir || "/" }), "ok");
    } catch (e) {
      reportError(errInfo(e));
      await refreshTree();
    }
  }

  function joinRelPath(dir, name) {
    return dir ? dir + "/" + name : name;
  }

  function onTreeActivate(node) {
    if (node.kind === "dir") {
      // 只有树，没有二级列表：点文件夹就是把它的子项展开/收起，同时把它作为新笔记的落点
      if (S.collapsed.has(node.path)) S.collapsed.delete(node.path); else S.collapsed.add(node.path);
      S.currentDir = node.path;
      if (S.hits) S.hits = null;
      renderTree(); renderTopbar();
      return;
    }
    if (node.kind === "file") return toast(t("errors").NOT_A_NOTE, "error");
    openNote(node.path);
  }

  /* ── 渲染：搜索命中（直接占用目录树位置，不再有二级列表） ── */
  function renderHits() {
    const frag = document.createDocumentFragment();
    const head = el("div", { class: "tree-tools hits-head" }, [
      el("span", { class: "hits-title", text: t("resultsTitle") + " · " + S.hits.length }),
      el("button", { class: "btn btn-small", type: "button", text: t("clearSearch"), onclick: () => clearSearch() }),
    ]);
    frag.appendChild(head);
    if (!S.hits.length) { frag.appendChild(el("div", { class: "empty-hint", text: t("noResults") })); dom.tree.appendChild(frag); return; }
    S.hits.forEach((hit) => {
      const row = el("div", { class: "hit-row" + (hit.path === S.note.path ? " is-current" : ""), dataset: { path: hit.path } }, [
        el("div", { class: "row-top" }, [
          el("span", { class: "label", text: hit.title || hit.name }),
          el("span", { class: "row-meta", text: "L" + hit.line }),
        ]),
        el("div", { class: "row-snippet", text: hit.snippet || hit.text || "" }),
      ]);
      row.addEventListener("click", () => { openNote(hit.path, { line: hit.line }); });
      frag.appendChild(row);
    });
    dom.tree.appendChild(frag);
  }

  function clearSearch() {
    S.hits = null;
    if (dom.search) dom.search.value = "";
    renderTree(); renderTopbar();
  }

  async function refreshAll() {
    if (!S.connectionId) return;
    try {
      const info = await call("notes/info", {});
      S.vault = info.vault || null; S.stats = info.stats || null;
    } catch (e) { /* call 已提示 */ }
    await refreshTree();
    renderTopbar(); renderDocTitle();
    await syncCurrentWithDisk();
  }

  // 笔记树只呈现笔记与文件夹。图片、附件、_assets 目录交给 mdnotes:// 文件浏览器，
  // 否则每个附件都变成树上的一行噪音。
  function isAssetsPath(rel) {
    const assets = (S.vault && S.vault.assetsDir) || "";
    return !!assets && (rel === assets || String(rel).startsWith(assets + "/"));
  }
  function pruneTree(nodes) {
    const out = [];
    (nodes || []).forEach((n) => {
      if (n.kind === "file") return;
      if (n.kind === "dir") {
        if (isAssetsPath(n.path)) return;
        out.push(Object.assign({}, n, { children: pruneTree(n.children) }));
        return;
      }
      out.push(n);
    });
    return out;
  }
  function pruneEntries(entries) {
    return (entries || []).filter((e) => e.kind !== "file" && !isAssetsPath(e.path));
  }

  async function refreshTree() {
    try { S.tree = pruneTree((await call("notes/tree", { dir: "", depth: 6 }, { silent: true })).nodes); }
    catch (e) { S.tree = []; reportError(errInfo(e)); }
    renderTree();
  }

  async function diskModifiedAt(path) {
    try {
      const res = await call("notes/list", { dir: dirname(path) }, { silent: true });
      const found = (res.entries || []).find((x) => x.path === path);
      return found ? found.modifiedAt : null;
    } catch (e) { return null; }
  }

  // 刷新时对齐磁盘：本地干净就静默重载，有未保存改动才打断用户
  async function syncCurrentWithDisk() {
    if (!S.note.path) return;
    const disk = await diskModifiedAt(S.note.path);
    if (disk == null) return showBanner("deleted");
    if (disk === S.note.modifiedAt) return;
    if (S.note.dirty) return showBanner("conflict");
    await reloadCurrent(true);
  }

  function showBanner(kind) {
    const d = lang();
    S.bannerAction = kind;
    dom.banner.hidden = false;
    dom.bannerText.textContent = kind === "deleted" ? d.conflictDeleted : kind === "save" ? d.conflictSaveTitle : d.conflictTitle;
    dom.bannerPrimary.textContent = kind === "deleted" ? d.refresh : d.conflictReload;
    dom.bannerSecondary.textContent = kind === "deleted" ? d.menuCopyPath : d.conflictKeep;
  }
  const hideBanner = () => { S.bannerAction = null; dom.banner.hidden = true; };

  /* ── 渲染：预览 ── */
  const schedulePreview = () => { clearTimeout(S.previewTimer); S.previewTimer = setTimeout(() => { renderPreview(); }, 120); };

  async function renderPreview() {
    if (!dom.preview) return;
    const token = ++S.previewToken, text = dom.editor.value;
    const html = window.MikoMarkdown ? window.MikoMarkdown.render(text) : "";
    dom.preview.textContent = "";
    dom.preview.classList.toggle("is-empty", !text.trim());
    dom.preview.dataset.empty = t("emptyBody");
    // 唯一允许的 HTML 注入点：内容已在渲染器内部整体转义
    if (html) dom.preview.innerHTML = html;
    if (token !== S.previewToken) return;
    normalizeLinks();
    await hydrateImages(token);
  }

  function normalizeLinks() {
    const canOpen = !!(caps().openUrl && typeof plugin().openUrl === "function");
    dom.preview.querySelectorAll("a[data-external]").forEach((a) => {
      if (canOpen) return a.classList.add("is-external");
      a.replaceWith(el("span", { class: "md-link-plain", text: a.textContent }));
    });
  }

  // 图片先用 data-rel 占位，插进 DOM 后再换 data: URL；并发 4，失败留占位框
  async function hydrateImages(token) {
    const imgs = Array.from(dom.preview.querySelectorAll("img[data-rel]"));
    if (!imgs.length) return;
    const baseDir = dirname(S.note.path);
    let idx = 0;
    const worker = async () => {
      while (idx < imgs.length) {
        const img = imgs[idx++];
        if (token !== S.previewToken) return;
        const rel = img.getAttribute("data-rel") || "";
        const target = rel.charAt(0) === "/" ? rel.slice(1) : resolveRel(baseDir, rel);
        try {
          const res = await call("notes/readAsset", { path: target, maxBytes: 4194304 }, { silent: true });
          if (!res.dataBase64) throw new Error("IO_ERROR: empty image");
          img.src = "data:" + (res.contentType || "application/octet-stream") + ";base64," + res.dataBase64;
        } catch (e) {
          img.classList.add("is-missing"); img.removeAttribute("data-rel"); img.title = errInfo(e).message;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  /* ── 刷新 ── */

  /* ── 笔记读写 ── */
  const blankNote = () => ({ path: "", name: "", modifiedAt: 0, dirty: false });

  function rememberCursor() {
    if (!S.note.path || !dom.editor) return;
    S.cursor.set(S.note.path, { start: dom.editor.selectionStart, end: dom.editor.selectionEnd, scroll: dom.editor.scrollTop });
  }

  function restoreCursor(path) {
    const pos = S.cursor.get(path);
    if (!pos) { dom.editor.scrollTop = 0; return; }
    try { dom.editor.setSelectionRange(pos.start, pos.end); } catch (e) { /* 内容变短时忽略 */ }
    dom.editor.scrollTop = pos.scroll || 0;
  }

  async function openNote(path, opts) {
    if (!path) return;
    if (path === S.note.path) { if (opts && opts.line) revealLine(opts.line); return; }
    await flushSave();
    rememberCursor();
    try {
      const data = await call("notes/read", { path });
      S.note = { path: data.path, name: data.name, modifiedAt: data.modifiedAt, dirty: false };
      dom.editor.value = data.content || "";
      hideBanner(); S.lastError = ""; setSaveState("saved"); setTitleSafe(data.name);
      S.currentDir = dirname(data.path);
      expandAncestors(data.path);
      rememberLast(data.path);
      renderDocTitle(); renderTree(); renderPreview(); restoreCursor(data.path); renderStatus(); setPane("editor");
      if (opts && opts.line) revealLine(opts.line);
    } catch (e) { if (e && e.code === "NOT_A_NOTE") toast(t("errors").NOT_A_NOTE, "error"); }
  }

  async function reloadCurrent(silent) {
    if (!S.note.path) return;
    try {
      const data = await call("notes/read", { path: S.note.path }, { silent: !!silent });
      S.note.modifiedAt = data.modifiedAt; S.note.name = data.name; S.note.dirty = false;
      dom.editor.value = data.content || "";
      hideBanner(); setSaveState("saved"); renderPreview();
    } catch (e) { if (!silent) reportError(errInfo(e)); }
  }

  // 保留本地修改：把磁盘 modifiedAt 当新基线，下一次写入即为覆盖
  async function keepMine() {
    const disk = await diskModifiedAt(S.note.path);
    if (disk != null) S.note.modifiedAt = disk;
    hideBanner();
    await saveNote(true);
  }

  function scheduleSave() {
    if (!S.autoSave) return;
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => { saveNote(false); }, 800);
  }
  const markDirty = () => { if (!S.note.path) return; S.note.dirty = true; setSaveState("unsaved"); scheduleSave(); };

  async function saveNote(force) {
    if (!S.note.path) return true;
    if (S.savingHandle) return S.savingHandle;
    if (!S.note.dirty && !force) return true;
    const path = S.note.path, content = dom.editor.value, expected = S.note.modifiedAt;
    setSaveState("saving");
    S.savingHandle = (async () => {
      try {
        const res = await call("notes/write", { path, content, expectedModifiedAt: expected });
        if (S.note.path === path) {
          S.note.modifiedAt = res.modifiedAt;
          if (dom.editor.value === content) { S.note.dirty = false; setSaveState("saved"); }
          else { setSaveState("unsaved"); scheduleSave(); }
          setTitleSafe(S.note.name);
        }
        return true;
      } catch (e) {
        if (S.note.path === path) setSaveState("failed");
        if (e && e.code === "CONFLICT") showBanner("save");
        return false;
      } finally { S.savingHandle = null; }
    })();
    return S.savingHandle;
  }

  async function flushSave() {
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    if (S.savingHandle) await S.savingHandle;
    if (S.note.dirty) await saveNote(true);
  }

  function closeNote() {
    rememberCursor();
    S.note = blankNote();
    dom.editor.value = ""; dom.preview.textContent = ""; S.lastError = "";
    hideBanner(); setSaveState("saved"); setTitleSafe(null); renderDocTitle(); renderTree();
  }

  function setTitleSafe(title) {
    const api = plugin();
    if (!api || typeof api.setTitle !== "function") return;
    try { api.setTitle(title || null); } catch (e) { /* 标题失败不影响编辑 */ }
  }

  function revealLine(lineNo) {
    const lines = dom.editor.value.split("\n");
    const n = Math.max(1, Math.min(lineNo || 1, lines.length));
    let pos = 0;
    for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1;
    dom.editor.focus();
    try { dom.editor.setSelectionRange(pos, pos + (lines[n - 1] || "").length); } catch (e) { /* ignore */ }
    dom.editor.scrollTop = Math.max(0, (n - 3) * (parseFloat(getComputedStyle(dom.editor).lineHeight) || 20));
    setViewMode("edit");
  }

  /* ── 编辑器操作 ── */
  function insertText(text, replStart, replEnd, selStart, selEnd) {
    const ta = dom.editor;
    const s = replStart == null ? ta.selectionStart : replStart, e = replEnd == null ? ta.selectionEnd : replEnd;
    if (typeof ta.setRangeText === "function") ta.setRangeText(text, s, e, "end");
    else ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    if (selStart != null) { try { ta.setSelectionRange(selStart, selEnd == null ? selStart : selEnd); } catch (err) { /* ignore */ } }
    ta.focus();
    markDirty(); schedulePreview(); renderStatus();
  }

  function wrapSel(before, after, placeholder) {
    const ta = dom.editor, s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || placeholder || "";
    insertText(before + sel + after, s, e, s + before.length, s + before.length + sel.length);
  }

  function transformLines(fn) {
    const ta = dom.editor;
    const start = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    let end = ta.value.indexOf("\n", ta.selectionEnd);
    if (end < 0) end = ta.value.length;
    const out = ta.value.slice(start, end).split("\n").map(fn).join("\n");
    insertText(out, start, end, start, start + out.length);
  }

  const TOOLBAR = {
    h1: () => transformLines((l) => "# " + l.replace(/^#{1,6}\s+/, "")),
    h2: () => transformLines((l) => "## " + l.replace(/^#{1,6}\s+/, "")),
    p: () => transformLines((l) => l.replace(/^#{1,6}\s+/, "")),
    bold: () => wrapSel("**", "**", "bold"), italic: () => wrapSel("*", "*", "italic"),
    code: () => wrapSel("`", "`", "code"), codeblock: () => wrapSel("```\n", "\n```", "code"),
    link: () => wrapSel("[", "](https://)", "text"), ul: () => transformLines((l) => "- " + l),
    task: () => transformLines((l) => "- [ ] " + l), quote: () => transformLines((l) => "> " + l),
    hr: () => insertText("\n\n---\n\n"),
    image: async () => { const p = await askText(t("tbImage"), t("imagePathLabel"), ""); if (p) insertText("![](" + p + ")"); }
  };

  /* ── 新建 / 重命名 / 删除 ── */
  async function actionNewNote(dir) {
    const title = await askText(t("newNoteTitle"), t("newNoteLabel"), "");
    if (title == null) return;
    await flushSave();
    try {
      const res = await call("notes/create", { dir: dir == null ? S.currentDir : dir, title: title || undefined });
      await refreshTree(); await openNote(res.path);
      dom.editor.focus();
    } catch (e) { /* 已提示 */ }
  }

  async function actionNewFolder(dir) {
    const name = await askText(t("newFolderTitle"), t("newFolderLabel"), "");
    if (!name) return;
    try {
      await call("notes/mkdir", { dir: dir == null ? S.currentDir : dir, name });
      await refreshTree();
    } catch (e) { /* 已提示 */ }
  }

  async function actionRename(node) {
    const next = await askText(t("renameTitle"), t("renameLabel"), node.name);
    if (!next || next === node.name) return;
    try {
      const res = await call("notes/rename", { path: node.path, newName: next });
      const wasOpen = S.note.path === node.path;
      await refreshTree();
      if (wasOpen) { S.note = blankNote(); await openNote(res.path); }
    } catch (e) { /* 已提示 */ }
  }

  async function actionDelete(node) {
    const isDir = node.kind === "dir";
    const r = await askConfirm(t("deleteTitle"),
      isDir ? t("deleteDirBody", { name: node.name }) : t("deleteNoteBody", { name: node.name }),
      { checkbox: { label: t("deletePermanent") }, danger: true });
    if (!r) return;
    try {
      const res = await call("notes/delete", { path: node.path, permanent: !!r.checked });
      if (S.note.path === node.path || S.note.path.indexOf(node.path + "/") === 0) closeNote();
      await refreshTree();
      if (res.trashedTo) toast(".trash → " + res.trashedTo, "ok");
    } catch (e) { /* 已提示 */ }
  }

  /* ── 导出 / 存盘 ── */
  async function actionExport() {
    if (!S.note.path) return toast(t("noNote"), "error");
    try {
      const res = await call("notes/exportNote", { path: S.note.path }, { timeoutMs: T_LONG });
      const name = res.name || S.note.name || "note.md";
      await saveBytesToDisk(name, base64ToBytes(res.dataBase64), res.contentType || "text/markdown; charset=utf-8");
      toast(t("exportDone", { name }), "ok");
    } catch (e) { /* 已提示 */ }
  }

  async function saveBytesToDisk(name, bytes, contentType) {
    const api = ft();
    if (api && canFT("beginSave")) {
      const target = await api.beginSave({ name, contentType, size: bytes.length });
      if (!target) return false;
      const chunk = target.chunkBytes || 1048576;
      for (let off = 0; off < bytes.length; off += chunk) await api.write(target.handleId, off, bytes.subarray(off, Math.min(off + chunk, bytes.length)));
      await api.finish(target.handleId);
      return true;
    }
    downloadBlob(name, bytes, contentType);
    return true;
  }

  function downloadBlob(name, bytes, contentType) {
    const url = URL.createObjectURL(new Blob([bytes], { type: contentType || "application/octet-stream" }));
    const a = el("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会被某些 WebView 当成取消下载，延后释放
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ── 文件读取：句柄 / File 两条路径 ── */
  async function readHandleBytes(handleId) {
    const chunks = [];
    let offset = 0;
    for (;;) {
      const r = await ft().read(handleId, offset, 262144);
      const bytes = base64ToBytes(r && r.dataBase64);
      if (bytes.length) chunks.push(bytes);
      offset += (r && r.length) || bytes.length;
      if (!r || r.eof || !bytes.length) break;
    }
    return concatBytes(chunks);
  }

  const fileBytes = async (file) => new Uint8Array(await file.arrayBuffer());
  const isMarkdownName = (name) => /\.(md|markdown)$/i.test(name || "");
  const isImageName = (name, ct) => (ct && /^image\//i.test(ct)) || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name || "");

  function pickFilesViaInput(input) {
    return new Promise((resolve) => {
      input.value = "";
      const once = () => { input.removeEventListener("change", once); resolve(Array.from(input.files || [])); };
      input.addEventListener("change", once);
      input.click();
    });
  }

  async function pickHandles(multiple, accept) {
    const api = ft();
    if (!api || !canFT("pick")) return null;
    const picked = await api.pick({ multiple: !!multiple, accept: accept || undefined });
    return Array.isArray(picked) ? picked : (picked && picked.files) || [];
  }
  async function cancelHandle(handleId) {
    if (handleId && ft() && typeof ft().cancel === "function") { try { await ft().cancel(handleId); } catch (e) { /* ignore */ } }
  }

  /* ── 导入 ── */
  async function importItems(items) {
    if (!items.length) return;
    const prog = showProgress(t("importing"), null), opened = [];
    let imported = 0, skipped = 0;
    try {
      for (let i = 0; i < items.length; i++) {
        if (prog.cancelled) break;
        prog.set(Math.round((i / items.length) * 100), i + 1 + " / " + items.length);
        const it = items[i];
        if (it.bytes.length > MAX_UPLOAD) { skipped++; continue; }
        try {
          const res = await call("notes/importFile", {
            name: it.name, relativePath: it.relativePath || "", dataBase64: bytesToBase64(it.bytes)
          }, { timeoutMs: T_LONG });
          imported++;
          if (isMarkdownName(res.path)) opened.push(res.path);
        } catch (e) { skipped++; }
      }
    } finally { prog.close(); }
    await refreshTree();
    if (imported) toast(t("importDone", { n: imported }), "ok");
    if (skipped) toast(t("importSkipped", { n: skipped }), "error");
    if (opened.length) await openNote(opened[0]);
  }

  async function actionImportMd() {
    try {
      const handles = await pickHandles(true, ".md,.markdown");
      if (handles === null) {
        const items = [];
        for (const f of await pickFilesViaInput(dom.fileInput)) {
          if (isMarkdownName(f.name)) items.push({ name: f.name, relativePath: f.webkitRelativePath || "", bytes: await fileBytes(f) });
        }
        return importItems(items);
      }
      if (!handles.length) return;
      const prog = showProgress(t("importing"), null), items = [];
      try {
        for (let i = 0; i < handles.length; i++) {
          const h = handles[i];
          if (!isMarkdownName(h.name)) continue;
          prog.set(Math.round((i / handles.length) * 100), h.name);
          items.push({ name: h.name, relativePath: h.relativePath || "", bytes: await readHandleBytes(h.handleId) });
          await cancelHandle(h.handleId);
        }
      } finally { prog.close(); }
      await importItems(items);
    } catch (e) { reportError(errInfo(e)); }
  }

  async function actionImportFolder() {
    const r = await showDialog({
      title: t("importFolderTitle"), message: t("importFolderHint"), input: { label: t("importFolderLabel"), value: "" }
    });
    if (!r.ok || !r.value) return;
    try {
      const res = await call("notes/importFolder", { sourcePath: r.value }, { timeoutMs: T_LONG });
      await refreshTree();
      toast(t("importDone", { n: res.imported || 0 }), "ok");
    } catch (e) { /* 已提示 */ }
  }

  /* ── 备份 ── */
  async function actionBackup() {
    let handle = null, prog = null, target = null, cancelled = false;
    const api = ft();
    try {
      const begin = await call("notes/backupBegin", { includeTrash: false }, { timeoutMs: T_LONG });
      handle = begin.handle;
      const total = begin.size || 0;
      prog = showProgress(t("backupRunning"), () => { cancelled = true; });
      if (api && canFT("beginSave")) target = await api.beginSave({ name: begin.name, contentType: "application/zip", size: total });
      const chunks = [];
      let offset = 0;
      for (let guard = 0; guard < 100000; guard++) {
        if (cancelled) break;
        const r = await call("notes/backupRead", { handle, offset, length: 1048576 }, { timeoutMs: T_LONG });
        const bytes = base64ToBytes(r.dataBase64);
        if (target) { if (bytes.length) await api.write(target.handleId, offset, bytes); } else if (bytes.length) chunks.push(bytes);
        offset += bytes.length;
        prog.set(total ? Math.min(100, Math.round((offset / total) * 100)) : null, fmtBytes(offset) + " / " + fmtBytes(total));
        if (r.eof || !bytes.length) break;
      }
      // 成功或取消都要清掉后端临时 zip
      await call("notes/backupEnd", { handle }, { silent: true });
      handle = null;
      prog.close(); prog = null;
      if (cancelled) {
        if (target) await api.cancel(target.handleId);
        return toast(t("cancelled"), "error");
      }
      if (target) await api.finish(target.handleId);
      else if (chunks.length) downloadBlob(begin.name, concatBytes(chunks), "application/zip");
      else return;
      toast(t("backupDone", { name: begin.name }), "ok");
    } catch (e) {
      if (prog) prog.close();
      if (handle) await call("notes/backupEnd", { handle }, { silent: true }).catch(() => {});
      reportError(errInfo(e));
    }
  }

  /* ── 恢复 ── */
  async function actionRestore() {
    try {
      let bytes = null, name = "backup.zip";
      const handles = await pickHandles(false, ".zip,application/zip");
      if (handles === null) {
        const files = await pickFilesViaInput(dom.zipInput);
        if (!files.length) return;
        name = files[0].name; bytes = await fileBytes(files[0]);
      } else {
        if (!handles.length) return;
        name = handles[0].name || name;
        bytes = await readHandleBytes(handles[0].handleId);
        await cancelHandle(handles[0].handleId);
      }
      if (!bytes || !bytes.length) return;
      const choice = await askConfirm(t("restoreTitle"), t("restoreBody"), { checkbox: { label: t("overwriteLabel"), checked: false } });
      if (!choice) return;
      const begin = await call("notes/restoreBegin", {}, { timeoutMs: T_LONG });
      const handle = begin.handle, prog = showProgress(t("restoreRunning"), null);
      try {
        for (let off = 0; off < bytes.length; off += 1048576) {
          if (prog.cancelled) break;
          const part = bytes.subarray(off, Math.min(off + 1048576, bytes.length));
          await call("notes/restoreChunk", { handle, dataBase64: bytesToBase64(part) }, { timeoutMs: T_LONG });
          prog.set(Math.round(((off + part.length) / bytes.length) * 100), name);
        }
        if (prog.cancelled) {
          prog.close();
          await call("notes/restoreAbort", { handle }, { silent: true });
          return toast(t("cancelled"), "error");
        }
        const res = await call("notes/restoreCommit", { handle, overwrite: !!choice.checked }, { timeoutMs: T_LONG });
        prog.close();
        toast(t("restoreDone", { restored: res.restored || 0, skipped: res.skipped || 0 }), "ok");
        await refreshAll();
      } catch (e) {
        prog.close();
        await call("notes/restoreAbort", { handle }, { silent: true }).catch(() => {});
        throw e;
      }
    } catch (e) { reportError(errInfo(e)); }
  }

  /* ── 文件浏览器 / 粘贴图片 ── */
  async function actionOpenFs() {
    const api = plugin();
    if (!api || typeof api.openFilesystem !== "function") return toast(t("errors").UNSUPPORTED, "error");
    try { await api.openFilesystem("miko.md.notes.fs", { connectionId: S.connectionId }); }
    catch (e) { reportError(errInfo(e)); }
  }

  async function onPaste(e) {
    if (!e.clipboardData) return;
    const images = Array.from(e.clipboardData.items || []).filter((it) => it.kind === "file" && String(it.type || "").indexOf("image/") === 0);
    if (!images.length) return; // 纯文本粘贴保持浏览器默认行为
    e.preventDefault();
    for (const item of images) {
      const file = item.getAsFile();
      if (!file) continue;
      if (file.size > MAX_UPLOAD) { toast(t("fileTooLarge", { name: file.name || "image" }), "error"); continue; }
      try {
        const res = await call("notes/saveImage", {
          notePath: S.note.path, name: file.name || "", dataBase64: bytesToBase64(await fileBytes(file)), mimeType: file.type || ""
        }, { timeoutMs: T_LONG });
        insertText(res.markdown);
        toast(t("imageInserted", { name: res.name }), "ok");
        refreshTree();
      } catch (err) { /* 已提示 */ }
    }
  }

  /* ── 拖放 ── */
  const setDropActive = (active) => { dom.dropOverlay.hidden = !active; dom.shell.classList.toggle("is-dropping", !!active); };
  const classifyDrop = (name, ct) => (isImageName(name, ct) ? "image" : isMarkdownName(name) ? "note" : "skip");

  async function handleDropFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const images = [], notes = [];
    let skipped = 0;
    const prog = showProgress(t("importing"), null);
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i], kind = classifyDrop(f.name, f.contentType);
        if (kind === "skip") { skipped++; continue; }
        prog.set(Math.round((i / list.length) * 100), f.name || "");
        let bytes;
        try { bytes = f.handleId ? await readHandleBytes(f.handleId) : await fileBytes(f); }
        catch (e) { skipped++; continue; }
        // relativePath 含 "/" 说明来自文件夹：逐文件导入即可保留目录结构
        if (kind === "image") images.push({ name: f.name, bytes, mime: f.contentType || "" });
        else notes.push({ name: f.name, relativePath: f.relativePath || "", bytes });
        await cancelHandle(f.handleId);
      }
      prog.close();
      let inserted = 0;
      for (const img of images) {
        if (!S.note.path) { toast(t("noNote"), "error"); break; }
        if (img.bytes.length > MAX_UPLOAD) { toast(t("fileTooLarge", { name: img.name }), "error"); continue; }
        try {
          const res = await call("notes/saveImage", {
            notePath: S.note.path, name: img.name, dataBase64: bytesToBase64(img.bytes), mimeType: img.mime
          }, { timeoutMs: T_LONG });
          insertText(res.markdown + "\n");
          inserted++;
        } catch (e) { /* 已提示 */ }
      }
      if (notes.length) await importItems(notes);
      else if (inserted) await refreshTree();
      if (skipped) toast(t("importSkipped", { n: skipped }), "error");
    } catch (e) { prog.close(); reportError(errInfo(e)); }
  }

  function bindDrop() {
    const api = ft();
    if (api && canFT("drop") && typeof api.onDrop === "function") {
      api.onDrop(async (files) => { setDropActive(false); await handleDropFiles(files); });
      if (typeof api.onDragState === "function") api.onDragState((a) => setDropActive(!!a));
      return;
    }
    bindTreeDrag();

    // 没有 fileTransfer 时退化到原生 dataTransfer.files
    const zone = dom.shell;
    zone.addEventListener("dragenter", (e) => { e.preventDefault(); S.dragDepth++; setDropActive(true); });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); });
    zone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      S.dragDepth = Math.max(0, S.dragDepth - 1);
      if (!S.dragDepth) setDropActive(false);
    });
    zone.addEventListener("drop", async (e) => {
      if (S.drag) return;                      // 树内拖动移动，不当文件导入
      e.preventDefault();
      S.dragDepth = 0; setDropActive(false);
      if (e.dataTransfer) await handleDropFiles(Array.from(e.dataTransfer.files || []));
    });
  }

  // 树内拖拽移动：用 pointer 事件自己实现，不走 HTML5 DnD。
  // 沙箱 iframe（Tauri/WKWebView）里 dataTransfer 常常收不到 dragover/drop，
  // 自己算落点反而稳定，也能自由画拖影与插入条。
  function bindTreeDrag() {
    const DIST = 4;          // 超过这个位移才算拖拽，避免误吃点击
    const EDGE = 26;         // 距离树上下边缘多少像素开始自动滚动
    const SPEED = 10;
    const ghost = el("div", { class: "drag-ghost", hidden: true });
    document.body.appendChild(ghost);
    let autoScroll = 0, hoverExpand = 0, hoverPath = "";

    const stopAutoScroll = () => { if (autoScroll) { cancelAnimationFrame(autoScroll); autoScroll = 0; } };

    function trackAutoScroll(y) {
      const rect = dom.tree.getBoundingClientRect();
      const up = y - rect.top < EDGE, down = rect.bottom - y < EDGE;
      if (!up && !down) { stopAutoScroll(); return; }
      if (autoScroll) return;
      const step = () => {
        if (!S.pd || !S.pd.active) { stopAutoScroll(); return; }
        dom.tree.scrollTop += up ? -SPEED : SPEED;
        autoScroll = requestAnimationFrame(step);
      };
      autoScroll = requestAnimationFrame(step);
    }

    // 悬停折叠的文件夹 600ms 自动展开，方便往里丢
    function considerExpand(hint) {
      if (!hint || !hint.row || hint.mode !== "child") { hoverPath = ""; return; }
      const p = hint.row.dataset.path || "";
      if (p === hoverPath) return;
      hoverPath = p;
      clearTimeout(hoverExpand);
      hoverExpand = setTimeout(() => {
        if (!S.pd || !S.pd.active) return;
        if (S.collapsed.delete(p)) renderTree();
        hoverPath = "";
      }, 600);
    }

    function endDrag(cancel) {
      const pd = S.pd;
      if (!pd || !pd.active) { S.pd = null; return; }   // 没拖动过：不捕获、不抑制 click
      const hint = S.dropHint;
      pd.rowEl && pd.rowEl.classList.remove("is-dragging");
      ghost.hidden = true;
      document.body.classList.remove("is-tree-dragging");
      clearDropHints();
      stopAutoScroll();
      clearTimeout(hoverExpand);
      hoverPath = "";
      try { dom.tree.releasePointerCapture(pd.pointerId); } catch (err) { /* 已释放 */ }
      S.pd = null;
      S.dropHint = null;
      const drag = S.drag;
      S.drag = null;
      S.suppressClickUntil = Date.now() + 350;
      if (cancel || !drag) return;
      if (!hint) return;
      if (!hint.valid) { toast(hint.reason || t("moveSameDir"), "error"); return; }
      moveNode(drag, hint.targetDir);
    }

    // 任何原生拖拽都关掉：它会抢走 pointer 事件，导致"松手才进入拖拽态"
    dom.tree.addEventListener("dragstart", (e) => e.preventDefault());

    dom.tree.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.buttons & 1) === 0) return;   // 只认左键按下
      if (e.isPrimary === false) return;                     // 多指触控时只用主指针
      const rowEl = e.target && e.target.closest ? e.target.closest(".tree-row") : null;
      if (!rowEl) return;
      S.pd = {
        rowEl, path: rowEl.dataset.path || "", kind: rowEl.dataset.kind || "",
        x0: e.clientX, y0: e.clientY, active: false, pointerId: e.pointerId,
      };
      // 注意：这里**不能** setPointerCapture。一旦捕获，click 事件的目标会变成捕获元素（#tree），
      // 行上的点击处理器收不到，表现为"点文件夹不展开、点笔记打不开"。等真正进入拖拽再捕获。
    });

    window.addEventListener("pointermove", (e) => {
      const pd = S.pd;
      const pressed = (e.buttons & 1) === 1;
      if (pd && !pd.active && !pressed) { S.pd = null; return; }   // 松手后的移动不算拖拽
      if (!pd || pd.active) {
        if (pd && pd.active) {
          ghost.style.transform = "translate(" + (e.clientX + 14) + "px," + (e.clientY + 10) + "px)";
          const rowEl = document.elementFromPoint
            ? (function (n) { return n && n.closest ? n.closest(".tree-row") : null; })(document.elementFromPoint(e.clientX, e.clientY))
            : null;
          const hint = hintFor(rowEl, e.clientY);
          S.dropHint = hint;
          paintDropHint(hint);
          considerExpand(hint);
          trackAutoScroll(e.clientY);
        }
        return;
      }
      if (Math.abs(e.clientX - pd.x0) < DIST && Math.abs(e.clientY - pd.y0) < DIST) return;
      // 越过阈值：正式开始拖拽（此时才捕获指针，不影响普通点击）
      pd.active = true;
      try { dom.tree.setPointerCapture(pd.pointerId); } catch (err) { /* 老宿主不支持就算了 */ }
      S.drag = { path: pd.path, kind: pd.kind };
      pd.rowEl.classList.add("is-dragging");
      document.body.classList.add("is-tree-dragging");
      ghost.textContent = (pd.rowEl.querySelector(".label") || {}).textContent || pd.path;
      ghost.hidden = false;
      ghost.style.transform = "translate(" + (e.clientX + 14) + "px," + (e.clientY + 10) + "px)";
    });

    window.addEventListener("pointerup", () => endDrag(false));
    // 指针移出 iframe（宿主区域）时收不到 pointerup，失焦就当作取消，避免卡在拖拽态
    window.addEventListener("blur", () => endDrag(true));
    window.addEventListener("pointercancel", () => endDrag(true));
    window.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.pd && S.pd.active) endDrag(true); });
  }

  /* ── 视图模式 / 面板 / 搜索 ── */  /* ── 视图模式 / 面板 / 搜索 ── */
  async function loadViewMode() {
    S.viewMode = "split";
    if (!canStorage()) return;
    try {
      const v = await plugin().storage.get(VIEW_KEY + S.connectionId);
      if (v === "edit" || v === "preview" || v === "split") S.viewMode = v;
    } catch (e) { /* 存储不可用就当默认分屏 */ }
  }

  function setViewMode(mode) {
    S.viewMode = mode;
    renderViewButtons();
    if (canStorage()) { try { plugin().storage.set(VIEW_KEY + S.connectionId, mode); } catch (e) { /* ignore */ } }
  }

  function rememberLast(path) {
    if (!canStorage()) return;
    try { plugin().storage.set(LAST_KEY + S.connectionId, path || ""); } catch (e) { /* 存储不可用就不记 */ }
  }

  // 回到上次打开的笔记；路径已不存在（被删/改名）就当没这回事
  async function restoreLastNote() {
    if (!canStorage() || S.note.path) return;
    let last = "";
    try { last = (await plugin().storage.get(LAST_KEY + S.connectionId)) || ""; } catch (e) { return; }
    if (!last) return;
    const findNote = (nodes) => (nodes || []).some((n) => (n.path === last && n.kind === "note")
      || (n.kind === "dir" && findNote(n.children)));
    if (!findNote(S.tree)) return;
    await openNote(last);
  }

  const setPane = (pane) => { S.pane = pane; dom.shell.dataset.pane = pane; };

  // 打开一篇笔记时把它的父目录都展开，否则树上看不到当前位置
  function expandAncestors(path) {
    const parts = String(path || "").split("/").slice(0, -1);
    let changed = false;
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (S.collapsed.delete(dir)) changed = true;
    }
    if (changed) renderTree();
  }

  function onSearchInput() {
    clearTimeout(S.searchTimer);
    const q = dom.search.value.trim();
    S.searchTimer = setTimeout(async () => {
      if (!q) { S.hits = null; renderTree(); renderTopbar(); return; }
      try { S.hits = (await call("notes/search", { query: q, limit: 50 }, { silent: true })).hits || []; }
      catch (e) { S.hits = []; }
      renderTree(); renderTopbar(); setPane("tree");
    }, 280);
  }

  // 手动刷新：本地有未保存改动且磁盘已变时先弹提示条，避免静默覆盖别人的修改
  async function manualRefresh() {
    clearTimeout(S.saveTimer);
    if (S.note.path && S.note.dirty) {
      const disk = await diskModifiedAt(S.note.path);
      if (disk != null && disk !== S.note.modifiedAt) return showBanner("conflict");
    }
    await flushSave();
    await refreshAll();
  }

  /* ── 环境：主题 / 语言 ── */
  function applyTheme(theme) {
    const root = document.documentElement, appearance = theme && theme.appearance;
    const prefersDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.dbxTheme = appearance === "dark" || (appearance === "system" && prefersDark) ? "dark" : "light";
    if (theme && theme.tokens) for (const key in theme.tokens) {
      const v = theme.tokens[key];
      if (typeof v === "string" && v) root.style.setProperty(key, v);
    }
    if (theme && theme.editor && theme.editor.fontFamily) root.style.setProperty("--font-mono", theme.editor.fontFamily);
  }

  function applyLocale(next) {
    S.locale = String(next || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
    document.documentElement.lang = S.locale;
    applyStaticI18n(); renderTree(); renderTopbar();
  }

  function onEnv(ev) {
    const d = (ev && ev.detail) || {};
    if (d.theme) applyTheme(d.theme);
    if (d.locale) applyLocale(d.locale);
  }

  /* ── 右键菜单 ── */
  function openContextMenu(x, y, node) {
    const d = lang(), isDir = node.kind === "dir", isRoot = !node.path;
    const items = [{ label: isDir ? d.menuNewNote : d.menuOpen, action: () => (isDir ? actionNewNote(node.path) : openNote(node.path)) }];
    items.push(isDir ? { label: d.menuNewFolder, action: () => actionNewFolder(node.path) }
      : { label: d.menuExport, action: () => actionExportFor(node.path) });
    if (!isRoot) items.push({ sep: true }, { label: d.menuRename, action: () => actionRename(node) },
      { label: d.menuDelete, danger: true, action: () => actionDelete(node) }, { sep: true });
    items.push({ label: d.menuCopyPath, action: () => copyText(node.path || "/") });
    if (isDir && !isRoot) items.push({
      label: S.collapsed.has(node.path) ? d.menuExpand : d.menuCollapse,
      action: () => {
        if (S.collapsed.has(node.path)) S.collapsed.delete(node.path); else S.collapsed.add(node.path);
        renderTree();
      }
    });
    showMenu(x, y, items);
  }

  async function actionExportFor(path) {
    if (S.note.path !== path) await openNote(path);
    await actionExport();
  }

  async function copyText(text) {
    const api = plugin();
    if (!api || typeof api.copy !== "function") return;
    try { await api.copy(text); toast(t("copied"), "ok"); } catch (e) { reportError(errInfo(e)); }
  }

  /* ── 上下文 / 启动 ── */
  async function init(ctx) {
    const conn = ctx && ctx.connectionId ? String(ctx.connectionId) : null;
    if (S.booted && conn === S.connectionId) return;
    S.booted = true;
    // 切连接前先落盘，用旧 connectionId 写回原笔记库
    if (S.note.path) { await flushSave(); closeNote(); }
    S.connectionId = conn; S.currentDir = ""; S.hits = null; S.tree = []; S.collapsed = new Set();
    if (dom.search) dom.search.value = "";
    renderTree();
    if (!conn) return showNoContext();
    dom.noc.hidden = true; dom.shell.hidden = false; dom.boot.hidden = true;
    setPane(window.innerWidth <= 900 ? "tree" : "editor");
    await loadViewMode();
    renderViewButtons();
    await refreshAll();
    await restoreLastNote();
    renderStatus();
  }

  function showNoContext() {
    dom.boot.hidden = true; dom.shell.hidden = true; dom.noc.hidden = false;
    dom.nocTitle.textContent = t("noContextTitle");
    dom.nocBody.textContent = t("noContextBody");
    dom.nocHint.textContent = t("noContextHint");
  }

  /* ── 事件 ── */
  function cacheDom() {
    const ids = ("shell boot nocontext noc-title noc-body noc-hint editor preview editor-body placeholder " +
      "ph-title ph-body tree tree-count vault-name vault-stats doc-title status-path " +
      "status-words status-save status-msg search banner banner-text banner-primary banner-secondary toasts " +
      "modal-root menu-root drop-overlay file-input zip-input btn-export auto-save").split(" ");
    ids.forEach((id) => { dom[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id); });
    dom.noc = dom.nocontext; dom.exportBtn = dom.btnExport; dom.autoSaveInput = dom.autoSave;
    dom.btnNewNote = $("btn-new-note"); dom.btnNewFolder = $("btn-new-folder");
    dom.btnBackTree = $("btn-back-tree"); dom.btnMenuTree = $("btn-menu-tree");
    dom.viewButtons = Array.from(document.querySelectorAll(".seg-btn"));
  }

  function onEditorKeydown(e) {
    const meta = e.metaKey || e.ctrlKey, key = String(e.key || "");
    if (meta && !e.shiftKey && (key === "s" || key === "S")) { e.preventDefault(); flushSave(); return; }
    if (meta && !e.shiftKey && (key === "b" || key === "B")) { e.preventDefault(); TOOLBAR.bold(); return; }
    if (meta && !e.shiftKey && (key === "i" || key === "I")) { e.preventDefault(); TOOLBAR.italic(); return; }
    if (key !== "Tab") return;
    e.preventDefault();
    if (!e.shiftKey) { insertText("  "); return; }
    const ta = dom.editor, s = ta.selectionStart, lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
    const head = ta.value.slice(lineStart, s);
    if (head.charAt(0) !== " ") return;
    const cut = head.charAt(1) === " " ? 2 : 1, caret = Math.max(lineStart, s - cut);
    insertText("", lineStart, lineStart + cut, caret, caret);
  }

  function bindEvents() {
    cacheDom();
    on("btn-new-note", "click", () => actionNewNote());
    on("btn-new-folder", "click", () => actionNewFolder());
    on("btn-import-md", "click", actionImportMd);
    on("btn-import-folder", "click", actionImportFolder);
    on("btn-backup", "click", actionBackup);
    on("btn-restore", "click", actionRestore);
    on("btn-open-fs", "click", actionOpenFs);
    on("btn-export", "click", actionExport);
    on("btn-refresh", "click", manualRefresh);
    on("btn-menu-tree", "click", () => setPane(S.pane === "tree" ? "editor" : "tree"));
    on("btn-back-tree", "click", () => setPane("tree"));
    on("ph-create", "click", () => actionNewNote(""));
    on("ph-import", "click", actionImportMd);
    on("noc-copy", "click", () => copyText(S.connectionId || "miko.md.notes.workbench"));
    on("md-toolbar", "click", (e) => {
      const btn = e.target.closest("[data-md]"), fn = btn && TOOLBAR[btn.dataset.md];
      if (fn) fn();
    });
    dom.viewButtons.forEach((b) => b.addEventListener("click", () => setViewMode(b.dataset.view)));
    dom.search.addEventListener("input", onSearchInput);
    dom.autoSaveInput.addEventListener("change", () => {
      S.autoSave = !!dom.autoSaveInput.checked;
      if (S.autoSave && S.note.dirty) scheduleSave();
    });
    dom.editor.addEventListener("input", () => { markDirty(); schedulePreview(); renderStatus(); });
    dom.editor.addEventListener("keydown", onEditorKeydown);
    dom.editor.addEventListener("paste", onPaste);
    dom.editor.addEventListener("scroll", rememberCursor);

    dom.preview.addEventListener("click", (e) => {
      const a = e.target.closest("a");
      if (!a) return;
      e.preventDefault();
      const external = a.getAttribute("data-external");
      if (external) {
        const api = plugin();
        if (api && caps().openUrl && typeof api.openUrl === "function") { try { api.openUrl(external); } catch (err) { /* ignore */ } }
        return;
      }
      const note = a.getAttribute("data-note");
      if (!note) return;
      const clean = note.replace(/[#?].*$/, "");
      openNote(clean.charAt(0) === "/" ? clean.slice(1) : resolveRel(dirname(S.note.path), clean));
    });

    dom.bannerPrimary.addEventListener("click", () => {
      if (S.bannerAction === "deleted") { closeNote(); refreshAll(); return; }
      if (S.bannerAction === "save") { keepMine(); return; }
      reloadCurrent(false);
    });
    dom.bannerSecondary.addEventListener("click", () => {
      if (S.bannerAction === "deleted") copyText(S.note.path); else keepMine();
    });
    // 目录树空白处右键 = 在根目录新建
    dom.tree.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".tree-row")) return;
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, { name: "/", path: "", kind: "dir" });
    });

    window.addEventListener("dbx-plugin-env", onEnv);
    window.addEventListener("pagehide", () => setTitleSafe(null));
    window.addEventListener("beforeunload", () => setTitleSafe(null));
    window.addEventListener("resize", () => { if (window.innerWidth > 900 && S.pane !== "editor") setPane("editor"); });
    bindDrop();
  }

  async function boot() {
    bindEvents();
    const api = plugin();
    if (!api) { applyLocale(String(navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en"); return showNoContext(); }
    try { await api.ready; } catch (e) { /* ready 失败也尽量把界面渲染出来 */ }
    applyTheme(api.theme || null);
    applyLocale(api.locale || navigator.language || "zh");
    if (typeof api.onContext === "function") { try { api.onContext((ctx) => { init(ctx); }); } catch (e) { /* ignore */ } }
    await init(api.context || {});
    if (S.connectionId) dom.boot.hidden = true;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
