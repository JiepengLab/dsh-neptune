/**
 * lib/client.js — 厂商接口的客户端与给人看的摘要。
 *
 * 凭证只存在内存里。插件卸载就没了。
 */

import {
  Client, credential, formatStatus, SOCKET_STATES,
} from "../core/neptune-core.mjs";

/** 凭证。只存在内存里。 */
let client = null;

/** 已经有了就直接用。没有就报错。 */
export function needClient() {
  if (!client) throw new Error("还没有凭证。先跑 neptune_pair");
  return client;
}

/**
 * 拿到客户端。没有凭证就去取。
 * 取不到时报错，并给出下一步。
 */
export async function ensureClient() {
  if (client) return client;
  const pairing = await credential();
  if (!pairing) {
    throw new Error(
      "本机微信浏览历史里没有厂商的网址。" +
      "在电脑微信里打开 https://szlzxn.cn/wechat/wxscan/50959120 ，" +
      "等它跳完，再来一次。末尾那串 8 位数字换成他自己那根桩的编号，编号印在桩上。" +
      "也可以设环境变量 NEPTUNE_OPENID（值是 openId 或整条配对串）",
    );
  }
  client = new Client(pairing);
  return client;
}

/** 记住一份凭证。取凭证的工具用。 */
export function rememberClient(pairing) {
  client = new Client(pairing);
  return client;
}

/** 余额、当前订单、可充时段、最近一单。 */
export async function statusText() {
  const c = await ensureClient();
  const account = await c.account();
  const session = await c.currentSession();
  const orders = await c.chargeLog();
  const last = orders.find((o) => Number(o.chargetime || 0) > 0) ?? orders[0] ?? null;
  const device = last ? await c.deviceInfo(String(last.devaddress)) : null;
  return formatStatus({ account, session, last, device });
}

/** 某根桩每个插座的占用状态。 */
export async function socketsText(devaddress) {
  const c = await ensureClient();
  const device = await c.deviceInfo(devaddress);
  const status = String(device.portstatur || "");
  if (!status) return `${devaddress} 没有回插座状态`;
  const lines = [];
  for (let i = 0; i < status.length; i++) {
    const port = String(i + 1).padStart(2, "0");
    const mark = SOCKET_STATES[status[i]] || `状态 ${status[i]}`;
    lines.push(`${port} 号  ${mark}`);
  }
  return [
    `${devaddress}  ${device.devdescript || ""}  可充时段 ${device.workTime || "?"}`,
    ...lines,
  ].join("\n");
}
