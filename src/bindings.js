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
  { id: 'CS_Idle', label: '待机', group: '移动', kind: 'spin' },

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
  CS_Idle: { trigger: '车辆持续静止指定时间后触发，开始行驶时结束' },
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
 * 「其他模型」每个事件的出厂默认播放方式与仲裁优先级。
 *
 * 定这张表的底线是：**信号亮着就一直激活的事件（灯光、刹车、转向）绝不能用 hold**。
 * 车机对 `activeEnd=hold` 的处理是播完尾帧后继续占着播放槽不放（见 CarModelEventBindings
 * 的 ACTION_HOLD 分支），只要灯还亮着就永远不让位——夜里开着近光，车模就会一直定格，
 * 待机和行驶动作再也轮不上，而且这一点光靠调优先级救不回来（优先级只决定谁抢到槽，
 * 不能让占着的人主动松手）。所以这类事件默认一律「播放一次后复位」，做完动作立刻让位。
 *
 * hold 只留给开合类：门 / 引擎盖 / 后备箱开着的时候定格，本来就是对的。
 */
const OTHER_EVENT_DEFAULTS = {
  // 背景状态：谁来都让位
  CS_Idle: { mode: 'loop', endMode: 'reset', priority: 0 },
  CS_WF: { mode: 'loop', endMode: 'reset', priority: 50 },
  CS_WB: { mode: 'loop', endMode: 'reset', priority: 50 },

  // 持续点亮的信号：做一个动作就让位，绝不占槽
  CS_Lower: { mode: 'once', endMode: 'reset', priority: 100 },
  CS_High: { mode: 'once', endMode: 'reset', priority: 100 },
  CS_Clearance: { mode: 'once', endMode: 'reset', priority: 100 },
  CS_Daytime: { mode: 'once', endMode: 'reset', priority: 100 },
  CS_Fog: { mode: 'once', endMode: 'reset', priority: 100 },
  CS_Backup: { mode: 'once', endMode: 'reset', priority: 100 },
  CS_LDirection: { mode: 'once', endMode: 'reset', priority: 100 },
  CS_RDirection: { mode: 'once', endMode: 'reset', priority: 100 },
  // 刹车比灯光更值得演，但同样播完就放手，否则停车等灯时会一直定格
  CS_Stop: { mode: 'once', endMode: 'reset', priority: 150 },

  // 开合类：开着的时候保持尾帧才符合直觉，关闭时反向收回
  CS_LF: { mode: 'hold', endMode: 'reverse', priority: 150 },
  CS_RF: { mode: 'hold', endMode: 'reverse', priority: 150 },
  CS_LB: { mode: 'hold', endMode: 'reverse', priority: 150 },
  CS_RB: { mode: 'hold', endMode: 'reverse', priority: 150 },
  CS_Bonnet: { mode: 'hold', endMode: 'reverse', priority: 150 },
  CS_Trunk: { mode: 'hold', endMode: 'reverse', priority: 150 },

  // 双闪是异常状态，就该压住一切并持续演
  CS_Emergency: { mode: 'loop', endMode: 'reset', priority: 200 },
};

// 上表已覆盖全部槽位，这里只兜底 slot 缺失的调用（如只为算时长的 playbackDurationOf）
const FALLBACK_PLAYBACK = { mode: 'loop', endMode: 'reset' };

/**
 * 其他模型的事件动画播放策略。未保存过配置的旧项目继续沿用它自己存下来的值，
 * 只有新绑定才吃上面这张表的默认值。
 */
