import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, CONFIG_DIR, readConfig, resolveApiKey, writeConfig } from './config.js';
import { MODELS, DEFAULT_MODEL, DEFAULT_IMAGE_MODEL, IMAGE_MODELS, resolveModel, resolveImageModel, estimateCost, estimateImageCost } from './models.js';
import { BASE_URL, buildContent, buildDraftContent, buildPayload, createTask, deleteTask, download, listTasks, queryTask, waitTask, slugify, stamp } from './ark.js';
import { buildImagePayload, computeSize, normalizeImageOptions, runImageBatch, runImageCompare } from './image.js';
import { BALANCE_THRESHOLD, assess, buildAccountReport, nameMatches, resolveAccessKey } from './account.js';
import { canonicalQuery, signedRequest, toXDate } from './sign.js';
import { PRESET_ORDER, resolvePreset } from './presets.js';

const HELP = `ark — 火山方舟生视频 CLI（Seedance 系列）

用法
  ark video "<提示词>" [选项]        创建视频任务 → 轮询 → 下载到 ./output
  ark image "<提示词>" [选项]        生成图片（Seedream，同步返回）→ 下载到 ./output/images
  ark task <任务ID>                  查询/继续等待某个任务
  ark models                         列出内置模型与价格
  ark account                        查余额、开通状态、免费额度（需要 Access Key）
  ark cost [选项]                    只估算费用，不发起请求
  ark ui [--port 5173] [--open]      启动本地网页控制台（--open 自动开浏览器）
  ark tasks [--status succeeded]     查询任务列表（官方接口，含样片与尾帧）
  ark cancel <任务ID>                取消排队中的任务 / 删除已结束记录
  ark config set api-key <KEY>       保存 API Key 到 ${CONFIG_FILE}
  ark config set access-key <AK>     保存 Access Key（查余额/开通状态用）
  ark config set secret-key <SK>     保存 Secret Key
  ark config show                    查看当前配置

video 选项
  -m, --model <名>        ${DEFAULT_MODEL}（默认）| seedance-2.0 | seedance-2.0-fast | seedance-2.0-mini | 完整 model id
  -R, --resolution <档>   480p | 720p（默认）| 1080p
      --ratio <比例>      16:9 | 4:3 | 1:1 | 3:4 | 9:16 | 21:9 | adaptive（默认 adaptive）
  -d, --duration <秒>     4-30，或 -1 让模型自选（默认 -1）
  -i, --image <文件>      首帧图（本地路径或 URL）
      --last-frame <文件> 尾帧图
  -r, --ref <文件>        参考图，可重复（最多 30 张）
      --video <文件>      参考视频 / 待编辑视频，可重复
      --audio <文件>      参考音频，可重复
      --task-type <类型>  auto（默认）| reference | edit | extend
      --preset <预设>     clay（白模参考）| green-gen（绿幕生成）| green-edit（绿幕换实景）
                          套用预设的参数与提示词骨架；你显式写的 flag 优先于预设
      --with-audio        强制开原生音频（预设默认静音，--mute 强制关）
      --mute              不生成原生音频（省钱）
      --watermark         加「AI生成」水印
      --seed <整数>       固定随机种子
      --draft             样片模式（仅 Seedance 2.5，480p 低成本试片）
      --draft-from <ID>   用样片任务 ID 出正式片（其余参数由平台复用）

image 选项
  -m, --model <名>        ${DEFAULT_IMAGE_MODEL}（默认）| seedream-4.5 | seedream-5.0-lite | seedream-5.0-pro | 完整 model id
      --size <档>         1K | 2K（默认）| 4K 等，按模型能力；也可直接写 2048x1152
      --ratio <比例>      1:1（默认）| 3:4 | 4:3 | 9:16 | 16:9 …（只用来折算短边像素）
  -n, --n <张数>          1-15；>1 时按张连发（平台一次只保证 1 张），按实际张数计费
      --compare <列表>    多模型对比，逗号分隔，如 --compare seedream-4.0,seedream-4.5
  -r, --ref <文件>        参考图，可重复（≤14 张）；给了参考图自动走图生图/编辑
      --format <格式>     jpeg（4.0 / 4.5 只支持这个）| png（5.0-lite / 5.0-pro）
      --watermark         加「AI生成」水印
  -o, --out <目录>        落盘目录（默认 ./output/images）

高级选项
      --seed <整数>               固定随机种子，同参数可复现
      --camera-fixed              锁定虚拟相机（固定机位）
      --output-format <格式>      mp4（默认）| mov（H.264+yuv444p，编辑/延长推荐）
      --return-last-frame         同时返回尾帧图（接续下一段用）
      --callback-url <URL>        Webhook 回调地址，替代轮询
      --expires <秒>              任务超时阈值 3600-259200（默认 48 小时）
      --priority <0-9>            调度优先级，越大越优先
      --safety-id <字符串>        终端用户标识（风控/审计用）
      --service-tier <等级>       default | flex（2.5 暂不支持 flex）
  -o, --out <目录>        产物目录（默认 ./output）
      --timeout <秒>      轮询上限（默认 1200）
      --body '<JSON>'     透传/覆盖请求体字段
      --json              机器可读输出
      --dry-run           只打印将要发送的请求体，不真正创建任务

account
  ark account                        余额 + 200 元门槛 + 各模型开通状态/免费额度
  ark account --json                 同一份数据的 JSON（网页控制台也走这个）
  需要 Access Key：ark config set access-key <AK> / secret-key <SK>
  （方舟 API Key 只能调模型，查余额和开通状态必须用 AK/SK）

示例
  ark config set api-key sk-xxxx
  ark video "夜晚的东京街头，霓虹倒影，镜头缓慢推进" -R 480p -d 5 --mute
  ark video "让画面里的女孩微笑着回头" -i ./girl.png --task-type reference
  ark video "把背景音乐去掉" --video ./clip.mp4 --task-type edit
  ark video --preset clay --video ./白模.mp4 -R 720p        # 白模预演 → 实拍质感
  ark video "五只奶蛙端着蛋糕直立行走" --preset green-gen    # 出可抠像绿幕素材
  ark video --preset green-edit --video ./green.mp4         # 绿幕素材补全环境
  ark cost -R 480p -d 8
  ark image "一只圆头奶蛙站在木地板上，暖光，产品摄影" --size 2K --ratio 1:1
  ark image "把背景换成纯白" --ref ./奶蛙.png
  ark image "奶蛙端着蛋糕，四种配色" -n 4 --size 2K
  ark image "奶蛙" --compare seedream-4.0,seedream-4.5 --size 1K
`;

