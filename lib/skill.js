/**
 * lib/skill.js — 嵌入式技能。
 *
 * 流程与硬规则装上就有了。模型按需加载这一段。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 技能目录。里面是 SKILL.md 与 references/。 */
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "neptune-resume");
const SKILL_PATH = join(SKILL_DIR, "SKILL.md");

/**
 * 注册技能。宿主没有 skill 服务时跳过，工具照常用。
 * 返回注册上的技能名，没注册返回空串。
 */
export function registerSkill(ctx) {
  if (!ctx.skills?.register) {
    console.log("[dsh-neptune] 这个宿主没有 skill 服务，技能没注册。工具照常用。");
    return "";
  }
  const name = "neptune-resume";
  try {
    ctx.skills.register({
      name,
      description:
        "尼普顿充电续充的流程与硬规则。取凭证、查状态、选插座、起任务、续充时用。" +
        "用户说的「小龟」就是电瓶车，问小龟充电情况也用这个。",
      whenToUse:
        "用户要查充电状态、要续充、或要定一个明早续上的任务。" +
        "问「小龟」充电情况也算。",
      // 装好的运行时要求这个字段。source 取 runtime 表示「插件在运行时注册的技能」。
      source: "runtime",
      content: readFileSync(SKILL_PATH, "utf8"),
      // 资源基准目录。宿主把它注入技能正文，
      // 技能里提到的相对路径（references/xxx.md）就能直接读，不用满世界找。
      resourceBase: { kind: "directory", path: SKILL_DIR },
    });
    console.log("[dsh-neptune] 技能已注册：neptune-resume");
  } catch (err) {
    console.log(`[dsh-neptune] 技能注册失败：${err?.message ?? err}`);
  }
  return name;
}
