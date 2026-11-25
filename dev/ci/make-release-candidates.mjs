// 汇总各平台的未签名候选包，生成 release-candidates.json。
//
// 规则与 DBX 官方 reusable workflow（t8y2/dbx/.github/workflows/plugin-release-reusable.yml）一致：
//   · target 必须匹配 ^[a-z0-9-]{1,64}$，且不能重复
//   · sha256 必须是 64 位十六进制，且与包的实际字节相符
//   · size 必须与包的实际字节数相符
//   · 候选包必须没有 signature.json（未签名）
//   · 每个包的 manifest 身份（id/name/description/publisher/version/permissions）必须完全一致
//   · 产物里不允许出现 signingKeyId（那是商店签名后才有的字段）
// 输出结构（dbx-store 的 sync-release-candidate.mjs 直接读它）：
//   { "plugin": {id,name,description,publisher,version,permissions[]},
//     "artifacts": [{target,url,sha256,size}, …] }
//
// 用法: node dev/ci/make-release-candidates.mjs <产物目录>
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || "release-assets";
const outputName = "release-candidates.json";

if (!fs.existsSync(root)) {
  console.error(`找不到产物目录: ${root}`);
  process.exit(2);
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const current = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(current) : [current];
  });
}

const files = filesUnder(root);
const metadataFiles = files.filter((file) => file.endsWith(".artifact.json"));
const packages = new Map();
for (const file of files.filter((file) => file.endsWith(".dbxp"))) {
  const name = path.basename(file);
  if (packages.has(name)) throw new Error(`包文件名重复: ${name}`);
  packages.set(name, file);
}
if (metadataFiles.length === 0) throw new Error("没有找到任何 .artifact.json");
if (packages.size === 0) throw new Error("没有找到任何 .dbxp");

const targets = new Set();
let pluginIdentity;
const artifacts = metadataFiles
  .map((file) => {
    const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!/^[a-z0-9-]{1,64}$/.test(artifact.target || "")) throw new Error(`${file}: target 非法`);
    if (!/^[a-fA-F0-9]{64}$/.test(artifact.sha256 || "")) throw new Error(`${file}: sha256 非法`);
    if (artifact.signingKeyId !== undefined) throw new Error(`${file}: 候选包不能声明 signingKeyId`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) throw new Error(`${file}: size 非法`);

    const packageName = path.basename(new URL(artifact.url, "https://plugins.invalid/releases/").pathname);
    const packageFile = packages.get(packageName);
    if (!packageFile) throw new Error(`${file}: 指向的包不存在 ${packageName}`);

    const bytes = fs.readFileSync(packageFile);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (artifact.size !== bytes.length) throw new Error(`${file}: size 与包不符（${artifact.size} vs ${bytes.length}）`);
    if (artifact.sha256.toLowerCase() !== sha256) throw new Error(`${file}: sha256 与包不符`);

    const entries = childProcess.execFileSync("unzip", ["-Z1", packageFile], { encoding: "utf8" }).split(/\r?\n/);
    if (entries.includes("signature.json")) throw new Error(`${packageName}: 候选包必须是未签名的`);

    const manifest = JSON.parse(
      childProcess.execFileSync("unzip", ["-p", packageFile, "manifest.json"], { encoding: "utf8" }),
    );
    const identity = {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description || "",
      publisher: manifest.publisher,
      version: manifest.version,
      permissions: [...(manifest.permissions || [])].sort(),
    };
    if (!identity.id || !identity.name || !identity.publisher || !identity.version) {
      throw new Error(`${packageName}: manifest 身份信息不完整`);
    }
    if (pluginIdentity && JSON.stringify(pluginIdentity) !== JSON.stringify(identity)) {
      throw new Error(`${packageName}: manifest 身份与其它平台不一致`);
    }
    pluginIdentity ||= identity;
    if (targets.has(artifact.target)) throw new Error(`target 重复: ${artifact.target}`);
    targets.add(artifact.target);

    return { target: artifact.target, url: artifact.url, sha256: artifact.sha256, size: artifact.size };
  })
  .sort((left, right) => left.target.localeCompare(right.target));

const output = { plugin: pluginIdentity, artifacts };
fs.writeFileSync(path.join(root, outputName), `${JSON.stringify(output, null, 2)}\n`);

console.log(`已生成 ${path.join(root, outputName)}`);
console.log(`  ${pluginIdentity.id}@${pluginIdentity.version}  平台: ${artifacts.map((a) => a.target).join(", ")}`);
