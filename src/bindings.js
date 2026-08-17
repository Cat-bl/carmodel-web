/**
 * 车模联动槽位定义与动画生成。
 *
 * 全部规格照抄官方 HcModel 实测结果（见 车道级车模联动机制.md 第六节）：
 * 单通道、25 关键帧、0.8 秒、LINEAR 插值。
 *
 * 本模块刻意保持纯粹（不依赖 DOM、不依赖 package.js），
 * 让实时预览与最终打包共用同一份动画真相。
 */

export const KEYFRAME_COUNT = 25;
export const DURATION = 0.8;

/** 闪烁的 scale 序列，逐帧抄自官方 CS_Emergency_A。 */
const BLINK_SCALE = [
  1, 1, 1, 1, 1, 1, 1,
  0.258,
  0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01,
  0.752,
  1, 1, 1, 1, 1,
];

const AXIS_VECTOR = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * 18 个联动槽位。
 * kind: lamp=仅换贴图 / blink=换贴图+闪烁 / spin=自转 / hinge=铰链开合
 * hinge=枢轴默认取包围盒的哪一侧：front=车头侧(min X)，rear=车尾侧(max X)
 */
export const BINDING_SLOTS = [
  { id: 'CS_Lower', label: '近光灯', group: '灯光', kind: 'lamp', color: '#fff6d5' },
  { id: 'CS_High', label: '远光灯', group: '灯光', kind: 'lamp', color: '#ffffff' },
  { id: 'CS_Clearance', label: '示宽灯', group: '灯光', kind: 'lamp', color: '#ffe9b0' },
  { id: 'CS_Stop', label: '刹车灯', group: '灯光', kind: 'lamp', color: '#ff2a1a' },
  { id: 'CS_Fog', label: '雾灯', group: '灯光', kind: 'lamp', color: '#fff0c0' },
  { id: 'CS_Daytime', label: '日行灯', group: '灯光', kind: 'lamp', color: '#eaf4ff' },
  { id: 'CS_Backup', label: '倒车灯', group: '灯光', kind: 'lamp', color: '#ffffff' },

  { id: 'CS_LDirection', label: '左转向灯', group: '闪烁', kind: 'blink', color: '#ff9d00' },
  { id: 'CS_RDirection', label: '右转向灯', group: '闪烁', kind: 'blink', color: '#ff9d00' },
  { id: 'CS_Emergency', label: '双闪', group: '闪烁', kind: 'blink', color: '#ff9d00' },

  { id: 'CS_WF', label: '前轮（左右一对）', group: '转动', kind: 'spin', axis: 'z' },
  { id: 'CS_WB', label: '后轮（左右一对）', group: '转动', kind: 'spin', axis: 'z' },

  { id: 'CS_LF', label: '左前门', group: '开合', kind: 'hinge', axis: 'y', angle: -45, hinge: 'front' },
  { id: 'CS_RF', label: '右前门', group: '开合', kind: 'hinge', axis: 'y', angle: 45, hinge: 'front' },
  { id: 'CS_LB', label: '左后门', group: '开合', kind: 'hinge', axis: 'y', angle: -45, hinge: 'rear' },
  { id: 'CS_RB', label: '右后门', group: '开合', kind: 'hinge', axis: 'y', angle: 45, hinge: 'rear' },
  { id: 'CS_Bonnet', label: '引擎盖', group: '开合', kind: 'hinge', axis: 'z', angle: -45, hinge: 'rear' },
  { id: 'CS_Trunk', label: '后备箱', group: '开合', kind: 'hinge', axis: 'z', angle: 60, hinge: 'front' },
];

export const SLOT_BY_ID = new Map(BINDING_SLOTS.map((slot) => [slot.id, slot]));

const OTHER_SLOT_PRESENTATION = {
  CS_WF: { label: '前进', group: '移动', trigger: '车辆开始或停止行驶时触发' },
  CS_LDirection: { trigger: '左转向灯打开时触发' },
  CS_RDirection: { trigger: '右转向灯打开时触发' },
  CS_Emergency: { trigger: '双闪打开时触发' },
  CS_Lower: { trigger: '近光灯打开时触发' },
  CS_High: { trigger: '远光灯打开时触发' },
  CS_Stop: { trigger: '刹车灯打开时触发' },
  CS_Daytime: { trigger: '日行灯打开时触发' },
  CS_LF: { trigger: '左前门打开或关闭时触发' },
  CS_RF: { trigger: '右前门打开或关闭时触发' },
  CS_LB: { trigger: '左后门打开或关闭时触发' },
  CS_RB: { trigger: '右后门打开或关闭时触发' },
  CS_Bonnet: { trigger: '引擎盖打开或关闭时触发' },
  CS_Trunk: { trigger: '后备箱打开或关闭时触发' },
};

