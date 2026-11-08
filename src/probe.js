import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 参考视频的官方限制，来源：方舟 Seedance 2.5 文档「使用限制 · 全模态输入 · 视频要求」。
 * 编辑任务对时长要求更严（4–30s），其余任务 2–30s。
 */
export const VIDEO_LIMITS = {
  durationNormal: [2, 30],
  durationEdit: [4, 30],
  totalDuration: 30,
  ratio: [0.4, 2.5],
  sidePx: [300, 6000],
  pixels: [407696, 8295044],
  fps: [24, 60],
  sizeMB: 200,
};

function parseFps(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    if (b) return a / b;
    return 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function runFfprobe(bin, target) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,codec_name',
      '-show_entries', 'format=duration,size,format_name',
      '-of', 'json',
      target,
    ];
    let out = '';
    let err = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      return done({ ok: false, error: e.message });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ok: false, error: 'ffprobe 读取超时（30s）' });
    }, 30000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, error: e.code === 'ENOENT' ? 'ENOENT' : e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return done({ ok: false, error: err.trim().slice(0, 300) || `ffprobe 退出码 ${code}` });
      try { done({ ok: true, data: JSON.parse(out) }); }
      catch { done({ ok: false, error: '无法解析 ffprobe 输出' }); }
    });
  });
}

function summarize(data, taskType) {
  const s = (data.streams || [])[0] || {};
  const f = data.format || {};
  const width = Number(s.width) || 0;
  const height = Number(s.height) || 0;
  const duration = Number(f.duration) || Number(s.duration) || 0;
  const fps = parseFps(s.avg_frame_rate) || parseFps(s.r_frame_rate);
  const pixels = width * height;
  const ratio = height ? width / height : 0;
  const size = Number(f.size) || 0;

  if (!width || !height) {
    return { ok: false, error: '读不到视频画面尺寸，可能不是视频文件或编码不受支持' };
  }

  const isEdit = taskType === 'edit';
  const [dMin, dMax] = isEdit ? VIDEO_LIMITS.durationEdit : VIDEO_LIMITS.durationNormal;

  const checks = [];
  const push = (key, label, value, ok, expect) => checks.push({ key, label, value, ok, expect });

  push('duration', '时长', `${duration.toFixed(2)}s`, duration >= dMin && duration <= dMax,
    `${dMin}–${dMax}s${isEdit ? '（编辑任务）' : ''}`);
  push('fps', '帧率', `${fps.toFixed(2)}fps`, fps >= VIDEO_LIMITS.fps[0] && fps <= VIDEO_LIMITS.fps[1], '24–60fps');
  push('ratio', '宽高比', ratio.toFixed(2), ratio >= VIDEO_LIMITS.ratio[0] && ratio <= VIDEO_LIMITS.ratio[1], '0.4–2.5');
  push('pixels', '像素总数', `${(pixels / 10000).toFixed(1)}万`,
    pixels >= VIDEO_LIMITS.pixels[0] && pixels <= VIDEO_LIMITS.pixels[1], '40.8万–829.5万');
  push('side', '边长', `${width}×${height}`,
    width >= 300 && height >= 300 && width <= 6000 && height <= 6000, '宽高各 300–6000px');
  if (size) push('size', '文件大小', `${(size / 1048576).toFixed(1)}MB`, size <= VIDEO_LIMITS.sizeMB * 1048576, '≤200MB');

  const bad = checks.filter((c) => !c.ok);
  return {
    ok: true,
    width,
    height,
    duration: Number(duration.toFixed(2)),
    fps: Number(fps.toFixed(2)),
    pixels,
    ratio: Number(ratio.toFixed(3)),
    sizeBytes: size,
    codec: s.codec_name || '',
    format: f.format_name || '',
    taskType,
    checks,
    pass: bad.length === 0,
    warnings: bad.map((c) => `${c.label} ${c.value} 不满足 ${c.expect}`),
  };
}

/**
 * 预检一段参考视频。src 支持 http(s) URL 与 dataURL。
 * ffprobe 不存在时返回 skipped，调用方应放行（预检是辅助，不能拦住正常提交）。
 */
export async function probeVideo(src, { taskType = 'auto' } = {}) {
  let target = String(src || '').trim();
  if (!target) return { ok: false, error: '没有可预检的素材' };

  let tmpFile = null;
  try {
    if (/^data:/i.test(target)) {
      const m = /^data:([^;]*);base64,(.*)$/s.exec(target);
      if (!m) return { ok: false, error: '无法解析 dataURL' };
      const ext = /quicktime/i.test(m[1]) ? '.mov' : '.mp4';
      tmpFile = path.join(os.tmpdir(), `ark-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
      fs.writeFileSync(tmpFile, Buffer.from(m[2], 'base64'));
      target = tmpFile;
    } else if (/^https?:\/\//i.test(target)) {
      /* 直接交给 ffprobe 拉取 */
    } else {
      /* 本地路径：只有 CLI 会走这里，API 层已在 handleProbe 里拦住 */
      if (!fs.existsSync(target)) return { ok: false, error: `找不到文件：${target}` };
      target = path.resolve(target);
    }

    const bin = process.env.FFPROBE_PATH || 'ffprobe';
    const r = await runFfprobe(bin, target);
    if (!r.ok) {
      if (r.error === 'ENOENT') {
        return { ok: false, skipped: true, reason: '本机没找到 ffprobe，已跳过预检（不影响提交）' };
      }
      return { ok: false, error: r.error };
    }
    return summarize(r.data, taskType);
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} }
  }
}