/* ---------------- 参数解析 ---------------- */

const VALUE_FLAGS = new Set([
  'model', 'm', 'resolution', 'R', 'ratio', 'duration', 'd', 'image', 'i', 'last-frame',
  'ref', 'r', 'video', 'audio', 'task-type', 'seed', 'out', 'o', 'timeout', 'body',
  'port', 'host', 'output-format', 'callback-url', 'expires', 'priority', 'safety-id',
  'service-tier', 'draft-from', 'status', 'page-size', 'size', 'n', 'format', 'compare',
  'preset', 'with-audio',
]);
const MULTI_FLAGS = new Set(['ref', 'r', 'video', 'audio']);
const BOOL_FLAGS = new Set([
  'mute', 'watermark', 'draft', 'json', 'dry-run', 'help', 'h', 'selftest', 'yes', 'open',
  'camera-fixed', 'return-last-frame', 'with-audio',
]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    let name = token.replace(/^--?/, '');
    let inline = null;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (BOOL_FLAGS.has(name)) {
      flags[name] = inline === null ? true : inline !== 'false';
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      fail(`未知参数 --${name}，用 ark --help 查看可用参数`);
    }
    const value = inline !== null ? inline : argv[++i];
    if (value === undefined) fail(`参数 --${name} 缺少值`);
    if (MULTI_FLAGS.has(name)) {
      flags[name] = flags[name] || [];
      flags[name].push(value);
    } else {
      flags[name] = value;
    }
  }
  return { flags, positional };
}

function fail(message, code = 2) {
  const err = new Error(message);
  err.exitCode = code;
  throw err;
}

const pick = (flags, ...names) => {
  for (const n of names) if (flags[n] !== undefined) return flags[n];
  return undefined;
};

/* ---------------- 任务参数校验 ---------------- */

export function normalizeVideoOptions(flags) {
  /* 预设只负责填空：用户显式写出的 flag 永远优先于预设 */
  const presetInput = pick(flags, 'preset');
  const preset = presetInput ? resolvePreset(presetInput) : null;
  if (presetInput && !preset) {
    fail(`未知预设「${presetInput}」；可选：${PRESET_ORDER.join(' / ')}`);
  }
  const profile = (preset && preset.preset) || {};

  const model = resolveModel(pick(flags, 'model', 'm'));
  const prompt = (pick(flags, 'prompt') || '').toString() || (preset ? preset.text : '');
  const resolution = pick(flags, 'resolution', 'R') || (model.resolutions ? '720p' : undefined);
  const ratio = pick(flags, 'ratio') || profile.ratio || 'adaptive';
  const rawDuration = pick(flags, 'duration', 'd');
  const duration =
    rawDuration === undefined
      ? (profile.duration !== undefined ? profile.duration : model.duration ? model.duration.auto : -1)
      : Number(rawDuration);
  const firstFrame = pick(flags, 'image', 'i');
  const lastFrame = pick(flags, 'last-frame');
  const refImages = pick(flags, 'ref', 'r') || [];
  const refVideos = pick(flags, 'video') || [];
  const refAudios = pick(flags, 'audio') || [];
  const taskType = pick(flags, 'task-type') || profile.taskType || 'auto';
  const seed = pick(flags, 'seed');
  const draftFrom = pick(flags, 'draft-from');
  const cameraFixed = flags['camera-fixed'] ? true : undefined;
  const returnLastFrame = flags['return-last-frame'] ? true : undefined;
  const outputFormat = pick(flags, 'output-format') || profile.outputFormat;
  const callbackUrl = pick(flags, 'callback-url');
  const safetyIdentifier = pick(flags, 'safety-id');
  const serviceTier = pick(flags, 'service-tier');

  if (outputFormat && !['mp4', 'mov'].includes(outputFormat)) fail('--output-format 只支持 mp4 / mov');
  if (callbackUrl && !/^https?:\/\//i.test(callbackUrl)) fail('--callback-url 必须是 http(s) 地址');
  if (serviceTier && !['default', 'flex'].includes(serviceTier)) fail('--service-tier 只支持 default / flex（2.5 暂不支持 flex）');

  let executionExpiresAfter;
  const rawExpires = pick(flags, 'expires');
  if (rawExpires !== undefined) {
    const n = Number(rawExpires);
    if (!Number.isFinite(n) || n < 3600 || n > 259200) fail('--expires 取值 3600-259200 秒（默认 172800 = 48 小时）');
    executionExpiresAfter = n;
  }
  let priority;
  const rawPriority = pick(flags, 'priority');
  if (rawPriority !== undefined) {
    const n = Number(rawPriority);
    if (!Number.isInteger(n) || n < 0 || n > 9) fail('--priority 取值 0-9 的整数，越大越优先');
    priority = n;
  }

  // 用样片任务 ID 出正式片：只传 model + draft_task，其余参数由平台复用
  if (draftFrom) {
    return {
      model,
      modelId: model.id,
      prompt: '',
      draftFrom: String(draftFrom).trim(),
      resolution: undefined,
      ratio: undefined,
      duration: undefined,
      firstFrame: undefined,
      lastFrame: undefined,
      refImages: [],
      refVideos: [],
      refAudios: [],
      taskType: 'auto',
      seed: undefined,
      generateAudio: undefined,
      watermark: undefined,
      draft: false,
      cameraFixed: undefined,
      returnLastFrame,
      outputFormat: undefined,
      callbackUrl,
      executionExpiresAfter,
      priority,
      safetyIdentifier,
      serviceTier,
      extra: null,
    };
  }

  if (model.resolutions && !model.resolutions.includes(resolution)) {
    fail(`模型 ${model.label} 支持的分辨率：${model.resolutions.join(' / ')}，收到 ${resolution}`);
  }
  if (Number.isNaN(duration)) fail(`--duration 必须是数字，收到 ${rawDuration}`);
  if (duration !== -1) {
    const min = model.duration ? model.duration.min : 4;
    const max = model.duration ? model.duration.max : 30;
    if (duration < min || duration > max) fail(`--duration 取值 ${min}-${max} 或 -1，收到 ${duration}`);
  }
  if (lastFrame && !firstFrame) fail('给了 --last-frame 就必须同时给 --image（首帧）');
  if (taskType === 'edit') {
    if (ratio !== 'adaptive') fail('视频编辑任务要求 --ratio 必须为 adaptive');
    if (duration !== -1) fail('视频编辑任务要求 --duration 必须为 -1（自动跟随原片时长）');
    if (refVideos.length === 0) fail('视频编辑任务需要至少一个 --video');
  }
  if (taskType === 'extend' && refVideos.length === 0) fail('视频延长任务需要至少一个 --video');
  if (taskType === 'edit' || taskType === 'extend') {
    if (ratio !== 'adaptive') fail(`${taskType} 任务要求 --ratio 必须为 adaptive`);
  }
  if (firstFrame && ratio !== 'adaptive') {
    fail('首帧/首尾帧任务要求 --ratio 必须为 adaptive（输出比例自动跟随首帧图片）');
  }
  if (!prompt.trim() && !firstFrame && refImages.length === 0 && refVideos.length === 0 && refAudios.length === 0) {
    fail('至少要给一句提示词，或一张首帧/参考图，或一段参考视频');
  }

  let extra = null;
  const bodyFlag = pick(flags, 'body');
  if (bodyFlag) {
    try {
      extra = JSON.parse(bodyFlag);
    } catch {
      fail('--body 不是合法 JSON');
    }
  }

  return {
    model,
    modelId: model.id,
    prompt,
    resolution,
    ratio,
    duration,
    firstFrame,
    lastFrame,
    refImages,
    refVideos,
    refAudios,
    taskType,
    seed,
    generateAudio: flags.mute ? false : flags['with-audio'] ? true : profile.genAudio !== undefined ? profile.genAudio : true,
    presetKey: preset ? preset.key : undefined,
    presetName: preset ? preset.name : undefined,
    presetHint: preset ? preset.hint : undefined,
    watermark: Boolean(flags.watermark),
    draft: Boolean(flags.draft),
    cameraFixed,
    returnLastFrame,
    outputFormat,
    callbackUrl,
    executionExpiresAfter,
    priority,
    safetyIdentifier,
    serviceTier,
    draftFrom: undefined,
    extra,
  };
}

/* ---------------- 命令 ---------------- */

/* ---------------- 账户 ---------------- */

const fmtNum = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : String(n));

