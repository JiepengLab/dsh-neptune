# 怎么给这个插件提改动

## 提交信息

**标题用 Conventional Commits**：`type(scope): 一句话结论` ✓

| type | 用于 |
|---|---|
| `feat` | 新增能力 |
| `fix` | 修 bug |
| `refactor` | 不改行为的结构调整 |
| `docs` | 文档 |
| `test` | 测试与验证脚本 |
| `ci` | 工作流 |
| `chore` | 杂项（依赖、清理） |

scope 用部件名：`neptune`（插件整体）、`core`（`core/neptune-core.mjs`）、`skill`（技能正文）、`verify`（验证脚本）。

**正文只写改了什么。** 一段变更清单：

```text
- 技能第 3 步改成：晚上说「帮我续充」，就是早上六点那一单
- neptune_charge_at 的 time 参数不再必填
```

⇒ 一条提交只做一件事。大改动拆成几条 ✓

## 跑哪些检查

```powershell
node tests/verify.mjs                  # 核心逻辑。对着厂商真接口，只读
node tests/verify-plugin.mjs           # 插件入口。假 ctx，只读
node scripts/check-package.mjs   # 包自查
```

`tests/verify.mjs` 会读厂商接口。它不花钱，但会消耗一次配额 ✓

## 代码在哪

| 位置 | 内容 |
|---|---|
| `index.js` | 入口。只做接线 |
| `lib/` | 域逻辑，按职责拆开 |
| `core/neptune-core.mjs` | 厂商接口。不依赖 DSH，可以单独跑 |
| `skills/neptune-resume/` | 技能。`SKILL.md` 加 `references/` |
| `tests/verify.mjs` | 厂商接口的验证。对着真接口，只读，不起单 |
| `tests/verify-plugin.mjs` | 插件入口的验证。用假 ctx 跑，只读 |
| `scripts/check-package.mjs` | 包自查。查结构与内容 |
| `cordis.patch.yml` | 这一层补丁。插进 profile 组合里 |
| `package.json` | 组合包清单（`dsh.bundle`） |

**这个仓库不另放开发文档。** 厂商接口的形状、计费档、那些坑，都写在
`core/neptune-core.mjs` 的注释里。接口规格的完整版在维护者那边。

## 怎么本地加载

开发时用 patch 直接加载，不改 profile：

```yaml
# scratch/cordis.yml
- insert:
    - id: neptune
      name: dsh-neptune
```

```powershell
pnpm dsh web --patch ./scratch/cordis.yml
```

`root` 填 `"."` 时，改了这个目录里的文件不用重启 DSH。

插件每次加载会往 `$DSH_HOME/neptune-plugin.log` 写一行，记下这轮注册了哪些工具。UI 看不全时看那行。

## 改协议的时候

**对着装好的那一份写。** 读 `app.asar` 里装着的运行时，不要对着仓库里的类型声明写。

```powershell
node -e "const {readFileSync}=require('fs');const b=readFileSync('E:/ProgramFile/DSH/resources/app.asar');..."
```

运行时换了接口，先在真机上验一遍。本地假 ctx 会骗人。

## 两条硬规则

**凭证不进上下文，也不进磁盘。** 不读 `.env`、密钥文件。不要把 openId 写进任何输出、文件、总结、任务提示。

**厂商小程序原文不进仓库。** 它是厂商的代码。仓库里只放我们自己的实现与结论。
