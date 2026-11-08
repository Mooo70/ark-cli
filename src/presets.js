/**
 * 内置预设：白模参考 / 绿幕生成 / 绿幕换实景。
 *
 * 关键事实：Seedance 2.5 的 API 没有 green_screen / clay_render 这类专用参数。
 * 官方文档里 omni_reference_task_type 只有 auto / reference / edit / extend，
 * content.role 只有 first_frame / last_frame / reference_image / reference_video / reference_audio。
 * 白模与绿幕都是「普通 reference_video + 特定写法的提示词」，靠模型语义识别。
 *
 * 所以预设固化的不是接口调用，而是三件事：
 *   1. 参数搭配（任务类型 / 画幅 / 时长 / 原生音频 / 输出格式）
 *   2. 提示词骨架
 *   3. 素材要求提示
 */

/** 输出格式默认给 mov：H.264 + yuv444p，绿幕边缘不会因色度下采样产生绿色溢出 */
const MOV = 'mov';

export const PRESETS = {
  clay: {
    key: 'clay',
    name: '白模参考 · 3D预演→实拍质感',
    hint: '参考视频放白模预演；建议 5–10 秒；导出前先删掉轨迹线、坐标轴、相机锥体，否则会被渲染进成片',
    preset: { taskType: 'reference', ratio: 'adaptive', duration: -1, genAudio: false, outputFormat: MOV },
    text: [
      '【结构参考】参考 @视频1 的相机机位、镜头运动、角色走位与画面构图，逐帧对齐，不改变画面内容。',
      '',
      '【重新生成】只提取白模视频中的几何结构、空间关系与运动轨迹，忽略其灰白素模外观、无贴图表面与低对比度质感。按以下方向重新渲染：',
      '- 主体：<主体造型与材质，例：梨形圆润身体的软胶玩偶，半哑光，边缘柔和高光>',
      '- 环境：<场景，例：室内白墙与木地板，暖色调>',
      '- 光照：<光源，例：左上方主光，柔和阴影，与场景一致>',
      '- 质感：接近实拍的影视质感，低饱和，脚下有真实投影',
      '',
      '【不出现】灰白素模外观、辅助线、坐标轴、相机锥体、网格线；卡通渲染、塑料玩具感；画面模糊、闪烁、跳变；主体悬浮离地或被画面边缘裁切。',
    ].join('\n'),
  },

  'green-gen': {
    key: 'green-gen',
    name: '绿幕生成 · 出可抠像素材',
    hint: '不需要参考视频，提示词写清主体与动作即可；输出已切 mov（yuv444p），避免 mp4 的色度溢出导致绿边',
    preset: { taskType: 'auto', genAudio: false, outputFormat: MOV },
    text: [
      '【主体】<主体与动作，例：五只圆润奶蛙玩偶依次端着蛋糕直立行走>',
      '',
      '【背景】纯色绿幕背景，标准 chroma key 绿（约 #00FF00），整幅背景颜色完全均匀一致：无渐变、无明暗变化、无纹理、无地面、无墙面、无任何物体；主体不向背景投射阴影。',
      '',
      '【主体质量】主体边缘清晰锐利，与绿幕之间色分离明确，无绿色反光溢出（no green spill）；主体内部不含任何绿色区域，避免与背景混色。',
      '',
      '【镜头】<机位与运镜，例：固定机位、平视、轻微手持呼吸感>',
      '',
      '【不出现】背景中出现地面、墙面、物体、光斑、渐变；主体边缘模糊、半透明或与背景颜色混融；主体上出现绿边或绿色高光。',
    ].join('\n'),
  },

  'green-edit': {
    key: 'green-edit',
    name: '绿幕换实景 · 补全环境',
    hint: '参考视频放绿幕素材；编辑任务要求原片 4–30 秒；已切 mov，色彩保真度更高',
    preset: { taskType: 'edit', ratio: 'adaptive', duration: -1, genAudio: false, outputFormat: MOV },
    text: [
      '【参考】@视频1 为绿幕素材，保留其中主体的外观、动作、走位、动作节奏、机位与画面构图完全不变。',
      '',
      '【替换背景】移除纯绿背景，替换为：<环境，例：室内暖光、白墙与木地板的居家场景>。新背景的光线方向与主体原有光照保持一致，主体落在新环境中要有真实投影。',
      '',
      '【边缘质量】主体边缘与新背景自然融合，无绿边残留、无抠像毛边、无轮廓发亮；主体的半透明部位（如边缘绒毛、发丝）保持自然。',
      '',
      '【不出现】任何绿色残留或绿边；主体轮廓出现亮边、黑边、锯齿；背景光照方向与主体矛盾；主体被裁切、变形或改变动作。',
    ].join('\n'),
  },
};

export const PRESET_ORDER = ['clay', 'green-gen', 'green-edit'];

/** 取预设，支持 key 或别名（中文名、常见简写） */
export function resolvePreset(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (PRESETS[s]) return PRESETS[s];
  const alias = {
    white: 'clay',
    whitemodel: 'clay',
    'white-model': 'clay',
    blockout: 'clay',
    白模: 'clay',
    green: 'green-gen',
    'green-screen': 'green-gen',
    greenscreen: 'green-gen',
    keying: 'green-gen',
    绿幕: 'green-gen',
    'green-real': 'green-edit',
    'green-edit': 'green-edit',
    绿幕换景: 'green-edit',
  };
  const hit = alias[s];
  return hit ? PRESETS[hit] : null;
}

export function presetList() {
  return PRESET_ORDER.map((k) => PRESETS[k]);
}
