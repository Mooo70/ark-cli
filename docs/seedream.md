# Seedream 生图 — AI 可读摘要

> 给 AI 读的事实表，不是教程。改生图代码前先看这里，不要凭记忆写 Model ID。
> 核对日期：2026-11-07。官方：
> - 模型能力对比 https://ark.volcengine.com/region:cn-beijing/docs/seedream-4-0-5-0
> - 5.0 pro / flash 教程 https://www.volcengine.com/docs/ark/seedream-5-0-pro
> - 模型列表 https://ark.volcengine.com/region:cn-beijing/docs/model-list

## 1. 基本信息

| 项 | 值 |
|---|---|
| 接口 | `POST https://ark.cn-beijing.volces.com/api/v3/images/generations` |
| 形态 | **同步**，无任务 ID、无轮询 |
| 鉴权 | `Authorization: Bearer $ARK_API_KEY` |
| 返回 | `{ data: [{ url, size }], usage: { total_tokens } }` |
| 产物 | URL 短期有效，必须立刻落盘 |

## 2. 模型矩阵（2026-11 核对）

| 模型 | Model ID | 分辨率 | 格式 | 组图 | 元/张 |
|---|---|---|---|---|---|
| Seedream 4.0 | `doubao-seedream-4-0-20260415` | 1K / 2K / 4K | jpeg | ✅ | 0.20 |
| Seedream 4.5 | `doubao-seedream-4-5-251128` | 2K / 4K | jpeg | ✅ | 0.25 |
| Seedream 5.0 flash | `doubao-seedream-5-0-flash-260915` | 1K / 1.5K / 2K | png / jpeg | ❌ | 0.12 |
| Seedream 5.0 lite | `doubao-seedream-5-0-260128`（别名 `doubao-seedream-5-0-lite-260128`） | 2K / 3K / 4K | png / jpeg | ✅ | 0.22 |
| Seedream 5.0 pro | `doubao-seedream-5-0-pro-260628` | 1K / 1.5K / 2K | png / jpeg | ❌ | 0.30 起 |

- **5.0 是三条独立产品线**，不是同一模型的档位。flash 主打速度与成本（0.12，最快），pro 主打画质（0.30 起），lite 支持组图。
- 官方标注 lite 与 4.5「即将下线」，4.0 的旧 ID `doubao-seedream-4-0-250828` 已 404，主线是 `-20260415`。
- 5.0 pro / flash 的「图层拆分」（1 底图 + 16 图层）与 `sequential_image_generation` 组图不是一回事，别混。
- 价格按输出张数计，输入参考图不计费。

## 3. 请求体

```jsonc
{
  "model": "doubao-seedream-5-0-flash-260915",
  "prompt": "……",
  "size": "1024x1024",
  "response_format": "url",
  "watermark": false,
  "image": "<URL | dataURL | [多张]>",       // 有参考图 = 图生图
  "output_format": "png",                    // 仅 5.0 系列支持 png
  "sequential_image_generation": "disabled"  // 5.0 pro / flash 不支持，必须整段省略
}
```

## 4. 参数坑（真机实测）

1. **`sequential_image_generation` 对 5.0 pro / flash 是硬错误**：即使传 `"disabled"` 也返回
   `400 ... parameter is not supported by the current model`。只有支持组图的模型（4.0 / 4.5 / lite）才能带这个字段。
2. `max_images` 实际只返回 1 张，要 N 张 = 客户端连发 N 次（见 `src/image.js` 的 `runImageBatch`）。
3. `output_format: "png"` 在 4.0 / 4.5 上直接 400，只有 5.0 系列支持。
4. `seed` 不可复现（同 seed 两次 sha256 不同），不提供该控件。
5. 接口**静默忽略**不认识的参数（塞 `__bogus_param__` 仍 200），所以「没报错」不等于「生效」。

## 5. 尺寸规则

档位是长边，短边按比例折算，8 的倍数取整，夹到单边 ≤4096、总像素 ∈ [1280×720, 4096×4096]。

```
1K + 9:16  → 720×1280   （不是 576×1024，被最小像素抬上来）
2K + 1:1   → 2048×2048
2K + 9:16  → 1152×2048
```

## 6. 开通状态 ≠ 模型存在

控制台显示「已开通」只代表账号有权限，**不代表模型出现在任何本地模型表里**——模型表是我们自己维护的。
新开通的模型要在 `src/models.js` 的 `IMAGE_MODELS` 补一条；临时用可以在网页选「＋ 自定义 Model ID」直接填 ID。

404 的三种可能：ID 写错 / 没开通 / 已下线。错误文案不区分，提示里要把三种都写出来。