export function normalizeOtherPlayback(slot, value = {}) {
  const preset = OTHER_EVENT_DEFAULTS[slot?.id] || FALLBACK_PLAYBACK;
  const defaults = { direction: 'forward', mode: preset.mode, endMode: preset.endMode };
  const stored = value && typeof value === 'object' ? value : {};
  const legacy = Object.keys(stored).length > 0 && ![2, 3].includes(Number(stored.version));
  const requestedMode = legacy && stored.mode === 'once' ? 'hold' : stored.mode;
  const speed = Math.min(4, Math.max(0.1, Number(stored.speed) || 1));
  const rawTransition = stored.transitionMs === undefined ? 200 : Number(stored.transitionMs);
  const transitionMs = Number.isFinite(rawTransition)
    ? Math.min(1000, Math.max(0, Math.round(rawTransition)))
    : 200;
  const rawStart = Number(stored.range?.start ?? stored.rangeStart);
  const rawEnd = Number(stored.range?.end ?? stored.rangeEnd);
  const start = Number.isFinite(rawStart) ? Math.min(0.98, Math.max(0, rawStart)) : 0;
  const end = Number.isFinite(rawEnd) ? Math.min(1, Math.max(start + 0.01, rawEnd)) : 1;
  return {
    version: 3,
    mode: ['once', 'hold', 'loop', 'pingpong'].includes(requestedMode) ? requestedMode : defaults.mode,
    direction: ['forward', 'reverse'].includes(stored.direction) ? stored.direction : defaults.direction,
    endMode: ['reverse', 'reset', 'hold', 'finish'].includes(stored.endMode)
      ? stored.endMode
      : stored.endMode === 'stop' ? 'reset' : defaults.endMode,
    speed,
    transitionMs,
    range: { start, end },
  };
}

export function playbackDurationOf(sourceDuration, playback, { cycle = true } = {}) {
  const duration = Math.max(0, Number(sourceDuration) || 0);
  const normalized = normalizeOtherPlayback(null, playback);
  const oneWay = duration * (normalized.range.end - normalized.range.start) / normalized.speed;
  return cycle && normalized.mode === 'pingpong' ? oneWay * 2 : oneWay;
}

export function normalizeIdleDelaySeconds(value) {
  if (value === '' || (typeof value === 'string' && value.trim() === '')) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.min(600, Math.max(0, Math.round(seconds))) : 0;
}

/**
 * 同一播放槽内多个事件同时激活时的仲裁优先级：数值大者接管，同值时最后触发者接管。
 *
 * 导出时会把“动画驱动节点互不重叠”的事件分到不同播放槽并行播放，
 * 因此优先级只在动作真的会互相抢节点时才起作用。
 */
export const EVENT_PRIORITY_LEVELS = [
  { value: 0, label: '最低' },
  { value: 50, label: '较低' },
  { value: 100, label: '普通' },
  { value: 150, label: '较高' },
  { value: 200, label: '最高' },
];

export function defaultEventPriority(slotOrId) {
  const id = typeof slotOrId === 'string' ? slotOrId : slotOrId?.id;
  return OTHER_EVENT_DEFAULTS[id]?.priority ?? 100;
}

/**
 * 是不是「信号亮着就一直激活」的事件（灯光、刹车、转向）。
 * 这类事件一旦配成保持尾帧，就会永久占住播放槽，所以默认播完即让位（mode=once）。
 */
export function isSustainedEvent(slotOrId) {
  const id = typeof slotOrId === 'string' ? slotOrId : slotOrId?.id;
  return OTHER_EVENT_DEFAULTS[id]?.mode === 'once';
}

/** 一个事件最多能挂几个动画；再多导出体积和过渡数量都会失控。 */
export const MAX_EVENT_VARIANTS = 6;

export function normalizeVariantWeight(value) {
  const weight = Math.round(Number(value));
  return Number.isFinite(weight) ? Math.min(100, Math.max(1, weight)) : 10;
}

/**
 * 事件下挂的动画列表（变体）。车机每次触发按权重随机挑一个播，动作就不会永远一个样。
 *
 * 老项目只存了单个 sourceAnimationIndex，这里统一折算成单元素列表；
 * 反过来第 0 个变体始终同步回 sourceAnimationIndex，好让预览、校验和旧车机继续按单动画走。
 */
