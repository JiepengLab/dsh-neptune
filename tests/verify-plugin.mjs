/**
 * verify-plugin.mjs — 插件入口的独立验证。不需要 DSH 宿主。
 *
 * 跑法：node tests/verify-plugin.mjs
 *
 * 用一个假 ctx 把插件跑起来：看它注册了哪些工具，
 * 再验起单那几道闸门。
 * 只读：不发起单。退出码即判据。
 */

import { apply, msUntilNext } from "../index.js";
import { deliveryTarget, parseTarget, targetLine } from "../lib/task.js";
import { parseSocketLabel, scanLabels } from "../lib/scan.js";
import { deliveryPrompts, wokenBySchedule } from "../lib/turn.js";
import { nextDailyOccurrence } from "../lib/time.js";
import { createHash } from "node:crypto";
import { credential, findPairing, findPairingIn, resume } from "../core/neptune-core.mjs";
import { mask } from "../lib/format.js";
import { setClipboardWriter } from "../lib/recipe.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const problems = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) problems.push(label);
};

const tools = new Map();
const commands = new Map();
const listeners = new Map();
const effects = [];
const schedules = [];
const skills = [];

/** 假 ctx 里把 at 选择器还原成本地时刻。 */
function fakeScheduledAt(timing) {
  const at = timing?.at;
  if (!at) return new Date(0).toISOString();
  const [year, month, day] = at.date.split("-").map(Number);
  const [hour, minute, second] = at.time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },

  },
  commands: {
    register(definition) {
      commands.set(definition.name, definition);
      return () => commands.delete(definition.name);
    },
  },
  on(event, handler) {
    listeners.set(event, handler);
  },
  effect(fn) {
    const disposer = fn();
    effects.push(disposer);
    return disposer;
  },
  skills: {
    register(definition) {
      skills.push(definition);
      return () => skills.splice(skills.indexOf(definition), 1);
    },
  },
  schedule: {
    // 签名跟宿主一致：create(request, actorSessionId, signal)。
    // 之前这里写的是 create(request)，把插件的调用错误兜住了，真机上才炸。
    async create(request, actorSessionId, signal) {
      schedules.push({ request, actorSessionId, signal });
      return { id: `schedule-test-${schedules.length}` };
    },
    // 全宿主的分页。插件自己筛出本会话的。
    async list() {
      const items = schedules.map((entry, index) => ({
        id: `schedule-test-${index + 1}`,
        scheduledAt: fakeScheduledAt(entry.request?.timing),
        target: entry.request?.target,
        status: "active",
      }));
      return { items, shown: items.length, total: items.length, limit: 100, offset: 0 };
    },
  },
};

apply(ctx);

const pairing = await findPairing();

/**
 * 值的哈希。测试只留哈希，不留原值。
 * 留了原值，将来有人加一行打印就把它带进日志。
 * @param {string} text 要算的值。
 * @returns {string} 十六进制的哈希。
 */
function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** 造一个假的 exec。events 是会话日志。 */
function fakeExec(name, args, events) {
  return {
    name,
    arguments: args ?? {},
    signal: undefined,
    agent: { session: { id: "session-test", events: events ?? [] } },
  };
}

