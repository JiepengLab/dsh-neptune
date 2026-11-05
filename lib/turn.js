/**
 * lib/turn.js — 当前这一回合是被谁叫醒的。
 *
 * 宿主把定时提醒作为一条用户消息投进会话，来源标记是 schedule。
 * 人打字的请求来源是 user。
 * 插件靠这个认一件事：这次调用是不是那次投递在说话。
 *
 * 批准在签发时发生。这个模块只给事实，不给结论。
 */

/**
 * 会话日志。
 * 0.2.2-rc.1 起是 ownEvents()；更早是 session.events。
 */
function readEvents(session) {
  if (!session) return [];
  if (typeof session.ownEvents === "function") {
    try {
      const events = session.ownEvents();
      if (Array.isArray(events)) return events;
    } catch {
      // 落到下一个取法
    }
  }
  if (typeof session.snapshotEvents === "function") {
    try {
      const events = session.snapshotEvents();
      if (Array.isArray(events)) return events;
    } catch {
      // 落到下一个取法
    }
  }
  return Array.isArray(session.events) ? session.events : [];
}

/**
 * 一条事件里带的那些消息。
 * user/message 是消息本身。agent/inbox/spliced 是插进收件箱的那几条，
 * 刚投进来的消息先记在那里，要到下一个步骤才落成 user/message。
 */
function messagesOf(event) {
  if (event.type === "user/message") return [event.data];
  if (event.type === "agent/inbox/spliced") {
    return Array.isArray(event.data?.inserted) ? event.data.inserted : [];
  }
  return [];
}

/** 当前回合里的那些消息。从后往前扫，遇到回合边界就停。 */
function turnMessages(exec) {
  const events = readEvents(exec?.agent?.session);
  const messages = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || typeof event !== "object") continue;
    if (event.type === "turn/start" || event.type === "turn/end") break;
    for (const message of messagesOf(event)) {
      if (message && typeof message === "object") messages.push(message);
    }
  }
  return messages.reverse();
}


/** 这一回合是被定时投递叫醒的吗。 */
export function wokenBySchedule(exec) {
  return turnMessages(exec).some((m) => m?.source?.kind === "schedule");
}

/** 消息正文。把文本块拼起来。 */
function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("\n");
}

/** 这一回合里的投递正文。没有投递就空串。 */
export function scheduleDeliveryText(exec) {
  const message = turnMessages(exec).find((m) => m?.source?.kind === "schedule");
  return message ? messageText(message) : "";
}

/** JSON 解析。坏的就当没有，不抛。 */
function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 投递正文里的提示词。两种格式都认。
 * 单条是 reminder_prompt_json 那一行，批量是 reminders_json 整个数组。
 * 格式是宿主写的，认不出来就返回空数组，调用方按「没有批准」处理。
 */
export function deliveryPrompts(text) {
  const prompts = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("reminder_prompt_json:")) {
      const parsed = safeJson(trimmed.slice("reminder_prompt_json:".length).trim());
      if (typeof parsed === "string") prompts.push(parsed);
    } else if (trimmed.startsWith("reminders_json:")) {
      const parsed = safeJson(trimmed.slice("reminders_json:".length).trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.reminder_prompt === "string") prompts.push(item.reminder_prompt);
        }
      }
    }
  }
  return prompts;
}
