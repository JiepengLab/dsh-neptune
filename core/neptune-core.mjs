/**
 * core/neptune-core.mjs — 尼普顿接口的核心逻辑。
 *
 * 这一层不依赖 DSH，只依赖 node 内置模块与 fetch。
 * 好处是能脱离宿主单独验证：`node tests/verify.mjs`。
 *
 * 凭证不落盘。openId 从本机微信浏览历史里读出来，只存在内存里，
 * 不进模型的上下文，也不返回给调用方。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 厂商接口主机。`www.szlzxn.cn` 那台已经不通了，只用主域。 */
export const API = "https://szlzxn.cn";

/** 配对串前缀。 */
export const PAIR_KEY = "zju-neptune:v1";

/** 配对串整体。环境变量里可以给整条。 */
const PAIR_PREFIX_RE = new RegExp(`^${PAIR_KEY}:([A-Za-z0-9_-]+):(\\d+)$`);

/**
 * 校区号。配对串里没有、也没给环境变量时用它。
 * 尼普顿在紫金港是 6。别的校区要显式给 `NEPTUNE_AREAID`。
 */
const DEFAULT_AREA_ID = 6;

/** 落地网址在浏览历史里是明文。正则就能取，不用解析 SQLite。 */
const PAIR_RE = /indexn\.html\?openId=([A-Za-z0-9_-]+)&areaid=(\d+)/g;

/**
 * 候选文件名。精确匹配，大小写照原样。
 *
 * `History` 是浏览历史。`Share Data` 是 Chromium 的共享字典，
 * 微信 4.x 把厂商落地页写在那儿，浏览历史里有时没有。
 * `History.wxbak` 是微信自己留的备份。
 * `History_encrypted` 是加密的，不在名单里。
 */
const CANDIDATE_FILE_NAMES = new Set(["History", "History.wxbak", "Share Data"]);

/** 单个候选文件的大小上限。共享字典会长大，别把它整个读进内存。 */
const MAX_CANDIDATE_BYTES = 16 * 1024 * 1024;

/** 计量档（综合收费：电费 0.558 加服务费 0.55）的费率字段，从设备信息取。 */
export const RATE_FIELDS = ["efee", "eCharge", "serviceCharge"];

/** 设备层字段。少了厂商回「系统异常！」。 */
export const DEVICE_FIELDS = ["devtypeid", "isWorkTime", "compensationAmount", "tfTime", "freetime"];

/** 计量档的标志值。`money=7` 才落综合收费档。 */
export const METERED_MONEY = 7;

/**
 * 微信浏览历史的候选目录。按可能性从高到低。
 * 微信 3.x 与 4.x 的目录形状不同，macOS 的版本目录名带版本号，
 * 所以候选是几个，不是一条。
 */
export function profilesDirCandidates() {
  const candidates = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    for (const dir of ["xwechat", "WeChat"]) {
      candidates.push(join(appData, "Tencent", dir, "radium", "web", "profiles"));
    }
  } else {
    const container = join(
      homedir(), "Library", "Containers", "com.tencent.xinWeChat", "Data", "Library",
      "Application Support", "com.tencent.xinWeChat",
    );
    candidates.push(join(container, "2.0b4.0.9", "radium", "web", "profiles"));
    candidates.push(join(container, "radium", "web", "profiles"));
  }
  return candidates;
}

/**
 * 微信的数据根目录。候选路径都不命中时，在这些根目录下面扫 History 文件。
 * 扫到的每一个都靠正则判内容，认错了也不会取到错的凭证。
 */
export function wechatRoots() {
  const roots = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    roots.push(join(appData, "Tencent"));
  } else {
    roots.push(join(
      homedir(), "Library", "Containers", "com.tencent.xinWeChat", "Data", "Library",
      "Application Support", "com.tencent.xinWeChat",
    ));
  }
  return roots;
}

/** 微信浏览历史的目录（第一个候选）。 */
export function profilesDir() {
  return profilesDirCandidates()[0];
}

/**
 * 从本机微信浏览历史里找 openId 与 areaid。
 *
 * 候选目录逐个试；都不命中就在微信的数据根目录下面扫候选文件
 * （微信 3.x 与 4.x 的目录形状不一样，写死的路径认不全）。
 * 找到返回对象，没找到返回 null。**调用方不要把 openId 交给模型。**
 */
