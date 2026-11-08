---
name: ark-console
version: 1.0.0
display_name: 火山方舟本地控制台（CLI + 网页）
display_name_en: Build a Local Ark Console for Seedance and Seedream
description_zh: 从零搭建或复刻一套「火山方舟（Ark）视频/生图本地控制台」：零依赖 Node CLI + 单文件网页控制台，覆盖 Seedance 视频生成（首尾帧/参考图/参考视频/视频编辑/样片）、Seedream 生图（文生图/图生图/多模型对比/连发出图）、参考素材公网托管与预检、白模绿幕预设。当用户说「搭一个方舟控制台」「做个生图/生视频的本地网页」「把火山方舟 API 封装成 CLI」「ark-cli 这个项目怎么做的」「复刻我那套控制台」，或需要给任意「提交任务→轮询→下载」型生成 API 做本地控制台时使用。
description_en: Build or replicate a local console for Volcengine Ark video and image generation — a zero-dependency Node CLI plus a single-file web console, covering Seedance video (first/last frame, reference image/video, video edit, draft mode), Seedream image generation (text-to-image, image-to-image, multi-model compare, batched output), public hosting and pre-flight checks for reference assets, and clay-render/green-screen presets. Use when the user wants a local control panel for a generation API, or asks how the ark-cli project was built.
description: 从零搭建或复刻一套「火山方舟（Ark）视频/生图本地控制台」：零依赖 Node CLI + 单文件网页控制台，覆盖 Seedance 视频生成、Seedream 生图、参考素材公网托管与 ffprobe 预检、白模/绿幕预设，以及一整套「先验证事实、再写代码、最后用结果验收」的工程流程。当用户想搭本地控制台、把生成类 API 封装成 CLI、或复刻 ark-cli 时使用。
agent_created: true
---

# 火山方舟本地控制台：从零到可用

交付物固定为同一形态：一个**零依赖 Node 项目**，既能在终端 `ark video "..."` 出片，也能 `ark ui` 起一个本地网页控制台（`ark ui` 默认 `127.0.0.1:5173`，`start-ui.bat` 固定 5199 并自动开浏览器，Windows 双击即用），网页与 CLI 共享同一套校验和组包代码。

两条路径，按情况选：

| 路径 | 适用 | 耗时 | 保真度 |
|---|---|---|---|
| **A 复制基线**（默认） | 要「和别人现在用的一模一样」 | 约 15 分钟 | 100%（代码就是成品） |
| **B 从零搭建** | 要换成别的厂商 API、或想真正掌握每一步 | 半天起 | 取决于事实采集质量 |
| **C 已有半成品** | 手上已经有一个项目，只想补齐/修好 | 视缺口 | 取决于体检结果 |

不论走哪条路径，**第 4 节的验收门必须全过**，否则不算完成。

---

## 1. 先决条件（动手前必须确认）

```bash
node -v            # 必须 ≥ 18（要用内置 fetch、node:test 风格断言、ESM）
ffprobe -version   # 可选，缺了只是素材预检降级，不阻塞
```

还需要一个方舟 API Key（`https://console.volcengine.com/ark` → API Key 管理），以及账号**已开通**要用的模型。模型是否开通无法从 Key 推断，只能发真实请求试（404 = 未开通或 ID 已下线）。

跑一次环境自检，别靠猜：

```bash
node scripts/check-env.mjs                # 只查环境，不花钱
node scripts/check-env.mjs --live         # 额外真发 1 张 1K 图（约 ¥0.2）验证 Key 与开通状态
```

---

## 2. 路径 A：复制基线（推荐）

`assets/baseline/` 是一套**已经跑通、已在真机验证**的完整实现（`ark --selftest` 29/29）。复刻 = 复制 + 改三处配置。