export function eventVariantsOf(binding) {
  const raw = Array.isArray(binding?.variants) ? binding.variants : [];
  const seen = new Set();
  const list = [];
  for (const item of raw) {
    if (!Number.isInteger(item?.index) || seen.has(item.index)) continue;
    seen.add(item.index);
    list.push({
      index: item.index,
      name: item.name || `#${item.index}`,
      weight: normalizeVariantWeight(item.weight),
    });
    if (list.length >= MAX_EVENT_VARIANTS) break;
  }
  if (list.length) return list;
  if (Number.isInteger(binding?.sourceAnimationIndex)) {
    return [{
      index: binding.sourceAnimationIndex,
      name: binding.sourceAnimationName || `#${binding.sourceAnimationIndex}`,
      weight: 10,
    }];
  }
  return [];
}

/** 把权重换算成展示用的百分比，四舍五入后补齐到 100。 */
export function variantChances(variants) {
  const total = variants.reduce((sum, item) => sum + item.weight, 0);
  if (!total) return variants.map(() => 0);
  const raw = variants.map((item) => (item.weight / total) * 100);
  const rounded = raw.map((value) => Math.round(value));
  const drift = 100 - rounded.reduce((sum, value) => sum + value, 0);
  if (drift !== 0 && rounded.length) {
    let pick = 0;
    for (let i = 1; i < raw.length; i++) {
      if (Math.abs(raw[i] - rounded[i]) > Math.abs(raw[pick] - rounded[pick])) pick = i;
    }
    rounded[pick] += drift;
  }
  return rounded;
}

