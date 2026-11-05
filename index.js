/**
 * index.js — DSH 插件：尼普顿充电
 *
 * 一套从取 openId 到续充的全流程：
 *   - 工具：给模型用的只读查询，加上起任务与到点续充
 *
 * 凭证只存在内存里。它不进模型的上下文，也不返回给调用方。
 * 起单会预扣余额，所以有三样东西把关：
 *   1. 插件自己的五道闸门
 *      （已经在充 / 不在可充时段 / 余额为 0 / 余额不够预扣 / 目标插座不空闲）
 *   2. 无人值守那条路只续被午夜断电切掉的那一单
 *   3. 批准在签发时发生，不在执行时。任务建好就等于用户批准过
 *
 * 这个文件只做接线。域逻辑在 lib/ 下。
 */

import { markLoaded } from "./lib/log.js";
import { registerSkill } from "./lib/skill.js";
import { registerTools } from "./lib/tools.js";

export const name = "dsh-neptune";

// 不注册命令。插件不给用户任何命令入口，用户界面里看不到它。
export const inject = ["tools", "schedule", "skills"];

export function apply(ctx, config) {
  // 这一轮注册了什么。UI 看不全时，看加载日志里那行。
  const toolNames = [];
  const registerTool = (definition) => {
    toolNames.push(definition.name);
    return ctx.tools.register(definition);
  };

  console.log("[dsh-neptune] 插件已加载。凭证只在内存里，不进模型上下文。");
  markLoaded();

  // 流程与硬规则。装上就有了，模型按需加载。
  const skillName = registerSkill(ctx);

  // 这里不拦着问人。用户的话就是授权，agent 带着上下文照做。
  // 关起单的钱由三样东西把关：
  //   1. 插件自己的五道闸门
  //      （已经在充 / 不在可充时段 / 余额为 0 / 余额不够预扣 / 目标插座不空闲）
  //   2. 无人值守只续被午夜断电切掉的那一单
  //   3. 批准在签发时发生，不在执行时

  registerTools(ctx, registerTool);

  // 记下这一轮注册了什么。UI 看不全时，看这行。
  markLoaded({
    tools: toolNames,
    skill: skillName ? [skillName] : [],
  });
}

// 转发几个对外要用到的函数。任务提示词与目标行是一处。
export { buildResumePrompt, parseTarget, targetLine } from "./lib/task.js";
export { msUntilNext } from "./lib/time.js";
export { parseSocketLabel } from "./lib/scan.js";