```bash
# 1) 复制到目标目录（脚本会校验文件完整性、改默认端口、可选 git init）
node scripts/scaffold.mjs "D:/path/to/my-ark-console"

# 2) 配 Key（写进 ~/.ark/config.json，权限 600，不进仓库）
cd "D:/path/to/my-ark-console"
node bin/ark.js config set api-key sk-你的Key

# 3) 离线验收（不花钱，必须全绿）
node scripts/verify.mjs "D:/path/to/my-ark-console"

# 4) 起控制台
node bin/ark.js ui --port 5199 --open
```

**只需要改三处**，其余不要动：

| 改什么 | 位置 | 说明 |
|---|---|---|
| 默认端口 | `start-ui.bat` 的 `--port`、`scripts/scaffold.mjs` 传参 | 5199 被占就换 5200+ |
| 模型与价格 | `src/models.js` | 唯一事实来源；ID/价格会随时间变，用官方文档核对后再改 |
| 预设文案 | `src/presets.js` | 白模/绿幕提示词骨架，按自己主体改占位符 |

复制完先读 `assets/baseline/AGENTS.md`——那是给后续 AI 改代码时看的强约束，比 README 更重要。

**基线里的东西一律不要删**：`--selftest` 的 29 条断言覆盖了模型解析、请求体组装、生图尺寸、预设优先级、编辑任务约束。删掉断言等于失去唯一的回归保护。

### 路径 C：手上已有一个半成品

先用 `node scripts/verify.mjs <项目目录>` 体检，它不关心代码是谁写的，只看行为：

- 哪几条 `[FAIL]` → 按 `references/architecture.md` 对应层修
- `selftest` 解析不到 → 说明缺自检，先补断言再改功能（否则后面每改一次都要靠肉眼验）
- `/api/state` 缺 `models` / `pricePerSecond` → 前端一定硬编码了模型，先拆掉
- 请求体里出现 `generateAudio` 之类 camelCase → 字段名没照文档抄，全局搜一遍

体检全绿之后再用 `references/` 逐个补缺的功能，不要推翻重写。

---

## 3. 路径 B：从零搭建（六个阶段）

每个阶段都有**完成判据**，判据不过不许进入下一阶段。跳阶段的代价是后面所有 bug 都定位不到根因。

### P1 事实层：把官方文档变成可引用的 `docs/*.md`

先建 `docs/<model>.md`，按九节结构写：基本信息 / 请求体 / 参数表 / 任务类型 / 素材规格 / 返回结构 / 价格 / 像素表 / 同系列。这份文档是后续所有代码的**唯一事实来源**，也是让 AI 能持续维护这个项目的前提。

**这一步最容易出事**：凭记忆写字段名。本项目最常见的 bug 就是 `generateAudio`（错）vs `generate_audio`（对）、`size`（错）vs `resolution`（对）。写代码时字段名必须能在 `docs/` 里逐字找到。

**完成判据**：`docs/` 里能查到每个要用的参数名、取值范围、以及每个任务类型的强制约束。

### P2 模型表：`src/models.js` 做唯一事实来源

一个模型一条记录：`id` / `resolutions` / `ratios` / `duration{min,max,auto}` / `audio` / `draft` / `pricePerSecond`。价格拿不到就写 `null` 并在界面显示「以官网计费为准」，**绝不编数字**。

同时写两个纯函数：`resolveModel()`（接受别名、简写、完整 ID，未知 ID 原样透传给服务端，避免 CLI 成为新模型的瓶颈）和 `estimateCost()`。

**完成判据**：`ark models` 能渲染全表；`ark cost -R 480p -d 8` 给出金额；未知模型 ID 不抛错而是透传。

### P3 视频链路：建任务 → 轮询 → 下载

三个函数，各管一段：`buildContent()` 组 `content` 数组（text / first_frame / last_frame / reference_image / reference_video / reference_audio），`createTask()` 提交，`waitTask()` 轮询到终态，`download()` 落盘。

必须守住的四条：

1. **产物必须落盘**。命令结束就要有文件，不允许只打印一个会过期的 URL。
2. **只有 GET 能重试**。POST 重试 = 重复计费。
3. **轮询要有上限**（默认 20 分钟），超时把任务 ID 交给用户自己续查。
4. **错误必须保留 `error.code`**。`InvalidParameter.TaskTypeConstraint` 这类码是定位任务类型判错的唯一线索，吞掉就再也查不出来。

