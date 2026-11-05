/**
 * lib/log.js — 加载标记。
 *
 * 每加载一次写一行。用来确认插件加载了、热重载也生效了。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 写一行加载标记。what 里放这一轮注册了什么。 */
export function markLoaded(what = {}) {
  try {
    const dir = join(homedir(), ".dsh");
    mkdirSync(dir, { recursive: true });
    const parts = [];
    for (const [key, value] of Object.entries(what)) {
      if (Array.isArray(value) && value.length) parts.push(`${key}=${value.join(",")}`);
    }
    appendFileSync(
      join(dir, "neptune-plugin.log"),
      `${new Date().toISOString()} 插件已加载 ${parts.join(" ")}\n`,
      "utf8",
    );
  } catch (err) {
    console.log(`[dsh-neptune] 写加载标记失败：${err?.message ?? err}`);
  }
}
