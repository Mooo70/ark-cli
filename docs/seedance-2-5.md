# Seedance 2.5 视频生成 — AI 可读摘要

> 本文件是**给 AI 读的**官方文档摘要，不是给人看的教程。改代码前先读这里，不要凭记忆写参数名。
> 核对日期：2026-11-05。官方原文：
> - 创建任务 https://www.volcengine.com/docs/82379/1520757
> - 查询任务 https://www.volcengine.com/docs/82379/1521309
> - 能力与限制 https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5

## 1. 基本信息

| 项 | 值 |
|---|---|
| Model ID | `doubao-seedance-2-5-260628` |
| Base URL | `https://ark.cn-beijing.volces.com/api/v3` |
| 鉴权 | 请求头 `Authorization: Bearer $ARK_API_KEY` |
| 创建任务 | `POST /contents/generations/tasks` |
| 查询任务 | `GET /contents/generations/tasks/{id}` |
| 形态 | **异步**：先拿 task id，再轮询到 `succeeded` |
| 产物 | `content.video_url`（24 小时有效，下载上限 100 次） |

## 2. 请求体

```jsonc
{
  "model": "doubao-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "提示词（中文建议 ≤ 500 字）" },
    { "type": "image_url", "role": "first_frame",      "image_url": { "url": "<URL 或 data:image/png;base64,...>" } },
    { "type": "image_url", "role": "last_frame",       "image_url": { "url": "..." } },
    { "type": "image_url", "role": "reference_image",  "image_url": { "url": "..." } },
    { "type": "video_url", "role": "reference_video",  "video_url": { "url": "..." } },
    { "type": "audio_url", "role": "reference_audio",  "audio_url": { "url": "..." } }
  ],
  "resolution": "720p",
  "ratio": "adaptive",
  "duration": 5,
  "generate_audio": true,
  "watermark": false,
  "seed": 12345,
  "omni_reference_task_type": "auto",
  "output_format": "mp4",
  "draft": false
}
```

## 3. 参数表

| 参数 | 类型 | 默认 | 取值 / 约束 |
|---|---|---|---|
| `model` | string | 必填 | Model ID 或 Endpoint ID |
| `content` | object[] | 必填 | 见上；纯文本、首帧、首尾帧、参考生视频、编辑、延长六种组合 |
| `resolution` | string | `720p` | `480p` / `720p` / `1080p`（1080p 是 10bit + H.265，老播放器可能不兼容）；**不支持 4K** |
| `ratio` | string | `adaptive` | `16:9` `4:3` `1:1` `3:4` `9:16` `21:9` `adaptive` |
| `duration` | int | `-1` | `[4, 30]` 或 `-1`（模型自选）；编辑任务**只能** `-1` |
| `generate_audio` | bool | 官方未标注，**建议显式传** | 原生生成对白/音效/音乐，支持 11 种语言 |
| `watermark` | bool | `false` | `true` 在右下角加「AI生成」 |
| `seed` | int | 随机 | 固定可复现；样片模式第二步禁止传入 |
| `camera_fixed` | bool | `false` | 锁定虚拟相机（固定机位） |
| `return_last_frame` | bool | `false` | 同时返回尾帧图 URL，用于拼接连续镜头 |
| `callback_url` | string | — | Webhook 回调，状态变化时 POST 推送（queued/running/succeeded/failed/expired），失败重试 3 次 |
| `execution_expires_after` | int | `172800` | 任务超时阈值，秒，取值 3600–259200 |
| `priority` | int | `0` | 调度优先级 0–9，越大越早 |
| `safety_identifier` | string | — | 终端用户标识，风控/审计用 |
| `service_tier` | string | `default` | `default` 在线推理 / `flex` 离线推理（半价）；**2.5 与 2.0 系列暂不支持 flex** |
| `omni_reference_task_type` | string | `auto` | `auto` / `reference` / `edit` / `extend` |
| `output_format` | string | `mp4` | `mp4` / `mov`（H.264+yuv444p+PCM，编辑/延长推荐） |
| `draft` | bool | `false` | 样片模式，**仅 2.5 支持，只出 480p** |
| `draft_task` | object | — | 用样片任务 ID 出正式片，见 §10 |
| `callback_url` | string | — | Webhook 回调，可替代轮询 |
| `return_last_frame` | bool | — | 返回尾帧图，便于接续下一段 |

