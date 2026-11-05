/**
 * lib/format.js — 给模型看的东西都要过这里。
 *
 * 凭证不能原样出现。掩码只有头尾几段。
 */

/** openId 的掩码。头 4 尾 3。 */
export const mask = (openId) => (openId ? `${openId.slice(0, 4)}…${openId.slice(-3)}` : "无");

/**
 * 把响应里像凭证的长串打码。
 * 厂商的应答偶尔会回显 openId，不能让它进模型上下文。
 */
export function maskSecret(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.replace(/[A-Za-z0-9_-]{20,}/g, (m) => `${m.slice(0, 4)}…${m.slice(-3)}`);
}
