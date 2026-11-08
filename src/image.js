// 图片生成（Seedream 系列）：POST /images/generations，同步返回，没有任务轮询。
// 与视频（ark.js）完全独立：不写任务表、不轮询、不需要公网 URL（参考图走 base64 即可）。
import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, slugify, stamp, toRef } from './ark.js';
import { estimateImageCost, resolveImageModel } from './models.js';

const SIZE_LONG = { '1K': 1024, '1.5K': 1536, '2K': 2048, '3K': 3072, '4K': 4096 };
/** 官方限制：总像素 [1280x720, 4096x4096]，单边不超过 4096。 */
const MIN_PIXELS = 1280 * 720;
const MAX_SIDE = 4096;

const round8 = (n) => Math.max(64, Math.round(n / 8) * 8);

function fail(message, code = 2) {
  const err = new Error(message);
  err.exitCode = code;
  throw err;
}

/** 档位 + 比例 → 具体像素。档位给的是「长边」，短边按比例折算，再夹到官方允许的像素区间。 */
export function computeSize(size = '2K', ratio = '1:1') {
  const raw = String(size).trim();
  if (/^\d+\s*x\s*\d+$/i.test(raw)) return raw.replace(/\s/g, '').toLowerCase();
  const long = SIZE_LONG[raw.toUpperCase()];
  if (!long) fail(`不认识的尺寸档位：${raw}（可用 1K / 1.5K / 2K / 3K / 4K，或直接写 2048x1152）`);

  const m = /^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/.exec(String(ratio ?? '').trim());
  let aw = m ? Number(m[1]) : 1;
  let ah = m ? Number(m[2]) : 1;
  if (!(aw > 0) || !(ah > 0)) {
    aw = 1;
    ah = 1;
  }

  let w = aw >= ah ? long : (long * aw) / ah;
  let h = aw >= ah ? (long * ah) / aw : long;
  w = round8(w);
  h = round8(h);

  for (let guard = 0; guard < 8; guard++) {
    if (w * h < MIN_PIXELS) {
      const k = Math.sqrt(MIN_PIXELS / (w * h));
      w = round8(w * k);
      h = round8(h * k);
      continue;
    }
    if (w > MAX_SIDE || h > MAX_SIDE) {
      const k = Math.min(MAX_SIDE / w, MAX_SIDE / h);
      w = round8(w * k);
      h = round8(h * k);
      continue;
    }
    break;
  }
  if (w * h < MIN_PIXELS || w > MAX_SIDE || h > MAX_SIDE) {
    fail(`${size} 档位配 ${ratio} 比例超出官方像素区间（1280x720 ~ 4096x4096），换个档位或比例`);
  }
  return `${w}x${h}`;
}

/** 校验并归一生图参数。CLI 与网页共用这一套，规则只写一遍。 */
export function normalizeImageOptions(input = {}) {
  const model = resolveImageModel(input.model);
  const prompt = String(input.prompt ?? '').trim();
  const refs = (Array.isArray(input.ref) ? input.ref : input.ref ? [input.ref] : []).map((s) => String(s).trim()).filter(Boolean);
  const count = Number(input.n ?? input.count ?? 1);
  const size = input.size ? String(input.size) : '2K';
  const ratio = input.ratio ? String(input.ratio) : '1:1';
  const format = input.format ? String(input.format).toLowerCase() : undefined;
  const watermark = Boolean(input.watermark);

  if (!prompt && !refs.length) fail('至少要有提示词或一张参考图');
  if (!Number.isInteger(count) || count < 1) fail('张数必须是 ≥1 的整数');
  if (model.maxImages && count > model.maxImages) fail(`${model.label} 单次最多 ${model.maxImages} 张`);
  if (model.group === false && count > 1) {
    fail(`${model.label} 暂不支持组图，请改用 seedream-4.0 / 4.5 / 5.0-lite，或把张数设为 1`);
  }
  if (model.maxRefs && refs.length > model.maxRefs) fail(`参考图最多 ${model.maxRefs} 张`);
  if (model.sizes && size !== 'auto' && !/^\d+\s*x\s*\d+$/i.test(size)) {
    const upper = size.toUpperCase();
    if (!model.sizes.includes(upper)) fail(`${model.label} 支持尺寸 ${model.sizes.join(' / ')}，或直接写宽x高`);
  }
  if (format && model.formats && !model.formats.includes(format)) {
    fail(`${model.label} 只支持输出 ${model.formats.join(' / ')}`);
  }

  return { model, modelId: model.id, prompt, refs, count, size, ratio, format, watermark };
}

