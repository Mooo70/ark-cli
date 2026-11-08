# AGENTS.md — 给 AI 编码代理的项目约定

> 任何 AI（ZCode / Cursor / Claude Code / Codex）在本仓库动手前必须读完本文件与 `docs/`。
> 冲突时：`docs/` 里的官方摘录 > 本文件 > 你的常识。

## 项目是什么

`ark` 是一个**零依赖 Node.js CLI**，封装火山方舟（Ark）`/contents/generations/tasks` 视频生成接口。用户一条命令出片：

```bash
ark video "提示词" -R 480p -d 5
```

设计目标：**可长期维护、可离线自检、不依赖 SDK**。不要引入 npm 依赖，Node ≥ 18 内置的 `fetch` 足够。

## 目录职责

| 路径 | 职责 | 改动规则 |
|---|---|---|
| `bin/ark.js` | 唯一入口，只做错误兜底与退出码 | 几乎不改 |
| `src/cli.js` | 参数解析、校验、命令分发、人读输出 | 加命令改这里 |
| `src/ark.js` | HTTP 层：组 content、建任务、轮询、下载 | 只放纯函数，不打日志 |
| `src/models.js` | **模型 ID 与价格的唯一事实来源** | 新增模型只改这里 |
| `src/config.js` | `~/.ark/config.json` 读写、Key 解析优先级 | 不改路径约定 |
| `src/sign.js` | 火山签名 v4（crypto 手写），只认 AK/SK | 不改 scope 格式，改动必须补签名断言 |
| `src/account.js` | 余额（service=billing）+ 开通状态（service=ark）| 两条链路要能独立失败 |
| `src/server.js` | `ark ui` 的本地 HTTP 服务，仅做路由与任务内存表 | 复用 `cli.js` 的校验，不重写 |
| `web/index.html` | 网页控制台，单文件、无构建、无 CDN | 不引框架，不拆多文件 |
| `docs/*.md` | 官方文档摘要，AI 的唯一知识来源 | 新模型 = 新文件 |

## 硬规则

1. **禁止在 `src/` 里硬编码 model id、分辨率列表、价格**。一律从 `models.js` 取。新增模型只允许改 `models.js` + 新增 `docs/<model>.md`。
2. **参数名必须与 `docs/seedance-2-5.md` 完全一致**（`generate_audio` 而不是 `generateAudio`，`resolution` 而不是 `size`）。凭记忆写字段名是本项目最常见的 bug。
3. **加一个官方参数要同时改四处**：`docs/` 记录 → `buildPayload()` 映射 → `normalizeVideoOptions()` 校验 → CLI flag 与网页表单。少一处就会出现「终端能传、页面传不了」的割裂。
3. **约束校验放在 `normalizeVideoOptions()`**，不要散落在命令函数里。当前必须拦住的：分辨率越界、时长越界、编辑任务 `ratio≠adaptive`、编辑任务 `duration≠-1`、给了尾帧没给首帧、素材全空。
4. **不发请求的路径要能跑通**：`--dry-run` 只打印请求体，`--selftest` 完全离线。任何新功能都要能被这两条覆盖，否则没法验证。
5. **退出码语义固定**：`0` 成功 / `1` 远端或运行失败 / `2` 参数或环境错误。不要用 `process.exit(1)` 糊所有情况。
6. **产物必须落盘**。CLI 的价值是「命令结束就有文件」，不允许只返回一个会过期的 URL。
7. **中文输出**，字段对齐、单行一项。`--json` 时 stdout 只能是 JSON，进度与提示走 stderr。
8. **不要往仓库里写 Key**。Key 只存在 `~/.ark/config.json` 或环境变量 `ARK_API_KEY`。
9. **网页控制台不许自成一套逻辑**。`src/server.js` 必须 `import { normalizeVideoOptions } from './cli.js'`，与 CLI 共享校验与组包；`web/index.html` 只做表单和展示，所有参数事实来自 `/api/state`，不要在前端硬编码模型 ID 或价格。
10. **前端保持零依赖**：不引 React/Vue/Tailwind/CDN，一个 HTML 文件 + 原生 fetch。

## 加一个新模型的标准流程

1. 读官方文档，新建 `docs/<model>.md`，按 `seedance-2-5.md` 的九节结构写（基本信息 / 请求体 / 参数表 / 任务类型 / 素材规格 / 返回结构 / 价格 / 像素表 / 同系列）。
2. 在 `src/models.js` 的 `MODELS` 里加一条：`id`、`resolutions`、`ratios`、`duration`、`audio`、`draft`、`pricePerSecond`。
3. 价格拿不到就写 `pricePerSecond: null`，`ark cost` 会显示「以官网计费为准」，**不要编数字**。
4. 在 `--selftest` 里补一条断言：别名能解析、请求体能组装。
5. 跑 `npm run selftest`，全绿才算完成。

## 报错怎么写

远端错误统一走 `src/ark.js` 的 `request()`，抛出带 `status` 与 `error.code` 的 Error。CLI 层只负责补人类可读的建议：

```
创建任务 HTTP 400 [InvalidParameter] duration 超出范围
```

不要吞掉 `error.code` —— `InvalidParameter.TaskTypeConstraint` 这类码是定位任务类型判错的唯一线索。

## 验证清单（每次改动必跑）

```bash
node bin/ark.js --selftest                 # 离线断言，必须 16/16
node bin/ark.js models                     # 模型表能正常渲染
node bin/ark.js cost -R 480p -d 8          # ≈ 5.38 元
node bin/ark.js video "测试" -R 480p -d 5 --dry-run   # 请求体字段名正确
node bin/ark.js ui --port 5199 &然后 curl 127.0.0.1:5199/api/state   # 控制台能起来
```

真机联调（需要 Key）用最便宜的组合：`-R 480p -d 4 --mute`，一次约 2.7 元。

## 不要做的事

- 不要引入 SDK / axios / commander / dotenv。
- 不要自动重试 POST（会重复计费）。只有 GET 可以重试 429/5xx。
- 不要给 `waitTask` 加无限轮询。默认 20 分钟上限，超时把任务 ID 交给用户。
- 不要把 `output/` 提交进 git。
- 不要「顺手」美化输出格式，用户脚本可能依赖现有文本。
