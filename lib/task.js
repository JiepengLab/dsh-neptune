/**
 * lib/task.js — 续充任务怎么写，怎么认回来。
 *
 * 任务由宿主持久化。那条任务记录就是批准凭据：它记着续哪个桩哪个插座。
 * 插件不另造秘密，也不落盘。
 *
 * 批准在签发时发生。执行时只核对凭据，不问人。
 */

import { deliveryPrompts, scheduleDeliveryText } from "./turn.js";

/** 目标那行的前缀。投递消息里靠它认出「这条提醒是我们的」。 */
export const TARGET_PREFIX = "尼普顿续充目标";

/** 目标那行。桩号与插座号。 */
export function targetLine(devaddress, port) {
  return `${TARGET_PREFIX}：devaddress=${devaddress} port=${port}`;
}

/** 从一段文字里取目标。取不到就空。 */
export function parseTarget(text) {
  const match = /尼普顿续充目标[：:]\s*devaddress=(\d+)\s+port=(\d+)/.exec(String(text ?? ""));
  if (!match) return null;
  return { devaddress: match[1], port: match[2] };
}

/**
 * 投递消息里我们批准的那个目标。
 * 认不出来就空。调用方按「没有批准」处理，不起单。
 */
export function deliveryTarget(exec) {
  for (const prompt of deliveryPrompts(scheduleDeliveryText(exec))) {
    const target = parseTarget(prompt);
    if (target) return target;
  }
  return null;
}

/** 到点投进会话的那段指令。带机器可读的目标行。 */
export function buildResumePrompt({ devaddress, port }) {
  return [
    "这是你批准的尼普顿续充任务，到点了。",
    targetLine(devaddress, port),
    `目标：桩 ${devaddress} 的 ${port} 号插座。`,
    "做法：调用 neptune_charge，带上 devaddress、port。",
    "它自己会查有没有进行中的订单、插座空不空、余额够不够。照它报的结果办，不要绕过。",
    "做完核对：档位 costunit 应等于那台桩的 efee，预扣应等于它的 yk 分，余额少了预扣那么多，用电量开始涨。",
    "然后把结果说给用户：起没起、续的哪根桩哪个插座、扣了多少、余额剩多少、那个插座有没有被别人占上。",
    "不要把 openId 或配对串贴出来。",
  ].join("\n");
}