/** 一条用户消息。人打字的来源是 user。 */
function userMessage(text) {
  return {
    type: "user/message",
    data: { role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
  };
}

/** 一条投递消息。来源是 schedule。 */
function scheduleMessage(text) {
  return {
    type: "user/message",
    data: { role: "user", content: [{ type: "text", text }], source: { kind: "schedule" } },
  };
}

/** 宿主写的那种单条投递正文。 */
function deliveryText(prompt) {
  return [
    "[SCHEDULE REMINDER]",
    "This is a scheduled message from the user",
    `schedule_id_json: "schedule-test"`,
    `occurrence_at: 2026-11-04T22:05:00.000Z`,
    `reminder_prompt_json: ${JSON.stringify(prompt)}`,
  ].join("\n");
}

/** 宿主写的那种批量投递正文。 */
function batchText(prompts) {
  return [
    "[SCHEDULE REMINDER BATCH]",
    "This is a scheduled message from the user",
    `reminders_json: ${JSON.stringify(prompts.map((prompt) => ({
      schedule_id: "schedule-test",
      occurrence_at: "2026-11-04T22:05:00.000Z",
      reminder_prompt: prompt,
    })))}`,
  ].join("\n");
}

/** 一条我们的任务提示。 */
function ourPrompt(devaddress = "50959120", port = "11") {
  return [
    "这是你批准的尼普顿续充任务，到点了。",
    targetLine(devaddress, port),
    `目标：桩 ${devaddress} 的 ${port} 号插座。`,
  ].join("\n");
}

console.log("=== 注册了什么 ===");
console.log("工具:", [...tools.keys()].join(", ") || "（无）");
console.log("命令:", [...commands.keys()].join(", ") || "（无）");
console.log("技能:", skills.map(s => s.name).join(", ") || "（无）");
check(tools.size === 7, "注册了 7 个工具");
check(skills.length === 1, "注册了 1 个技能");
check(skills[0]?.name === "neptune-resume", "技能叫 neptune-resume");
check(skills[0]?.source === "runtime", "技能带了 source 字段。装好的运行时加载时要它");
check(skills[0]?.resourceBase?.kind === "directory", "技能带了资源基准目录");
check(String(skills[0]?.resourceBase?.path ?? "").includes("neptune-resume"), "资源基准目录指向技能目录");
check(existsSync(join(String(skills[0]?.resourceBase?.path ?? ""), "references", "alternate-routes.md")),
  "资源目录里有那份替代路线的说明");
check(typeof skills[0]?.description === "string" && skills[0].description.length > 0, "技能有非空的描述");
check(tools.has("neptune_pair") && tools.has("neptune_status")
  && tools.has("neptune_sockets") && tools.has("neptune_charge") && tools.has("neptune_scan")
  && tools.has("neptune_recipe"), "工具名字对");
check(!tools.get("neptune_charge")?.parameters?.token, "续充工具不再有 token 参数");

console.log("\n=== 只读工具实跑 ===");
const pairTool = tools.get("neptune_pair");
const pairOut = await pairTool.execute({}, { signal: undefined });
console.log("neptune_pair →", pairOut);
check(/凭证已就绪|没找到/.test(String(pairOut)), "取凭证有明确结果");

console.log("\n=== 配方网址工具 ===");
// 剪贴板换成替身。测试不动真剪贴板。
// 抓到的东西只留派生数据：长度、哈希、几项检查结果。
// 原始值不进数组，将来有人加一行 console.log(captured) 也不会漏进日志。
const captured = [];
setClipboardWriter(async (text) => {
  const value = String(text);
  captured.push({
    len: value.length,
    sha: sha256(value),
    isUrl: value.startsWith("https://szlzxn.cn/wxn/beginCharge?"),
    isAreaId: value === "6",
    hasMoney7: /(^|&)money=7(&|$)/.test(value),
    devaddress: (value.match(/[?&]devaddress=(\d+)/) ?? ["", ""])[1],
    port: (value.match(/[?&]port=(\d+)/) ?? ["", ""])[1],
    hasEmployeeid: /employeeid=\d+/.test(value),
    hasUndefined: value.includes("undefined"),
    paramCount: (value.split("?")[1] ?? "").split("&").length,
  });
  return { ok: true, written: true };
});

const recipeTool = tools.get("neptune_recipe");
const realOpenId = pairing?.openId ?? "";

try {
  const areaOut = await recipeTool.execute({ what: "area_id" }, { signal: undefined });
  console.log("neptune_recipe(area_id) →", areaOut);
  check(captured.length === 1, "写了一次剪贴板");
  check(captured[0].isAreaId, "写的是校区号");
  check(/已放到剪贴板/.test(String(areaOut)), "回报说放好了");
  check(!String(areaOut).includes(realOpenId), "回报里没有 openId 明文");

  // 这一支是唯一真正搬运凭证的分支。
  const openOut = await recipeTool.execute({ what: "open_id" }, { signal: undefined });
  console.log("neptune_recipe(open_id) →", openOut);
  check(captured.length === 2, "又写了一次");
  check(captured[1].len === realOpenId.length, "写的是 openId 本身");
  check(captured[1].sha === sha256(realOpenId), "写的是这个账号的 openId");
  check(!String(openOut).includes(realOpenId), "回报里没有 openId 明文");
  check(!String(openOut).includes(mask(realOpenId)), "回报里连掩码也没有");

  const urlOut = await recipeTool.execute({ what: "url" }, { signal: undefined });
  console.log("neptune_recipe(url) →", String(urlOut).slice(0, 48));
  check(captured.length === 3, "又写了一次");
  check(captured[2].isUrl, "写的是起单网址");
  check(captured[2].hasMoney7, "网址带 money=7，那是计量档的标志值");
  check(captured[2].devaddress.length === 8, "网址带着 8 位桩号");
  check(captured[2].port.length === 2, "网址带着插座号");
  check(captured[2].hasEmployeeid, "网址带着 employeeid");
  check(!captured[2].hasUndefined, "网址里没有 undefined");
  check(captured[2].paramCount >= 20, "网址的参数够数");
  check(!String(urlOut).includes(realOpenId), "回报里没有 openId 明文");
  check(
    String(urlOut).includes(captured[2].devaddress)
      && String(urlOut).includes(`${captured[2].port} 号插座`),
    "回报说清了是哪个桩哪个插座",
  );

  // 桩号与插座号只给一个会取到上一单的那个插座，可能不是同一根桩。
  const halfOut = await recipeTool.execute({ what: "url", devaddress: "50959120" }, { signal: undefined });
  console.log("neptune_recipe(只给桩号) →", halfOut);
  check(/要一起给/.test(String(halfOut)), "只给一个时说清楚要一起给");
  check(captured.length === 3, "没写剪贴板");

  const badOut = await recipeTool.execute({ what: "没有这个" }, { signal: undefined });
  console.log("neptune_recipe(乱写) →", badOut);
  check(/不知道要写哪一个/.test(String(badOut)), "写错名字时说得清");
} finally {
  // 替身不留在进程里。测到一半崩了也不能留着它。
  setClipboardWriter(null);
}

console.log("\n=== 照片路径 ===");
const scanTool = tools.get("neptune_scan");
const noCwd = await scanTool.execute({ path: "qr.jpg" }, { signal: undefined });
console.log("neptune_scan(无工作目录) →", noCwd);
check(/绝对路径/.test(String(noCwd)), "会话没有工作目录时要求绝对路径");
const withCwd = await scanTool.execute(
  { path: "qr.jpg" },
  { signal: undefined, agent: { session: { id: "s", header: { cwd: "SESSION_CWD" } } } },
);
console.log("neptune_scan(相对路径) →", String(withCwd).slice(0, 60));
check(/SESSION_CWD/.test(String(withCwd)), "相对路径按会话的工作目录解析");

console.log("\n=== 环境变量入口 ===");
// 用假值测。只验「读到了、来源标对了」，不碰真凭证。
process.env.NEPTUNE_OPENID = "zju-neptune:v1:FAKE_OPENID_FOR_TEST:6";
const fromPaired = await credential();
console.log("给整条配对串 →", fromPaired?.source, "areaId", fromPaired?.areaId);
check(fromPaired?.openId === "FAKE_OPENID_FOR_TEST", "配对串里的 openId 取到了");
check(fromPaired?.areaId === 6, "配对串里的校区号取到了");
process.env.NEPTUNE_OPENID = "FAKE_OPENID_2";
process.env.NEPTUNE_AREAID = "2";
const fromBare = await credential();
console.log("给裸 openId →", fromBare?.source, "areaId", fromBare?.areaId);
check(fromBare?.openId === "FAKE_OPENID_2", "裸 openId 取到了");
check(fromBare?.areaId === 2, "NEPTUNE_AREAID 生效");
check(String(fromBare?.source).includes("环境变量"), "来源标成环境变量");
delete process.env.NEPTUNE_OPENID;
delete process.env.NEPTUNE_AREAID;
const fromWechat = await credential();
check(fromWechat?.source?.includes("History") || fromWechat?.source?.includes("环境变量"),
  "没有环境变量时回到挖本机微信");

console.log("\n=== agent 给目录那条路 ===");
// 造一棵假的微信目录树。内容是假 openId，不碰真凭证。
const fakeRoot = join(tmpdir(), `neptune-fake-${process.pid}`);
const fakeProfiles = join(fakeRoot, "radium", "web", "profiles", "multitab_fake");
mkdirSync(fakeProfiles, { recursive: true });
writeFileSync(
  join(fakeProfiles, "History"),
  "https://szlzxn.cn/wx/indexn.html?openId=FAKE_IN_DIR_TEST&areaid=6&employeeId=1",
  "utf8",
);
const fromDir = await findPairingIn(join(fakeRoot, "radium", "web", "profiles"));
console.log("扫假目录 →", fromDir?.source);
check(fromDir?.openId === "FAKE_IN_DIR_TEST", "目录里扫出了 openId");
check(fromDir?.areaId === 6, "目录里扫出了校区号");
const viaDir = await credential({ dir: join(fakeRoot, "radium", "web", "profiles") });
check(viaDir?.openId === "FAKE_IN_DIR_TEST", "credential 走目录这条路");
const emptyDir = await findPairingIn(join(fakeRoot, "nothing-here"));
check(emptyDir === null, "没有 History 时返回 null");
rmSync(fakeRoot, { recursive: true, force: true });

const statusOut = await tools.get("neptune_status").execute({}, { signal: undefined });
console.log("neptune_status →\n" + statusOut);
check(/余额/.test(String(statusOut)), "状态里有余额");

// 插座表要真打一次厂商接口。桩号从环境变量取，包里不写死某一个桩。
const testDevice = process.env.NEPTUNE_TEST_DEVICE;
if (testDevice) {
  const socketsOut = await tools.get("neptune_sockets").execute(
    { devaddress: testDevice }, { signal: undefined });
  console.log("neptune_sockets →\n" + socketsOut);
  check(/号/.test(String(socketsOut)), "插座表有内容");
} else {
  console.log("neptune_sockets → 跳过。没给 NEPTUNE_TEST_DEVICE。");
  check(true, "插座表检查可跳过");
}

console.log("\n=== 每日自动续充的定时器 ===");
const now = new Date(2026, 10, 3, 23, 50, 0, 0);
const soon = msUntilNext(6, 5, now.getTime());
const later = msUntilNext(6, 5, new Date(2026, 10, 3, 6, 30, 0, 0).getTime());
console.log("23:50 到明早 06:05:", Math.round(soon / 60000), "分钟");
console.log("06:30 到次日 06:05:", Math.round(later / 60000), "分钟");
check(Math.round(soon / 60000) === 375, "23:50 起算到 06:05 是 375 分钟");
check(Math.round(later / 60000) === 1415, "过了点就顺延到次日");
check(effects.length === 0, "默认不挂自动续充（要开在配置里）");

console.log("\n=== 起一个 DSH 任务 ===");
// 时间取两分钟以后，这样才测得到投递正文。
const due = new Date(Date.now() + 2 * 60 * 1000);
const p2 = (n) => String(n).padStart(2, "0");
const soonTime = `${p2(due.getHours())}:${p2(due.getMinutes())}:${p2(due.getSeconds())}`;
const taskOut = await tools.get("neptune_charge_at").execute(
  { time: soonTime },
  fakeExec("neptune_charge_at", { time: soonTime },
    [{ type: "turn/start" }, userMessage("明早六点帮我续上")]));
console.log("neptune_charge_at →", taskOut);
check(schedules.length === 1, "建了一个 DSH 任务");
const call = schedules[0] ?? {};
const task = call.request ?? {};
check(call.actorSessionId === "session-test", "任务挂在调用方的会话上");
check(call.request?.target?.sessionId === "session-test", "任务投回调用方的会话");
check(typeof task.title === "string" && task.title.includes("尼普顿"), "任务有标题");
check(/尼普顿续充目标：devaddress=\d+ port=\d+/.test(task.prompt ?? ""),
  "任务提示里有机器可读的目标行");
check(!(task.prompt ?? "").includes("授权码"), "任务提示里没有授权码");
check(task.timing?.kind === "at", "一次性任务的计时是 at");
check(task.timing?.at?.time === soonTime, "时刻是 HH:mm:ss");
check(task.timing?.at?.time_zone === "Asia/Shanghai", "时刻带时区");
check(/^\d{4}-\d{2}-\d{2}$/.test(task.timing?.at?.date ?? ""), "任务带了一个日历日");
check(pairing ? !task.prompt.includes(pairing.openId) : true, "任务里没有 openId 的值");

console.log("\n=== 不给时刻就定在 06:05 ===");
await tools.get("neptune_charge_at").execute(
  {},
  fakeExec("neptune_charge_at", {},
    [{ type: "turn/start" }, userMessage("帮我续充")]),
);
const defaultCall = schedules[schedules.length - 1]?.request ?? {};
console.log("不给时刻 →", JSON.stringify(defaultCall.timing?.at));
check(defaultCall.timing?.at?.time === "06:05:00", "不给时刻就定在 06:05");

console.log("\n=== 每天重复的任务 ===");
await tools.get("neptune_charge_at").execute(
  { time: "06:05", daily: true },
  fakeExec("neptune_charge_at", { time: "06:05", daily: true },
    [{ type: "turn/start" }, userMessage("每天六点续上")]));
const dailyCall = schedules[schedules.length - 1]?.request ?? {};
console.log("每天 →", JSON.stringify(dailyCall.daily));
check(dailyCall.timing?.kind === "daily", "每天任务的计时是 daily");
check(dailyCall.timing?.daily?.time === "06:05:00", "每天任务的时刻是 HH:mm:ss");
check(dailyCall.timing?.daily?.time_zone === "Asia/Shanghai", "每天任务带时区");

console.log("\n=== 插座不在这根桩上 ===");
let socketError = "";
try {
  await tools.get("neptune_charge_at").execute(
    { devaddress: "50959120", port: "99" },
    fakeExec("neptune_charge_at", { devaddress: "50959120", port: "99" },
      [{ type: "turn/start" }, userMessage("起明早的单")]),
  );
} catch (err) {
  socketError = String(err?.message ?? err);
}
console.log("不存在的插座 →", socketError);
check(socketError.includes("没有 99 号插座"), "照片读错编号时当场报错");

console.log("\n=== 扫插座二维码 ===");
const { default: QRCode } = await import("qrcode");
const qrPath = join(tmpdir(), "neptune-test-socket-qr.png");
writeFileSync(qrPath, await QRCode.toBuffer("http://szlzxn.cn/wechat/wxscan/5095912011", { type: "png", width: 480 }));
const scanned = await scanLabels(qrPath);
console.log("扫出来 →", JSON.stringify(scanned));
check(scanned[0]?.devaddress === "50959120" && scanned[0]?.port === "11", "照片里的编号拆成桩号与插座号");
check(parseSocketLabel("5095912011")?.port === "11", "裸编号也认");
check(parseSocketLabel("https://example.com/x") === null, "别的内容不乱认");

// 二维码优先。印刷编号与二维码不一致时，工具要说出来。
const conflict = await tools.get("neptune_scan").execute(
  { path: qrPath, label: "5095912099" },
  fakeExec("neptune_scan", { path: qrPath, label: "5095912099" },
    [{ type: "turn/start" }, userMessage("这个插座")]),
);
console.log("两个编号不一致 →", conflict);
check(String(conflict).includes("以二维码为准"), "印刷编号与二维码不一致时说以二维码为准");
check(String(conflict).includes("50959120"), "冲突时仍给出二维码那个插座");

console.log("\n=== 没有会话时建不了任务 ===");
let noSessionError = "";
try {
  await tools.get("neptune_charge_at").execute({ time: "06:05" }, { signal: undefined });
} catch (err) {
  noSessionError = String(err?.message ?? err);
}
console.log("没有 agent →", noSessionError);
check(noSessionError.includes("会话"), "没有会话时给了明确报错");

console.log("\n=== 投递消息里的绑定说了算 ===");
const bound = deliveryTarget(fakeExec("neptune_charge", {},
  [{ type: "turn/start" }, scheduleMessage(deliveryText(ourPrompt("50959120", "11")))]));
console.log("投递里的目标 →", JSON.stringify(bound));
check(bound?.devaddress === "50959120" && bound?.port === "11", "认出了投递消息里的目标");
check(parseTarget("没有目标行") === null, "没有目标行就认不出");
check(parseTarget(targetLine("50959120", "07"))?.port === "07", "目标行能认回来");
check(wokenBySchedule(fakeExec("neptune_charge", {},
  [{ type: "turn/start" }, scheduleMessage("x")])) === true, "认得出投递叫醒");
check(deliveryPrompts(deliveryText(ourPrompt())).length === 1, "认得出单条投递正文");
check(deliveryPrompts(batchText(["甲", "乙"])).length === 2, "认得出批量投递正文");
check(deliveryPrompts("看不懂的正文").length === 0, "看不懂就当没有");

// 没有那条投递消息就没有批准，当场续这条路已经没有了。
const noBinding = await tools.get("neptune_charge").execute(
  { devaddress: "50959120", port: "11" },
  fakeExec("neptune_charge", { devaddress: "50959120", port: "11" },
    [{ type: "turn/start" }, userMessage("现在就续")]),
);
console.log("不到点 →", noBinding);
check(String(noBinding).includes("不到点不续充"), "不到点就不起单");

// 拿批准过的那个插座去续别的，要拦下来。
const wrongTarget = await tools.get("neptune_charge").execute(
  { devaddress: "50959120", port: "07" },
  fakeExec("neptune_charge", { devaddress: "50959120", port: "07" },
    [{ type: "turn/start" }, scheduleMessage(deliveryText(ourPrompt("50959120", "11")))]));
console.log("拿批准过的去续别的插座 →", wrongTarget);
check(String(wrongTarget).includes("批准的是别的插座"), "拿批准过的去续别的插座被拦下");

console.log("\n=== 断电判据只在投递那条路上开 ===");
// 投递那条路上，最近一单是手动结束的就不续。
const manualOrder = {
  begindt: "20261103100000", devaddress: "50959120", devport: "11",
  chargetime: 60, eleconsum: 1000, endtype: 1, enddt: Date.parse("2026-11-03T21:05:00+08:00"),
};
const cutOrder = {
  begindt: "20261103224819", devaddress: "50959120", devport: "11",
  chargetime: 78, eleconsum: 192, endtype: 39, enddt: Date.parse("2026-11-04T00:10:00+08:00"),
};
const fakeClient = {
  async currentSession() { return null; },
  async chargeLog() { return [manualOrder, cutOrder]; },
  async account() { return { employeeid: "1", readyaccountmoney: 700 }; },
  async deviceInfo() { return { isWorkTime: 1, workTime: "6:00-24:00", yk: 100, portstatur: "000000000000" }; },
  async startCharge() { return { ok: true }; },
};
const strict = await resume(fakeClient, { requireCut: true });
console.log("最近一单是手动结束的 →", strict.action, strict.reason);
check(strict.action === "skipped", "手动结束的那一单不续");
check(/断电|手动结束|结束方式/.test(String(strict.detail)), "报出了那一单是怎么结束的");

const cutOnly = {
  ...fakeClient,
  async chargeLog() { return [cutOrder]; },
};
const strictCut = await resume(cutOnly, { requireCut: true, dryRun: true });
console.log("最近一单是断电切掉的 →", strictCut.action, strictCut.reason);
check(strictCut.action === "resume", "断电切掉的那一单照续");


// 计划里要看得懂：这个插座是哪来的，上一单是什么时候的事。
const plan = await resume(fakeClient, { dryRun: true });
console.log("演练 →", plan.action, plan.detail);
check(plan.action === "resume", "演练说会续充");
check(/号插座/.test(plan.detail), "计划里写了哪个插座");
check(plan.detail.includes("上一单"), "计划里写了那是哪一单");
check(plan.detail.includes("手动结束的"), "上一单是手动结束的，说清楚");
check(plan.devaddress === "50959120" && plan.port === "11", "计划里带着目标插座");
const cutPlan = await resume(cutOnly, { dryRun: true });
check(cutPlan.detail.includes("被午夜断电切掉的"), "断电切掉的那一单说清楚");

const loose = await resume(fakeClient, { dryRun: true });
console.log("当场续（不带约束）→", loose.action, loose.reason);
check(loose.action === "resume", "当场续不受断电判据约束");


console.log("\n=== 命令 ===");
// 假 ctx 里留着 commands 服务当探针。插件不碰它，这里就是空的。
check(commands.size === 0, "插件没有注册命令。用户界面里不出现这个插件的命令");

process.exit(problems.length ? 1 : 0);