**完成判据**：`ark video "测试" -R 480p -d 5 --dry-run` 打出的请求体，字段名与 `docs/` 逐字一致。

### P4 校验层：`normalizeVideoOptions()` 一个入口

所有约束集中在一个函数里，不要散落在命令函数中。必须拦住：

- 分辨率不在模型能力表内
- 时长越界（普通任务 4–30s，`-1` 表示跟随原片）
- 编辑任务：`ratio` 必须 `adaptive`、`duration` 必须 `-1`、必须有参考视频
- 首帧/首尾帧任务：`ratio` 必须 `adaptive`
- 给了尾帧却没给首帧
- 提示词与素材全空

CLI 与网页**共用这一个函数**（`server.js` 直接 `import`，不许重写一遍）。这条规则是整个项目最重要的一条：否则「终端能传、页面传不了」会变成常态。

**完成判据**：故意传错参数，每一条都被拦住并给出人话原因。

### P5 控制台：`src/server.js` + `web/index.html`

服务端只用 `node:http` 手写路由，不引框架。前端是**一个 HTML 文件**，内联 CSS/JS，不引 React/Vue/Tailwind/CDN，不用构建。

关键设计：`GET /api/state` 把模型、分辨率、价格、任务类型、能力开关**一次性下发给前端**，前端不许硬编码模型 ID 或价格。加一个模型只改 `models.js`，页面自动多一个选项。

**完成判据**：`curl 127.0.0.1:5199/api/state` 返回非空且含全部模型；页面能提交一条真实任务、看到轮询状态、播放并下载产物。

### P6 生图、素材、预设（按需增补，顺序无关）

三块彼此独立，可单独做，细节见 `references/`：

- **生图**：`POST /images/generations` 是**同步**接口，没有任务 ID、不用轮询，与视频链路完全独立，不要试图复用任务表。见 `references/image-generation.md`。
- **参考视频**：`reference_video` 必须是**公网 URL**，本地文件走 base64 会撑爆请求体上限。见 `references/material-hosting.md`。
- **预设**：白模/绿幕没有专用 API 参数，只是「普通参考视频 + 特定提示词 + 特定参数搭配」，因此固化成预设而不是新接口。见 `references/presets.md`。

---

## 4. 验收门（全过才算完成）

```bash
node bin/ark.js --selftest            # 离线断言全绿（基线为 29/29）
node bin/ark.js models                # 模型表正常渲染
node bin/ark.js cost -R 480p -d 8     # 金额符合推算
node bin/ark.js video "测试" -R 480p -d 5 --dry-run   # 请求体字段名正确
node bin/ark.js image "测试" --dry-run                # 生图请求体正确
node scripts/verify.mjs .             # 起服务 + 打 /api/state + 断言关键字段
```

再补三条**真机**验证（花小钱，但只有它能证明链路通）：

1. 最便宜组合出一条视频：`-R 480p -d 4 --mute`（约 ¥2.7），确认落盘、能播放。
2. 生图 1 张 1K（约 ¥0.2），确认返回 URL 能下载。
3. 浏览器里手动跑一遍：加参考视频看预检徽标、切任务类型看重新判定、选预设看参数是否被套用并展开高级区。

---

## 5. 硬规则（违反其中任何一条都会在两周内反噬）

