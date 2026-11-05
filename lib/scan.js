/**
 * lib/scan.js — 从照片里读插座二维码。
 *
 * 插座上那张标签印着编号，编号是 8 位桩号加 2 位插座号。
 * 二维码里是厂商的扫描入口网址，尾巴上就是那串编号。
 *
 * 解码用 zxing-cpp 的 WASM 版，进程内跑，不需要外部程序。
 * 图片解码用纯 JS 的 jpeg-js，PNG 用 zlib 自己解。都没有原生模块。
 */

import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { readBarcodes } from "zxing-wasm/reader";

/** 厂商的扫描入口。二维码里就是它。 */
const SCAN_URL = /wechat\/wxscan\/(\d+)/;

/**
 * 解一张图。返回 RGBA 像素。
 * @param {string} path 本地路径。
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}>}
 */
async function readPixels(path) {
  const raw = await readFile(path);
  if (raw.length > 8 && raw[0] === 0x89 && raw[1] === 0x50) return readPng(raw);
  const img = jpeg.decode(raw, { useTArray: true });
  return {
    data: new Uint8ClampedArray(img.data),
    width: img.width,
    height: img.height,
  };
}

/**
 * 读一张 PNG。只需要 8 位真彩色与带 alpha 的那种。
 * @param {Buffer} raw PNG 字节。
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
function readPng(raw) {
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];
  while (at < raw.length) {
    const length = raw.readUInt32BE(at);
    const type = raw.toString("ascii", at + 4, at + 8);
    const body = raw.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (depth !== 8) throw new Error("只认 8 位深的 PNG");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error("只认真彩或带 alpha 的 PNG");

  const merged = Buffer.concat(idat);
  const pixels = inflateSync(merged);
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);

  // 每一行按 PNG 的过滤方式还原。
  for (let y = 0; y < height; y++) {
    const filter = pixels[y * (stride + 1)];
    const row = pixels.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y > 0 ? out.subarray((y - 1) * width * 4, y * width * 4) : null;
    for (let x = 0; x < stride; x++) {
      const rawByte = row[x];
      const left = x >= channels ? out[y * width * 4 + (x - channels)] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      let value = rawByte;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * width * 4 + x] = value & 0xff;
    }
  }
  return { data: out, width, height };
}

/**
 * 从一段文字里取插座编号。
 * 扫入口的网址尾巴上是编号。裸编号也认。
 * @param {string} text 二维码里的文字。
 * @returns {{label: string, devaddress: string, port: string}|null}
 */
export function parseSocketLabel(text) {
  const value = String(text ?? "").trim();
  const m = SCAN_URL.exec(value);
  const label = m ? m[1] : (/^\d{8,10}$/.test(value) ? value : null);
  if (!label) return null;
  const devaddress = label.slice(0, 8);
  const port = label.length > 8 ? label.slice(8) : "00";
  return { label, devaddress, port };
}

/**
 * 扫一张照片。返回照片里所有认得出的插座编号。
 * @param {string} path 照片的本地路径。
 * @returns {Promise<Array<{label: string, devaddress: string, port: string, text: string}>>}
 */
export async function scanLabels(path) {
  const pixels = await readPixels(path);
  const found = await readBarcodes(pixels, { tryHarder: true });
  const out = [];
  for (const item of found) {
    const parsed = parseSocketLabel(item.text);
    if (parsed) out.push({ ...parsed, text: item.text });
  }
  return out;
}