async function cmdAccount(flags) {
  const { ak, sk, source } = resolveAccessKey();
  const report = await buildAccountReport({ ak, sk });
  const json = Boolean(flags.json);

  if (json) {
    const { balance, entries, others, ...rest } = report;
    console.log(
      JSON.stringify(
        {
          ok: true,
          source,
          balance: balance ? { ...balance, raw: undefined } : null,
          models: entries,
          others,
          ...rest,
        },
        null,
        2,
      ),
    );
    return;
  }

  const b = report.balance;
  console.log(`凭证      ${source}`);
  if (b) {
    console.log(`账户      ${b.accountId ?? '—'} · ${b.currency}`);
    console.log(`可用余额  ¥ ${b.available.toFixed(2)}`);
    console.log(`明细      现金 ${b.cash.toFixed(2)} · 冻结 ${b.freeze.toFixed(2)} · 欠费 ${b.arrears.toFixed(2)} · 信控 ${b.credit.toFixed(2)}`);
  } else {
    console.log('可用余额  查询失败');
  }

  if (report.met === true) {
    console.log(`开通门槛  ✅ 可用余额 ≥ ${BALANCE_THRESHOLD} 元（余量 ¥${(report.available - BALANCE_THRESHOLD).toFixed(2)}）`);
    if (report.locked) console.log(`锁定      其中 ¥${report.locked.toFixed(2)} 在模型开通期间不可提现`);
  } else if (report.met === false) {
    console.log(`开通门槛  ❌ 还差 ¥${(BALANCE_THRESHOLD - report.available).toFixed(2)}，现在无法开通 Seedance 视频模型`);
  }

  if (report.available !== null) {
    const per = MODELS['seedance-2.5'].pricePerSecond['480p'];
    const secs = Math.floor(report.available / per);
    console.log(`出片能力  ≈ ${secs} 秒 480p 成片（约 ${Math.floor(secs / 8)} 条 8 秒片）`);
  }

  console.log('\n模型开通');
  for (const e of report.entries) {
    const icon = e.state === 'Available' ? '✅' : e.state === 'Unavailable' ? '⬜' : '❔';
    const state = e.state === 'Available' ? '已开通' : e.state === 'Unavailable' ? '未开通' : '未查到';
    const quota = e.freeTotal ? `${fmtNum(e.freeConsumed)}/${fmtNum(e.freeTotal)}` : '—';
    console.log(`  ${icon} ${e.label.padEnd(26)} ${state}   免费额度 ${quota}`);
  }
  if (!report.entries.some((e) => e.found)) {
    console.log('  （开通列表里没匹配到 Seedance，可能是账号无权查看或模型尚未上线）');
  }

  if (report.others.length) {
    console.log(`\n其他已开通模型（${report.others.length} 个，免费额度用完后直接扣余额）`);
    for (const o of report.others.slice(0, 8)) {
      const quota = o.freeTotal ? `${fmtNum(o.freeConsumed)}/${fmtNum(o.freeTotal)}` : '无额度';
      console.log(`  · ${String(o.label).padEnd(30)} 免费额度 ${quota}${o.overdue ? '  ⚠ 欠费' : ''}`);
    }
    if (report.others.length > 8) console.log(`  …还有 ${report.others.length - 8} 个，用 ark account --json 看全量`);
  }

  const notes = [...report.errors, ...report.warnings];
  if (notes.length) {
    console.log('');
    for (const n of notes) console.log(`⚠ ${n}`);
  }
  console.log('\n规则      200 元是「可用余额门槛」，不是费用；开通期间这部分锁定不可提现');
}