## 4. 任务类型判定（最容易踩坑的地方）

| 任务 | 触发条件 | 硬约束 |
|---|---|---|
| 文生视频 | 只有 text | 无 |
| 首帧/首尾帧 | `role: first_frame`(+`last_frame`) | **`ratio` 必须 `adaptive`** |
| 参考生视频 | 至少一个 `reference_*` | 无 |
| 视频编辑 | `reference_video` + 编辑意图 | **`ratio=adaptive`、`duration=-1`**，参考视频 4–30s，提示词须含「编辑/增加/删除/修改/替换」 |
| 视频延长 | `reference_video` + 延长意图 | **`ratio=adaptive`**，提示词须含「向前/向后延长、延续、续写」 |

报错分两种：
- **同步**：提交时参数校验失败，立刻返回。
- **异步**：任务跑起来才发现类型不匹配，错误码 `InvalidParameter.TaskTypeMismatch` / `InvalidParameter.TaskTypeConstraint`。

> 规避策略：全模态参考场景统一用 `omni_reference_task_type=auto` + `ratio=adaptive` + `duration=-1`，可同时兼容编辑/延长。

## 5. 素材规格

| 类型 | 数量 | 单文件 |
|---|---|---|
| 图片 | ≤ 30 张 | < 30MB，jpeg/png/webp/bmp/tiff/gif/heic/heif，边长 300–6000px，宽高比 0.4–2.5 |
| 视频 | ≤ 10 个（总时长 ≤ 30s） | 单个 2–30s，< 200MB，mp4/mov，24–60fps |
| 音频 | ≤ 10 段（总时长 ≤ 30s） | 单个 2–30s，< 15MB，wav/mp3 |

请求体总大小 ≤ 64MB，**大文件用 URL，不要 Base64**。
Seedance 2.5 / 2.0 **不支持含真人人脸的参考图/视频**（需走平台授权的虚拟人像或已授权素材）。

## 6. 返回结构

创建任务返回 `{ "id": "cgt-2026xxxx-xxxx" }`。

查询任务返回：

```jsonc
{
  "id": "cgt-...",
  "model": "doubao-seedance-2-5-260628",
  "status": "succeeded",              // queued | running | succeeded | failed | cancelled | expired
  "content": { "video_url": "https://..." },
  "usage": { "completion_tokens": 108900, "total_tokens": 108900 },
  "duration": 5, "ratio": "16:9", "resolution": "720p",
  "framespersecond": 24, "generate_audio": true, "draft": false,
  "created_at": 1779348818, "updated_at": 1779348874,
  "error": { "code": "...", "message": "..." }
}
```

## 7. 价格参考（Seedance 2.5，16:9）

按 token 计费（分辨率 × 时长 × 是否输入视频）。各比例像素数接近，所以按秒折算基本通用：

| 分辨率 | 5s | 每秒 |
|---|---|---|
| 480p | ≈ 3.36 元 | 0.672 |
| 720p | ≈ 7.56 元 | 1.512 |
| 1080p | ≈ 18.71 元 | 3.742 |

推导核对：720p 15s = 22.68 元（控制台预估），22.68 / 15 × 5 = 7.56 ✓；480p 8s = 5.38 元，与「5 块 4 做一条 8 秒 480p」一致 ✓。

省钱路径：`draft: true`（480p 样片先试）→ 满意后再出正式片；关掉 `generate_audio`。

### 7.1 Seedance 2.0 系列（16:9，输入不含视频）

官方只给「元/百万 token」，2.0 系列没有现成每秒价，这里按官方公式折算：

```
tokens/s = 宽 × 高 × 帧率 / 1024        （480p 854×480、720p 1280×720、1080p 1920×1080、4k 3840×2160，24fps）
元/秒     = tokens/s × token单价 / 1e6
```