export function normalizeEventPriority(slotOrId, value) {
  const priority = Math.round(Number(value));
  if (!Number.isFinite(priority)) return defaultEventPriority(slotOrId);
  return Math.min(999, Math.max(0, priority));
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
const OTHER_ONLY_SLOT_IDS = new Set(['CS_Idle']);

export function slotGroups(modelType = 'vehicle') {
  const groups = new Map();
  for (const baseSlot of BINDING_SLOTS) {
    const slot = slotForMode(baseSlot, modelType);
    if (PAGE_HIDDEN_SLOT_IDS.has(slot.id)) continue;
    if (modelType !== 'other' && OTHER_ONLY_SLOT_IDS.has(slot.id)) continue;
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

/* ---------- 灯光质感：叠加层发光 + 路面光束 ---------- */

export function isLampSlot(slot) {
  return slot?.kind === 'lamp' || slot?.kind === 'blink';
}

/**
 * 路面光束的槽位默认值。长度/宽度按车长/车宽的倍数存储，任意尺寸的车型都能自适应。
 * 数值对齐官方 HcModel：近光路面 quad 约 2.2 倍车长、1.75 倍车宽，远光更长更亮。
 * 尾部灯光（刹车/倒车）默认关闭，需要时可手动打开在车尾投射红/白光晕。
 */
const BEAM_SLOT_DEFAULTS = {
  CS_Lower: { direction: 'front', enabled: true, length: 2.2, width: 1.75, intensity: 0.6, spread: 0.45 },
  CS_High: { direction: 'front', enabled: true, length: 2.8, width: 1.9, intensity: 0.75, spread: 0.6 },
  CS_Fog: { direction: 'front', enabled: true, length: 1.2, width: 1.9, intensity: 0.4, spread: 0.85 },
  CS_Stop: { direction: 'rear', enabled: false, length: 0.7, width: 1.4, intensity: 0.45, spread: 0.7 },
  CS_Backup: { direction: 'rear', enabled: false, length: 1.0, width: 1.3, intensity: 0.5, spread: 0.6 },
};

export const LAMP_GLOW_LIMITS = Object.freeze({
  intensity: [0.3, 1.5],
  core: [0, 1],
  detail: [0, 1],
  softness: [0, 1],
});

export const LAMP_BEAM_LIMITS = Object.freeze({
  length: [0.3, 5],
  width: [0.4, 3.5],
  intensity: [0.05, 1],
  spread: [0, 1],
  offset: [-0.3, 0.8], // 起点相对保险杠的前后偏移（×车长）
  side: [-0.5, 0.5], // 左右偏移（×车宽）
  height: [0, 0.1], // 离地高度（米）
  lobeSpacing: [0.1, 1.2], // 双光斑间距（×车宽）
  lobeWidth: [0, 1],
  falloff: [0, 1],
  haze: [0, 1],
});

export const BEAM_SHAPES = Object.freeze([
  { value: 'cone', label: '锥形光束' },
  { value: 'pool', label: '圆形光斑' },
  { value: 'bar', label: '平行光带' },
]);

export const BEAM_LOBE_MODES = Object.freeze([
  { value: 'auto', label: '按灯罩自动' },
  { value: 'single', label: '单光斑' },
  { value: 'double', label: '双光斑' },
]);

function normalizeHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function clampNumber(value, [min, max], fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function beamDirectionOf(slotOrId) {
  const id = typeof slotOrId === 'string' ? slotOrId : slotOrId?.id;
  return BEAM_SLOT_DEFAULTS[id]?.direction || null;
}

/** 发光质感：亮度、热白中心、保留原贴图纹理的程度、边缘柔化 */
export function normalizeLampGlow(value) {
  const stored = value && typeof value === 'object' ? value : {};
  return {
    intensity: clampNumber(stored.intensity, LAMP_GLOW_LIMITS.intensity, 1),
    core: clampNumber(stored.core, LAMP_GLOW_LIMITS.core, 0.45),
    detail: clampNumber(stored.detail, LAMP_GLOW_LIMITS.detail, 0.6),
    softness: clampNumber(stored.softness, LAMP_GLOW_LIMITS.softness, 0.3),
  };
}

/** 路面光束；不支持光束的槽位返回 null */
export function normalizeLampBeam(slotOrId, value) {
  const id = typeof slotOrId === 'string' ? slotOrId : slotOrId?.id;
  const defaults = BEAM_SLOT_DEFAULTS[id];
  if (!defaults) return null;
  const stored = value && typeof value === 'object' ? value : {};
  return {
    direction: defaults.direction,
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : defaults.enabled,
    shape: BEAM_SHAPES.some((item) => item.value === stored.shape) ? stored.shape : 'cone',
    lobeMode: BEAM_LOBE_MODES.some((item) => item.value === stored.lobeMode) ? stored.lobeMode : 'auto',
    lobeSpacing: clampNumber(stored.lobeSpacing, LAMP_BEAM_LIMITS.lobeSpacing, 0.6),
    lobeWidth: clampNumber(stored.lobeWidth, LAMP_BEAM_LIMITS.lobeWidth, 0.4),
    length: clampNumber(stored.length, LAMP_BEAM_LIMITS.length, defaults.length),
    width: clampNumber(stored.width, LAMP_BEAM_LIMITS.width, defaults.width),
    offset: clampNumber(stored.offset, LAMP_BEAM_LIMITS.offset, 0.06),
    side: clampNumber(stored.side, LAMP_BEAM_LIMITS.side, 0),
    height: clampNumber(stored.height, LAMP_BEAM_LIMITS.height, 0.02),
    intensity: clampNumber(stored.intensity, LAMP_BEAM_LIMITS.intensity, defaults.intensity),
    spread: clampNumber(stored.spread, LAMP_BEAM_LIMITS.spread, defaults.spread),
    falloff: clampNumber(stored.falloff, LAMP_BEAM_LIMITS.falloff, 0.45),
    haze: clampNumber(stored.haze, LAMP_BEAM_LIMITS.haze, 0.35),
    // null = 跟随点亮颜色
    color: normalizeHexColor(stored.color),
  };
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