export async function findPairing() {
  for (const dir of profilesDirCandidates()) {
    const found = await findPairingIn(dir);
    if (found) return found;
  }
  for (const root of wechatRoots()) {
    const found = await findPairingIn(root, { maxDepth: 9, maxFiles: 400 });
    if (found) return found;
  }
  return null;
}

/**
 * 在一个目录里找候选文件（History、History.wxbak、Share Data），
 * 取出 openId 与 areaid。
 *
 * 这个目录可以由 agent 找出来（微信 3.x 与 macOS 的目录形状不一样）。
 * **只读文件，不把内容返回给调用方。**
 * 扫描有深度与文件数上限，另加单文件大小上限，别让它扫整块盘。
 */
export async function findPairingIn(dir, { maxDepth = 6, maxFiles = 400 } = {}) {
  const candidates = [];
  const walk = async (current, depth) => {
    if (depth > maxDepth || candidates.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= maxFiles) return;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && CANDIDATE_FILE_NAMES.has(entry.name)) {
        candidates.push(full);
      }
    }
  };
  await walk(dir, 0);

  for (const file of candidates) {
    // 先看大小。共享字典会长大，超限的跳过，别整个读进内存。
    try {
      const info = await stat(file);
      if (info.size > MAX_CANDIDATE_BYTES) continue;
    } catch {
      continue;
    }
    // 按字节读。latin1 一字节一字符，不丢字节也不抛错。
    // SQLite 与共享字典里都是明文字节，正则按 ASCII 认。
    let text;
    try {
      text = await readFile(file, "latin1");
    } catch {
      continue;
    }
    PAIR_RE.lastIndex = 0;
    const hit = PAIR_RE.exec(text);
    if (hit) {
      return {
        openId: hit[1],
        areaId: Number(hit[2]),
        source: file,
      };
    }
  }
  return null;
}

/**
 * 凭证。三个来路，按这个顺序：
 *
 * 1. 环境变量。`NEPTUNE_OPENID` 是 openId 本身，或整条配对串
 *    `zju-neptune:v1:<openId>:<areaid>`。`NEPTUNE_AREAID` 是校区号。
 *    跟配对串一起给时忽略这一条
 * 2. 调用方给的目录。微信 3.x 与 macOS 的目录形状不一样，
 *    agent 可以先把目录找出来再交给这里
 * 3. 本机微信浏览历史的默认位置
 *
 * 找不到返回 null。**调用方不要把 openId 交给模型。**
 */
export async function credential({ dir } = {}) {
  const raw = process.env.NEPTUNE_OPENID?.trim();
  if (raw) {
    const paired = PAIR_PREFIX_RE.exec(raw);
    if (paired) {
      return {
        openId: paired[1],
        areaId: Number(paired[2]),
        source: "环境变量 NEPTUNE_OPENID（配对串）",
      };
    }
    return {
      openId: raw,
      areaId: Number(process.env.NEPTUNE_AREAID?.trim() || DEFAULT_AREA_ID),
      source: "环境变量 NEPTUNE_OPENID",
    };
  }
  if (dir) {
    const found = await findPairingIn(dir);
    if (found) return found;
  }
  return findPairing();
}

/** 表单编码 POST。厂商对三种传参都认，用表单正文最省事。 */
export async function api(path, params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.append(key, String(value));
  }
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.msg || "厂商拒绝了请求");
  return json.obj;
}

/** 厂商的金额是分，用电量是毫度。 */
export const yuan = (fen) => (Number(fen || 0) / 100).toFixed(2);
export const kwh = (milli) => (Number(milli || 0) / 1000).toFixed(3);