1. **不引依赖**。Node ≥18 内置 fetch 足够。`node_modules` 一旦出现，这个项目就再也无法「拷走即用」。
2. **模型 ID、价格、分辨率列表只写在 `models.js`**。`src/` 其他文件里出现裸字符串 `doubao-...` 就是 bug。
3. **参数名逐字照抄官方文档**，写完回头在 `docs/` 里 grep 一遍。
4. **加一个参数要同时改四处**：`docs/` → `buildPayload()` → `normalizeVideoOptions()` → CLI flag 与网页表单。少一处必然割裂。
5. **不发请求的路径要能跑通**：`--dry-run` 只打印请求体，`--selftest` 完全离线。新功能不能被这两条覆盖就等于无法验证。
6. **退出码语义固定**：`0` 成功 / `1` 远端或运行失败 / `2` 参数或环境错误。别用 `exit(1)` 糊所有情况。
7. **Key 只存在 `~/.ark/config.json` 或环境变量**，永远不进仓库、不进前端源码、不打进日志。
8. **网页不许自成一套逻辑**，校验与组包必须 import CLI 的。
9. **改了代码必须重启进程**。ESM 没有热重载，旧进程还在跑就会看到「改了没生效」的假象；浏览器再 `Ctrl+Shift+R`。
10. **参数生效只能靠结果验证**。未知参数会被接口静默忽略（见 `references/pitfalls.md`），「没报错」不等于「生效了」。

---

## 6. 故障速查

| 现象 | 真实原因 | 处理 |
|---|---|---|
| `reference_video must be provided as a web url` | 本地视频走了 base64，或传了 `file://` | 上传对象存储拿公网直链，填 URL |
| `Failed to fetch` / `ERR_CONNECTION_REFUSED` | 本地服务没起、端口不对、或起了又挂了 | 确认进程在跑，端口与地址栏一致 |
| 页面看不到刚加的功能 | 改了 `index.html`/`server.js` 没重启进程 | 杀进程重启 + 硬刷新 |
| `/api/state` 里字段是空的 | 旧进程仍在占用端口，新进程没起来 | 找到占端口的 PID 杀掉再起 |
| 生图/视频 404 | 模型未开通，或该 Model ID 已下线 | 控制台开通，或换当前主线 ID |
| 参数传了但结果没变化 | 接口静默忽略未知参数 | 换一种写法实测，用产物验证 |
| 1080p 挂参考图报错 | 挂参考素材时该分辨率不可用 | 降到 720p |
| 视频编辑任务报参数错 | `ratio` 不是 `adaptive`，或 `duration` 不是 `-1`，或原片不在 4–30s | 三项一起检查 |
| 绿幕抠出来一圈绿边 | 输出成了 mp4（yuv420 色度溢出） | 强制 `output_format: mov` |
| 素材预检不显示 | 本机没有 `ffprobe` | 装 ffmpeg，或设 `FFPROBE_PATH` |

---

## 7. 参考文件索引

按需读取，不要一次全读。

| 文件 | 什么时候读 |
|---|---|
| `references/api-facts.md` | 写任何请求前：接口、参数、限制、价格、错误码 |
| `references/architecture.md` | 决定「这段逻辑放哪个文件」时 |
| `references/image-generation.md` | 做生图这一半时（同步接口、尺寸折算、连发出图、多模型对比） |
| `references/material-hosting.md` | 参考视频/音频传不上去时（公网 URL、TOS 建桶与 CORS、ffprobe 限制表） |
| `references/ui-conventions.md` | 做网页那半时（`/api/state` 契约、模板与历史、产物三连、深链） |
| `references/presets.md` | 做白模/绿幕或任何「参数组合 + 提示词骨架」时 |
| `references/pitfalls.md` | 动手前读一遍：已被实测证伪的假设清单，能省掉一整天 |
| `assets/baseline/` | 路径 A：整套可运行代码 |
| `assets/baseline/AGENTS.md` | 让后续 AI 接手改代码前必读 |
| `assets/screenshots/` | 目标效果参照：生图页、白模绿幕预设页 |

---

## 8. 明确不做

- 不做账号体系、不做多用户、不做云端部署——这是**本地**控制台，跑在 `127.0.0.1`。
- 不做前端构建链、不做 SSR、不拆多文件。
- 不用 `seed` 锁构图（实测不可复现，不提供该控件）。
- 不自动重试 POST。
- 不为了「好看」改输出文本格式——用户的脚本可能依赖它。
