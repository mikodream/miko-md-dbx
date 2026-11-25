// 校验 .dbx-store.json（商店展示元数据）。
// 规则来自 t8y2/dbx-store 的 scripts/validate.mjs 与 scripts/sync-release-candidate.mjs：
//   · 只认白名单字段（未知字段会让同步失败）
//   · icon 可用包内相对路径或 http(s) 绝对地址（同步时会把相对路径转成 tag 下的 raw URL）
//   · tags / permissions 必须是不重复的非空字符串数组
//   · localizations[locale] 只允许 { name, description } 两个键
//   · 商店会给「缺 zh-CN」和「中文正文但缺 en」打警告，所以两者都写
//
// 用法: node dev/ci/check-store-metadata.mjs [.dbx-store.json]
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2] || ".dbx-store.json";
const allowedKeys = new Set([
  "name", "description", "icon", "tags", "permissions",
  "source", "homepage", "license", "releaseNotes", "localizations",
]);

const problems = [];
const warnings = [];
const fail = (message) => problems.push(message);
const warn = (message) => warnings.push(message);

if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}`);
  process.exit(2);
}

let meta;
try {
  meta = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(`${file} 不是合法 JSON: ${error.message}`);
  process.exit(1);
}
if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
  console.error(`${file} 顶层必须是对象`);
  process.exit(1);
}

for (const key of Object.keys(meta)) {
  if (!allowedKeys.has(key)) fail(`不支持的字段 '${key}'（商店会拒绝同步）`);
}

for (const key of ["name", "description", "icon", "source", "homepage", "license"]) {
  if (typeof meta[key] !== "string" || !meta[key].trim()) fail(`缺少必需字段 '${key}'`);
}
if (typeof meta.icon === "string" && meta.icon.trim()) {
  const isUrl = /^https?:\/\//.test(meta.icon);
  const isRelative = !isUrl && !meta.icon.startsWith("/") && !meta.icon.includes("..");
  if (!isUrl && !isRelative) fail(`icon 必须是 http(s) URL 或包内相对路径: ${meta.icon}`);
  else if (isRelative && !fs.existsSync(path.join(meta.icon))) fail(`icon 指向的文件不存在: ${meta.icon}`);
}
for (const key of ["source", "homepage"]) {
  if (typeof meta[key] === "string" && meta[key].trim() && !/^https?:\/\//.test(meta[key])) {
    fail(`${key} 必须是 http(s) URL`);
  }
}
for (const key of ["tags", "permissions"]) {
  const value = meta[key];
  if (value === undefined) continue;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    fail(`${key} 必须是非空字符串数组`);
  } else if (new Set(value).size !== value.length) {
    fail(`${key} 里有重复项`);
  }
}
if (meta.releaseNotes !== undefined && typeof meta.releaseNotes !== "string") {
  fail("releaseNotes 必须是字符串");
}

if (meta.localizations !== undefined) {
  if (!meta.localizations || typeof meta.localizations !== "object" || Array.isArray(meta.localizations)) {
    fail("localizations 必须是对象");
  } else {
    for (const [locale, value] of Object.entries(meta.localizations)) {
      if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) fail(`locale 名称非法: ${locale}`);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(`localizations['${locale}'] 必须是对象`);
        continue;
      }
      for (const key of Object.keys(value)) {
        if (key !== "name" && key !== "description") fail(`localizations['${locale}'] 多了字段 '${key}'（只允许 name/description）`);
      }
      for (const key of ["name", "description"]) {
        if (typeof value[key] !== "string" || !value[key].trim()) {
          fail(`localizations['${locale}'] 缺 ${key}`);
        }
      }
    }
    const has = (locale) => typeof meta.localizations[locale]?.description === "string"
      && meta.localizations[locale].description.trim().length > 0;
    if (!has("zh-CN")) warn("缺 zh-CN 本地化，商店会给警告");
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(String(meta.description || "")) && !has("en")) {
      warn("正文是中文但缺 en 本地化，商店会给警告");
    }
  }
}

const manifestPath = path.join(path.dirname(file) || ".", "manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (meta.source && manifest.source && meta.source !== manifest.source) {
    warn(`source 与 manifest 不一致（manifest: ${manifest.source}）`);
  }
  if (meta.tags === undefined && !Array.isArray(manifest.permissions)) {
    warn("manifest 没有 permissions 字段，商店会认为插件无特权");
  }
}
if (typeof meta.license === "string" && !fs.existsSync("LICENSE") && !fs.existsSync("LICENSE.md")) {
  warn(`声明了 license ${meta.license}，但仓库里没有 LICENSE 文件`);
}

for (const message of warnings) console.warn(`[warn]  ${message}`);
for (const message of problems) console.error(`[error] ${message}`);
if (problems.length === 0) {
  console.log(`OK — ${file} 通过（${warnings.length} warning）`);
  process.exit(0);
}
console.error(`FAIL — ${problems.length} error`);
process.exit(1);
