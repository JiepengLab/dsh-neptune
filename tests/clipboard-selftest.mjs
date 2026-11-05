/**
 * 剪贴板真机自测。跑法：node tests/clipboard-selftest.mjs
 *
 * **这个脚本会动真剪贴板。** 它先把原值存下来，测完放回去。
 * 它不在 `npm run verify` 里，因为常规验证要保持只读。
 * 跑它之前，确认剪贴板里没有要紧的东西。
 *
 * 验的是编码、写入与读回比对。替身测不了这三样。
 */

import { execFileSync } from "node:child_process";
import { putOnClipboard } from "../lib/recipe.js";

const problems = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) problems.push(label);
};

/** 读回剪贴板。只读，不改。 */
function readClipboard() {
  if (process.platform === "darwin") {
    return execFileSync("pbpaste", [], { encoding: "utf8" }).replace(/\r?\n$/, "");
  }
  return execFileSync("pwsh", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" })
    .replace(/\r?\n$/, "");
}

console.log("平台:", process.platform);
const orig = readClipboard();
console.log("原值长度:", orig.length);

const cases = [
  ["ASCII", "clip-selftest-" + Date.now()],
  ["中文", "第七个工具 neptune_recipe，值不进上下文。"],
  ["一行网址", "https://szlzxn.cn/wxn/beginCharge?areaId=6&openId=abc&devaddress=50959120&port=11&money=7"],
];

try {
  for (const [label, value] of cases) {
    const put = await putOnClipboard(value);
    const back = readClipboard();
    check(put.ok, `${label}：写进去了（${put.error ?? ""}）`);
    check(back === value, `${label}：读回来逐字相等`);
  }
  const empty = await putOnClipboard("");
  check(!empty.ok, "空值不写");
} finally {
  await putOnClipboard(orig);
  const back = readClipboard();
  check(back === orig, "原值还原了");
}

process.exit(problems.length ? 1 : 0);
