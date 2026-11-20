/**
 * verify.mjs — 核心逻辑的独立验证。不需要 DSH 宿主。
 *
 * 跑法：node tests/verify.mjs
 *
 * 只读。凭证不打印：openId 一律打码。退出码即判据。
 */

import {
  Client, findPairing, formatStatus, recipeCurl, recipeUrl, resume,
  buildChargeBody, socketState, isMidnightCut, profilesDir, profilesDirCandidates, wechatRoots, findPairingIn,
} from "../core/neptune-core.mjs";

const mask = (openId) => (openId ? openId.slice(0, 4) + "…" + openId.slice(-3) : "无");

const problems = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) problems.push(label);
};

/** 记下当前在哪一步。出错时要说清是第几步、期望什么。 */
let step = "启动";
const at = (name) => { step = name; console.log(`\n=== ${name} ===`); };

// 厂商接口偶尔抽风。出错时要说清卡在哪一步，别只甩一个栈。
process.on("unhandledRejection", (err) => {
  console.log(`\n第「${step}」这一步失败：${err?.message ?? err}`);
  console.log("多半是厂商接口临时不可用或网络抖了。重跑一次。");
  process.exit(1);
});

at("1. 从本机微信浏览历史取凭证");
console.log("目录:", profilesDir());
const pairing = await findPairing();
check(!!pairing, pairing ? `找到配对串，来源 ${pairing.source}` : "没找到配对串");
if (!pairing) {
  console.log("\n没找到。回电脑微信里打开厂商链接，等它跳完，再跑一次。");
  process.exit(1);
}
console.log("openId:", mask(pairing.openId), " areaId:", pairing.areaId);

const client = new Client(pairing);
at("2. 账户与当前状态");
const account = await client.account();
check(Number(account.employeeid) > 0, `拿到 employeeid=${account.employeeid}`);
const session = await client.currentSession();
console.log("进行中的订单:", session ? `桩 ${session.devaddress} 的 ${session.devport} 号插座` : "无");

at("3. 订单历史与断电判据");
const orders = await client.chargeLog();
check(orders.length > 0, `历史订单 ${orders.length} 条`);
const last = orders.find((o) => Number(o.chargetime || 0) > 0) ?? orders[0];
const cut = orders.filter(isMidnightCut);
console.log(`最近一单: ${last.begindt} 桩 ${last.devaddress} 的 ${last.devport} 号插座`);
console.log(`半夜断电的单: ${cut.length} 条，最新一条 ${cut[0]?.begindt ?? "无"}`);

at("4. 设备与插座");
const device = await client.deviceInfo(String(last.devaddress));
console.log(`${device.devdescript || ""}  可充时段 ${device.workTime || "?"}  ycTime=${device.ycTime}  yk=${device.yk}`);
console.log("portstatur:", device.portstatur);
const st = socketState(device, String(last.devport));
console.log(`目标插座 ${last.devport}: ${st.free ? "空闲" : "有人在用（" + st.why + "）"}`);

at("5. 起单体（只拼不发）");
const body = buildChargeBody({
  openId: pairing.openId, areaId: pairing.areaId, employeeid: account.employeeid,
  devaddress: String(last.devaddress), port: String(last.devport),
  device, balance: account.readyaccountmoney,
});
console.log("字段数:", Object.keys(body).length);
console.log("money:", body.money, " yuan7:", body.yuan7,
  " efee:", body.efee, " eCharge:", body.eCharge, " serviceCharge:", body.serviceCharge);
check(body.money === 7, "money=7（计量档标志值）");
check(body.yuan7 === 0, "yuan7=0（充满自停）");
check(Object.keys(body).length === 23, "起单字段 23 个");
const url = recipeUrl(body);
console.log("配方网址（openId 已打码）:", url.replace(/openId=[^&]*/, "openId=…"));
console.log("cURL 行数:", recipeCurl(body).split("\n").length);

at("6. 续充演练（不发请求）");
const dry = await resume(client, { dryRun: true });
console.log(`${dry.action}：${dry.reason}  ${dry.detail}`);

at("6b. 余额不够预扣时要在起单前拦下");
// 假一个余额只有 50 分（0.5 元）的账号。那台桩预扣 yk 分。
const poorBalance = {
  async account() { return { employeeid: account.employeeid, readyaccountmoney: 50 }; },
  async chargeLog() { return orders; },
  async currentSession() { return null; },
  async deviceInfo() { return device; },
};
const poor = await resume(poorBalance, { dryRun: false, devaddress: String(last.devaddress), port: String(last.devport) });
console.log(`余额 0.5 元 → ${poor.action}：${poor.reason}  ${poor.detail}`);
check(poor.action === "skipped", "余额不够预扣时不起单");
check(poor.reason.includes("预扣"), "报的是预扣不够，不是余额为 0");

at("7. 状态摘要");
console.log(formatStatus({ account, session, last, device }));

at("8. 凭证路径的候选与兜底");
console.log("候选:", profilesDirCandidates().join(" | "));
check(profilesDirCandidates().length >= 2, "有多条候选路径（3.x 与 4.x、macOS 的版本目录）");
const scanStart = Date.now();
const scanned = await findPairingIn(wechatRoots()[0], { maxDepth: 9, maxFiles: 400 });
console.log(`兜底扫描 ${Date.now() - scanStart} ms →`, scanned ? `找到 ${scanned.source}` : "没找到");
check(Boolean(scanned), "在微信根目录下扫到凭证");

console.log("\n" + (problems.length ? `有 ${problems.length} 项不通过` : "全部通过"));
process.exit(problems.length ? 1 : 0);
