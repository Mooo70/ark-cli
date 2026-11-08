import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, readConfig, resolveApiKey, writeConfig } from './config.js';
import { DEFAULT_IMAGE_MODEL, DEFAULT_MODEL, IMAGE_MODELS, MODELS, estimateCost } from './models.js';
import { normalizeImageOptions, runImageBatch, runImageCompare } from './image.js';
import { probeVideo } from './probe.js';
import { presetList } from './presets.js';
import { BASE_URL, buildContent, buildDraftContent, buildPayload, createTask, deleteTask, download, listTasks, slugify, stamp, waitTask } from './ark.js';
import { normalizeVideoOptions } from './cli.js';
import { BALANCE_THRESHOLD, buildAccountReport, resolveAccessKey } from './account.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');
const MIME_WEB = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** 内存任务表：进程重启即丢，够本地用。 */
const tasks = new Map();
const OUTPUT_DIR = path.resolve(process.env.ARK_OUTPUT_DIR || 'output');
/** 进程启动时刻，随 /api/state 下发，用于页面上自证「你连的是哪个实例」。 */
const STARTED_AT = new Date().toISOString();

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limitBytes = 70 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('请求体超过 70MB，请改用 URL 引用素材'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function modelList() {
  return Object.entries(MODELS).map(([key, m]) => ({
    key,
    label: m.label,
    id: m.id,
    resolutions: m.resolutions,
    ratios: m.ratios,
    duration: m.duration,
    audio: m.audio,
    draft: m.draft,
    pricePerSecond: m.pricePerSecond,
  }));
}

function imageModelList() {
  return Object.entries(IMAGE_MODELS).map(([key, m]) => ({
    key,
    label: m.label,
    id: m.id,
    sizes: m.sizes,
    formats: m.formats,
    group: m.group,
    maxImages: m.maxImages,
    maxRefs: m.maxRefs,
    pricePerImage: m.pricePerImage,
  }));
}

function keyHintOf(key) {
  if (!key) return null;
  const k = String(key);
  return k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : '已配置';
}

async function runTaskInBackground({ id, apiKey, opts, payload }) {
  const entry = tasks.get(id);
  try {
    const task = await waitTask({
      apiKey,
      id,
      timeoutMs: 20 * 60 * 1000,
      onTick: (t) => {
        entry.status = t.status;
        entry.updatedAt = Date.now();
      },
    });
    if (task.status !== 'succeeded') {
      entry.status = task.status;
      entry.error = task.error?.message || task.error?.code || task.status;
      return;
    }
    const url = task.content?.video_url;
    if (!url) throw new Error('任务成功但没有 video_url');
    const filename = `${slugify(opts.prompt || 'video')}-${stamp()}.mp4`;
    const saved = await download(url, OUTPUT_DIR, filename);
    entry.status = 'succeeded';
    entry.file = filename;
    entry.path = saved;
    entry.remoteUrl = url;
    entry.resolution = task.resolution;
    entry.ratio = task.ratio;
    entry.duration = task.duration;
    entry.framespersecond = task.framespersecond;
    entry.tokens = task.usage?.completion_tokens ?? task.usage?.total_tokens ?? null;
    entry.finishedAt = Date.now();
    entry.draft = Boolean(task.draft);
    if (task.content?.last_frame_url) {
      entry.lastFrameUrl = task.content.last_frame_url;
      try {
        entry.lastFrameFile = await download(task.content.last_frame_url, OUTPUT_DIR, filename.replace(/\.mp4$/, '-lastframe.png'));
      } catch {
        // 尾帧下载失败不影响主产物
      }
    }
  } catch (err) {
    entry.status = entry.status === 'succeeded' ? 'failed' : entry.status;
    entry.error = err.message;
    entry.finishedAt = Date.now();
  }
}

async function handleCreate(body) {
  let opts;
  try {
    opts = normalizeVideoOptions({
      model: body.model || DEFAULT_MODEL,
      prompt: body.prompt || '',
      resolution: body.resolution,
      ratio: body.ratio,
      duration: body.duration,
      image: body.firstFrame && body.firstFrame.startsWith('data:') ? body.firstFrame : undefined,
      'last-frame': body.lastFrame && body.lastFrame.startsWith('data:') ? body.lastFrame : undefined,
      ref: Array.isArray(body.refImages) ? body.refImages : [],
      video: Array.isArray(body.refVideos) ? body.refVideos : [],
      audio: Array.isArray(body.refAudios) ? body.refAudios : [],
      'task-type': body.taskType || 'auto',
      'draft-from': body.draftFrom || undefined,
      'camera-fixed': Boolean(body.cameraFixed),
      'return-last-frame': Boolean(body.returnLastFrame),
      'output-format': body.outputFormat || undefined,
      'callback-url': body.callbackUrl || undefined,
      'safety-id': body.safetyIdentifier || undefined,
      'service-tier': body.serviceTier || undefined,
      expires: body.executionExpiresAfter || undefined,
      priority: body.priority === '' || body.priority === undefined ? undefined : body.priority,
    });
  } catch (err) {
    return { code: 400, body: { ok: false, error: err.message } };
  }
  // 非 data: 的本地路径/URL 直接交给 toRef
  if (body.firstFrame && !String(body.firstFrame).startsWith('data:')) opts.firstFrame = body.firstFrame;
  if (body.lastFrame && !String(body.lastFrame).startsWith('data:')) opts.lastFrame = body.lastFrame;
  opts.generateAudio = body.generateAudio !== false;
  opts.watermark = Boolean(body.watermark);
  opts.draft = Boolean(body.draft);

  let apiKey;
  try {
    apiKey = resolveApiKey().key;
  } catch (err) {
    return { code: 400, body: { ok: false, error: err.message } };
  }

  const content = opts.draftFrom ? buildDraftContent(opts.draftFrom) : buildContent(opts);
  if (!content.length) return { code: 400, body: { ok: false, error: 'content 为空：至少要提示词或一张首帧图' } };
  const payload = buildPayload({ ...opts, content });
  const payloadSize = Buffer.byteLength(JSON.stringify(payload));
  if (payloadSize > 62 * 1024 * 1024) {
    return {
      code: 413,
      body: {
        ok: false,
        error: `请求体 ${(payloadSize / 1048576).toFixed(1)}MB，超过官方 64MB 上限。参考图/视频请改用公网 URL，不要走 base64`,
      },
    };
  }

  let created;
  try {
    created = await createTask({ apiKey, payload });
  } catch (err) {
    return { code: 502, body: { ok: false, error: err.message } };
  }
  const id = created.id;
  if (!id) return { code: 502, body: { ok: false, error: '创建任务未返回 ID：' + JSON.stringify(created) } };

  tasks.set(id, {
    id,
    status: 'queued',
    createdAt: Date.now(),
    model: opts.modelId,
    estimate: null,
    draft: Boolean(opts.draft),
    draftFrom: opts.draftFrom || null,
    prompt: opts.prompt || '',
  });
  const cost = opts.duration === -1 ? null : estimateCost(opts.model, opts.resolution, opts.duration);
  const estimate = cost === null ? null : `${opts.resolution} ${opts.duration}s ≈ ${cost} 元`;
  tasks.get(id).estimate = estimate;
  runTaskInBackground({ id, apiKey, opts, payload });

  return { code: 200, body: { ok: true, id, estimate } };
}

/** 生图：同步等待结果（通常 10–40s），不写任务表。 */
async function handleImage(body) {
  let opts;
  try {
    opts = normalizeImageOptions({
      model: body.model || DEFAULT_IMAGE_MODEL,
      prompt: body.prompt || '',
      size: body.size,
      ratio: body.ratio,
      n: body.count ?? body.n ?? 1,
      ref: Array.isArray(body.refImages) ? body.refImages : body.refImages ? [body.refImages] : [],
      watermark: body.watermark,
      format: body.format,
    });
  } catch (err) {
    return { code: 400, body: { ok: false, error: err.message } };
  }

  let apiKey;
  try {
    apiKey = resolveApiKey().key;
  } catch (err) {
    return { code: 400, body: { ok: false, error: err.message } };
  }

  try {
    const result = await runImageBatch({
      apiKey,
      opts,
      outDir: path.join(OUTPUT_DIR, 'images'),
      timeoutMs: Number(body.timeoutMs) || 180000,
    });
    return {
      code: 200,
      body: {
        ok: true,
        ...result,
        files: result.files.map((f) => ({
          ...f,
          localUrl: `/api/file/images/${encodeURIComponent(f.name)}`,
        })),
      },
    };
  } catch (err) {
    return { code: 502, body: { ok: false, error: err.message } };
  }
}

/** 多模型对比：{ prompt, models: ['seedream-4.0', ...], size, ratio, refImages } */
async function handleImageCompare(body) {
  const keys = (Array.isArray(body.models) ? body.models : []).filter(Boolean).slice(0, 4);
  if (keys.length < 2) return { code: 400, body: { ok: false, error: '对比至少需要 2 个模型' } };

  let opts;
  try {
    opts = normalizeImageOptions({
      model: keys[0],
      prompt: body.prompt || '',
      size: body.size,
      ratio: body.ratio,
      n: 1,
      ref: Array.isArray(body.refImages) ? body.refImages : body.refImages ? [body.refImages] : [],
      watermark: body.watermark,
    });
  } catch (err) {
    return { code: 400, body: { ok: false, error: err.message } };
  }

  let apiKey;
  try {
    apiKey = resolveApiKey().key;
  } catch (err) {
    return { code: 400, body: { ok: false, error: err.message } };
  }

  try {
    const result = await runImageCompare({
      apiKey,
      opts,
      modelKeys: keys,
      outDir: path.join(OUTPUT_DIR, 'images'),
      timeoutMs: Number(body.timeoutMs) || 180000,
    });
    const wrap = (f) => ({ ...f, localUrl: `/api/file/images/${encodeURIComponent(f.name)}` });
    return {
      code: 200,
      body: {
        ok: true,
        ...result,
        files: result.files.map(wrap),
        groups: result.groups.map((g) => ({ ...g, files: g.files.map(wrap) })),
      },
    };
  } catch (err) {
    return { code: 502, body: { ok: false, error: err.message } };
  }
}

/** 预检参考视频：调本机 ffprobe 读参数，按官方限制判断能不能提交。 */
async function handleProbe(body) {
  const src = body?.src || body?.url || body?.dataUrl;
  if (!src) return { code: 400, body: { ok: false, error: '缺少 src（http URL 或 dataURL）' } };
  /* 只放行公网 URL 与 dataURL，不通过 HTTP 接口暴露任意本地路径 */
  if (!/^(https?:\/\/|data:)/i.test(String(src).trim())) {
    return { code: 400, body: { ok: false, error: 'src 只接受 http(s) URL 或 dataURL' } };
  }
  try {
    const r = await probeVideo(src, { taskType: body.taskType || 'auto' });
    return { code: 200, body: r };
  } catch (err) {
    return { code: 500, body: { ok: false, error: err.message } };
  }
}

const MIME_OUT = {
  '.mp4': 'video/mp4',  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** 支持子目录（图片落在 output/images/），并做目录穿越防护。 */
function serveFile(req, res, name) {
  const rel = decodeURIComponent(name).replace(/\\/g, '/').replace(/^\/+/, '');
  const file = path.resolve(OUTPUT_DIR, rel);
  const rootWithSep = OUTPUT_DIR.endsWith(path.sep) ? OUTPUT_DIR : OUTPUT_DIR + path.sep;
  if (!file.startsWith(rootWithSep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    sendJson(res, 404, { error: '文件不存在' });
    return;
  }
  const stat = fs.statSync(file);
  const type = MIME_OUT[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

/** 调系统默认浏览器打开 URL。失败不影响服务，只提示手动访问。 */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    console.log(`  请手动在浏览器打开 ${url}`);
  }
}

export function startServer({ port = 5173, host = '127.0.0.1', open = false } = {}) {  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME_WEB['.html'], 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && p === '/api/state') {
        const cfg = readConfig();
        const envKey = process.env.ARK_API_KEY && process.env.ARK_API_KEY.trim();
        const key = envKey || cfg.apiKey;
        sendJson(res, 200, {
          // 页面上要能看出自己连的是哪个进程，否则「端口被占自动 +1」会让人对着旧代码怀疑人生
          pid: process.pid,
          startedAt: STARTED_AT,
          hasKey: Boolean(key),
          keyHint: envKey ? '来自环境变量' : keyHintOf(cfg.apiKey),
          baseUrl: BASE_URL,
          defaultModel: DEFAULT_MODEL,
          models: modelList(),
          defaultImageModel: DEFAULT_IMAGE_MODEL,
          imageModels: imageModelList(),
          configFile: CONFIG_FILE,
        });
        return;
      }

      if (req.method === 'POST' && p === '/api/config') {
        const body = await readBody(req);
        const cfg = readConfig();
        const saved = {};

        const apiKey = String(body.apiKey || '').trim();
        if (apiKey) {
          cfg.apiKey = apiKey;
          saved.apiKey = keyHintOf(apiKey);
        }

        const accessKey = String(body.accessKey || '').trim();
        const secretKey = String(body.secretKey || '').trim();
        if (accessKey) {
          cfg.accessKey = accessKey;
          saved.accessKey = keyHintOf(accessKey);
        }
        if (secretKey) {
          cfg.secretKey = secretKey;
          saved.secretKey = '已保存 ' + secretKey.length + ' 字符';
        }

        if (!Object.keys(saved).length) {
          return sendJson(res, 400, { ok: false, error: '没有可保存的配置项' });
        }
        cfg.updatedAt = new Date().toISOString();
        writeConfig(cfg);
        return sendJson(res, 200, { ok: true, ...saved });
      }

      if (req.method === 'GET' && p === '/api/account') {
        let ak, sk;
        try {
          ({ ak, sk } = resolveAccessKey());
        } catch (err) {
          return sendJson(res, 400, {
            ok: false,
            needsAk: true,
            error: err.message,
            hint: 'ark config set access-key <AK> && ark config set secret-key <SK>',
          });
        }
        try {
          const r = await buildAccountReport({ ak, sk });
          const { raw, ...balance } = r.balance || {};
          return sendJson(res, 200, {
            ok: true,
            balance: r.balance ? balance : null,
            models: r.entries,
            others: r.others,
            available: r.available,
            met: r.met,
            locked: r.locked,
            threshold: BALANCE_THRESHOLD,
            warnings: r.warnings,
            errors: r.errors,
            activationCount: r.activationCount,
          });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && p === '/api/video') {
        const body = await readBody(req);
        const out = await handleCreate(body);
        return sendJson(res, out.code, out.body);
      }

      if (req.method === 'GET' && p === '/api/presets') {
        return sendJson(res, 200, { ok: true, presets: presetList() });
      }

      if (req.method === 'GET' && p === '/api/image-models') {
        return sendJson(res, 200, { ok: true, defaultModel: DEFAULT_IMAGE_MODEL, models: imageModelList() });
      }

      if (req.method === 'POST' && p === '/api/image') {
        const body = await readBody(req);
        const out = await handleImage(body);
        return sendJson(res, out.code, out.body);
      }

      if (req.method === 'POST' && p === '/api/image-compare') {
        const body = await readBody(req);
        const out = await handleImageCompare(body);
        return sendJson(res, out.code, out.body);
      }

      if (req.method === 'POST' && p === '/api/probe') {
        const body = await readBody(req);
        const out = await handleProbe(body);
        return sendJson(res, out.code, out.body);
      }

      if (req.method === 'GET' && p === '/api/tasks') {
        let apiKey;
        try {
          apiKey = resolveApiKey().key;
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
        try {
          const data = await listTasks({
            apiKey,
            status: url.searchParams.get('status') || undefined,
            pageSize: Number(url.searchParams.get('size')) || 20,
          });
          return sendJson(res, 200, { ok: true, items: data.items || [] });
        } catch (err) {
          return sendJson(res, 502, { ok: false, error: err.message });
        }
      }

      if (req.method === 'DELETE' && p.startsWith('/api/task/')) {
        const id = decodeURIComponent(p.slice('/api/task/'.length));
        let apiKey;
        try {
          apiKey = resolveApiKey().key;
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
        try {
          await deleteTask({ apiKey, id });
          const entry = tasks.get(id);
          if (entry && entry.status === 'queued') entry.status = 'cancelled';
          return sendJson(res, 200, { ok: true, id });
        } catch (err) {
          return sendJson(res, 502, { ok: false, error: err.message });
        }
      }

      if (req.method === 'GET' && p.startsWith('/api/task/')) {
        const id = decodeURIComponent(p.slice('/api/task/'.length));
        const entry = tasks.get(id);
        if (!entry) return sendJson(res, 404, { status: 'unknown', error: '没有这个任务（服务重启会清空内存任务表）' });
        return sendJson(res, 200, entry);
      }

      if (req.method === 'GET' && p.startsWith('/api/file/')) {
        return serveFile(req, res, p.slice('/api/file/'.length));
      }

      if (p === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  /** 端口被占时先问一句：占用者是 ark 自己吗？是就直接复用，绝不再起第二个。 */
  const probeArk = (p) =>
    new Promise((resolve) => {
      const req = http.get({ host, port: p, path: '/api/state', timeout: 800 }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(j && j.models && j.imageModels ? j : null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });

  const listenOn = (p) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onOk);
        reject(err);
      };
      const onOk = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onOk);
      server.listen(p, host);
    });

  const banner = (real) => {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const cfg = readConfig();
    const hasKey = Boolean(process.env.ARK_API_KEY || cfg.apiKey);
    console.log('');
    console.log('  ark · 本地控制台已启动');
    console.log(`  地址   http://${host}:${real}`);
    console.log(`  产物   ${OUTPUT_DIR}`);
    console.log(`  图片   ${path.join(OUTPUT_DIR, 'images')}`);
    console.log(`  Key    ${hasKey ? '已配置' : '未配置（页面左下角可直接粘贴保存）'}`);
    console.log(`  进程   pid ${process.pid}（改过 src/ 后要重启的正是它）`);
    console.log('');
    console.log('  按 Ctrl+C 停止');
    console.log('');
  };

  (async () => {
    for (let attempt = 0; attempt <= 10; attempt++) {
      const target = port + attempt;
      try {
        await listenOn(target);
        banner(target);
        if (open) openBrowser(`http://${host}:${target}/`);
        return;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') {
          console.error('[ark ui] 启动失败：' + err.message);
          process.exit(1);
        }
        const live = await probeArk(target);
        if (live && attempt === 0) {
          // 关键：不要静默加端口。用户会以为自己还在原端口，实际连的是旧进程。
          console.log('');
          console.log(`  ${target} 端口已有一个 ark 控制台在运行（pid ${live.pid || '?'}），直接复用它`);
          console.log(`  地址   http://${host}:${target}`);
          console.log(`  模型   ${live.models.length} 个视频 / ${live.imageModels.length} 个生图`);
          console.log('');
          console.log('  注意：那个进程跑的是它启动那一刻的 src/ 代码。如果你刚改过 src/，');
          console.log('        它不会自动生效 —— 先关掉它（或结束上面那个 pid），再重新启动。');
          console.log('');
          if (open) openBrowser(`http://${host}:${target}/`);
          return;
        }
        if (attempt === 10) {
          console.error(`[ark ui] ${port}~${port + 10} 端口都被占用，放弃启动`);
          process.exit(1);
        }
        console.log(`  端口 ${target} 被其他程序占用，改用 ${target + 1}`);
      }
    }
  })();
  return server;
}
