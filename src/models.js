// 模型目录：唯一的模型 ID 事实来源。改模型只改这里，不要在别处硬编码 ID。
// 价格单位：元/秒（16:9 基准，各比例像素数接近，可近似通用）。数据源见 docs/seedance-2-5.md。
//
// 元/秒 的推导（官方只给「元/百万 token」+ token 用量公式，除 2.5 外没有现成每秒价）：
//   tokens/s = 宽 × 高 × 帧率 / 1024
//   元/秒   = tokens/s × token单价 / 1e6
// 尺寸与帧率：480p 854×480、720p 1280×720、1080p 1920×1080、4k 3840×2160，均 24fps。
// 已用 2.5 官方价格示例三点校验：480p 0.6725→0.67、720p 1.512→1.51、1080p 3.7422→3.74（全部吻合）。
// 表中数值按「输入不含视频」计，属保守上界；带参考视频时 token 单价更低。

export const MODELS = {
  'seedance-2.5': {
    id: 'doubao-seedance-2-5-260628',
    label: 'Doubao-Seedance-2.5',
    resolutions: ['480p', '720p', '1080p'],
    ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    duration: { min: 4, max: 30, auto: -1 },
    audio: true,
    draft: true,
    pricePerSecond: { '480p': 0.672, '720p': 1.512, '1080p': 3.742 },
  },
  'seedance-2.0': {
    id: 'doubao-seedance-2-0-260128',
    label: 'Doubao-Seedance-2.0',
    resolutions: ['480p', '720p', '1080p', '4k'],
    ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    duration: { min: 4, max: 15, auto: -1 },
    audio: true,
    draft: false,
    pricePerSecond: { '480p': 0.442, '720p': 0.994, '1080p': 2.479, '4k': 5.054 },
  },
  'seedance-2.0-fast': {
    id: 'doubao-seedance-2-0-fast-260128',
    label: 'Doubao-Seedance-2.0-fast',
    // 官方能力表：2.0-fast 只支持 480p / 720p（无 1080p、无 4k）
    resolutions: ['480p', '720p'],
    ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    duration: { min: 4, max: 15, auto: -1 },
    audio: true,
    draft: false,
    pricePerSecond: { '480p': 0.355, '720p': 0.799 },
  },
  'seedance-2.0-mini': {
    id: 'doubao-seedance-2-0-mini-260615',
    label: 'Doubao-Seedance-2.0-mini',
    resolutions: ['480p', '720p'],
    ratios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    duration: { min: 4, max: 15, auto: -1 },
    audio: true,
    draft: false,
    pricePerSecond: { '480p': 0.221, '720p': 0.497 },
  },
};

export const DEFAULT_MODEL = 'seedance-2.5';

/** 接受别名（seedance-2.5 / 2.5 / seedance25 / 完整 model id / 直接用 model id）。 */
export function resolveModel(input) {
  if (!input) return { key: DEFAULT_MODEL, ...MODELS[DEFAULT_MODEL] };
  const raw = String(input).trim().toLowerCase();
  if (MODELS[raw]) return { key: raw, ...MODELS[raw] };
  const squeezed = raw.replace(/[\s._-]/g, '');
  for (const [key, m] of Object.entries(MODELS)) {
    if (key.replace(/[\s._-]/g, '') === squeezed) return { key, ...m };
    if (m.id.toLowerCase() === raw) return { key, ...m };
  }
  if (squeezed === '25') return { key: 'seedance-2.5', ...MODELS['seedance-2.5'] };
  if (squeezed === '20') return { key: 'seedance-2.0', ...MODELS['seedance-2.0'] };
  // 未知 ID 直接透传，交给服务端校验（避免 CLI 成为新模型的瓶颈）
  return { key: 'custom', id: String(input).trim(), label: String(input).trim(), resolutions: null, ratios: null, duration: null, audio: null, draft: null, pricePerSecond: null };
}

/** 估算费用（元）。返回 null 表示没有内置价格。 */
export function estimateCost(model, resolution, seconds) {
  const table = model.pricePerSecond;
  if (!table) return null;
  const rate = table[resolution];
  if (!rate) return null;
  return Math.round(rate * seconds * 100) / 100;
}

/* ---------------- 图片生成模型（Seedream 系列） ----------------
 * 接口与视频完全不同：POST /images/generations，同步返回，没有任务轮询。
 * 价格单位：元/张（输入图不计费）。数据源：官方「模型价格」页 + 模型详情页，采集于 2026-11。
 * sizes 是官方「分辨率」档位；formats 是该模型可输出的图片格式。
 *
 * 5.0 有三条独立产品线，ID 与能力都不同，别混：
 *   flash  doubao-seedream-5-0-flash-260915  1K/1.5K/2K  png/jpeg  不支持组图  0.12 元/张（最快最便宜）
 *   pro    doubao-seedream-5-0-pro-260628    1K/1.5K/2K  png/jpeg  不支持组图  0.30 元/张起
 *   lite   doubao-seedream-5-0-260128        2K/3K/4K    png/jpeg  支持组图    0.22 元/张（官方标注即将下线）
 * 开通状态与模型是否存在是两件事：控制台显示「已开通」但不在本表里，下拉就不会出现——按 ID 补一条即可。
 * 注意：4.0 的旧 ID doubao-seedream-4-0-250828 已下线（实测 404），主线换成 20260415。
 */
