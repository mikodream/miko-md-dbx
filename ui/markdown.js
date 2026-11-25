/* MIKO.MD 笔记 —— 独立 Markdown 渲染器
 * 只产出「已转义」的 HTML 字符串，不碰 DOM、不依赖宿主环境。
 * 自己写的原因：沙箱没有网络也没有构建步骤，不能引入 marked / markdown-it。 */
(function (global) {
  "use strict";

  var ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  /* ── 行内语法 ─────────────────────────────────────────────── */

  // 代码片段 / 图片 / 链接先摘成占位符，避免强调规则吃掉它们内部的下划线与星号
  var PH = "\u0000";
  var PHE = "\u0001";

  function findBracket(s, open) {
    var depth = 0;
    for (var j = open; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === "\\") { j++; continue; }
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) return j; }
    }
    return -1;
  }

  function parseLinkAt(s, open) {
    var close = findBracket(s, open);
    if (close < 0 || s.charAt(close + 1) !== "(") return null;
    var end = -1;
    for (var j = close + 2; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === "\\") { j++; continue; }
      if (c === ")") { end = j; break; }
    }
    if (end < 0) return null;
    var label = s.slice(open + 1, close);
    var target = s.slice(close + 2, end).trim();
    // 去掉 (url "title") 里的 title
    var t = /^(\S+)\s+["'(].*$/.exec(target);
    if (t) target = t[1];
    return { label: label, target: target, end: end + 1 };
  }

  function unwrap(t) {
    t = String(t || "").trim();
    if (t.length > 1 && t.charAt(0) === "<" && t.charAt(t.length - 1) === ">") t = t.slice(1, -1);
    return t;
  }

  // javascript:/data:/vbscript: 一律不渲染成链接或图片，避免不可信内容变成可执行入口
  function classify(t) {
    var u = unwrap(t);
    if (!u) return { kind: "none", url: "" };
    var flat = u.replace(/[\u0000-\u0020]/g, "");
    if (/^(?:javascript|vbscript|data|file|blob|about):/i.test(flat)) return { kind: "none", url: u };
    if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return { kind: "external", url: u };
    if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return { kind: "none", url: u };
    return { kind: "relative", url: u };
  }

  function relPath(u) {
    var out = unwrap(u).replace(/^\.\//, "");
    try { out = decodeURIComponent(out); } catch (e) { /* 非法百分号编码就保持原样 */ }
    return out;
  }

  function imageHtml(link, opts) {
    var alt = link.label.replace(/[*_~`]/g, "").trim();
    var cls = classify(link.target);
    if (cls.kind !== "relative") return '<span class="md-media-missing">' + esc(alt || cls.url) + "</span>";
    var rel = relPath(cls.url);
    var src = "";
    if (opts && typeof opts.resolveImage === "function") {
      try { src = String(opts.resolveImage(rel) || ""); } catch (e) { src = ""; }
    }
    // src 留空：由 app.js 插入 DOM 后用 notes/readAsset 换成 data: URL
    var html = '<img class="md-img" data-rel="' + esc(rel) + '" alt="' + esc(alt) + '" loading="lazy"';
    if (src) html += ' src="' + esc(src) + '"';
    return html + ">";
  }

  function linkHtml(link, opts) {
    var labelHtml = link.label ? inline(link.label, opts) : esc(unwrap(link.target));
    var cls = classify(link.target);
    if (cls.kind === "external") {
      return '<a class="md-link is-external" data-external="' + esc(cls.url) + '" title="' + esc(cls.url) + '">' + labelHtml + "</a>";
    }
    if (cls.kind === "relative") {
      var rel = relPath(cls.url);
      if (/\.(md|markdown)$/i.test(rel.replace(/[#?].*$/, ""))) {
        return '<a class="md-link md-note-link" data-note="' + esc(rel) + '" title="' + esc(rel) + '">' + labelHtml + "</a>";
      }
    }
    return "<span>" + labelHtml + "</span>";
  }

  function emphasize(html) {
    return html
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])__(?=\S)([\s\S]*?\S)__(?=$|[\s).,;:!?])/g, "$1<strong>$2</strong>")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
      .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?=$|[^_\w])/g, "$1<em>$2</em>");
  }

  function inline(raw, opts) {
    var tokens = [];
    var out = "";
    var buf = "";
    var i = 0;

    function flush() {
      if (!buf) return;
      out += esc(buf);
      buf = "";
    }
    function hold(html) {
      tokens.push(html);
      out += PH + (tokens.length - 1) + PHE;
    }

    while (i < raw.length) {
      var c = raw.charAt(i);
      if (c === "\\" && i + 1 < raw.length && /[\\`*_{}\[\]()#+\-.!~|>]/.test(raw.charAt(i + 1))) {
        buf += raw.charAt(i + 1);
        i += 2;
        continue;
      }
      if (c === "`") {
        var code = /^(`+)([\s\S]*?)\1/.exec(raw.slice(i));
        if (code) { flush(); hold("<code>" + esc(code[2]) + "</code>"); i += code[0].length; continue; }
      }
      if (c === "!" && raw.charAt(i + 1) === "[") {
        var img = parseLinkAt(raw, i + 1);
        if (img) { flush(); hold(imageHtml(img, opts)); i = img.end; continue; }
      }
      if (c === "[") {
        var lnk = parseLinkAt(raw, i);
        if (lnk) { flush(); hold(linkHtml(lnk, opts)); i = lnk.end; continue; }
      }
      buf += c;
      i++;
    }
    flush();

    return emphasize(out).replace(/\u0000(\d+)\u0001/g, function (_, n) { return tokens[+n]; });
  }

  /* ── 块级语法 ─────────────────────────────────────────────── */

  function listMatch(line) {
    return /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
  }

  function isTableStart(lines, i) {
    if (i + 1 >= lines.length) return false;
    var head = lines[i];
    if (head.indexOf("|") < 0) return false;
    var sep = lines[i + 1];
    if (sep.indexOf("-") < 0 || !/^\s{0,3}\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(sep)) return false;
    return sep.indexOf("|") >= 0 || head.split("|").length > 2;
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    var cells = [];
    var cur = "";
    var escNext = false;
    for (var k = 0; k < s.length; k++) {
      var ch = s.charAt(k);
      if (escNext) { cur += ch; escNext = false; continue; }
      if (ch === "\\") { escNext = true; continue; }
      if (ch === "|") { cells.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells.map(function (c) { return c.trim(); });
  }

  function cellHtml(tag, text, align) {
    return "<" + tag + (align ? ' style="text-align:' + align + '"' : "") + ">" + inline(text) + "</" + tag + ">";
  }

  function parseTable(lines, start, opts) {
    var head = splitRow(lines[start]);
    var sep = splitRow(lines[start + 1]);
    var align = sep.map(function (c) {
      var left = c.charAt(0) === ":";
      var right = c.charAt(c.length - 1) === ":";
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });
    var rows = [];
    var i = start + 2;
    while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) { rows.push(splitRow(lines[i])); i++; }
    var html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    for (var c = 0; c < head.length; c++) html += cellHtml("th", head[c], align[c] || "");
    html += "</tr></thead><tbody>";
    for (var r = 0; r < rows.length; r++) {
      html += "<tr>";
      for (var c2 = 0; c2 < head.length; c2++) html += cellHtml("td", rows[r][c2] == null ? "" : rows[r][c2], align[c2] || "");
      html += "</tr>";
    }
    return { html: html + "</tbody></table></div>", next: i };
  }

  function isBlockStart(lines, i) {
    var l = lines[i];
    if (!l.trim()) return true;
    if (/^\s{0,3}(#{1,6})\s+/.test(l)) return true;
    if (/^\s{0,3}(`{3,}|~{3,})/.test(l)) return true;
    if (/^\s{0,3}>/.test(l)) return true;
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(l)) return true;
    if (listMatch(l)) return true;
    return isTableStart(lines, i);
  }

  function parseList(lines, start, opts) {
    var first = listMatch(lines[start]);
    var baseIndent = first[1].length;
    var ordered = /\d/.test(first[2]);
    var items = [];
    var i = start;

    while (i < lines.length) {
      var m = listMatch(lines[i]);
      if (!m) {
        // 列表内允许夹空行，后面仍是列表项就继续
        if (!lines[i].trim()) {
          var j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          var nm = j < lines.length ? listMatch(lines[j]) : null;
          // 空行后继续同一列表要求缩进与类型（有序/无序）都一致，否则是两个列表
          if (nm && nm[1].length >= baseIndent && /\d/.test(nm[2]) === ordered) { i = j; continue; }
        }
        break;
      }
      if (m[1].length < baseIndent) break;
      if (m[1].length > baseIndent) {
        if (!items.length) break;
        // 更深缩进整段交给递归渲染，嵌套列表因此天然生效
        var cut = Math.min(m[1].length, baseIndent + 2);
        var item = items[items.length - 1];
        while (i < lines.length) {
          var mm = listMatch(lines[i]);
          if (mm && mm[1].length <= baseIndent) break;
          if (!lines[i].trim()) { i++; continue; }
          item.extra.push(lines[i].slice(Math.min(cut, lines[i].length)));
          i++;
        }
        continue;
      }

      if (m[1].length === baseIndent && /\d/.test(m[2]) !== ordered) break;

      var current = { content: m[3], extra: [], ordered: /\d/.test(m[2]) };
      items.push(current);
      i++;
      // 懒续行：缩进够两个空格的普通文本算进上一项
      while (i < lines.length) {
        if (!lines[i].trim() || listMatch(lines[i])) break;
        var ind = /^\s*/.exec(lines[i])[0].length;
        if (ind < baseIndent + 2) break;
        current.extra.push(lines[i].slice(baseIndent + 2));
        i++;
      }
    }

    var tag = ordered ? "ol" : "ul";
    var html = '<' + tag + ' class="md-' + tag + '">';
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var task = /^\[([ xX])\]\s+/.exec(it.content);
      var inner;
      if (task) {
        var body = inline(it.content.slice(task[0].length), opts);
        var extra = it.extra.length ? renderBlocks(it.extra, opts) : "";
        inner = '<span class="md-task"><span class="md-task-box' + (task[1] === " " ? "" : " is-done") + '"></span>' + body + "</span>" + extra;
      } else {
        var lines2 = [it.content].concat(it.extra);
        inner = renderBlocks(lines2, opts);
        // 紧密列表：单个段落解包，避免 <li><p> 撑高行距
        if (/^<p>[\s\S]*<\/p>$/.test(inner)) inner = inner.slice(3, -4);
      }
      html += "<li" + (task ? ' class="md-task-item"' : "") + ">" + inner + "</li>";
    }
    return { html: html + "</" + tag + ">", next: i };
  }

  function codeHtml(code, lang) {
    var label = lang ? '<span class="md-code-lang">' + esc(lang) + "</span>" : "";
    return '<pre class="md-code">' + label + "<code>" + esc(code) + "</code></pre>";
  }

  function paragraph(lines, opts) {
    var html = "";
    for (var k = 0; k < lines.length; k++) {
      var hard = / {2,}$/.test(lines[k]);
      html += inline(lines[k].replace(/[ \t]+$/, ""), opts);
      if (k < lines.length - 1) html += hard ? "<br>" : " ";
    }
    return html;
  }

  function renderBlocks(lines, opts) {
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      var fence = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/.exec(line);
      if (fence) {
        var ch = fence[1].charAt(0);
        var len = fence[1].length;
        var body = [];
        var closeRe = new RegExp("^\\s{0,3}" + (ch === "`" ? "`" : "~") + "{" + len + ",}\\s*$");
        i++;
        while (i < lines.length && !closeRe.test(lines[i])) { body.push(lines[i]); i++; }
        if (i < lines.length) i++;
        out.push(codeHtml(body.join("\n"), fence[2] || ""));
        continue;
      }

      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

      var h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        var lv = h[1].length;
        out.push("<h" + lv + ">" + inline(h[2], opts) + "</h" + lv + ">");
        i++;
        continue;
      }

      if (isTableStart(lines, i)) {
        var table = parseTable(lines, i, opts);
        out.push(table.html);
        i = table.next;
        continue;
      }

      if (/^\s{0,3}>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + renderBlocks(quote, opts) + "</blockquote>");
        continue;
      }

      if (listMatch(line)) {
        var list = parseList(lines, i, opts);
        out.push(list.html);
        i = list.next;
        continue;
      }

      var para = [];
      while (i < lines.length && !isBlockStart(lines, i)) { para.push(lines[i]); i++; }
      if (!para.length) { para.push(lines[i]); i++; }
      out.push("<p>" + paragraph(para, opts) + "</p>");
    }
    return out.join("\n");
  }

  function render(text, options) {
    var src = String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    if (!src.trim()) return "";
    return renderBlocks(src.split("\n"), options || {});
  }

  global.MikoMarkdown = { render: render, escapeHtml: esc, version: "1.0.0" };
})(typeof window !== "undefined" ? window : globalThis);
