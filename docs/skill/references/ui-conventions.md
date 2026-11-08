# 网页控制台的约定

一个 HTML 文件，内联 CSS/JS，无框架、无构建、无 CDN。所有参数事实来自 `GET /api/state`，前端不硬编码模型 ID 与价格。

## 布局

```
┌──────────── 268px 侧栏 ────────────┬───────────── 主区 ─────────────┐
│ API Key（粘贴即存，绿/红状态灯）      │  [视频] [生图]  ← 顶部 tab       │
│ 账户余额（需 AK/SK，可选）           │                                 │
│ 本次费用（大字 + 参数行 + 进度条）    │  提示词框 + 模板下拉             │
│ 运行状态（任务 ID / 阶段 / 耗时）     │  模型 / 分辨率 / 时长 / 画幅      │
│ 模型能力（当前模型支持什么）          │  首帧 尾帧 / 参考图 / 参考视频 / 参考音频 │
│ 说明                                │  任务类型 / 开关 / 高级参数       │
└────────────────────────────────────┴─────────────────────────────────┘
                                      │ 日志（等价 CLI 终端输出）        │
                                      │ 产物（播放 + 下载）              │
                                      │ 任务记录（官方接口，关页仍在）    │
```

深色主题，CSS 变量统一（`--bg / --panel / --line / --text / --muted / --accent / --ok / --warn / --err`）。改配色只改 `:root`。

## `/api/state` 契约

这是前端唯一的「能力来源」：

```jsonc
{
  "pid": 127700,                    // 进程号：页面据此自证「连的是哪个实例」
  "startedAt": "2026-11-07T06:24:05.898Z",
  "hasKey": true,
  "keyHint": "sk-…abcd 或 来自环境变量",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "defaultModel": "seedance-2.5",
  "models": [ /* 完整模型记录，含 resolutions/ratios/duration/audio/draft/pricePerSecond */ ],
  "defaultImageModel": "seedream-4.0",
  "imageModels": [ /* 含 sizes/formats/group/maxImages/maxRefs/pricePerImage */ ],
  "configFile": "C:\\Users\\<你>\\.ark\\config.json"
}
```

前端据此渲染：模型下拉、分辨率 chips（每个带 `¥/秒 × 当前时长`）、时长上限、画幅选项、生图尺寸档（只显示该模型支持的）、格式下拉（只在模型支持多格式时出现）。
`pid` / `startedAt` 渲染在左侧「运行状态」卡片：`127.0.0.1:5199 · pid 127700 · 14:24 启动`。

**判断标准**：往 `models.js` 加一个模型，刷新页面就该自动出现。如果还得改 HTML，说明前端硬编码了。

## 接口清单

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/state` | 能力与配置快照 |
| POST | `/api/config` | 保存 API Key / AK / SK |
| GET | `/api/account` | 余额与模型开通状态（AK/SK） |
| POST | `/api/video` | 提交视频任务（同步等到终态再返回） |
| GET | `/api/tasks` | 官方任务列表 |
| GET/DELETE | `/api/task/:id` | 查/删单个任务 |
| GET | `/api/presets` | 内置预设（含提示词骨架） |
| GET | `/api/image-models` | 生图模型列表 |
| POST | `/api/image` | 生图（单张或连发 N 张） |
| POST | `/api/image-compare` | 多模型对比 |
| POST | `/api/probe` | 素材预检（只接受 http(s)/dataURL） |
| GET | `/api/file/...` | 读 `output/` 下的产物（支持子目录） |

## 表单交互的几处细节

- **参数 chip 带价格**：分辨率按钮上直接写 `1080p ¥3.74/s`，用户不用点开才知道贵。
- **时长支持自定义**：固定档位之外给一个「+ 自定义」，输入 4–30 任意整数。
- **高级参数折叠**：seed / 输出格式 / 超时 / 优先级 / 回调 / safety_id 放折叠区，默认收起；**套用预设时自动展开**并写日志说明改了哪几项。
- **参考素材区块**：标题右侧是入口（`+ 选本地视频` / `+ 选本地音频`），下面一行是「或粘贴公网 URL」。加进来的条目点一下就地展开播放器，右侧显示「本地/URL · 大小」，`×` 移除。
- **错误用 banner 显示**，不要 `alert()`：banner 里给「原因 + 下一步」，原始错误码保留。
- **日志区等价 CLI 输出**：每条带时间戳，成功绿、失败红。用户排查时先看这里。

## 模板与历史（localStorage）

| 键 | 内容 | 上限 |
|---|---|---|
| `ark.templates.v1` | 视频提示词模板 `{name, text}` | — |
| `ark.templates.image.v1` | 生图模板 | 80 |
| `ark.image.history.v1` | 生图历史（提示词/模型/尺寸/张数/费用/时间） | 60 |

视频模板下拉分两组：**内置预设**（来自 `/api/presets`，不可删、不可覆盖）与**我的模板**（可存可删，同名再存是更新）。
预设与模板是两种东西：预设同时套**参数 + 提示词**，模板只存提示词。别混在一个下拉里不分组的平铺。

## 产物与联动

视频产物：页面内 `<video controls>` 播放 + 下载按钮 + 「用这个样片出正式片」（仅 draft 产物出现）。

生图产物每张三个按钮：

1. **以此为参考** → 填进生图参考图，继续改
2. **用作视频首帧** → 切到视频 tab，填首帧槽
3. **用作视频参考图** → 切到视频 tab，填参考图列表

联动是这个控制台最值钱的地方：生图 → 挑一张 → 出视频，中间不落盘、不上传。

## 深链与静态资源

- `#image` 打开生图 tab（`hashchange` + 首屏各处理一次）。
- `index.html` 响应头带 `Cache-Control: no-store`，避免改了页面还看到旧版本。
- `/api/file/` 要做路径穿越防护：`resolve` 后必须以 `output/` 为前缀；MIME 要覆盖 jpg/webp/mp4/mov/mp3。

## 什么时候必须重启 + 硬刷新

改 `src/*.js` 或 `web/index.html` 之后：**杀进程 → 重启 → `Ctrl+Shift+R`**。

判断是否还连着旧进程，按这个顺序：

1. 看页面「运行状态 → 实例」那行的 `pid` 和启动时间，是不是你刚起的那个；
2. `curl 127.0.0.1:<port>/api/state`，看新字段（如 `pid`）在不在、`imageModels` 数量对不对；
3. `netstat -ano | grep :<port>` + 任务管理器核对 pid。

**不要靠「我就在 5199」这种记忆判断**。端口被占时如果程序静默换号，浏览器可能停在旧端口上，而你完全看不出来。
基线里的 `startServer` 已经改成「占用者是 ark 就复用并打印 pid，否则明确提示换端口」，别再改回静默 `+1`。
