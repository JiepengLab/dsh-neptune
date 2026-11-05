/**
 * lib/recipe.js — 交给用户的那几样东西。
 *
 * 电脑晚上不能开机时，用户要自己把两样东西填到别处：
 *   - 三个 secret 值。填进 GitHub 的 Secrets 表单
 *   - 起单网址。填进手机自动化的「打开 URL」动作
 *
 * **值不进模型上下文，也不出现在聊天里。** 插件把它们写进剪贴板，只回一句话。
 *
 * 写剪贴板的办法：起一个子进程，值先 base64 再走 stdin。
 * Windows 上 pwsh 的 stdin 按 GBK 解，原始 UTF-8 会变成乱码。
 * base64 是纯 ASCII，绕开代码页这一条。
 * 子进程里解码、写入、读回比对，只吐 ok 或 fail。值不出子进程。
 */

import { spawn } from "node:child_process";
import { buildChargeBody, recipeUrl } from "../core/neptune-core.mjs";

/** 子进程回话用的两个标记。stdout 里只会出现其中一个。 */
const CLIP_OK = "NEPTUNE_CLIP_OK";
const CLIP_FAIL = "NEPTUNE_CLIP_FAIL";

/** 写剪贴板超时的毫秒数。剪贴板被别的占住时，pwsh 会一直等。 */
const CLIP_TIMEOUT_MS = 15000;

/** Windows 上写剪贴板并当场读回比对的 pwsh 脚本。 */
const POWERSHELL_SET = [
  "$v = [Console]::In.ReadToEnd().Trim()",
  "$s = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($v))",
  "$s | Set-Clipboard",
  "$b = [string](Get-Clipboard -Raw)",
  `if ($b.TrimEnd() -eq $s.TrimEnd()) { "${CLIP_OK}" } else { "${CLIP_FAIL}" }`,
].join("; ");

/**
 * 起一个子进程。等它结束，或者超时，或者被取消。
 *
 * 取消与超时会杀掉子进程。剪贴板被占住时 pwsh 会一直等，
 * 没有超时这个 promise 永远不落，工具调用就卡在那儿。
 *
 * @param {string} command 可执行文件。
 * @param {string[]} args 参数。
 * @param {string} [input] 往 stdin 写的内容。不给就关掉 stdin。
 * @param {object} [opts] `signal` 与 `timeoutMs`。
 * @returns {Promise<{code: number, out: string, err: string, timedOut: boolean, canceled: boolean}>}
 */
function run(command, args, input, { signal, timeoutMs = CLIP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let timedOut = false;
    let canceled = false;
    const kill = () => {
      try { child.kill(); } catch { /* 已经退出了 */ }
    };
    const onAbort = () => {
      canceled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({ code, out, err, timedOut, canceled });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { err = String(e?.message ?? e); finish(-1); });
    child.on("close", (code) => finish(code));
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

/** 取第一行报错。子进程的输出常常是好几行堆栈。 */
function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/).find((line) => line.trim()) ?? "";
}

/** 报错里不能带值。子进程的 stderr 是唯一一条原始外部文本。 */
function scrub(text, value) {
  const s = String(text ?? "");
  return value && s.includes(value) ? s.split(value).join("") : s;
}

/**
 * 看子进程的回话，给出结论。
 * @param {object} r run 的结果。
 * @param {string} value 写进去的值。报错里不能带它。
 * @param {string} tool 跑的是哪个程序。
 * @param {string} hint 那个程序不在时，给用户的说法。
 * @returns {{ok: boolean, written: boolean, error?: string}}
 */
function verdict(r, value, tool, hint) {
  if (r.timedOut) {
    return {
      ok: false,
      written: false,
      error: `${tool} 超过 ${CLIP_TIMEOUT_MS / 1000} 秒没有回话。剪贴板可能被别的占住了`,
    };
  }
  if (r.canceled) return { ok: false, written: false, error: "被取消了" };
  const said = String(r.out);
  if (said.includes(CLIP_OK)) return { ok: true, written: true };
  if (said.includes(CLIP_FAIL)) {
    return { ok: false, written: true, error: "写进去了，但读回来不一样" };
  }
  if (/ENOENT/.test(String(r.err ?? ""))) {
    return { ok: false, written: false, error: hint };
  }
  return { ok: false, written: false, error: scrub(firstLine(r.err), value) || `${tool} 退出码 ${r.code}` };
}