/** 组装官方请求体。参考图有就带上（自动走图生图/编辑），没有就纯文生图。 */
export function buildImagePayload(opts) {
  const size = computeSize(opts.size, opts.ratio);
  const payload = {
    model: opts.modelId,
    prompt: opts.prompt || '以参考图主体为基础，生成一张同风格的图片',
    size,
    response_format: 'url',
    watermark: Boolean(opts.watermark),
  };
  if (opts.refs && opts.refs.length) {
    const refs = opts.refs.map((f) => toRef(f, '参考图'));
    payload.image = refs.length === 1 ? refs[0] : refs;
  }
  if (opts.count > 1) {
    payload.sequential_image_generation = 'auto';
    payload.max_images = opts.count;
  } else if (!opts.model || opts.model.group !== false) {
    // 5.0 pro / flash 不支持组图：连 sequential_image_generation="disabled" 都会 400
    // （实测报错：the parameter is not supported by the current model），所以整段省略
    payload.sequential_image_generation = 'disabled';
  }
  if (opts.format) payload.output_format = opts.format;
  return payload;
}

const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/** 同步调用，一次请求拿全部结果。生图通常 10–40s，超时给足。 */
export async function generateImages({ apiKey, payload, timeoutMs = 180000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE_URL}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }
      if (res.ok) return parsed;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const msg = parsed?.error?.message || parsed?.message || JSON.stringify(parsed).slice(0, 300);
      const hint =
        res.status === 404
          ? '（模型已下线或账号未开通：去方舟控制台「开通管理」开通对应模型，或用 --model 传完整 Model ID）'
          : '';
      const err = new Error(`生图失败 HTTP ${res.status} ${msg || ''}${hint}`.trim());
      err.status = res.status;
      err.exitCode = 1;
      throw err;
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      const e = new Error(`生图超时（${Math.round(timeoutMs / 1000)}s 未返回结果）`);
      e.exitCode = 1;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function saveOne(item, dir, base, index) {
  let buf;
  let ext = '.jpg';
  if (item?.url) {
    const res = await fetch(item.url);
    if (!res.ok) fail(`下载生成的图片失败 HTTP ${res.status}`, 1);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (EXT_BY_TYPE[type]) ext = EXT_BY_TYPE[type];
    else if (item.output_format) ext = `.${String(item.output_format).toLowerCase()}`;
    buf = Buffer.from(await res.arrayBuffer());
  } else if (item?.b64_json) {
    buf = Buffer.from(String(item.b64_json), 'base64');
    if (item.output_format) ext = `.${String(item.output_format).toLowerCase()}`;
  } else {
    fail('接口返回里既没有 url 也没有 b64_json', 1);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${base}-${index}${ext}`);
  fs.writeFileSync(file, buf);
  return { file, name: path.basename(file), bytes: buf.length, size: item.size || null, remoteUrl: item.url || null };
}

/** 生成 + 落盘。返回结构化结果，CLI 负责打印、网页负责转 JSON。 */
export async function runImage({ apiKey, opts, outDir, timeoutMs, roundNo, tag }) {
  const started = Date.now();
  const payload = buildImagePayload(opts);
  const res = await generateImages({ apiKey, payload, timeoutMs });
  const list = Array.isArray(res.data) ? res.data : [];
  if (!list.length) fail(`接口没有返回图片：${JSON.stringify(res).slice(0, 300)}`, 1);

  const round = roundNo ? `-r${roundNo}` : '';
  const tagPart = tag ? `-${slugify(tag, 16)}` : '';
  const base = `${slugify(opts.prompt || 'image', 32)}-${stamp()}${tagPart}${round}`;
  const files = [];
  for (let i = 0; i < list.length; i++) {
    files.push(await saveOne(list[i], outDir, base, i + 1));
  }
  return {
    model: opts.model.label,
    modelId: opts.modelId,
    size: payload.size,
    requested: opts.count,
    got: files.length,
    files,
    cost: estimateImageCost(opts.model, files.length),
    elapsedMs: Date.now() - started,
    usage: res.usage || null,
  };
}

/**
 * 连发式多张：平台一次请求只保证 1 张（实测 max_images 不生效），所以「要 N 张」= 发 N 次。
 * 第一次就失败说明是配置问题（模型没开通 / 参数非法），直接抛出，不继续烧钱。
 */
export async function runImageBatch({ apiKey, opts, outDir, timeoutMs, onRound }) {
  const started = Date.now();
  const files = [];
  const errors = [];
  let tokens = 0;

  for (let i = 1; i <= opts.count; i++) {
    try {
      const r = await runImage({ apiKey, opts: { ...opts, count: 1 }, outDir, timeoutMs, roundNo: opts.count > 1 ? i : 0 });
      files.push(...r.files);
      tokens += Number(r.usage?.total_tokens) || 0;
      onRound?.({ round: i, total: opts.count, got: r.files.length, error: null });
    } catch (err) {
      errors.push(`第 ${i} 张失败：${err.message}`);
      onRound?.({ round: i, total: opts.count, got: 0, error: err.message });
      if (i === 1) throw err;
    }
  }

  if (!files.length) fail(`全部 ${opts.count} 次都失败了：${errors.join('；')}`, 1);

  return {
    mode: 'batch',
    model: opts.model.label,
    modelId: opts.modelId,
    size: buildImagePayload({ ...opts, count: 1 }).size,
    requested: opts.count,
    got: files.length,
    files,
    cost: estimateImageCost(opts.model, files.length),
    elapsedMs: Date.now() - started,
    usage: tokens ? { total_tokens: tokens } : null,
    errors,
  };
}

/**
 * 多模型对比：同一提示词并行调多个模型，每个各出 1 张。
 * 用于判断「哪个模型最适合这个主体」，一次花的钱 = 模型数 × 单价。
 */
export async function runImageCompare({ apiKey, opts, modelKeys, outDir, timeoutMs }) {
  const started = Date.now();
  const slots = new Array(modelKeys.length).fill(null);
  let total = 0;

  await Promise.all(
    modelKeys.map(async (key, i) => {
      try {
        const model = resolveImageModel(key);
        const r = await runImage({
          apiKey,
          opts: { ...opts, model, count: 1 },
          outDir,
          timeoutMs,
          tag: key,
        });
        total += r.cost || 0;
        slots[i] = { modelKey: key, model: r.model, files: r.files, cost: r.cost, elapsedMs: r.elapsedMs };
      } catch (e) {
        slots[i] = { modelKey: key, model: key, files: [], cost: 0, error: e.message };
      }
    }),
  );

  const groups = slots.filter(Boolean);
  const failed = groups.filter((g) => !g.files.length);
  if (failed.length === groups.length) {
    fail(`所有模型都失败了：${failed.map((g) => `${g.model} ${g.error}`).join('；')}`, 1);
  }

  return {
    mode: 'compare',
    groups,
    requested: modelKeys.length,
    got: groups.reduce((n, g) => n + g.files.length, 0),
    files: groups.flatMap((g) => g.files),
    cost: Math.round(total * 100) / 100,
    elapsedMs: Date.now() - started,
    errors: failed.map((g) => `${g.model}：${g.error}`),
  };
}
