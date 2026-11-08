# 架构：为什么这么分文件

零依赖 Node 项目，总共 10 个源文件，职责单一。分层的唯一目的是：**同一套规则只写一遍，CLI 与网页共用**。

```
bin/ark.js        入口，只做错误兜底与退出码
   ↓
src/cli.js        参数解析 → normalizeVideoOptions() → 命令分发 → 人读输出
   ↓                    ↑
src/ark.js        HTTP：组 content / 建任务 / 轮询 / 下载（纯函数，不打日志）
src/models.js     模型 ID 与价格的唯一事实来源
src/config.js     ~/.ark/config.json 读写，Key 优先级
src/sign.js       火山签名 v4（crypto 手写，仅 AK/SK 链路用）
src/account.js    余额（service=billing）+ 开通状态（service=ark）
src/server.js     ark ui 的本地 HTTP 服务，import cli.js 的校验，不重写
   ↓
web/index.html    单文件前端，只做表单与展示，参数事实全来自 /api/state
```

## 各文件改什么

| 文件 | 职责 | 改动规则 |
|---|---|---|
| `bin/ark.js` | 唯一入口 | 几乎不改 |
| `src/cli.js` | 参数、校验、命令、输出 | 加命令改这里 |
| `src/ark.js` | HTTP 层 | 只放纯函数，不打日志 |
| `src/models.js` | 模型与价格 | **新增模型只改这里** |
| `src/config.js` | 配置读写 | 不改路径约定 |
| `src/sign.js` | 签名 v4 | 不改 scope 格式，改动必须补签名断言 |
| `src/account.js` | 账户体检 | 两条链路要能独立失败 |
| `src/server.js` | 本地 HTTP | 复用 `cli.js` 校验，不重写 |
| `web/index.html` | 网页控制台 | 单文件、无构建、无 CDN |

## 核心机制：单一校验入口

`normalizeVideoOptions(flags)` 是**唯一**的参数校验入口，返回一个归一化后的 options 对象。它负责：

1. 解析模型（含别名）
2. 套预设（**用户显式写的 flag 永远优先于预设**）
3. 越界与互斥校验
4. 补齐默认值（`ratio` 默认 `adaptive`、`duration` 默认 `-1`）

CLI 拿到它直接组包；`server.js` 拿到它也是组包。所以「终端能传、页面传不了」这种割裂在结构上就不会发生——除非有人偷偷在 `server.js` 里重写一遍校验，那是最常见的破坏性改动。

同理，生图是 `normalizeImageOptions()`，`src/image.js` 里自带，同样被 CLI 与 server 共用。

## 加一个参数的完整清单

以「加 `output_format`」为例，**四处缺一不可**：

1. `docs/<model>.md` 记下来源、取值、默认值
2. `src/ark.js` 的 `buildPayload()` 加字段映射（注意 `output_format` 而非 `outputFormat`）
3. `src/cli.js` 的 `normalizeVideoOptions()` 加校验（白名单、枚举）
4. CLI flag 定义 + `web/index.html` 表单控件 + `src/server.js` 的 body 映射

少第 4 处 = 终端能传、页面传不了。少第 3 处 = 传错值直接打到远端，报错难读。

## 加一个模型的完整清单

1. 新建 `docs/<model>.md`（九节结构，见 `assets/baseline/docs/seedance-2-5.md`）
2. `src/models.js` 的 `MODELS` 加一条
3. `--selftest` 补一条断言：别名能解析、请求体能组装
4. `npm run selftest` 全绿

**不需要改前端**。前端从 `/api/state` 拿 `models` 数组渲染选项，加模型自动出现在下拉里。如果改了模型却要在前端改代码，说明前端硬编码了模型 ID——那是 bug。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 远端失败 / 运行失败 |
| 2 | 参数或环境错误（缺 Key、文件不存在、参数越界） |

不要 `process.exit(1)` 糊所有情况：调用方脚本靠这个码区分「我参数写错了」和「服务端挂了」。

## 为什么坚持零依赖

- `npm i` 之后项目就不再是「拷走即用」——而本地控制台的核心价值恰恰是拷走即用。
- Node ≥18 的 `fetch`、`http`、`crypto` 已经覆盖全部需求（含 HMAC 签名）。
- 依赖会引入版本漂移，半年后别人的机器上 `npm i` 直接失败。

如果你确实要引依赖，先问自己：这个依赖是不是省下了 200 行以上、且不会腐烂？通常答案是否。

## 日志与输出约定

- 中文输出，字段对齐，一行一项。
- `--json` 时 **stdout 只能是 JSON**，进度、提示、警告全走 stderr。
- 进度行用 `\r` 原地刷新（状态 + 已用时），不要每 3 秒打印一整段新行。
- 不要「顺手」美化已有输出格式，用户的脚本可能依赖当前文本。

## 自检怎么写

`--selftest` 必须**完全离线**，不读 Key、不发请求。它断言的是：

- 别名解析（`2.5` / `seedance25` / 完整 ID 都能命中同一条记录）
- 请求体字段名正确（拼出来是 `generate_audio` 而不是 `generateAudio`）
- 约束会被拦住（编辑任务传 `ratio: '16:9'` 必须抛错）
- 尺寸折算边界（`1K + 9:16` 不能低于最小像素数）
- 预设优先级（显式 flag 覆盖预设）

断言失败要打印「期望 vs 实际」，不要只打印 `assert failed`。这是给自己半年后看的。
