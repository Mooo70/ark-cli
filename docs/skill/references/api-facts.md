# 接口事实速查（方舟视频 + 生图）

> 所有数字都来自真机调用或官方文档摘录，采集于 2026-11。**价格与 Model ID 会变**，动手前用官方页面复核一次，不要在代码里写死后再也不看。
> 视频参数的完整表在 `assets/baseline/docs/seedance-2-5.md`，本文件只补它没覆盖的部分（生图、错误码、轮询、下载）。

## 1. 两套接口，形态完全不同

| | 视频（Seedance） | 生图（Seedream） |
|---|---|---|
| 路径 | `POST /contents/generations/tasks` | `POST /images/generations` |
| 形态 | **异步**，先拿 task id 再轮询 | **同步**，一次请求等到结果 |
| 耗时 | 1–5 分钟 | 10–40 秒 |
| 返回 | `{ id }` → 再查 `content.video_url` | 直接 `{ data: [{ url }] }` |
| 产物有效期 | URL 24 小时，下载上限 100 次 | URL 短期有效，必须立刻落盘 |
| 参考素材 | 视频/音频**必须公网 URL** | 参考图 base64 即可（≤14 张） |
| 计费 | 按 token（≈ 按秒） | 按张 |

**不要把两者揉进一套任务表。** 生图没有 task id、没有状态机，硬套轮询只会引入无意义的抽象。

Base URL：`https://ark.cn-beijing.volces.com/api/v3`，鉴权 `Authorization: Bearer <API_KEY>`。

官方原文（复核用）：

- 创建任务 https://www.volcengine.com/docs/82379/1520757
- 查询任务 https://www.volcengine.com/docs/82379/1521309
- 能力与限制 https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5
- 模型与价格：方舟控制台「开通管理」+ 官网「模型价格」页

## 2. 视频：请求体字段（只列关键）

```
model / content[] / resolution / ratio / duration / generate_audio / watermark
seed / camera_fixed / return_last_frame / callback_url / execution_expires_after
priority / safety_identifier / service_tier / omni_reference_task_type
output_format / draft / draft_task
```

`content[]` 的 `role` 只有五种：`first_frame`、`last_frame`、`reference_image`、`reference_video`、`reference_audio`（外加 `draft_task` 这种 type）。

`omni_reference_task_type` 只有四个值：`auto`、`reference`、`edit`、`extend`。

**没有任何「白模」「绿幕」专用参数**——这两者是「普通参考视频 + 特定提示词 + 特定参数搭配」，见 `presets.md`。

## 3. 视频：任务状态与时序

状态机：`queued → running → succeeded | failed | cancelled | expired`。

轮询建议：首次 3s，之后每次 ×1.25，上限 8s；总超时 20 分钟。**只对 GET 重试**（429/5xx 最多 2 次），POST 绝不重试——重试等于重复计费。

`DELETE /contents/generations/tasks/{id}` 的行为随状态变化：`queued` 可取消；`running` 不可；`succeeded/failed/expired` 是删除记录（删了就再也查不到）。

## 4. 视频：模型能力矩阵

| 模型 | Model ID | 分辨率 | 时长 | 4k | 样片 |
|---|---|---|---|---|---|
| Seedance 2.5 | `doubao-seedance-2-5-260628` | 480p/720p/1080p | 4–30s | ❌ | ✅ |
| Seedance 2.0 | `doubao-seedance-2-0-260128` | 480p/720p/1080p/4k | 4–15s | ✅ | ❌ |
| 2.0 fast | `doubao-seedance-2-0-fast-260128` | 480p/720p | 4–15s | ❌ | ❌ |
| 2.0 mini | `doubao-seedance-2-0-mini-260615` | 480p/720p | 4–15s | ❌ | ❌ |

**挂参考图/参考视频时 1080p 不可用**，只能用 480p/720p。这条没有文档明写，是实测撞出来的。

### 价格（元/秒，16:9，输入不含视频）

| 模型 | 480p | 720p | 1080p | 4k |
|---|---|---|---|---|
| 2.5 | 0.672 | 1.512 | 3.742 | — |
| 2.0 | 0.442 | 0.994 | 2.479 | 5.054 |
| 2.0 fast | 0.355 | 0.799 | — | — |
| 2.0 mini | 0.221 | 0.497 | — | — |