/**
 * 把一段文字写进剪贴板。
 *
 * 写完当场读回比对。旧记录里有过「不报错，但读不回来」的静默失败，
 * 不比对就会对用户说「已放到剪贴板」而剪贴板里是空的。
 *
 * @param {string} text 要写的内容。
 * @param {object} [opts] `signal`。回合被取消时，子进程会被杀掉。
 * @returns {Promise<{ok: boolean, written: boolean, error?: string}>}
 *   `written` 说值有没有进剪贴板。写进去但读回比对没过时，它是真的。
 */
export async function putOnClipboard(text, { signal } = {}) {
  const value = String(text ?? "");
  if (!value) return { ok: false, written: false, error: "没有要写的内容" };

  if (process.platform === "win32") {
    const encoded = Buffer.from(value, "utf8").toString("base64");
    const r = await run("pwsh", ["-NoProfile", "-Command", POWERSHELL_SET], encoded, { signal });
    return verdict(r, value, "pwsh", "没找到 pwsh。Windows 上要装 PowerShell 7 才能写剪贴板");
  }

  if (process.platform === "darwin") {
    const w = await run("pbcopy", [], value, { signal });
    if (w.timedOut || w.canceled) {
      return verdict(w, value, "pbcopy", "没找到 pbcopy");
    }
    if (w.code !== 0) {
      return { ok: false, written: false, error: scrub(firstLine(w.err), value) || "pbcopy 跑不起来" };
    }
    const r = await run("pbpaste", [], undefined, { signal });
    if (r.timedOut || r.canceled) {
      return verdict(r, value, "pbpaste", "没找到 pbpaste");
    }
    if (String(r.out).trimEnd() === value.trimEnd()) return { ok: true, written: true };
    return { ok: false, written: true, error: "写进去了，但读回来不一样" };
  }

  return { ok: false, written: false, error: `这个平台 ${process.platform} 没有剪贴板写法` };
}

/**
 * 真正写剪贴板的那一步。测试把它换成替身，不动真剪贴板。
 * @type {(text: string, opts?: object) => Promise<{ok: boolean, written: boolean, error?: string}>}
 */
let writer = putOnClipboard;

/**
 * 换掉写剪贴板那一步。给测试用。传 null 换回真的。
 * @param {((text: string, opts?: object) => Promise<object>)|null} fn 替身。
 */
export function setClipboardWriter(fn) {
  writer = typeof fn === "function" ? fn : putOnClipboard;
}

/**
 * 写剪贴板。走当前的 writer。
 * @param {string} text 要写的内容。
 * @param {object} [opts] `signal`。
 * @returns {Promise<{ok: boolean, written: boolean, error?: string}>} 写进去了就 ok。
 */
export function writeClipboard(text, opts) {
  return writer(text, opts);
}

/**
 * 三个 secret 值。
 *
 * openId 就是凭证，它只进剪贴板。employeeId 从账号信息里拿，
 * 上游的云端方案要它当 secret，但厂商那边不必当 secret。
 *
 * @param {{openId: string, areaId: string|number, employeeid: string|number}} account 账号信息。
 * @returns {{open_id: string, employee_id: string, area_id: string}}
 */
export function secretValues({ openId, areaId, employeeid }) {
  return {
    open_id: String(openId ?? ""),
    employee_id: employeeid === undefined || employeeid === null ? "" : String(employeeid),
    area_id: String(areaId ?? ""),
  };
}

/**
 * 起单网址。
 *
 * 照抄厂商小程序的计量分支（case 146）。费率与设备字段来自 getDeviceInfo，
 * 桩与插座来自最近一单。参数全在查询串里，手机上就是「打开 URL」一个动作。
 *
 * @param {object} args 账号、设备与目标插座。
 * @returns {string} 起单网址。
 */
export function recipeUrlFor({ openId, areaId, employeeid, devaddress, port, device, balance }) {
  // 缺 employeeid 时 recipeUrl 会把它写成字符串 "undefined" 发给厂商，
  // 那样拼出来的网址起不了单，但工具照样说「已放到剪贴板」。这里直接报错。
  if (employeeid === undefined || employeeid === null || employeeid === "") {
    throw new Error("账号信息里没有 employeeid。先查 getUserInfo 的应答");
  }
  const body = buildChargeBody({
    openId, areaId, employeeid, devaddress, port, device, balance,
  });
  return recipeUrl(body);
}