async function cmdConfig(flags, positional) {
  const [, action, key, value] = positional;
  if (!action || action === 'show') {
    const cfg = readConfig();
    const masked = cfg.apiKey ? cfg.apiKey.slice(0, 6) + '…' + cfg.apiKey.slice(-4) : null;
    const maskAk = cfg.accessKey ? String(cfg.accessKey).slice(0, 8) + '…' : null;
    console.log(`配置文件  ${CONFIG_FILE}`);
    console.log(`apiKey    ${masked || '（未设置）'}`);
    console.log(`accessKey ${maskAk || '（未设置，ark account 需要）'}`);
    console.log(`secretKey ${cfg.secretKey ? '已设置' : '（未设置）'}`);
    if (process.env.ARK_API_KEY) console.log('环境变量  ARK_API_KEY 已设置（优先生效）');
    if (process.env.VOLC_ACCESS_KEY) console.log('环境变量  VOLC_ACCESS_KEY 已设置（优先于配置文件）');
    console.log(`baseUrl   ${BASE_URL}`);
    return;
  }
  if (action === 'set') {
    if (key === 'api-key' || key === 'apikey') {
      if (!value) fail('用法：ark config set api-key <KEY>');
      const cfg = readConfig();
      cfg.apiKey = value.trim();
      cfg.updatedAt = new Date().toISOString();
      const file = writeConfig(cfg);
      console.log(`已写入  ${file}`);
      console.log(`Key     ${value.trim().slice(0, 6)}…${value.trim().slice(-4)}`);
      return;
    }
    if (['access-key', 'ak', 'secret-key', 'sk'].includes(key)) {
      if (!value) fail(`用法：ark config set ${key} <值>`);
      const cfg = readConfig();
      if (key === 'access-key' || key === 'ak') cfg.accessKey = value.trim();
      else cfg.secretKey = value.trim();
      cfg.updatedAt = new Date().toISOString();
      const file = writeConfig(cfg);
      console.log(`已写入  ${file}`);
      console.log(`字段    ${key === 'ak' ? 'access-key' : key === 'sk' ? 'secret-key' : key}`);
      if (cfg.accessKey && cfg.secretKey) console.log('下一步  ark account');
      return;
    }
    fail('支持的配置项：api-key | access-key | secret-key');
  }
  fail(`未知配置命令：${action}`);
}

function printEstimate(opts) {
  const seconds = opts.duration === -1 ? null : opts.duration;
  const cost = seconds ? estimateCost(opts.model, opts.resolution, seconds) : null;
  if (cost === null) {
    console.log(`预估费用  ${opts.model.pricePerSecond ? '该分辨率无内置单价' : '该模型未内置单价，以官网计费为准'}`);
    return;
  }
  console.log(`预估费用  ≈ ${cost} 元（${opts.resolution} × ${seconds}s，仅供参考，按 token 实际结算）`);
  if (opts.generateAudio) console.log('提示      已开启原生音频生成；加 --mute 更省');
}

async function runVideo(opts, flags) {
  const content = opts.draftFrom ? buildDraftContent(opts.draftFrom) : buildContent(opts);
  const payload = buildPayload({ ...opts, content });
  const json = Boolean(flags.json);

  if (flags['dry-run']) {
    console.log(JSON.stringify({ url: `${BASE_URL}/contents/generations/tasks`, body: payload }, null, 2));
    return;
  }

  const { key: apiKey, source } = resolveApiKey();
  if (!json) {
    if (opts.draftFrom) {
      console.log(`模式      样片转正式片（复用样片 ${opts.draftFrom} 的场景结构，分辨率/时长等由平台复用）`);
      console.log(`模型      ${opts.model.label}（${opts.modelId}）`);
    } else {
      console.log(`模型      ${opts.model.label}（${opts.modelId}）`);
      if (opts.presetName) {
        console.log(`预设      ${opts.presetName}`);
        if (opts.presetHint) console.log(`          ${opts.presetHint}`);
      }
      console.log(`参数      ${opts.resolution} · ${opts.ratio} · ${opts.duration === -1 ? '时长自动' : opts.duration + 's'} · 音频${opts.generateAudio ? '开' : '关'}${opts.draft ? ' · 样片模式' : ''}${opts.outputFormat ? ` · 输出 ${opts.outputFormat}` : ''}`);
      console.log(`素材      ${content.filter((c) => c.type !== 'text').length} 个`);
      const adv = [];
      if (opts.seed !== undefined) adv.push(`seed=${opts.seed}`);
      if (opts.cameraFixed) adv.push('锁机位');
      if (opts.outputFormat) adv.push(opts.outputFormat);
      if (opts.returnLastFrame) adv.push('返回尾帧');
      if (opts.priority !== undefined) adv.push(`priority=${opts.priority}`);
      if (opts.executionExpiresAfter) adv.push(`超时${Math.round(opts.executionExpiresAfter / 3600)}h`);
      if (opts.callbackUrl) adv.push('Webhook');
      if (adv.length) console.log(`高级      ${adv.join(' · ')}`);
      printEstimate(opts);
    }
    console.log(`Key       ${source}`);
  }

  const created = await createTask({ apiKey, payload });
  const id = created.id;
  if (!id) fail(`创建任务未返回任务 ID：${JSON.stringify(created)}`);
  if (json) process.stderr.write(`task ${id}\n`);
  else console.log(`任务      ${id}  已提交，开始轮询…`);

  const task = await waitTask({
    apiKey,
    id,
    timeoutMs: (Number(pick(flags, 'timeout')) || 1200) * 1000,
    onTick: (t, elapsed) => {
      if (json) return;
      const sec = Math.round(elapsed / 1000);
      process.stdout.write(`\r状态      ${t.status}  ${sec}s   `);
    },
  });
  if (!json) process.stdout.write('\n');

  if (task.status !== 'succeeded') {
    const reason = task.error?.message || task.error?.code || task.status;
    fail(`任务未成功：${reason}\n任务 ID ${id}，可用 ark task ${id} 复查`);
  }

  const url = task.content?.video_url;
  if (!url) fail(`任务成功但没有 video_url：${JSON.stringify(task)}`);

  const outDir = path.resolve(pick(flags, 'out', 'o') || 'output');
  const filename = `${slugify(opts.prompt || 'video')}-${stamp()}.mp4`;
  const saved = await download(url, outDir, filename);

  const tokens = task.usage?.completion_tokens ?? task.usage?.total_tokens;
  if (json) {
    console.log(JSON.stringify({ id, status: task.status, file: saved, url, usage: task.usage || null, resolution: task.resolution, ratio: task.ratio, duration: task.duration }, null, 2));
    return;
  }
  console.log(`完成      ${saved}`);
  console.log(`规格      ${task.resolution || opts.resolution} · ${task.ratio || opts.ratio} · ${task.duration || opts.duration}s · ${task.framespersecond || '?'}fps`);
  if (task.content?.last_frame_url) {
    const lfName = filename.replace(/\.mp4$/, '-lastframe.png');
    const lf = await download(task.content.last_frame_url, outDir, lfName);
    console.log(`尾帧      ${lf}`);
  }
  if (task.draft) console.log(`样片      这是 480p 样片，满意后出正式片：ark video --draft-from ${id}`);
  if (tokens) {
    const cost = estimateCost(opts.model, task.resolution || opts.resolution, task.duration || opts.duration);
    console.log(`用量      ${tokens} tokens${cost ? `（≈ ${cost} 元）` : ''}`);
  }
  console.log(`提醒      产物 URL 24 小时有效、下载上限 100 次，已落盘可直接用`);
}

