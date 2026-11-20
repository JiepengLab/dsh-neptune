/**
 * lib/tools.js — 给模型用的七个工具。
 *
 * `neptune_charge` 会花钱。`neptune_recipe` 会写用户的剪贴板。其余五个只读。
 */

import { isAbsolute, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  credential, profilesDirCandidates, resume, yuan, socketExists } from "../core/neptune-core.mjs";
import { ensureClient, rememberClient, socketsText, statusText } from "./client.js";
import { mask } from "./format.js";
import { recipeUrlFor, secretValues, writeClipboard } from "./recipe.js";
import { parseSocketLabel, scanLabels } from "./scan.js";
import { buildResumePrompt, deliveryTarget } from "./task.js";
import { localDate, localMomentMs, nextDailyOccurrence, normalizeTime } from "./time.js";

/**
 * 照片路径。相对路径按会话创建时的工作目录解析。
 *
 * 插件宿主自己的 cwd 是 profile 目录，不是用户的工作目录。
 * 2026-11-05 实测：相对路径的报错指向 `…\.dsh\profiles\desktop`。
 * 所以相对路径要靠会话的 cwd 才对得上。那个 cwd 是会话创建时的目录，
 * 不是当前目录。
 * @param {string} input 调用方给的路径。
 * @param {object} exec 本次执行的身份。
 * @returns {{path?: string, base?: string, error?: string}} 能解就给出 path。
 */
function photoTarget(input, exec) {
  const raw = String(input ?? "").trim();
  if (!raw) return { error: "没给照片路径。" };
  if (isAbsolute(raw)) return { path: raw, base: "" };
  const base = String(exec?.agent?.session?.header?.cwd ?? "");
  if (!base) {
    return { error: "照片要给绝对路径。这个会话没有工作目录，相对路径解不出来。" };
  }
  return { path: resolve(base, raw), base };
}

/**
 * 剪贴板没写好时的说法。
 *
 * 写进去但读回比对没过时，值其实已经在剪贴板里。
 * 那时候说「这里给不了值」是错的，用户会以为要去别处找值。
 * @param {object} put writeClipboard 的结果。
 * @returns {string} 给模型的那句话。
 */
function clipboardError(put) {
  if (put?.written) {
    return `剪贴板写进去了，但核对时读回来不一样：${put.error ?? "原因不明"}。` +
      "值应该已经在剪贴板里，粘之前核一下";
  }
  return `剪贴板写不进去：${put?.error ?? "原因不明"}。这个插件不落盘凭证，这里给不了值`;
}