export const IMAGE_MODELS = {
  'seedream-4.0': {
    id: 'doubao-seedream-4-0-20260415',
    label: 'Doubao-Seedream-4.0',
    sizes: ['1K', '2K', '4K'],
    formats: ['jpeg'],
    group: true,
    maxImages: 15,
    maxRefs: 14,
    pricePerImage: 0.2,
    verified: true,
  },
  'seedream-4.5': {
    id: 'doubao-seedream-4-5-251128',
    label: 'Doubao-Seedream-4.5',
    sizes: ['2K', '4K'],
    formats: ['jpeg'],
    group: true,
    maxImages: 15,
    maxRefs: 14,
    pricePerImage: 0.25,
  },
  'seedream-5.0-flash': {
    id: 'doubao-seedream-5-0-flash-260915',
    label: 'Doubao-Seedream-5.0 flash',
    sizes: ['1K', '1.5K', '2K'],
    formats: ['png', 'jpeg'],
    // 官方能力表：5.0 pro / flash 暂不支持生成组图；图层拆分是另一回事，不在本工具的组图开关里
    group: false,
    maxImages: 1,
    maxRefs: 14,
    pricePerImage: 0.12,
  },
  'seedream-5.0-lite': {
    id: 'doubao-seedream-5-0-260128',
    label: 'Doubao-Seedream-5.0 lite',
    sizes: ['2K', '3K', '4K'],
    formats: ['png', 'jpeg'],
    group: true,
    maxImages: 15,
    maxRefs: 14,
    pricePerImage: 0.22,
  },
  'seedream-5.0-pro': {
    id: 'doubao-seedream-5-0-pro-260628',
    label: 'Doubao-Seedream-5.0 pro',
    sizes: ['1K', '1.5K', '2K'],
    formats: ['png', 'jpeg'],
    // 官方能力表：5.0 pro 暂不支持生成组图
    group: false,
    maxImages: 1,
    maxRefs: 14,
    // 官方按像素分档：≤261 万 0.30 元，更大 0.60 元。这里取较低的档位，实际以出图尺寸为准
    pricePerImage: 0.3,
  },
};

export const DEFAULT_IMAGE_MODEL = 'seedream-4.0';

/** 接受别名（4.0 / seedream4 / seedream-4-0 / 完整 model id）。 */
export function resolveImageModel(input) {
  if (!input) return { key: DEFAULT_IMAGE_MODEL, ...IMAGE_MODELS[DEFAULT_IMAGE_MODEL] };
  const raw = String(input).trim().toLowerCase();
  if (IMAGE_MODELS[raw]) return { key: raw, ...IMAGE_MODELS[raw] };
  const squeezed = raw.replace(/[\s._-]/g, '');
  for (const [key, m] of Object.entries(IMAGE_MODELS)) {
    if (key.replace(/[\s._-]/g, '') === squeezed) return { key, ...m };
    if (m.id.toLowerCase() === raw) return { key, ...m };
  }
  if (squeezed === '4' || squeezed === '40') return { key: 'seedream-4.0', ...IMAGE_MODELS['seedream-4.0'] };
  if (squeezed === '45') return { key: 'seedream-4.5', ...IMAGE_MODELS['seedream-4.5'] };
  if (squeezed === '50flash' || squeezed === 'flash') return { key: 'seedream-5.0-flash', ...IMAGE_MODELS['seedream-5.0-flash'] };
  if (squeezed === '50lite' || squeezed === 'lite') return { key: 'seedream-5.0-lite', ...IMAGE_MODELS['seedream-5.0-lite'] };
  if (squeezed === '50pro' || squeezed === 'pro') return { key: 'seedream-5.0-pro', ...IMAGE_MODELS['seedream-5.0-pro'] };
  // 未知 ID 透传，交给服务端校验
  return {
    key: 'custom',
    id: String(input).trim(),
    label: String(input).trim(),
    sizes: null,
    formats: null,
    group: null,
    maxImages: 15,
    maxRefs: 14,
    pricePerImage: null,
  };
}

/** 估算生图费用（元）。返回 null 表示没有内置价格。 */
export function estimateImageCost(model, count = 1) {
  const rate = model?.pricePerImage;
  if (!rate) return null;
  return Math.round(rate * count * 100) / 100;
}