export function slotForMode(slotOrId, modelType = 'vehicle') {
  const slot = typeof slotOrId === 'string' ? SLOT_BY_ID.get(slotOrId) : slotOrId;
  if (!slot || modelType !== 'other') return slot;
  return { ...slot, ...(OTHER_SLOT_PRESENTATION[slot.id] || {}) };
}

/**
 * 其他模型的事件动画播放策略。未保存过配置的旧项目继续沿用原默认值：
 * 开合/灯光单次播放并在事件结束时反向恢复，循环类事件结束时直接停止。
 */
export function normalizeOtherPlayback(slot, value = {}) {
  const defaults = slot?.kind === 'hinge' || slot?.kind === 'lamp'
    ? { mode: 'hold', direction: 'forward', endMode: 'reverse' }
    : { mode: 'loop', direction: 'forward', endMode: 'reset' };
  const stored = value && typeof value === 'object' ? value : {};
  const legacy = Object.keys(stored).length > 0 && stored.version !== 2;
  const requestedMode = legacy && stored.mode === 'once' ? 'hold' : stored.mode;
  const speed = Math.min(4, Math.max(0.1, Number(stored.speed) || 1));
  const rawStart = Number(stored.range?.start ?? stored.rangeStart);
  const rawEnd = Number(stored.range?.end ?? stored.rangeEnd);
  const start = Number.isFinite(rawStart) ? Math.min(0.98, Math.max(0, rawStart)) : 0;
  const end = Number.isFinite(rawEnd) ? Math.min(1, Math.max(start + 0.01, rawEnd)) : 1;
  return {
    version: 2,
    mode: ['once', 'hold', 'loop', 'pingpong'].includes(requestedMode) ? requestedMode : defaults.mode,
    direction: ['forward', 'reverse'].includes(stored.direction) ? stored.direction : defaults.direction,
    endMode: ['reverse', 'reset', 'hold', 'finish'].includes(stored.endMode)
      ? stored.endMode
      : stored.endMode === 'stop' ? 'reset' : defaults.endMode,
    speed,
    range: { start, end },
  };
}

export function playbackDurationOf(sourceDuration, playback, { cycle = true } = {}) {
  const duration = Math.max(0, Number(sourceDuration) || 0);
  const normalized = normalizeOtherPlayback(null, playback);
  const oneWay = duration * (normalized.range.end - normalized.range.start) / normalized.speed;
  return cycle && normalized.mode === 'pingpong' ? oneWay * 2 : oneWay;
}

const OTHER_ACTION_OPTIONS = {
  lamp: [{ value: 'lamp', label: '发光 / 换色' }],
  blink: [
    { value: 'blink', label: '闪烁显隐' },
    { value: 'spin', label: '循环旋转' },
    { value: 'swing', label: '往复摆动' },
  ],
  spin: [
    { value: 'spin', label: '循环旋转' },
    { value: 'swing', label: '往复摆动' },
    { value: 'pulse', label: '循环缩放' },
  ],
  hinge: [
    { value: 'hinge', label: '旋转开合' },
    { value: 'scale', label: '缩放开合' },
  ],
};

export function actionOptionsOf(slot, modelType = 'vehicle') {
  if (!slot || modelType !== 'other') return [];
  return OTHER_ACTION_OPTIONS[slot.kind] || [];
}

export function actionKindOf(slot, params = {}) {
  const value = params.actionKind;
  return OTHER_ACTION_OPTIONS[slot?.kind]?.some((option) => option.value === value) ? value : slot?.kind;
}

// 页面暂时隐藏这三个绑定入口；槽位定义和导出兼容逻辑继续保留，方便后续恢复。
const PAGE_HIDDEN_SLOT_IDS = new Set([
  'CS_Clearance', // 示宽灯
  'CS_Fog', // 雾灯
  'CS_Backup', // 倒车灯
]);

