import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const BASE_URL = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

/** 本地文件 → BASE64 引用；http(s) 与 data: 原样返回。单文件超过上限直接报错（官方请求体总上限 64MB）。 */
export function toRef(input, kind = 'image') {
  const s = String(input).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:/i.test(s)) return s;
  const abs = path.resolve(s);
  if (!fs.existsSync(abs)) {
    const err = new Error(`找不到文件：${abs}`);
    err.exitCode = 2;
    throw err;
  }
  const size = fs.statSync(abs).size;
  const limitMB = 30;
  if (size > limitMB * 1024 * 1024) {
    const err = new Error(`${path.basename(abs)} 有 ${(size / 1048576).toFixed(1)}MB，超过 ${kind} 单文件 ${limitMB}MB 上限`);
    err.exitCode = 2;
    throw err;
  }
  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

function costError(status, body, what) {
  const msg = body?.error?.message || body?.message || (typeof body === 'string' ? body : JSON.stringify(body));
  const code = body?.error?.code || status;
  const err = new Error(`${what} HTTP ${status} ${code ? `[${code}]` : ''} ${msg || ''}`.trim());
  err.exitCode = 1;
  err.status = status;
  return err;
}

async function request(url, { method = 'GET', apiKey, body, retries = 2, label } = {}) {
  const what = label || (method === 'POST' ? '创建任务' : method === 'DELETE' ? '取消/删除任务' : '查询任务');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
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
    if (retryable && attempt < retries) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw costError(res.status, parsed, what);
  }
}

/** 组装 content 数组：文本 + 首帧 + 尾帧 + 参考图 + 参考视频 + 参考音频。 */
export function buildContent({ prompt, firstFrame, lastFrame, refImages = [], refVideos = [], refAudios = [] }) {
  const content = [];
  if (prompt && String(prompt).trim()) content.push({ type: 'text', text: String(prompt).trim() });
  if (firstFrame) content.push({ type: 'image_url', role: 'first_frame', image_url: { url: toRef(firstFrame) } });
  if (lastFrame) content.push({ type: 'image_url', role: 'last_frame', image_url: { url: toRef(lastFrame) } });
  for (const f of refImages) content.push({ type: 'image_url', role: 'reference_image', image_url: { url: toRef(f) } });
  for (const f of refVideos) content.push({ type: 'video_url', role: 'reference_video', video_url: { url: toRef(f, '视频') } });
  for (const f of refAudios) content.push({ type: 'audio_url', role: 'reference_audio', audio_url: { url: toRef(f, '音频') } });
  return content;
}

/** 组装请求体。规则约束（ratio/duration 的强制项）在 CLI 层校验，这里只做组装。 */
export function buildPayload(opts) {
  const payload = {
    model: opts.modelId,
    content: opts.content,
  };
  if (opts.resolution) payload.resolution = opts.resolution;
  if (opts.ratio) payload.ratio = opts.ratio;
  if (opts.duration !== undefined && opts.duration !== null) payload.duration = Number(opts.duration);
  if (opts.generateAudio !== undefined) payload.generate_audio = Boolean(opts.generateAudio);
  if (opts.watermark !== undefined) payload.watermark = Boolean(opts.watermark);
  if (opts.seed !== undefined && opts.seed !== null) payload.seed = Number(opts.seed);
  if (opts.cameraFixed !== undefined) payload.camera_fixed = Boolean(opts.cameraFixed);
  if (opts.outputFormat) payload.output_format = opts.outputFormat;
  if (opts.returnLastFrame) payload.return_last_frame = true;
  if (opts.callbackUrl) payload.callback_url = opts.callbackUrl;
  if (opts.executionExpiresAfter) payload.execution_expires_after = Number(opts.executionExpiresAfter);
  if (opts.priority !== undefined && opts.priority !== null) payload.priority = Number(opts.priority);
  if (opts.safetyIdentifier) payload.safety_identifier = opts.safetyIdentifier;
  if (opts.serviceTier && opts.serviceTier !== 'default') payload.service_tier = opts.serviceTier;
  if (opts.draft) payload.draft = true;
  if (opts.taskType && opts.taskType !== 'auto') payload.omni_reference_task_type = opts.taskType;
  if (opts.extra && typeof opts.extra === 'object') Object.assign(payload, opts.extra);
  return payload;
}

/** 基于样片任务 ID 生成正式视频：content 只放 draft_task，其余参数由平台复用。 */
export function buildDraftContent(draftTaskId) {
  return [{ type: 'draft_task', draft_task: { id: String(draftTaskId).trim() } }];
}

/** 查询任务列表（官方 GET /contents/generations/tasks）。 */
export async function listTasks({ apiKey, status, pageSize = 20, pageNum = 1, taskIds }) {
  const qs = new URLSearchParams();
  if (status) qs.set('filter.status', status);
  qs.set('page_num', String(pageNum));
  qs.set('page_size', String(pageSize));
  if (taskIds && taskIds.length) for (const id of taskIds) qs.append('filter.task_ids', id);
  return request(`${BASE_URL}/contents/generations/tasks?${qs.toString()}`, { apiKey });
}

/** 取消排队中的任务，或删除已结束任务的记录。 */
export async function deleteTask({ apiKey, id }) {
  return request(`${BASE_URL}/contents/generations/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', apiKey });
}

export async function createTask({ apiKey, payload }) {
  return request(`${BASE_URL}/contents/generations/tasks`, { method: 'POST', apiKey, body: payload });
}

export async function queryTask({ apiKey, id }) {
  return request(`${BASE_URL}/contents/generations/tasks/${encodeURIComponent(id)}`, { apiKey });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

/** 轮询到终态。onTick 每秒回调一次当前状态，用于打进度。 */
export async function waitTask({ apiKey, id, timeoutMs = 20 * 60 * 1000, minInterval = 3000, maxInterval = 8000, onTick }) {
  const started = Date.now();
  let interval = minInterval;
  let last = null;
  for (;;) {
    const task = await queryTask({ apiKey, id });
    last = task;
    if (onTick) onTick(task, Date.now() - started);
    if (TERMINAL.has(task.status)) return task;
    if (Date.now() - started > timeoutMs) {
      const err = new Error(`轮询超时（${Math.round(timeoutMs / 1000)}s），任务 ${id} 状态仍是 ${task.status}，可用 ark task ${id} 继续查询`);
      err.exitCode = 1;
      throw err;
    }
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.25), maxInterval);
  }
}

export async function download(url, destDir, filename) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, filename);
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`下载产物失败 HTTP ${res.status}`);
    err.exitCode = 1;
    throw err;
  }
  if (res.body) {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  } else {
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  return dest;
}

/** 把用户提示词压成安全文件名，保留中文。 */
export function slugify(text, max = 40) {
  const base = String(text || 'video')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .trim();
  return (base || 'video').slice(0, max);
}

export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