async function cmdImage(flags, positional) {
  const prompt = positional.slice(1).join(' ').trim();
  const opts = normalizeImageOptions({
    model: pick(flags, 'model', 'm'),
    prompt,
    size: pick(flags, 'size'),
    ratio: pick(flags, 'ratio'),
    n: pick(flags, 'n'),
    ref: flags.ref || flags.r || [],
    watermark: Boolean(flags.watermark),
    format: pick(flags, 'format'),
  });
  const payload = buildImagePayload({ ...opts, count: 1 });
  const json = Boolean(flags.json);

  if (flags['dry-run']) {
    console.log(JSON.stringify({ url: `${BASE_URL}/images/generations`, body: payload }, null, 2));
    return;
  }

  const { key: apiKey, source } = resolveApiKey();
  const compareKeys = flags.compare
    ? String(flags.compare)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (!json) {
    if (compareKeys.length) {
      const est = compareKeys.reduce((s, k) => s + (IMAGE_MODELS[k]?.pricePerImage || 0), 0);
      console.log(`对比      ${compareKeys.join(' / ')}`);
      console.log(`规格      ${payload.size} · ${opts.ratio} · 每个模型 1 张`);
      console.log(`预估费用  ≈ ${Math.round(est * 100) / 100} 元（${compareKeys.length} 个模型）`);
    } else {
      console.log(`模型      ${opts.model.label}（${opts.modelId}）`);
      console.log(
        `规格      ${payload.size} · ${opts.ratio} · 连发 ${opts.count} 次` +
          `${opts.refs.length ? ` · 参考图 ${opts.refs.length} 张` : ''}${opts.watermark ? ' · 水印' : ''}`,
      );
      const cost = estimateImageCost(opts.model, opts.count);
      console.log(
        `预估费用  ${cost === null ? '该模型未内置单价，以官网计费为准' : `≈ ${cost} 元（${opts.model.pricePerImage} × ${opts.count} 张，仅供参考）`}`,
      );
    }
    console.log(`Key       ${source}`);
  }

  const outDir = path.resolve(pick(flags, 'out', 'o') || path.join('output', 'images'));

  if (compareKeys.length) {
    if (compareKeys.length < 2) fail('--compare 至少要 2 个模型，用逗号分隔，例如 --compare 4.0,4.5');
    const r = await runImageCompare({
      apiKey,
      opts,
      modelKeys: compareKeys,
      outDir,
      timeoutMs: (Number(pick(flags, 'timeout')) || 180) * 1000,
    });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    for (const g of r.groups) {
      const file = g.files[0];
      console.log(`${String(g.model).padEnd(24)} ${file ? `${file.file}  ${(file.bytes / 1024).toFixed(0)}KB` : `失败：${g.error}`}`);
    }
    console.log(`完成      ${r.got} 张，用时 ${(r.elapsedMs / 1000).toFixed(1)}s，费用 ≈ ${r.cost} 元`);
    return;
  }

  const started = Date.now();
  const ticker = json
    ? null
    : setInterval(() => {
        process.stdout.write(`\r状态      生成中  ${Math.round((Date.now() - started) / 1000)}s   `);
      }, 1000);
  let result;
  try {
    result = await runImageBatch({
      apiKey,
      opts,
      outDir,
      timeoutMs: (Number(pick(flags, 'timeout')) || 180) * 1000,
      onRound: ({ round, total, error }) => {
        if (json || total < 2) return;
        if (error) console.log(`\r第 ${round}/${total} 张失败：${String(error).slice(0, 60)}`);
      },
    });
  } finally {
    if (ticker) {
      clearInterval(ticker);
      process.stdout.write('\r' + ' '.repeat(44) + '\r');
    }
  }

  if (json) {
    console.log(JSON.stringify({ ...result, payload }, null, 2));
    return;
  }
  console.log(`完成      ${result.got} 张，用时 ${(result.elapsedMs / 1000).toFixed(1)}s`);
  for (const f of result.files) {
    console.log(`          ${f.file}  ${(f.bytes / 1024).toFixed(0)}KB${f.size ? `  ${f.size}` : ''}`);
  }
  (result.errors || []).forEach((e) => console.log(`失败      ${e}`));
  if (result.cost !== null && result.cost !== undefined) {
    console.log(`费用      ≈ ${result.cost} 元（按实际 ${result.got} 张计）`);
  }
  console.log('提醒      远端 URL 24 小时有效，本地文件已落盘可直接用');
}