/** 注册七个工具。registerTool 是入口给的包装，顺手记名字。 */
export function registerTools(ctx, registerTool) {
  registerTool(defineTool({
    name: "neptune_pair",
    description:
      "从本机微信浏览历史里找尼普顿的 openId 并记住。只读，不花钱。" +
      "凭证不会返回给模型。找不到就报错并给出下一步。" +
      "微信的数据目录不认得时，把找到的目录填进 dir，插件自己去那儿读。",
    parameters: {
      dir: {
        type: "string",
        description:
          "微信数据根目录，比如 %APPDATA%\\Tencent。插件自己在下面扫 History 与 Share Data 文件。" +
          "只列目录名去猜，不要读里面的文件内容。那里面有 openId。" +
          "传整个根目录，不要只传某一个 profiles 目录。企业微信也有同名的目录",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args) {
      const dir = args.dir ? String(args.dir) : "";
      const pairing = await credential({ dir });
      if (!pairing) {
        return "没找到厂商的网址。\n" +
          `试过这些地方：${profilesDirCandidates().join("、")}，` +
          "还有微信数据根目录下面扫 History 与 Share Data 文件（都没命中）。\n" +
          "下一步：用文件工具找到微信的数据目录，" +
          "找 …/radium/web/profiles/<档案名>/History 这种结构，" +
          "把它上面的 profiles 目录填进 dir 再试一次。" +
          "只列目录名，不要读 History 文件的内容，那里面有 openId。\n" +
          "也可以设环境变量 NEPTUNE_OPENID" +
          "（值是 openId，或整条配对串 zju-neptune:v1:<openId>:<areaid>）。";
      }
      const client = rememberClient(pairing);
      const account = await client.account();
      return `凭证已就绪（openId ${mask(pairing.openId)}，来源 ${pairing.source}）。` +
        `余额 ${yuan(account.readyaccountmoney)} 元。`;
    },
  }));

  registerTool(defineTool({
    name: "neptune_status",
    description:
      "查尼普顿的余额、当前订单、可充时段、最近一单怎么结束的。只读。" +
      "用户说的「小龟」就是电瓶车，问小龟充电情况用这个。",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute() {
      return await statusText();
    },
  }));

  registerTool(defineTool({
    name: "neptune_sockets",
    description: "查某根桩每个插座的占用状态。只读。",
    parameters: {
      devaddress: { type: "string", required: true, description: "8 位桩号" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args) {
      return await socketsText(String(args.devaddress));
    },
  }));

  registerTool(defineTool({
    name: "neptune_charge",
    description:
      "到点执行续充。只在宿主投递那条任务时用。" +
      "它按那条任务里写明的桩与插座起一个新单（综合收费档，充满自停）。" +
      "起单前有五道闸门：已经在充、不在可充时段、余额为 0、余额不够预扣、目标插座有人在充。" +
      "dry_run=true 只判断不动作。" +
      "用户当场要续，用 neptune_charge_at 定一个到点的任务。",
    parameters: {
      devaddress: { type: "string", description: "8 位桩号。不给就用上一单那个。要给就连插座号一起给" },
      port: { type: "string", description: "插座号，如 11。不给就用上一单那个。要给就连桩号一起给" },
      dry_run: { type: "boolean", description: "只判断不动作" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const c = await ensureClient();
      const dryRun = args.dry_run === true;
      // 无人值守那条路：这一回合是被先前批准过的那条任务叫醒的。
      // 批准凭据是宿主那条任务记录，目标从投递消息里取。
      const target = deliveryTarget(exec);
      // 没有那条绑定就不是批准过的那一单。当场续这条路已经没有了。
      if (!target && !dryRun) {
        return "skipped：不到点不续充。要续就起一个到点的任务。";
      }
      const requireCut = target !== null;
      // 批准的是某个桩某个插座。拿它去续别的地方要拦下来。
      const report = await resume(c, {
        dryRun,
        requireCut,
        expect: target,
        devaddress: args.devaddress ? String(args.devaddress) : "",
        port: args.port ? String(args.port) : "",
      });
      return `${report.action}：${report.reason}  ${report.detail}`;
    },
  }));

  registerTool(defineTool({
    name: "neptune_scan",
    description:
      "从插座二维码的照片里读出桩号与插座号。只读，不花钱。" +
      "用户拍了插座上那张二维码标签就调这个。" +
      "它解二维码，取出编号：前 8 位是桩号，后 2 位是插座号。" +
      "二维码是机器读的，比照片上那行印刷编号可靠。" +
      "再向厂商核一遍那个插座在不在，不在就说明照片读糊了。" +
      "照片可以是 JPEG 或 PNG。",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "照片的本地路径。附件的路径直接给。相对路径按会话创建时的工作目录解析",
      },
      label: {
        type: "string",
        description:
          "照片上那行印刷编号，用户读到的。给了就与二维码对照。" +
          "二维码解不出来时用它兜底",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const target = photoTarget(String(args.path ?? ""), exec);
      if (target.error) return target.error;
      let found = [];
      try {
        found = await scanLabels(target.path);
      } catch (err) {
        return `照片没读出来：${err?.message ?? err}。` +
          (target.base ? `相对路径按 ${target.base} 解析的。给绝对路径。` : "给绝对路径。");
      }
      const fromQr = found[0] ?? null;
      const fromText = parseSocketLabel(String(args.label ?? ""));

      // 二维码优先。它是机器读的，印刷编号是人看的，可能看错。
      const chosen = fromQr ?? fromText;
      if (!chosen) {
        return "照片里没找出插座二维码。拍清楚一点，要能看见整张二维码。" +
          "也可以直接把插座上的编号告诉 agent。";
      }

      const c = await ensureClient();
      const device = await c.deviceInfo(chosen.devaddress);
      const exists = socketExists(device, chosen.port);
      const where = `桩 ${chosen.devaddress} 的 ${chosen.port} 号插座`;

      if (fromQr && fromText && fromQr.label !== fromText.label) {
        return `照片上有两个编号：二维码是 ${fromQr.label}，印刷那行读成 ${fromText.label}。` +
          `以二维码为准：${where}。` +
          (exists ? "这根桩上有这个插座" : "这根桩上没有这个插座");
      }

      if (!fromQr) {
        return `二维码没解出来，用印刷编号 ${chosen.label}：${where}。` +
          (exists ? "这根桩上有这个插座" : "这根桩上没有这个插座") +
          "。这条没有机器核对过。";
      }

      return `${where}，二维码读出来的。` +
        (exists ? "这根桩上有这个插座" : "这根桩上没有这个插座。照片可能读错了");
    },
  }));
  registerTool(defineTool({
    name: "neptune_recipe",
    description:
      "把尼普顿续充要交给用户的东西写进剪贴板。只在用户已经同意之后才调。" +
      "值不进模型上下文，也不出现在聊天里。" +
      "可写的是 open_id（账号的 openId）、employee_id（账号的 employeeId）、" +
      "area_id（校区号）、url（起单网址，只在指定桩与插座上生效）。" +
      "调用前必须先告诉用户要写什么、为什么写，等用户同意再调。" +
      "用户没要那个值，就不要动他的剪贴板。",
    parameters: {
      what: {
        type: "string",
        required: true,
        description: "写哪一个：open_id / employee_id / area_id / url",
      },
      devaddress: { type: "string", description: "8 位桩号。写 url 时用。不给就用最近一单那个。要给就连插座号一起给" },
      port: { type: "string", description: "插座号，如 11。写 url 时用。不给就用最近一单那个。要给就连桩号一起给" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const what = String(args.what ?? "").trim();
      if (!["open_id", "employee_id", "area_id", "url"].includes(what)) {
        return "不知道要写哪一个。可写的是：open_id、employee_id、area_id、url";
      }
      const c = await ensureClient();
      const account = await c.account();

      if (what === "url") {
        // 桩号与插座号要么一起给，要么都不给。
        // 只给一个的话，另一半从上一单取，可能落在另一根桩上。
        // 拼出来的网址会在那个插座起单，那一笔账上你付。
        const given = String(args.devaddress ?? "").trim();
        const givenPort = String(args.port ?? "").trim();
        if (Boolean(given) !== Boolean(givenPort)) {
          return "桩号与插座号要一起给，或者都不给。只给一个会取到上一单的那个插座，可能不是同一根桩";
        }
        let dev = given;
        let socket = givenPort;
        if (!dev) {
          const orders = await c.chargeLog();
          const last = orders.find((o) => Number(o.chargetime || 0) > 0) ?? orders[0];
          if (!last) return "没有可参考的历史订单。先扫一次桩的二维码。";
          dev = String(last.devaddress || "");
          socket = String(last.devport || "");
        }
        const device = await c.deviceInfo(dev);
        if (!socketExists(device, socket)) {
          return `桩 ${dev} 上没有 ${socket} 号插座。核对一下编号：前 8 位是桩号，后 2 位是插座号`;
        }
        const url = recipeUrlFor({
          openId: c.openId,
          areaId: c.areaId,
          employeeid: account.employeeid,
          devaddress: dev,
          port: socket,
          device,
          balance: account.readyaccountmoney,
        });
        const put = await writeClipboard(url, { signal: exec?.signal });
        if (!put.ok) return clipboardError(put);
        return `起单网址已放到剪贴板。桩 ${dev} 的 ${socket} 号插座，只在这个插座上生效。` +
          "手机自动化里加「打开 URL」的动作，定在 06:05";
      }

      const values = secretValues({
        openId: c.openId,
        areaId: c.areaId,
        employeeid: account.employeeid,
      });
      const value = values[what];
      const put = await writeClipboard(value, { signal: exec?.signal });
      if (!put.ok) return clipboardError(put);
      if (what === "open_id") {
        // 不回显掩码。掩码也是凭证的一部分，说过「值不进上下文」。
        return "openId 已放到剪贴板。填进 GitHub 的 secret NEPTUNE_OPEN_ID";
      }
      if (what === "employee_id") {
        return "employeeId 已放到剪贴板。填进 GitHub 的 secret NEPTUNE_EMPLOYEE_ID";
      }
      return `areaId ${value} 已放到剪贴板。填进 GitHub 的 secret NEPTUNE_AREA_ID`;
    },
  }));
  registerTool(defineTool({
    name: "neptune_charge_at",
    description:
      "定一个到点的续充任务。到点自动续充。" +
      "用户说「帮我续充」「明早六点帮我续上」这类话时用这个。不给时刻就定在 06:05。" +
      "它按最近一单真正充过电的桩起任务（也可以指定桩与插座），" +
      "到点时任务提醒 agent 执行续充，那条任务记录就是批准凭据，agent 不用再问一次。" +
      "只创建任务，不立刻起单。" +
      "注意：任务到点会叫醒 agent，会消耗一点 token。跟用户说一声。",
    parameters: {
      time: { type: "string", description: "本地时刻，如 06:05。不给就是 06:05" },
      date: { type: "string", description: "哪一天，格式 2026-11-04。不给就是下一个这样的日子" },
      daily: { type: "boolean", description: "每天重复。默认只做一次" },
      time_zone: { type: "string", description: "时区，默认 Asia/Shanghai" },
      devaddress: { type: "string", description: "8 位桩号。不给就用上一单那个。要给就连插座号一起给" },
      port: { type: "string", description: "插座号，如 11。不给就用上一单那个。要给就连桩号一起给" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const c = await ensureClient();
      const orders = await c.chargeLog();
      // 桩号与插座号要么一起给，要么都不给。
      // 只给一个的话，另一半从上一单取，可能落在另一根桩上。
      const given = String(args.devaddress ?? "").trim();
      const givenPort = String(args.port ?? "").trim();
      if (Boolean(given) !== Boolean(givenPort)) {
        throw new Error(
          "桩号与插座号要一起给，或者都不给。只给一个会取到上一单的那个插座，可能不是同一根桩",
        );
      }
      let dev = given;
      let socket = givenPort;
      if (!dev) {
        const last = orders.find((o) => Number(o.chargetime || 0) > 0) ?? orders[0];
        if (!last) throw new Error("没有可参考的历史订单，先手动扫一次桩的二维码");
        dev = String(last.devaddress || "");
        socket = String(last.devport || "");
      }
      // 用户可能拍插座上的二维码照片来定下一单。照片上的编号是
      // 8 位桩号加 2 位插座号，读错了这里能发现。
      // 插座现在有人在充没关系，那是今天的事，明天几点再充由任务决定。
      const device = await c.deviceInfo(dev);
      if (!socketExists(device, socket)) {
        throw new Error(
          `桩 ${dev} 上没有 ${socket} 号插座。核对一下照片上的编号：` +
          "前 8 位是桩号，后 2 位是插座号",
        );
      }
      const timeZone = String(args.time_zone || "Asia/Shanghai");
      const hhmm = normalizeTime(args.time || "06:05:00");
      const daily = args.daily === true;
      const dueAt = args.date
        ? localMomentMs(args.date, hhmm)
        : nextDailyOccurrence(hhmm, timeZone);

      const prompt = buildResumePrompt({ devaddress: dev, port: socket });

      const sessionId = exec?.agent?.session?.id;
      if (!sessionId) {
        throw new Error(
          "起不了任务。调度任务要挂在一个会话上，当前调用没有会话。" +
          "让用户在聊天里说一句「明早六点帮我续上」就行",
        );
      }

      // 宿主的调度接口（0.2.2-rc.1 起）：
      // create(request, actorSessionId, signal)。
      // request 里计时是 rrule 两行，目的地是 target。
      const title = `尼普顿续充：${dev} 的 ${socket} 号插座`;
      const request = {
        title,
        prompt,
        timing: daily
          ? { kind: "daily", daily: { time: hhmm, time_zone: timeZone } }
          : { kind: "at", at: { date: args.date || localDate(dueAt), time: hhmm, time_zone: timeZone } },
        // 不写 target 的话，宿主默认另建一个会话。续充要投回本会话。
        target: { kind: "session", sessionId },
      };

      const entry = await ctx.schedule.create(request, sessionId, exec.signal);
      const when = new Date(dueAt).toLocaleString("zh-CN");
      return `任务已建：${when}（${daily ? "每天" : "只做一次"}）。` +
        `到点会续桩 ${dev} 的 ${socket} 号插座。任务 id：${entry?.id ?? "?"}。` +
        "到点它会叫醒 agent 执行续充。那条任务记录就是批准凭据，agent 不用再问一次。";
    },
  }));
}