// “其他模型”只需要感知车辆是否正在行驶。地图会同时派发前、后轮事件，
// 因此统一复用 CS_WF 作为“前进”，隐藏 CS_WB，避免同一骨骼动作被播放两次。
const OTHER_HIDDEN_SLOT_IDS = new Set(['CS_WB']);

export function slotGroups(modelType = 'vehicle') {
  const groups = new Map();
  for (const baseSlot of BINDING_SLOTS) {
    const slot = slotForMode(baseSlot, modelType);
    if (PAGE_HIDDEN_SLOT_IDS.has(slot.id)) continue;
    if (modelType === 'other' && OTHER_HIDDEN_SLOT_IDS.has(slot.id)) continue;
    if (!groups.has(slot.group)) groups.set(slot.group, []);
    groups.get(slot.group).push(slot);
  }
  return groups;
}

/** 该槽位会生成哪几段动画；灯光类返回空数组。 */
export function animationNamesOf(slot) {
  if (slot.kind === 'blink') return [`${slot.id}_A`];
  if (slot.kind === 'spin') return [`${slot.id}_A`];
  if (slot.kind === 'hinge') return [`${slot.id}_Open`, `${slot.id}_Close`];
  return [];
}

/** 按部件包围盒给出默认参数，用户可再调。 */
export function defaultParams(slot, bounds, { modelType = 'vehicle' } = {}) {
  const center = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const params = { pivot: center, axis: slot.axis, angle: slot.angle, color: slot.color };
  if (slot.kind === 'hinge' && modelType !== 'other') {
    // 铰链在部件的车头侧或车尾侧边缘（X 为纵向，−X 是车头）
    params.pivot = [slot.hinge === 'front' ? bounds.min[0] : bounds.max[0], center[1], center[2]];
  }
  if (slot.kind === 'spin' && modelType !== 'other') {
    // 轮轴取横向中心，保证左右两侧同轴转动
    params.pivot = [center[0], center[1], 0];
  }
  return params;
}

/**
 * 生成某段动画的关键帧数据。
 * 返回 { path, times: number[], values: number[] }，values 已按 path 展平
 * （rotation 为 4 分量四元数，scale 为 3 分量）。
 * 转动/开合类支持自定义时长（0.2~5 秒）；闪烁节奏与官方转向灯继电器对齐，不开放。
 */
export function buildKeyframes(slot, params, animationName) {
  const actionKind = actionKindOf(slot, params);
  const custom = Number(params.duration);
  const duration = !['lamp', 'blink'].includes(actionKind) && Number.isFinite(custom) && custom > 0
    ? Math.min(5, Math.max(0.2, custom))
    : DURATION;
  const times = [];
  for (let i = 0; i < KEYFRAME_COUNT; i++) {
    times.push((i * duration) / (KEYFRAME_COUNT - 1));
  }

  if (actionKind === 'blink') {
    const values = [];
    for (const s of BLINK_SCALE) values.push(s, s, s);
    return { path: 'scale', times, values };
  }

  if (actionKind === 'pulse') {
    const amount = Math.min(0.9, Math.max(0.05, Number(params.scaleAmount) || 0.25));
    const values = [];
    for (let i = 0; i < KEYFRAME_COUNT; i++) {
      const progress = i / (KEYFRAME_COUNT - 1);
      const scale = 1 + Math.sin(progress * Math.PI * 2) * amount;
      values.push(scale, scale, scale);
    }
    return { path: 'scale', times, values };
  }

  if (actionKind === 'scale') {
    const target = Math.min(3, Math.max(0.01, Number(params.scaleTarget) || 0.01));
    const close = animationName.endsWith('_Close');
    const values = [];
    for (let i = 0; i < KEYFRAME_COUNT; i++) {
      const progress = i / (KEYFRAME_COUNT - 1);
      const scale = close
        ? target + (1 - target) * progress
        : 1 + (target - 1) * progress;
      values.push(scale, scale, scale);
    }
    return { path: 'scale', times, values };
  }

  const axis = AXIS_VECTOR[params.axis || slot.axis || 'z'];
  const values = [];
  for (let i = 0; i < KEYFRAME_COUNT; i++) {
    const progress = i / (KEYFRAME_COUNT - 1);
    let degrees;
    if (actionKind === 'spin') {
      degrees = progress * 360 * (params.reverse ? -1 : 1);
    } else if (actionKind === 'swing') {
      const target = Number.isFinite(params.angle) ? params.angle : 30;
      degrees = Math.sin(progress * Math.PI * 2) * target;
    } else {
      const target = Number.isFinite(params.angle) ? params.angle : slot.angle;
      // Open 从 0 转到目标角，Close 反过来
      degrees = animationName.endsWith('_Close')
        ? target * (1 - progress)
        : target * progress;
    }
    const half = (degrees * Math.PI) / 360;
    let sin = Math.sin(half);
    let cos = Math.cos(half);
    // 与官方一致：转角达到 180° 后改用等价的负四元数，
    // 这样整圈动画的末帧会回到 (0,0,0,1) 与首帧相同，循环播放才能无缝衔接
    if (Math.abs(degrees) >= 180) {
      sin = -sin;
      cos = -cos;
    }
    values.push(axis[0] * sin, axis[1] * sin, axis[2] * sin, cos);
  }
  return { path: 'rotation', times, values };
}

