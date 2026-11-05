#!/usr/bin/env node
/**
 * scripts/check-package.mjs — 包结构与内容自查。
 *
 * 两种用法：
 *   node scripts/check-package.mjs            查源目录
 *   node scripts/check-package.mjs --packed   查 npm pack 打出来的包
 *
 * 查四样：
 *   1. 该有的文件在不在
 *   2. 包里有没有本机路径、用户名、邮箱
 *   3. 包里有没有凭证形态的串
 *   4. package.json 的关键字段对不对
 *
 * 退出码即判据。0 = 全过。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packed = process.argv.includes("--packed");

/** 打包后要查的目录。 */
function targetDir() {
  if (!packed) return ROOT;
  const out = fs.readdirSync(ROOT).find((n) => n.endsWith(".tgz"));
  if (!out) {
    console.log("没有 tarball。先跑 npm pack。");
    process.exit(1);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-neptune-pack-"));
  execFileSync("tar", ["-xzf", path.join(ROOT, out), "-C", dir]);
  return path.join(dir, "package");
}

const dir = targetDir();
const problems = [];
const fail = (msg) => problems.push(msg);

/** 收集要查的文本文件。 */
function texts() {
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|json|md|yml|yaml)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

// 1. 该有的文件
for (const required of ["package.json", "cordis.patch.yml", "README.md", "LICENSE", "index.js", "skills/neptune-resume/SKILL.md"]) {
  if (!fs.existsSync(path.join(dir, required))) fail(`少了 ${required}`);
}
for (const required of [
  "skills/neptune-resume/references/alternate-routes.md",
]) {
  if (!fs.existsSync(path.join(dir, required))) fail(`少了 ${required}`);
}
for (const required of ["locale/en.json", "locale/zh.json"]) {
  if (!fs.existsSync(path.join(dir, required))) fail(`少了 ${required}`);
}
if (!fs.existsSync(path.join(dir, "icon.svg"))) fail("少了 icon.svg");

// 1b. 发布出去的包不含开发材料。
// 社区插件的 tests/ 与 scripts/ 留在仓库根目录，但不在 files 清单里。
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
for (const dev of ["tests/", "scripts/", "docs/"]) {
  if ((manifest.files || []).some((f) => f === dev || f.startsWith(dev))) {
    fail(`发布清单里不该有 ${dev}。开发材料只留在仓库里`);
  }
}
if (fs.existsSync(path.join(dir, "docs"))) {
  fail("插件仓库不该有 docs/ 目录。那些内容在工作区与代码注释里");
}

// 2 与 3. 内容
const PATTERNS = [
  [/[A-Za-z]:\\[^\s"']+/, "本机绝对路径"],
  [/\/Users\/[^\s"']+/, "macOS 家目录路径"],
  [/\/home\/[^\s"']+/, "Linux 家目录路径"],
  [/ouis[A-Za-z0-9_-]{8,}/, "openId 形态的串"],
  [/[A-Za-z0-9_-]{28,}\.[A-Za-z0-9_-]{12,}/, "私钥形态的串"],
  [/\b[\w.+-]+@qq\.com\b/, "QQ 邮箱"],
  [/\b[\w.+-]+@gmail\.com\b/, "Gmail 地址"],
];
for (const file of texts()) {
  const content = fs.readFileSync(file, "utf8");
  for (const [pattern, label] of PATTERNS) {
    const hit = content.match(pattern);
    if (hit) fail(`${path.relative(dir, file)} 里有${label}：${hit[0].slice(0, 60)}`);
  }
}

// 4. package.json
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
if (pkg.private === true) fail("package.json 里 private 还是 true。发不出去");
if (pkg.main !== "index.js") fail(`main 应是 index.js，现在是 ${pkg.main}`);
if (!pkg.dsh?.bundle?.patch) fail("package.json 缺 dsh.bundle.patch");
if (!pkg.engines?.dsh) fail("package.json 缺 engines.dsh");
if (!pkg.license) fail("package.json 缺 license");
if (!pkg.keywords?.includes("dsh-plugin")) fail("package.json 的 keywords 缺 dsh-plugin");
if (!fs.existsSync(path.join(dir, pkg.dsh.bundle.patch))) fail("dsh.bundle.patch 指的文件不在");

console.log(`包自查: ${dir}`);
console.log(`  文件 ${texts().length} 个`);
if (problems.length) {
  for (const problem of problems) console.log(`  FAIL ${problem}`);
  console.log(`结果: FAIL (${problems.length})`);
  process.exit(1);
}
console.log("结果: PASS");