async function runTask(flags, positional) {
  const id = positional[1];
  if (!id) fail('用法：ark task <任务ID>');
  const { key: apiKey } = resolveApiKey();
  const json = Boolean(flags.json);
  let first = true;
  const task = await waitTask({
    apiKey,
    id,
    timeoutMs: (Number(pick(flags, 'timeout')) || 300) * 1000,
    onTick: (t, elapsed) => {
      if (json) return;
      if (first || elapsed % 3000 < 1000) {
        process.stdout.write(`\r状态      ${t.status}  ${Math.round(elapsed / 1000)}s   `);
        first = false;
      }
    },
  }).catch(async (err) => {
    // 超时不代表失败：把当前状态打出来
    const now = await queryTask({ apiKey, id });
    if (json) console.log(JSON.stringify(now, null, 2));
    else {
      process.stdout.write('\n');
      console.log(`状态      ${now.status}（仍在跑，稍后再查）`);
      if (now.content?.video_url) console.log(`地址      ${now.content.video_url}`);
    }
    throw err;
  });
  if (json) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  process.stdout.write('\n');
  console.log(`状态      ${task.status}`);
  if (task.content?.video_url) {
    console.log(`地址      ${task.content.video_url}`);
    console.log(`提示      ark video 加 --out 可直接下载；这里不自动落盘避免覆盖`);
  }
  if (task.error) console.log(`错误      ${task.error.message || JSON.stringify(task.error)}`);
  if (task.usage?.completion_tokens) console.log(`用量      ${task.usage.completion_tokens} tokens`);
}