| 模型 | token 单价 | 480p | 720p | 1080p | 4k |
|---|---|---|---|---|---|
| Seedance 2.5 | 70（1080p 77） | 0.672 | 1.512 | 3.742 | — |
| Seedance 2.0 | 46（1080p 51、4k 26） | 0.442 | 0.994 | 2.479 | 5.054 |
| Seedance 2.0 fast | 37 | 0.355 | 0.799 | 不支持 | 不支持 |
| Seedance 2.0 mini | 23 | 0.221 | 0.497 | 不支持 | 不支持 |

推导自检：2.5 三档与官方示例完全吻合（0.6725→0.67、1.512→1.51、3.7422→3.74）。
上表按「输入不含视频」计，属保守上界；输入带视频时 token 单价更低（2.0 为 28、fast 22、mini 14），但 token 用量会加上输入视频时长。

> 4k 每秒价是按 24fps 推的估算值，官方未给 4k 价格示例；需要精确数字用官方价格计算器。

## 8. 分辨率 × 比例的真实像素

| | 16:9 | 4:3 | 1:1 | 3:4 | 9:16 | 21:9 |
|---|---|---|---|---|---|---|
| 480p | 854×480 | 752×560 | 640×640 | 560×752 | 480×854 | 992×432 |
| 720p | 1280×720 | 1112×834 | 960×960 | 834×1112 | 720×1280 | 1470×630 |
| 1080p | 1920×1080 | 1664×1248 | 1440×1440 | 1248×1664 | 1080×1920 | 2206×946 |

## 9. 同系列其他模型

| 模型 | Model ID | 时长上限 | 备注 |
|---|---|---|---|
| Seedance 2.0 | `doubao-seedance-2-0-260128` | 15s | **唯一支持 4k** |
| Seedance 2.0 fast | `doubao-seedance-2-0-fast-260128` | 15s | 不支持 1080p |
| Seedance 2.0 mini | `doubao-seedance-2-0-mini-260615` | 15s | 不支持 1080p |

> `1080p` 在**参考图场景下不支持**；`4k` 仅 Seedance 2.0。

## 10. 样片模式（Draft）

两步走，用于低成本试片：

1. `draft: true` → 只出 **480p 样片**（构景、镜头、动作、prompt 意图是否符合预期）
2. 满意后，用样片任务 ID 作为 `content` 里唯一元素再调一次：

```jsonc
{
  "model": "doubao-seedance-2-5-260628",
  "content": [{ "type": "draft_task", "draft_task": { "id": "<样片任务 ID>" } }]
}
```

- 场景结构、镜头调度等参数由平台**自动复用**；`seed` 等禁止再次传入
- 样片任务 ID 有效期：2026-10-28 10:00 (UTC+8) 之后创建的有效 14 天，之前创建的 7 天

## 11. 任务管理接口

| 操作 | 方法/路径 |
|---|---|
| 创建 | `POST /contents/generations/tasks` |
| 查询单个 | `GET /contents/generations/tasks/{id}` |
| 查询列表 | `GET /contents/generations/tasks?filter.status=&page_num=&page_size=` |
| 取消/删除 | `DELETE /contents/generations/tasks/{id}` |

列表返回 `items[]`，含 `id / model / status / content.video_url / content.last_frame_url / created_at / duration / draft / error`，分页上限 500。

`DELETE` 的行为取决于当前状态：

| 当前状态 | 是否可删 | 结果 |
|---|---|---|
| `queued` | 是 | 取消排队，状态变 `cancelled` |
| `cancelled` | 否 | — |
| `running` | 否 | — |
| `succeeded` / `failed` / `expired` | 是 | 删除记录，之后无法再查 |

## 12. 有效期

- 视频/尾帧 URL：**24 小时**，Seedance 2.5 产物下载上限 **100 次**
- 任务 ID：普通 7 天；Draft 14 天
- 建议用 TOS 数据订阅把产物自动转存，长期备份