推导公式（官方只给「元/百万 token」）：`tokens/s = 宽 × 高 × 帧率 / 1024`，`元/秒 = tokens/s × 单价 / 1e6`。
2.5 已用官方三个示例点校验吻合（0.6725→0.67、1.512→1.51、3.7422→3.74）。

**别拿 480p 和 1080p 的差价当「小钱」**：12 秒 480p ≈ 8 元，12 秒 1080p ≈ 45 元，差 37 元。这是最容易被用户抓到的估算错误。

## 5. 生图：请求体

```jsonc
{
  "model": "doubao-seedream-4-0-20260415",
  "prompt": "……",
  "size": "2048x2048",              // 或 "1K"/"2K"/"4K" 档位，实测传档位也能过，但自己算好像素更稳
  "response_format": "url",
  "watermark": false,
  "image": "<URL | dataURL | [多张]>",   // 有参考图 = 图生图，无需切换模式
  "sequential_image_generation": "disabled",
  "max_images": 1
}
```

返回：`{ data: [{ url | b64_json, size }], usage: { total_tokens } }`。**`data` 是数组，可能为空，必须判空**。

### 尺寸规则

档位给的是**长边**，短边按比例折算，8 的倍数取整，再夹到官方允许区间：单边 ≤ 4096、总像素 ∈ [1280×720, 4096×4096]。

所以 `1K + 9:16` 不会给 576×1024，会自动放大到 720×1280——因为 576×1024 低于最小像素数。

### 模型与价格（元/张，输入图不计费）

| 模型 | Model ID | 元/张 | 档位 | 格式 | 组图 |
|---|---|---|---|---|---|
| 4.0 | `doubao-seedream-4-0-20260415` | 0.20 | 1K/2K/4K | jpeg | ✅ |
| 4.5 | `doubao-seedream-4-5-251128` | 0.25 | 2K/4K | jpeg | ✅ |
| 5.0-flash | `doubao-seedream-5-0-flash-260915` | 0.12 | 1K/1.5K/2K | png/jpeg | ❌ |
| 5.0-lite | `doubao-seedream-5-0-260128` | 0.22 | 2K/3K/4K | png/jpeg | ✅ |
| 5.0-pro | `doubao-seedream-5-0-pro-260628` | 0.30 起 | 1K/1.5K/2K | png/jpeg | ❌ |

**5.0 是三条独立产品线**（flash 快而便宜 / pro 画质 / lite 组图），ID 与能力各不相同，不要当成同一模型的档位。

- `doubao-seedream-4-0-250828` 已下线（404），别再抄旧 ID。
- 5.0 三个模型都要**单独开通**，未开通就是 404。
- 4.0 / 4.5 只出 jpeg，传 `output_format: png` 直接 400。
- **组图参数是硬门槛**：5.0 pro / flash 连 `sequential_image_generation: "disabled"` 都不接受
  （`400 ... parameter is not supported by the current model`），必须整段省略这个字段；
  4.0 / 4.5 / lite 才带。实现上用 `model.group` 控制。

## 6. 错误处理约定

远端错误统一在一个 `request()` 里落地，抛出的 Error 必须带 `status` 与原始 `error.code`：

```
创建任务 HTTP 400 [InvalidParameter] duration 超出范围
```

- **同步错误**：提交时参数校验失败，立刻返回，改参数即可。
- **异步错误**：任务跑起来才发现，错误码 `InvalidParameter.TaskTypeMismatch` / `InvalidParameter.TaskTypeConstraint` —— 这是「任务类型判错了」，不是参数越界。
- **404**：模型不存在 / 未开通 / ID 已下线，三者对外表现一致，提示里要把三种可能都写出来。
- 不要吞 `error.code`。没有它，这类问题只能靠猜。

退出码语义：`0` 成功 / `1` 远端或运行失败 / `2` 参数或环境错误。

## 7. 产物下载

`content.video_url` 是带签名的临时 URL，**必须立刻下载**（24 小时后失效，且下载次数有上限）。
用流式写入（`Readable.fromWeb(res.body).pipe(fs.createWriteStream(dest))`），别 `arrayBuffer()` 一次性读进内存——1080p 视频动辄几十 MB。

文件名用「提示词 slug + 时间戳」，保留中文，去掉 `\/:*?"<>|`。