async function cmdTasks(flags) {
  const { key: apiKey } = resolveApiKey();
  const status = pick(flags, 'status');
  const pageSize = Number(pick(flags, 'page-size')) || 20;
  const data = await listTasks({ apiKey, status, pageSize });
  const items = data.items || [];
  const json = Boolean(flags.json);
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (!items.length) {
    console.log('没有任务记录');
    return;
  }
  const map = { queued: '排队', running: '生成中', succeeded: '成功', failed: '失败', cancelled: '已取消', expired: '超时' };
  console.log('状态    分辨率  时长  创建时间          任务 ID');
  for (const t of items) {
    const when = t.created_at ? new Date(t.created_at * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
    console.log(
      `${(map[t.status] || t.status).padEnd(7)}${String(t.resolution || '—').padEnd(9)}` +
        `${String(t.duration ?? '—').padEnd(6)}${when.padEnd(18)}${t.id}${t.draft ? '  [样片]' : ''}`,
    );
    if (t.error?.message) console.log(`         └ ${t.error.code || ''} ${t.error.message}`);
  }
  console.log(`\n共 ${items.length} 条${status ? `（status=${status}）` : ''}；详情 ark task <id>`);
}

async function cmdCancel(flags, positional) {
  const id = positional[1];
  if (!id) fail('用法：ark cancel <任务ID>');
  const { key: apiKey } = resolveApiKey();
  await deleteTask({ apiKey, id });
  console.log(`已处理  ${id}`);
  console.log('说明    排队中的任务会变成 cancelled；已结束的任务是删除记录，之后无法再查询');
}

function cmdModels() {
  console.log('模型别名             Model ID                        分辨率                时长        内置单价（元/秒）');
  for (const [key, m] of Object.entries(MODELS)) {
    const price = m.pricePerSecond
      ? Object.entries(m.pricePerSecond).map(([r, v]) => `${r}:${v}`).join(' ')
      : '—';
    console.log(
      `${key.padEnd(20)}${m.id.padEnd(33)}${(m.resolutions || []).join('/').padEnd(23)}` +
        `${`${m.duration.min}-${m.duration.max}`.padEnd(12)}${price}`,
    );
  }
  console.log('\n图片模型（ark image，单价按输出张数计，输入图不计费）');
  console.log('别名                 Model ID                        尺寸              格式        元/张         组图');
  for (const [key, m] of Object.entries(IMAGE_MODELS)) {
    console.log(
      `${key.padEnd(21)}${m.id.padEnd(33)}${(m.sizes || []).join('/').padEnd(18)}` +
        `${(m.formats || []).join('/').padEnd(12)}${String(m.pricePerImage ?? '—').padEnd(14)}${m.group ? '支持' : '不支持'}`,
    );
  }
  console.log(`\n默认模型 ${DEFAULT_MODEL}（视频）/ ${DEFAULT_IMAGE_MODEL}（图片）；换模型用 -m，也可直接传完整 Model ID`);
  console.log('单价来源：官方 token 单价 × token 用量公式折算（2.5 三档已与官方示例三点校验），仅供参考，实际按 token 结算');
}

function cmdCost(flags) {
  const opts = normalizeVideoOptions({ ...flags, prompt: flags.prompt || 'cost' });
  console.log(`模型      ${opts.model.label}`);
  if (opts.duration === -1) {
    console.log('时长      自动（-1），无法估算；用 -d 指定秒数再算');
    if (opts.model.pricePerSecond) {
      const table = opts.model.pricePerSecond[opts.resolution];
      if (table) console.log(`参考      ${opts.resolution} 每 5s ≈ ${(Math.round(table * 500) / 100).toFixed(2)} 元`);
    }
    return;
  }
  const cost = estimateCost(opts.model, opts.resolution, opts.duration);
  if (cost === null) {
    console.log('该模型/分辨率没有内置单价，以官网计费为准');
    return;
  }
  console.log(`规格      ${opts.resolution} · ${opts.ratio} · ${opts.duration}s`);
  console.log(`费用      ≈ ${cost} 元`);
}

/* ---------------- 自检（离线，不发请求） ---------------- */

async function selftest() {
  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push([true, name]);
    } catch (e) {
      checks.push([false, `${name} → ${e.message}`]);
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  check('模型别名 seedance-2.5 → 官方 ID', () => {
    assert(resolveModel('seedance-2.5').id === 'doubao-seedance-2-5-260628', 'ID 不匹配');
    assert(resolveModel('2.5').id === 'doubao-seedance-2-5-260628', '别名 2.5 失效');
    assert(resolveModel('seedance25').id === 'doubao-seedance-2-5-260628', '别名 25 失效');
  });
  check('未知 model id 透传', () => {
    assert(resolveModel('doubao-xxx-1').id === 'doubao-xxx-1', '未透传');
  });
  check('费用折算 480p 8s = 5.38 元', () => {
    const cost = estimateCost(resolveModel('seedance-2.5'), '480p', 8);
    assert(cost === 5.38, `得到 ${cost}`);
  });
  check('分辨率非法时被拦截', () => {
    let threw = false;
    try {
      normalizeVideoOptions({ resolution: '4k', prompt: 'x' });
    } catch {
      threw = true;
    }
    assert(threw, '4k 应该被拒');
  });
  check('时长越界被拦截', () => {
    let threw = false;
    try {
      normalizeVideoOptions({ duration: '60', prompt: 'x' });
    } catch {
      threw = true;
    }
    assert(threw, '60s 应该被拒');
  });
  check('编辑任务强制 ratio=adaptive / duration=-1', () => {
    let threw = false;
    try {
      normalizeVideoOptions({ 'task-type': 'edit', video: ['a.mp4'], ratio: '16:9', prompt: 'x' });
    } catch {
      threw = true;
    }
    assert(threw, '应被拒');
  });
  check('请求体字段名符合官方（resolution/ratio/duration/generate_audio）', () => {
    const opts = normalizeVideoOptions({ prompt: 'hello', resolution: '480p', duration: '5' });
    const payload = buildPayload({ ...opts, content: buildContent(opts) });
    assert(payload.model === 'doubao-seedance-2-5-260628', 'model 错');
    assert(payload.resolution === '480p', 'resolution 错');
    assert(payload.duration === 5, 'duration 应为数字');
    assert(payload.generate_audio === true, 'generate_audio 错');
    assert(Array.isArray(payload.content) && payload.content[0].type === 'text', 'content 错');
  });
  check('data URL 引用本地图片', () => {
    const tmp = path.join(CONFIG_DIR, '_selftest.png');
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(tmp, Buffer.from('89504e470d0a1a0a', 'hex'));
    const ref = buildContent({ prompt: '', firstFrame: tmp })[0];
    assert(ref.role === 'first_frame', 'role 错');
    assert(ref.image_url.url.startsWith('data:image/png;base64,'), 'data url 错');
    fs.unlinkSync(tmp);
  });
  check('文件名安全化', () => {
    assert(slugify('a/b:c*?"<>|d') === 'abcd', `得到 ${slugify('a/b:c*?"<>|d')}`);
  });
  check('价格表：四个视频模型 480p 8s 均可估算', () => {
    const cases = [['seedance-2.5', 5.38], ['seedance-2.0', 3.54], ['seedance-2.0-fast', 2.84], ['seedance-2.0-mini', 1.77]];
    for (const [key, want] of cases) {
      const got = estimateCost(MODELS[key], '480p', 8);
      assert(got === want, `${key} 得到 ${got}，期望 ${want}`);
    }
  });
  check('能力边界：fast/mini 只到 720p，4k 仅 2.0', () => {
    assert(!MODELS['seedance-2.0-fast'].resolutions.includes('1080p'), 'fast 不该有 1080p');
    assert(!MODELS['seedance-2.0-mini'].resolutions.includes('1080p'), 'mini 不该有 1080p');
    assert(MODELS['seedance-2.0'].resolutions.includes('4k'), '2.0 应有 4k');
    assert(!MODELS['seedance-2.5'].resolutions.includes('4k'), '2.5 不该有 4k');
  });
  check('签名 x-date 格式', () => {
    assert(toXDate(new Date('2026-11-05T04:40:00.123Z')) === '20261105T044000Z', '格式错');
  });
  check('查询串字典序 + RFC3986 编码', () => {
    assert(canonicalQuery({ Version: '2022-01-01', Action: 'QueryBalanceAcct' }) === 'Action=QueryBalanceAcct&Version=2022-01-01', '排序错');
    assert(canonicalQuery({ q: 'a b' }) === 'q=a%20b', '编码错');
  });
  check('签名 scope 与结构', () => {
    const r = signedRequest({
      method: 'GET',
      host: 'billing.volcengineapi.com',
      service: 'billing',
      query: { Action: 'QueryBalanceAcct', Version: '2022-01-01' },
      ak: 'AKTEST',
      sk: 'SKTEST',
      now: new Date('2026-11-05T04:40:00Z'),
    });
    assert(/Credential=AKTEST\/20261105\/cn-beijing\/billing\/request/.test(r.headers.authorization), r.headers.authorization);
    assert(/Signature=[0-9a-f]{64}$/.test(r.headers.authorization), '签名长度不对');
    assert(r.url.startsWith('https://billing.volcengineapi.com/?Action=QueryBalanceAcct'), r.url);
  });
  check('POST 签名含 x-content-sha256', () => {
    const r = signedRequest({
      method: 'POST',
      host: 'ark.cn-beijing.volcengineapi.com',
      service: 'ark',
      query: { Action: 'ListModelActivations', Version: '2024-01-01' },
      body: { PageNumber: 1 },
      ak: 'AK',
      sk: 'SK',
    });
    assert(/^[0-9a-f]{64}$/.test(r.headers['x-content-sha256']), 'sha256 错');
    assert(r.headers.authorization.includes('SignedHeaders=content-type;host;x-content-sha256;x-date'), 'SignedHeaders 错');
  });
  check('门槛判定：余额 213.5 → 达标且锁定 200', () => {
    const r = assess({
      balance: { available: 213.5 },
      activations: [{ FoundationModelName: 'doubao-seedance-2-5', DisplayName: 'Doubao Seedance 2.5', State: 'Available' }],
    });
    assert(r.met === true, 'met 应为 true');
    assert(r.locked === 200, `locked 得到 ${r.locked}`);
    assert(r.entries.find((e) => e.key === 'seedance-2.5').state === 'Available', '2.5 应已开通');
  });
  check('门槛判定：余额 150 → 未达标并给警告', () => {
    const r = assess({ balance: { available: 150 }, activations: [] });
    assert(r.met === false, 'met 应为 false');
    assert(r.warnings.some((w) => w.includes('低于 200')), '缺少余额警告');
  });
  check('官方模型名前后缀匹配', () => {
    assert(nameMatches('doubao-seedance-2-5', 'doubao-seedance-2-5-260628'), '前缀匹配失效');
    assert(!nameMatches('doubao-seed-1-8', 'doubao-seedance-2-5-260628'), '误匹配');
  });

  check('生图模型别名与 4.0 主线 ID', () => {
    assert(resolveImageModel('4').id === 'doubao-seedream-4-0-20260415', '别名 4 失效');
    assert(resolveImageModel('seedream-4.0').id === 'doubao-seedream-4-0-20260415', '4.0 ID 不对');
    assert(resolveImageModel('5.0-lite').id === 'doubao-seedream-5-0-260128', 'lite 别名失效');
    assert(resolveImageModel('pro').group === false, 'pro 不该支持组图');
  });
  check('5.0 flash 是独立产品线（ID / 档位 / 组图 / 价格都不同）', () => {
    const flash = resolveImageModel('flash');
    assert(flash.id === 'doubao-seedream-5-0-flash-260915', `flash ID 不对：${flash.id}`);
    assert(flash.key === 'seedream-5.0-flash', 'flash key 不对');
    assert(flash.sizes.join() === '1K,1.5K,2K', `flash 档位不对：${flash.sizes}`);
    assert(flash.group === false, 'flash 不支持组图');
    assert(flash.pricePerImage === 0.12, 'flash 单价应为 0.12');
    // flash 支持 png，4.0 只支持 jpeg
    assert(flash.formats.includes('png'), 'flash 应支持 png');
    let threw = false;
    try {
      normalizeImageOptions({ model: 'flash', prompt: 'x', count: 2 });
    } catch {
      threw = true;
    }
    assert(threw, 'flash 张数 >1 应被拒');
  });
  check('生图像素折算：2K 9:16 → 1152x2048', () => {
    assert(computeSize('2K', '9:16') === '1152x2048', `得到 ${computeSize('2K', '9:16')}`);
    assert(computeSize('2K', '1:1') === '2048x2048', `得到 ${computeSize('2K', '1:1')}`);
  });
  check('生图像素下限夹取：1K 9:16 → 720x1280', () => {
    assert(computeSize('1K', '9:16') === '720x1280', `得到 ${computeSize('1K', '9:16')}`);
  });
  check('生图费用：4.0 三张 = 0.6 元', () => {
    assert(estimateImageCost(resolveImageModel('4.0'), 3) === 0.6, '费用算错');
  });
  check('生图参数拦截：pro 张数 >1 被拒，尺寸越界被拒', () => {
    let threw = 0;
    try { normalizeImageOptions({ model: 'pro', prompt: 'x', n: 2 }); } catch { threw++; }
    try { normalizeImageOptions({ model: '4.0', prompt: 'x', size: '8K' }); } catch { threw++; }
    assert(threw === 2, `只拦下 ${threw} 条`);
  });
  check('生图请求体：有参考图带 image，单图关组图', () => {
    const opts = normalizeImageOptions({ model: '4.0', prompt: 'x', size: '1K', ratio: '1:1' });
    const p = buildImagePayload(opts);
    assert(p.model === 'doubao-seedream-4-0-20260415', 'model 错');
    assert(p.size === '1024x1024', `size 错 ${p.size}`);
    assert(p.sequential_image_generation === 'disabled', '单图应 disabled');
    assert(!('image' in p), '无参考图不该带 image');
  });

  check('预设：三套骨架与参数齐备', () => {
    assert(PRESET_ORDER.length === 3, '预设数量应为 3');
    for (const k of PRESET_ORDER) {
      const p = resolvePreset(k);
      assert(p, `缺少预设 ${k}`);
      assert(p.text && p.text.length > 100, `${k} 提示词过短`);
      assert(p.preset && typeof p.preset === 'object', `${k} 缺参数`);
    }
    /* 别名的容错 */
    assert(resolvePreset('白模') === resolvePreset('clay'), '中文别名失效');
    assert(resolvePreset('green') === resolvePreset('green-gen'), 'green 别名失效');
    assert(resolvePreset('不存在') === null, '未知预设应为 null');
  });

  check('预设：用户显式 flag 优先于预设', () => {
    const o = normalizeVideoOptions({ preset: 'clay', video: ['a.mp4'], ratio: '16:9' });
    assert(o.taskType === 'reference', '预设任务类型未生效');
    assert(o.ratio === '16:9', '用户显式 ratio 未优先生效');
    assert(o.outputFormat === 'mov', '预设输出格式未生效');
    assert(o.generateAudio === false, '预设应关闭原生音频');
  });

  check('预设：绿幕换实景锁定 edit 的强制参数', () => {
    const o = normalizeVideoOptions({ preset: 'green-edit', video: ['a.mp4'] });
    assert(o.taskType === 'edit', '应为 edit');
    assert(o.ratio === 'adaptive' && o.duration === -1, 'edit 要求 adaptive + duration -1');
    assert(o.outputFormat === 'mov', '绿幕必须 mov（yuv444p 保色度）');
  });

  check('预设：未知预设名被拦截', () => {
    let threw = false;
    try { normalizeVideoOptions({ preset: 'nope', prompt: 'x' }); } catch { threw = true; }
    assert(threw, '未知预设想报错但没报');
  });

  let failed = 0;
  for (const [ok, name] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} 通过`);
  if (failed) {
    const err = new Error('自检未通过');
    err.exitCode = 1;
    throw err;
  }
}

/* ---------------- 入口 ---------------- */

export async function main(argv) {
  if (argv.includes('--selftest') || argv[0] === 'selftest') return selftest();
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    console.log(HELP);
    return;
  }

  const { flags, positional } = parseArgs(argv);
  const command = positional[0];

  switch (command) {
    case 'config':
      return cmdConfig(flags, positional);
    case 'models':
      return cmdModels();
    case 'account':
    case 'balance':
      return cmdAccount(flags);
    case 'video':
    case 'gen': {
      // 提示词：命令行第一个位置参数之后的全部内容（支持不带引号）
      const prompt = positional.slice(1).join(' ').trim();
      if (!prompt && !flags.preset && !flags.image && !flags.i && !flags['last-frame'] && !flags.ref && !flags.r && !flags['draft-from']) {
        fail('缺少提示词。用法：ark video "你的提示词"');
      }
      const opts = normalizeVideoOptions({ ...flags, prompt });
      await runVideo(opts, flags);
      return;
    }
    case 'image':
    case 'img':
      return cmdImage(flags, positional);
    case 'task':
      return runTask(flags, positional);
    case 'cost':
      return cmdCost(flags);
    case 'tasks':
    case 'list':
      return cmdTasks(flags);
    case 'cancel':
    case 'rm':
      return cmdCancel(flags, positional);
    case 'ui':
    case 'web': {
      const { startServer } = await import('./server.js');
      startServer({
        port: Number(pick(flags, 'port')) || 5173,
        host: pick(flags, 'host') || '127.0.0.1',
        open: Boolean(flags.open),
      });
      return;
    }
    default:
      if (command && !command.startsWith('-')) fail(`未知命令 ${command}，用 ark --help 查看用法`);
      console.log(HELP);
  }
}
