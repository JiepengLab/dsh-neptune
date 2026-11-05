/**
 * lib/time.js — 时刻与本地日历。
 *
 * 调度器只认 HH:mm:ss。日期用本地时区算。
 */

/** 下一个 HH:mm 的时刻（本地时区）。过了点就顺延到次日。 */
export function nextDailyOccurrence(hhmm, timeZone, now = Date.now()) {
  const [hour, minute] = String(hhmm || "06:05:00").split(":").map(Number);
  const d = new Date(now);
  let target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= now) target = new Date(target.getTime() + 24 * 3600 * 1000);
  return target.getTime();
}

/** 距离下一个 hh:mm 还有多少毫秒。用本机本地时区。 */
export function msUntilNext(hour, minute, now = Date.now()) {
  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now;
}

/** 本地日历日，格式 2026-11-04。 */
export function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 时刻要写成 HH:mm:ss。调度器只认这个格式。 */
export function normalizeTime(hhmm) {
  const parts = String(hhmm || "06:05").split(":").map((n) => Number(n) || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(parts[0] || 0)}:${p(parts[1] || 0)}:${p(parts[2] || 0)}`;
}

/** 指定某一天某个本地时刻的毫秒数。 */
export function localMomentMs(date, hhmm) {
  const [hour, minute, second] = normalizeTime(hhmm).split(":").map(Number);
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hour, minute, second, 0).getTime();
}

/**
 * 宿主要的两行计时。第一行 DTSTART，第二行 RRULE。
 *
 * 一次性任务用 COUNT=1。日常任务不带 COUNT。
 * DTSTART 带 TZID，用 IANA 时区名。固定偏移要写成 Etc/GMT-5 那种，符号相反。
 */
export function buildRRule(dueAt, { daily = false, timeZone = "Asia/Shanghai" } = {}) {
  const start = new Date(dueAt);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${start.getFullYear()}${p(start.getMonth() + 1)}${p(start.getDate())}` +
    `T${p(start.getHours())}${p(start.getMinutes())}${p(start.getSeconds())}`;
  const rule = `FREQ=DAILY;BYHOUR=${start.getHours()};BYMINUTE=${start.getMinutes()}` +
    (daily ? "" : ";COUNT=1");
  return `DTSTART;TZID=${timeZone}:${stamp}\nRRULE:${rule}`;
}