/** `begindt` 是 `20261027180138` 这种紧凑格式。 */
export function compactTime(value) {
  const t = String(value || "");
  if (t.length < 12) return t;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`;
}

/** `enddt` 是毫秒时间戳。 */
export function endTimeLabel(order) {
  const ms = Number(order?.enddt || 0);
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}


/**
 * 上一单是什么。人要靠它判断这个插座是不是昨晚那个。
 * @param order 订单记录。
 * @returns 一句话说明。空串表示没有订单。
 */
export function orderNote(order) {
  if (!order) return "";
  const type = Number(order.endtype || 0);
  let how = `结束方式 ${type}`;
  if (isMidnightCut(order)) how = "被午夜断电切掉的";
  else if (type === 0 || type === 1) how = "手动结束的";
  else if (type === 39) how = "厂商强制结束的";
  const start = compactTime(order.begindt);
  const end = endTimeLabel(order);
  return `。上一单 ${start} 开始${end ? `，${end} 结束` : ""}，${how}`;
}

/**
 * 结束方式的中文说法。模型看数字没用，看字才有用。
 * @param order 订单记录。
 * @returns 一句话说明。
 */
export function endTypeLabel(order) {
  const type = Number(order?.endtype || 0);
  if (isMidnightCut(order)) return "被午夜断电切掉的";
  if (type === 0 || type === 1) return "手动结束的。车已经不在了";
  if (type === 5 || type === 6) return "空单。一分钱没扣";
  if (type === 7) return "充满自停";
  if (type === 11) return "按时间档到期";
  if (type === 39) return "厂商强制结束的";
  return `结束方式 ${type}`;
}

/**
 * 半夜断电的判据要两个条件：`endtype=39` 且结束时刻落在 23:45 到 00:35。
 * 只看 endtype 会把营业时间外被结束的那一单也算进来。
 *
 * 窗口末端取 00:35：我们的样本落在 00:03 到 00:18，
 * 上游项目在真实的用户订单上撞到过 00:15 之后才结束的（见 issue #4），他们也扩到了 00:35。
 */
export function isMidnightCut(order) {
  if (Number(order?.endtype || 0) !== 39) return false;
  const ms = Number(order?.enddt || 0);
  if (!ms) return false;
  const d = new Date(ms);
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 23 * 60 + 45 || mins <= 35;
}

/**
 * 插座状态那一位的含义。语义从厂商包里读出来的。
 * 见 ../../docs/spec.md 的「插座状态怎么读」。
 */
export const SOCKET_STATES = {
  0: "空闲",
  1: "有人在充",
  2: "车辆空闲",
  3: "浮动充电",
  4: "存储中",
  6: "双重占用",
  7: "计量故障",
  8: "保险丝故障",
  9: "继电器故障",
};

/** 插座号到下标。插座号从 01 起。读不对的返回 -1。 */
function socketIndex(port) {
  const index = Number.parseInt(port, 10) - 1;
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

/**
 * 这个插座存不存在。定任务时用：插座现在有人在充没关系，
 * 但编号读错了要当场发现，不能等到第二天早上。
 * @param device 设备信息。
 * @param port 插座号，如 11。
 * @returns 存在就 true。
 */
export function socketExists(device, port) {
  const status = String(device?.portstatur || "");
  const index = socketIndex(port);
  return index >= 0 && index < status.length;
}

/**
 * 某个插座现在能不能起单。
 * `portstatur` 每插座一位，插座号从 01 起，第 n 号插座对应下标 n-1。
 * 厂商不拦在别人占用的插座上起单，而且结束订单会把那个插座的状态清掉，
 * 等于打断对方的充电。所以这一位不是 0 就不能动。
 */
export function socketState(device, port) {
  const status = String(device?.portstatur || "");
  const index = socketIndex(port);
  if (index < 0 || index >= status.length) {
    return { free: false, why: `这根桩没有 ${port} 号插座（portstatur=${status || "空"}）` };
  }
  if (status[index] === "0") return { free: true, why: "" };
  return { free: false, why: `${port} 号插座现在状态是 ${status[index]}，有人在用` };
}

/**
 * 起单体。照抄厂商小程序的计量分支（case 146）：
 * `money=7` 加三个费率字段加 `yuan7=0`，再加设备层那 5 个字段。
 * 费率与设备字段都从 `getDeviceInfo` 取，不抄上一单（会被服务端按 money 重算）。
 */
export function buildChargeBody({ openId, areaId, employeeid, devaddress, port, device, balance }) {
  const body = {
    areaId,
    openId,
    userId: "null",
    devaddress: String(devaddress),
    port: String(port),
    employeeid,
    payType: 1,
    consumeType: 3,
    beforemoney: Number(balance || 0),
    money: METERED_MONEY,
    yuan7: 0,
    fullStop: 0,
    safeOpen: 0,
    safeCharge: device?.safeCharge ?? 0,
    edtType: 0,
  };
  for (const key of [...RATE_FIELDS, ...DEVICE_FIELDS]) {
    if (device?.[key] !== undefined && device?.[key] !== null) body[key] = device[key];
  }
  return body;
}

/** 起单网址。参数全放查询串里，iPhone 上就是「打开 URL」一个动作。 */
export function recipeUrl(body) {
  return `${API}/wxn/beginCharge?${new URLSearchParams(Object.entries(body).map(
    ([k, v]) => [k, String(v)])).toString()}`;
}

/** cURL 一行。MacroDroid 的 HTTP 动作能直接导入。 */
export function recipeCurl(body) {
  const form = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString();
  return `curl -X POST '${API}/wxn/beginCharge' --data-raw '${form}'`;
}

/**
 * 一个账号的客户端。凭证只在这里，不外传。
 */
export class Client {
  constructor({ openId, areaId }) {
    this.openId = openId;
    this.areaId = areaId;
  }

  account() {
    return api("/wxn/getUserInfo", { openId: this.openId, areaId: this.areaId });
  }

  async currentSession() {
    const obj = await api("/wxn/isChargeing", { areaId: this.areaId, openId: this.openId });
    if (Array.isArray(obj)) return obj[0] ?? null;
    return obj ?? null;
  }

  deviceInfo(devaddress) {
    return api("/wxn/getDeviceInfo", { areaId: this.areaId, devaddress });
  }

  async chargeLog() {
    const account = await this.account();
    const rows = await api("/wxn/getChargeLog", { employeeid: account.employeeid, term: 2 });
    return Array.isArray(rows) ? rows : [];
  }

  startCharge(body) {
    return api("/wxn/beginCharge", body);
  }
}

/**
 * 续充。默认先查后起。五道闸门：
 * 已经在充、不在可充时段、余额为 0、余额不够预扣、目标插座不空闲。
 *
 * 选单规则：续**最近一单真正充过电的**，不管它是断电切的还是手动结束的。
 * 刚起就结束的空单不挑，厂商那边字段不全。
 */
export async function resume(client, { dryRun = false, devaddress = "", port = "", requireCut = false, expect = null } = {}) {
  const session = await client.currentSession();
  if (session) {
    return {
      action: "already-charging",
      reason: "已经在充，不用续",
      detail: `桩 ${session.devaddress}/${session.devport}`,
    };
  }

  const orders = await client.chargeLog();
  if (!orders.length) {
    return { action: "skipped", reason: "没有可参考的历史订单", detail: "第一次用请手动扫一次桩的二维码" };
  }

  let dev = devaddress;
  let socket = port;
  let target = null;
  // 桩号与插座号要么一起给，要么都不给。
  // 只给一个的话，另一半从上一单取，可能落在另一根桩上。
  if (Boolean(dev) !== Boolean(socket)) {
    return {
      action: "skipped",
      reason: "桩号与插座号要一起给",
      detail: "只给一个会取到上一单的那个插座，可能不是同一根桩",
    };
  }
  if (!dev) {
    target = orders.find((o) => Number(o.chargetime || 0) > 0)
      ?? orders.find((o) => o.costunit)
      ?? orders[0];
    dev = String(target.devaddress || "");
    socket = String(target.devport || "");
  }

  // 批准的是某个桩某个插座。用它去续别的地方，等于拿一次批准做了另一件事。
  if (expect && (String(expect.devaddress) !== dev || String(expect.port) !== socket)) {
    return {
      action: "skipped",
      reason: "批准的是别的插座，不续",
      detail: `那条任务批准的是桩 ${expect.devaddress} 的 ${expect.port} 号插座，` +
        `这次要续的是桩 ${dev} 的 ${socket} 号插座`,
    };
  }

  // 无人值守的那条路（定时任务叫醒的）：只有昨晚那单确实被午夜断电切掉才续。
  // 手动结束过就说明车已经不在了，续它等于在空插座上白起一单。
  if (requireCut) {
    const lastCharged = target ?? orders.find((o) => Number(o.chargetime || 0) > 0);
    if (!lastCharged || !isMidnightCut(lastCharged)) {
      return {
        action: "skipped",
        reason: "昨晚那一单不是断电切掉的，不续",
        detail: lastCharged
          ? `最近一单 ${compactTime(lastCharged.begindt)} 开始，${endTypeLabel(lastCharged)}，` +
            `结束时间 ${endTimeLabel(lastCharged)}。断电切掉的才续`
          : "没有可参考的已充订单",
      };
    }
  }

  const account = await client.account();
  const balance = Number(account.readyaccountmoney || 0);
  if (balance <= 0) {
    return { action: "skipped", reason: "余额为 0，先充值", detail: "" };
  }

  const device = await client.deviceInfo(dev);

  // 预扣是设备定的：yk=100 是一元，yk=200 是两元。
  // 余额不够厂商直接拒。发之前先拦下来，别白跑一趟。
  const holdFen = Number(device.yk);
  if (Number.isFinite(holdFen) && holdFen > 0 && balance < holdFen) {
    return {
      action: "skipped",
      reason: "余额不够预扣",
      detail: `余额 ${yuan(balance)} 元，这台桩预扣 ${yuan(holdFen)} 元`,
    };
  }

  if (Number(device.isWorkTime) === 0) {
    return { action: "skipped", reason: "还没到可充电时段", detail: `设备说此刻不可充电（${device.workTime || "?"}）` };
  }

  const socketInfo = socketState(device, socket);
  if (!socketInfo.free) {
    return { action: "skipped", reason: "目标插座不空闲", detail: socketInfo.why };
  }

  const body = buildChargeBody({
    openId: client.openId,
    areaId: client.areaId,
    employeeid: account.employeeid,
    devaddress: dev,
    port: socket,
    device,
    balance,
  });
  const hold = device.yk === undefined || device.yk === null ? "" : `预扣 ${yuan(device.yk)} 元`;
  const head = `桩 ${dev} 的 ${socket} 号插座，综合收费档（电费+服务费）${hold ? "，" + hold : ""}`;

  if (dryRun) {
    return {
      action: "resume",
      reason: "会续充（演练）",
      detail: `${head}，余额 ${yuan(balance)} 元${orderNote(target)}`,
      devaddress: dev,
      port: socket,
    };
  }

  const response = await client.startCharge(body);
  const after = await client.currentSession();
  // 起单后核一遍余额。余额掉的就是厂商预扣的那笔。
  // 厂商有时钱扣了却不说清楚，只看返回值会误判。
  let balanceAfter = null;
  try {
    balanceAfter = Number((await client.account())?.readyaccountmoney ?? 0);
  } catch {
    balanceAfter = null;
  }
  const balanceNote = balanceAfter === null
    ? ""
    : `，余额 ${yuan(balance)} → ${yuan(balanceAfter)} 元`;
  return {
    action: "started",
    reason: "已起新单",
    detail: `${head}${after ? `，档位 costunit=${after.costunit}，预扣 ${yuan(after.yfMoney)} 元` : ""}` +
      `${balanceNote}` +
      `${after ? "" : "。厂商没报进行中的订单，这单可能没真正通电"}`,
    response: maskSecret(response),
    session: after,
    balanceAfter,
    devaddress: dev,
    port: socket,
  };
}

/**
 * 把响应里像凭证的长串打码。
 * 厂商的应答偶尔会回显 openId，不能让它进模型上下文。
 */
export function maskSecret(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.replace(/[A-Za-z0-9_-]{20,}/g, (m) => `${m.slice(0, 4)}…${m.slice(-3)}`);
}

/** 给人看的状态摘要。 */
export function formatStatus({ account, session, last, device }) {
  const lines = [];
  lines.push(`余额 ${yuan(account?.readyaccountmoney)} 元`);
  lines.push(session
    ? `当前订单：桩 ${session.devaddress} 的 ${session.devport} 号插座，已充 ${kwh(session.eleconsum)} 度`
    : "当前没有进行中的订单");
  if (last) {
    lines.push(`最近一单：${compactTime(last.begindt)} 开始，桩 ${last.devaddress} 的 ${last.devport} 号插座` +
      `，${endTypeLabel(last)}`);
  }
  if (device) {
    lines.push(`${device.devdescript || ""} 可充时段 ${device.workTime || "?"}` +
      (device.yk === undefined ? "" : `，起单预扣 ${yuan(device.yk)} 元`));
  }
  return lines.join("\n");
}
