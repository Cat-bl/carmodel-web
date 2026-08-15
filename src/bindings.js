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

// 页面暂时隐藏这三个绑定入口；槽位定义和导出兼容逻辑继续保留，方便后续恢复。
const PAGE_HIDDEN_SLOT_IDS = new Set([
  'CS_Clearance', // 示宽灯
  'CS_Fog', // 雾灯
  'CS_Backup', // 倒车灯
]);

export function slotGroups() {
  const groups = new Map();
  for (const slot of BINDING_SLOTS) {
    if (PAGE_HIDDEN_SLOT_IDS.has(slot.id)) continue;
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
export function defaultParams(slot, bounds) {
  const center = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const params = { pivot: center, axis: slot.axis, angle: slot.angle, color: slot.color };
  if (slot.kind === 'hinge') {
    // 铰链在部件的车头侧或车尾侧边缘（X 为纵向，−X 是车头）
    params.pivot = [slot.hinge === 'front' ? bounds.min[0] : bounds.max[0], center[1], center[2]];
  }
  if (slot.kind === 'spin') {
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
  const custom = Number(params.duration);
  const duration = (slot.kind === 'spin' || slot.kind === 'hinge') && Number.isFinite(custom) && custom > 0
    ? Math.min(5, Math.max(0.2, custom))
    : DURATION;
  const times = [];
  for (let i = 0; i < KEYFRAME_COUNT; i++) {
    times.push((i * duration) / (KEYFRAME_COUNT - 1));
  }

  if (slot.kind === 'blink') {
    const values = [];
    for (const s of BLINK_SCALE) values.push(s, s, s);
    return { path: 'scale', times, values };
  }

  const axis = AXIS_VECTOR[params.axis || slot.axis || 'z'];
  const values = [];
  for (let i = 0; i < KEYFRAME_COUNT; i++) {
    const progress = i / (KEYFRAME_COUNT - 1);
    let degrees;
    if (slot.kind === 'spin') {
      degrees = progress * 360 * (params.reverse ? -1 : 1);
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

export function suggestRegion(slot, bounds) {
  const hint = REGION_HINTS[slot.id] || { x: [0.35, 0.65], y: [0.35, 0.65], z: [0.35, 0.65] };
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