/** #rrggbb → [r, g, b] 0~255 */
export function parseColor(hex) {
  const value = String(hex || '#ffffff').replace('#', '');
  const full = value.length === 3
    ? value.split('').map((c) => c + c).join('')
    : value.padEnd(6, '0').slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

/**
 * 给每个槽位一个大致的默认框选范围，用户只需微调。
 * 坐标约定：X 纵向（−X 车头）、Y 竖直向上、Z 横向（+Z 左 / −Z 右）。
 * 各分量用 0~1 的相对比例表示，再映射到模型包围盒。
 */
const REGION_HINTS = {
  CS_WF: { x: [0, 0.32], y: [0, 0.38], z: [0, 1] },
  CS_WB: { x: [0.68, 1], y: [0, 0.38], z: [0, 1] },
  CS_LF: { x: [0.2, 0.52], y: [0.3, 0.85], z: [0.5, 1] },
  CS_RF: { x: [0.2, 0.52], y: [0.3, 0.85], z: [0, 0.5] },
  CS_LB: { x: [0.52, 0.84], y: [0.3, 0.85], z: [0.5, 1] },
  CS_RB: { x: [0.52, 0.84], y: [0.3, 0.85], z: [0, 0.5] },
  CS_Bonnet: { x: [0.02, 0.32], y: [0.45, 0.75], z: [0.1, 0.9] },
  CS_Trunk: { x: [0.72, 0.98], y: [0.45, 0.8], z: [0.1, 0.9] },
  CS_Lower: { x: [0, 0.12], y: [0.25, 0.5], z: [0, 1] },
  CS_High: { x: [0, 0.12], y: [0.35, 0.6], z: [0, 1] },
  CS_Fog: { x: [0, 0.1], y: [0.12, 0.3], z: [0, 1] },
  CS_Daytime: { x: [0, 0.1], y: [0.3, 0.5], z: [0, 1] },
  CS_Clearance: { x: [0, 0.1], y: [0.25, 0.45], z: [0, 1] },
  CS_Stop: { x: [0.88, 1], y: [0.3, 0.6], z: [0, 1] },
  CS_Backup: { x: [0.9, 1], y: [0.2, 0.42], z: [0, 1] },
  CS_LDirection: { x: [0, 0.15], y: [0.25, 0.5], z: [0.55, 1] },
  CS_RDirection: { x: [0, 0.15], y: [0.25, 0.5], z: [0, 0.45] },
  CS_Emergency: { x: [0, 0.15], y: [0.25, 0.5], z: [0, 1] },
};

export function suggestRegion(slot, bounds, { modelType = 'vehicle' } = {}) {
  const genericHint = { x: [0.35, 0.65], y: [0.35, 0.65], z: [0.35, 0.65] };
  const hint = modelType === 'other' ? genericHint : (REGION_HINTS[slot.id] || genericHint);
  const axes = ['x', 'y', 'z'];
  const min = [];
  const max = [];
  axes.forEach((axis, i) => {
    const span = bounds.max[i] - bounds.min[i];
    min.push(bounds.min[i] + span * hint[axis][0]);
    max.push(bounds.min[i] + span * hint[axis][1]);
  });
  return { min, max };
}
