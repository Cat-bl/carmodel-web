/**
 * 灯光质感：叠加层点亮贴图 + 路面光束。
 *
 * 照抄官方车模的结构（HcModel/U8/U8L/U7 实测一致）：
 * - 灯不从车身切下来，而是在灯罩表面铺一层薄叠加面片（材质 BLEND + doubleSided）。
 *   亮时车机换成外部的 CS_XXX.png“点亮图集”，灭时回退到 GLB 内嵌的全透明贴图，叠加层隐形。
 * - 近光/远光额外带一块车前路面 quad，贴图是从左右大灯位置向前渐隐的两个光斑。
 *
 * 本模块只做像素与几何计算，不依赖 three.js 与 glTF 结构，导出与预览共用同一份真相。
 * 坐标约定：X 纵向（−X 车头）、Y 竖直向上、Z 横向（+Z 左 / −Z 右）。
 */

export const LAMP_ATLAS_MAX = 1024;
export const LAMP_BEAM_CELL = 256;
const CELL_PAD = 4;
const DILATE_PX = 3;

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  return Object.assign(document.createElement('canvas'), { width, height });
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / Math.max(1e-9, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function nextPow2(value) {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

/** #rrggbb → [r, g, b] 0~1 */
export function hexToRgb(hex) {
  const value = String(hex || '#ffffff').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map((at) => (parseInt(full.slice(at, at + 2), 16) || 0) / 255);
}

function luminance(r, g, b) {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** 叠加层沿法线外推的距离：随车长缩放，1~4 mm，既不穿模也不悬空 */
export function lampOverlayOffset(carLength) {
  return Math.min(0.004, Math.max(0.001, (Number(carLength) || 0) * 0.0004));
}

/** 没有 UV 的灯罩几何按最大的两个轴投影出一套平面 UV，保证任何模型都能画出点亮贴图 */
export function synthesizePlanarUv(positions, vertexCount) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  const extents = [0, 1, 2].map((axis) => ({ axis, size: max[axis] - min[axis] }))
    .sort((a, b) => b.size - a.size);
  const [a, b] = [extents[0], extents[1]];
  const uv = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    uv[i * 2] = a.size > 1e-9 ? (positions[i * 3 + a.axis] - min[a.axis]) / a.size : 0.5;
    uv[i * 2 + 1] = b.size > 1e-9 ? (positions[i * 3 + b.axis] - min[b.axis]) / b.size : 0.5;
  }
  return uv;
}

/**
 * 路面光束 quad（世界坐标，也就是车机最终空间）。
 * 官方近光 quad 起于保险杠前方一小段、贴地 2~5 cm；这里按车尺寸按比例复刻。
 * UV：近车端 v=1，远端 v=0；u=0 在 +Z（左）侧。
 */
export function beamQuadGeometry({ direction, bounds, beam }) {
  const length = bounds.max[0] - bounds.min[0];
  const width = bounds.max[2] - bounds.min[2];
  const gap = (Number.isFinite(beam.offset) ? beam.offset : 0.06) * length;
  const reach = beam.length * length;
  const halfWidth = (beam.width * width) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2 + (Number.isFinite(beam.side) ? beam.side : 0) * width;
  const y = bounds.min[1] + (Number.isFinite(beam.height) ? beam.height : 0.02);
  const front = direction !== 'rear';
  const near = front ? bounds.min[0] - gap : bounds.max[0] + gap;
  const far = front ? near - reach : near + reach;
  const positions = Float32Array.from([
    near, y, centerZ + halfWidth,
    near, y, centerZ - halfWidth,
    far, y, centerZ - halfWidth,
    far, y, centerZ + halfWidth,
  ]);
  return {
    positions,
    normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uv: Float32Array.from([0, 1, 1, 1, 1, 0, 0, 0]),
    // 保持法线朝上的环绕方向
    indices: front ? Uint32Array.from([0, 1, 2, 0, 2, 3]) : Uint32Array.from([0, 2, 1, 0, 3, 2]),
    halfWidth,
    centerZ,
    near,
    far,
  };
}

/**
 * 把灯罩几何的横向坐标聚成 1~2 个光斑（左右各一盏 → 两个；单盏中置 → 一个），
 * 返回它们在光束贴图上的 u 位置。任何车型（含摩托、只绑了一侧）都能得到合理结果。
 */
export function beamLobesFromZ(zValues, { centerZ, halfWidth, carWidth }) {
  const uOf = (z) => clamp01((centerZ + halfWidth - z) / Math.max(1e-6, 2 * halfWidth));
  if (!zValues.length) return [uOf(centerZ)];
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const z of zValues) {
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  if (zMax - zMin > carWidth * 0.3) {
    const mid = (zMin + zMax) / 2;
    let leftSum = 0;
    let leftCount = 0;
    let rightSum = 0;
    let rightCount = 0;
    for (const z of zValues) {
      if (z > mid) { leftSum += z; leftCount++; } else { rightSum += z; rightCount++; }
    }
    return [uOf(leftSum / Math.max(1, leftCount)), uOf(rightSum / Math.max(1, rightCount))];
  }
  let sum = 0;
  for (const z of zValues) sum += z;
  return [uOf(sum / zValues.length)];
}

/** 按“光斑分布”设置给出光斑位置：自动按灯罩几何聚类，或固定单/双光斑（双光斑间距可调） */
export function beamLobes(zValues, geometry, beam) {
  const { halfWidth, carWidth } = geometry;
  if (beam.lobeMode === 'single') return [0.5];
  if (beam.lobeMode === 'double') {
    const half = clamp01((beam.lobeSpacing * carWidth) / 2 / Math.max(1e-6, 2 * halfWidth));
    return [clamp01(0.5 - half), clamp01(0.5 + half)];
  }
  return beamLobesFromZ(zValues, geometry);
}

/* ---------- 图集布局 ---------- */

function packCells(sizes, maxSize) {
  let scale = 1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scaled = sizes.map((size) => ({
      w: Math.max(32, Math.round(size.w * scale)),
      h: Math.max(32, Math.round(size.h * scale)),
    }));
    const totalArea = scaled.reduce((sum, size) => sum + size.w * size.h, 0);
    const maxCell = scaled.reduce((max, size) => Math.max(max, size.w, size.h), 1);
    let width = Math.min(maxSize, Math.max(nextPow2(Math.ceil(Math.sqrt(totalArea * 1.15))), nextPow2(maxCell)));
    while (width <= maxSize) {
      const order = scaled.map((size, index) => ({ ...size, index }))
        .sort((a, b) => b.h - a.h || b.w - a.w);
      const cells = new Array(scaled.length);
      let x = 0;
      let y = 0;
      let rowHeight = 0;
      for (const item of order) {
        if (x + item.w > width) {
          x = 0;
          y += rowHeight;
          rowHeight = 0;
        }
        cells[item.index] = { x, y, w: item.w, h: item.h };
        x += item.w;
        rowHeight = Math.max(rowHeight, item.h);
      }
      const height = nextPow2(y + rowHeight);
      if (height <= maxSize) return { width, height, cells };
      if (width >= maxSize) break;
      width *= 2;
    }
    scale *= 0.5;
  }
  throw new Error('灯光图集布局失败');
}

/* ---------- 光栅化与距离场 ---------- */

/** 保守光栅化：像素中心到三条边的带符号距离都 ≥ −0.7px 即视为覆盖，细长三角形也不会漏掉 */
function rasterizeTriangles(mask, width, height, points, indices) {
  const tolerance = -0.7;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ax = points[indices[t] * 2];
    const ay = points[indices[t] * 2 + 1];
    const bx = points[indices[t + 1] * 2];
    const by = points[indices[t + 1] * 2 + 1];
    const cx = points[indices[t + 2] * 2];
    const cy = points[indices[t + 2] * 2 + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!Number.isFinite(area)) continue;
    const sign = area >= 0 ? 1 : -1;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1);
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1);
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)) + 1);
    const lenAB = Math.hypot(bx - ax, by - ay) || 1;
    const lenBC = Math.hypot(cx - bx, cy - by) || 1;
    const lenCA = Math.hypot(ax - cx, ay - cy) || 1;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const dAB = (((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * sign) / lenAB;
        if (dAB < tolerance) continue;
        const dBC = (((cx - bx) * (py - by) - (cy - by) * (px - bx)) * sign) / lenBC;
        if (dBC < tolerance) continue;
        const dCA = (((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * sign) / lenCA;
        if (dCA < tolerance) continue;
        mask[y * width + x] = 1;
      }
    }
  }
}

/** 3-4 倒角距离变换：target 像素到最近非 target 像素的距离（像素） */
function chamferDistance(mask, width, height, target) {
  const dist = new Float32Array(width * height);
  const INF = 1e9;
  for (let i = 0; i < dist.length; i++) dist[i] = mask[i] === target ? INF : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      let d = dist[at];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[at - 1] + 3);
      if (y > 0) {
        d = Math.min(d, dist[at - width] + 3);
        if (x > 0) d = Math.min(d, dist[at - width - 1] + 4);
        if (x < width - 1) d = Math.min(d, dist[at - width + 1] + 4);
      }
      dist[at] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const at = y * width + x;
      let d = dist[at];
      if (d === 0) continue;
      if (x < width - 1) d = Math.min(d, dist[at + 1] + 3);
      if (y < height - 1) {
        d = Math.min(d, dist[at + width] + 3);
        if (x < width - 1) d = Math.min(d, dist[at + width + 1] + 4);
        if (x > 0) d = Math.min(d, dist[at + width - 1] + 4);
      }
      dist[at] = d;
    }
  }
  for (let i = 0; i < dist.length; i++) dist[i] = dist[i] >= INF ? 0 : dist[i] / 3;
  return dist;
}

/* ---------- 采样 ---------- */

function sampleImage(image, u, v) {
  const { width, height, data } = image;
  const fx = (u - Math.floor(u)) * width - 0.5;
  const fy = (v - Math.floor(v)) * height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const wrapX = (x) => ((x % width) + width) % width;
  const wrapY = (y) => ((y % height) + height) % height;
  const xa = wrapX(x0);
  const xb = wrapX(x0 + 1);
  const ya = wrapY(y0);
  const yb = wrapY(y0 + 1);
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = data[(ya * width + xa) * 4 + c] * (1 - tx) + data[(ya * width + xb) * 4 + c] * tx;
    const bottom = data[(yb * width + xa) * 4 + c] * (1 - tx) + data[(yb * width + xb) * 4 + c] * tx;
    out[c] = (top * (1 - ty) + bottom * ty) / 255;
  }
  return out;
}

function uvBoundsOf(uv, indices) {
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < indices.length; i++) {
    const u = uv[indices[i] * 2];
    const v = uv[indices[i] * 2 + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  if (!Number.isFinite(u0)) return { u0: 0, v0: 0, u1: 1, v1: 1 };
  // 平铺贴图的超大 UV 跨度截到一个周期，避免图集被撑爆
  if (u1 - u0 > 1) u1 = u0 + 1;
  if (v1 - v0 > 1) v1 = v0 + 1;
  return { u0, v0, u1: Math.max(u1, u0 + 1e-4), v1: Math.max(v1, v0 + 1e-4) };
}

/* ---------- 绘制 ---------- */

function paintLampCell(atlas, cell, piece, tint, glow) {
  const { width: atlasWidth, data } = atlas;
  const innerW = cell.w - CELL_PAD * 2;
  const innerH = cell.h - CELL_PAD * 2;
  const { u0, v0, u1, v1 } = piece.bounds;
  const du = u1 - u0;
  const dv = v1 - v0;
  const points = new Float32Array(piece.vertexCount * 2);
  for (let i = 0; i < piece.vertexCount; i++) {
    points[i * 2] = CELL_PAD + ((piece.uv[i * 2] - u0) / du) * innerW;
    points[i * 2 + 1] = CELL_PAD + ((piece.uv[i * 2 + 1] - v0) / dv) * innerH;
  }
  const mask = new Uint8Array(cell.w * cell.h);
  rasterizeTriangles(mask, cell.w, cell.h, points, piece.indices);
  const inside = chamferDistance(mask, cell.w, cell.h, 1);
  const outside = chamferDistance(mask, cell.w, cell.h, 0);

  // 亮度归一化：按选区内 10%/90% 分位拉开，深色灯罩贴图也能显出纹理
  const samples = [];
  let dMax = 1;
  const colors = new Float32Array(cell.w * cell.h * 3);
  for (let ly = 0; ly < cell.h; ly++) {
    for (let lx = 0; lx < cell.w; lx++) {
      const at = ly * cell.w + lx;
      if (mask[at] === 0 && outside[at] > DILATE_PX) continue;
      const u = u0 + ((lx + 0.5 - CELL_PAD) / innerW) * du;
      const v = v0 + ((ly + 0.5 - CELL_PAD) / innerH) * dv;
      const rgb = piece.image ? sampleImage(piece.image, u, v) : piece.baseColor;
      colors[at * 3] = rgb[0];
      colors[at * 3 + 1] = rgb[1];
      colors[at * 3 + 2] = rgb[2];
      if (mask[at]) {
        samples.push(luminance(rgb[0], rgb[1], rgb[2]));
        if (inside[at] > dMax) dMax = inside[at];
      }
    }
  }
  if (samples.length === 0) return;
  samples.sort((a, b) => a - b);
  const lumLow = samples[Math.floor(samples.length * 0.1)];
  const lumHigh = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))];
  const lumRange = lumHigh - lumLow;
  const flat = lumRange < 0.04;

  const brightness = clamp01(glow.intensity);
  const whiteBoost = Math.max(0, glow.intensity - 1) * 0.6;
  const feather = glow.softness * 0.4 * dMax;
  for (let ly = 0; ly < cell.h; ly++) {
    for (let lx = 0; lx < cell.w; lx++) {
      const at = ly * cell.w + lx;
      const covered = mask[at] === 1;
      if (!covered && outside[at] > DILATE_PX) continue;
      const rgb = [colors[at * 3], colors[at * 3 + 1], colors[at * 3 + 2]];
      const lum = flat ? 0.5 : clamp01((luminance(rgb[0], rgb[1], rgb[2]) - lumLow) / lumRange);
      const modulation = 1 - glow.detail + glow.detail * (0.3 + 0.7 * lum);
      const depth = covered ? inside[at] : 0;
      const coreT = glow.core * clamp01(depth / (dMax * 0.9)) ** 1.4;
      const out = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const base = tint[c] * modulation;
        const lit = base + (1 - base) * coreT;
        out[c] = lit + (1 - lit) * whiteBoost;
      }
      let alpha = brightness;
      if (feather > 0) alpha *= smoothstep(0, feather + 1, depth);
      else if (!covered) alpha = brightness; // 无柔化时外扩一圈实色，防止双线性采样把透明边缘混进来
      const index = ((cell.y + ly) * atlasWidth + cell.x + lx) * 4;
      data[index] = Math.round(clamp01(out[0]) * 255);
      data[index + 1] = Math.round(clamp01(out[1]) * 255);
      data[index + 2] = Math.round(clamp01(out[2]) * 255);
      data[index + 3] = Math.round(clamp01(alpha) * 255);
    }
  }
}

/**
 * 路面光束贴图。复刻官方 CS_Lower.png 的形态：近车端两个光斑最亮，沿路面快速衰减并逐渐扩散，
 * 远端完全消失；远光更亮、更长并带整片弱雾感（spread 越大扩散越快、雾感越强）。
 */
function paintBeamCell(atlas, cell, beam, tint) {
  const { width: atlasWidth, data } = atlas;
  const rgb = [0, 1, 2].map((c) => 1 - 0.4 * (1 - tint[c]));
  const lobes = beam.lobes?.length ? beam.lobes : [0.5];
  const spread = clamp01(beam.spread);
  const falloff = clamp01(Number.isFinite(beam.falloff) ? beam.falloff : 0.45);
  const hazeWeight = 0.5 * clamp01(Number.isFinite(beam.haze) ? beam.haze : 0.35);
  const lobeWidth = clamp01(Number.isFinite(beam.lobeWidth) ? beam.lobeWidth : 0.4);
  const shape = beam.shape || 'cone';
  const sigma0 = 0.04 + 0.14 * lobeWidth;
  // 锥形：光斑与雾感随距离展宽；平行光带：宽度基本不变
  const growth = shape === 'bar' ? 0.3 * spread : 0.6 + 3.4 * spread;
  const nearFall = shape === 'bar' ? 0.3 + 0.9 * falloff : 0.08 + 0.32 * falloff;
  const farFall = 0.3 + 0.5 * falloff;
  const hazeSigma0 = 0.1 + 0.15 * spread;
  // 圆形光斑：每个光斑是一团椭圆光晕，中心落在近车端前方一点
  const poolU = 0.08 + 0.3 * lobeWidth;
  const poolT = 0.2 + 0.45 * falloff;
  const poolCenterT = 0.22;
  for (let ly = 0; ly < cell.h; ly++) {
    const t = 1 - ly / (cell.h - 1); // 0 = 近车端（贴图底部，v=1），1 = 远端
    const sigma = sigma0 * (1 + growth * t);
    const hazeSigma = hazeSigma0 * (1 + growth * t);
    const along = Math.min(1, 0.85 * Math.exp(-t / nearFall) + 0.25 * Math.exp(-t / farFall));
    // 无论参数怎么调，贴图四边都归零，否则 quad 的矩形轮廓会直接印在路面上
    const envelope = (shape === 'pool' ? 1 : along) * (1 - smoothstep(0.7, 1, t)) * smoothstep(0, 0.1, t);
    for (let lx = 0; lx < cell.w; lx++) {
      const u = lx / (cell.w - 1);
      const lateral = 1 - smoothstep(0.5, 1, Math.abs(u * 2 - 1));
      let lobe = 0;
      for (const center of lobes) {
        const d = (u - center) / sigma;
        if (shape === 'pool') {
          const dt = (t - poolCenterT) / poolT;
          const du = (u - center) / poolU;
          lobe += Math.exp(-0.5 * (du * du + dt * dt));
        } else {
          lobe += Math.exp(-0.5 * d * d);
        }
      }
      lobe = Math.min(1, lobe);
      const hd = (u - 0.5) / hazeSigma;
      const haze = Math.exp(-0.5 * hd * hd) * hazeWeight * (shape === 'pool' ? along : 1);
      const alpha = beam.intensity * envelope * lateral * Math.min(1, lobe + haze * (1 - lobe));
      const index = ((cell.y + ly) * atlasWidth + cell.x + lx) * 4;
      data[index] = Math.round(rgb[0] * 255);
      data[index + 1] = Math.round(rgb[1] * 255);
      data[index + 2] = Math.round(rgb[2] * 255);
      data[index + 3] = Math.round(clamp01(alpha) * 255);
    }
  }
}

/**
 * 生成一个灯位的点亮图集。
 * pieces: [{ uv: Float32Array, indices: ArrayLike<number>, vertexCount, image: ImageData|null, baseColor: [r,g,b] 0~1 }]
 *   每个 piece 是叠加层里来自同一源 primitive 的一组三角形；原 UV 区域会被裁剪进图集的独立格子，
 *   因此多张源贴图、任意 UV 布局都能共用一张点亮贴图（车机每个灯位只认一张 CS_XXX.png）。
 * beam: null | { lobes: number[], intensity, spread }
 * 返回 { canvas, width, height, pieceUvs: Float32Array[]（已重映射到图集）, beamUv: {u0,v0,u1,v1}|null }
 */
export function buildLampArtwork({ pieces = [], beam = null, color = '#ffffff', glow = {} }) {
  const tint = hexToRgb(color);
  const glowParams = {
    intensity: Number.isFinite(glow.intensity) ? glow.intensity : 1,
    core: Number.isFinite(glow.core) ? glow.core : 0.45,
    detail: Number.isFinite(glow.detail) ? glow.detail : 0.6,
    softness: Number.isFinite(glow.softness) ? glow.softness : 0.3,
  };
  // 不过滤 piece：返回的 pieceUvs 必须与传入顺序一一对应；空 piece 只是画不出内容
  const prepared = pieces
    .map((piece) => {
      const bounds = uvBoundsOf(piece.uv, piece.indices);
      const sourceW = piece.image ? (bounds.u1 - bounds.u0) * piece.image.width : 96;
      const sourceH = piece.image ? (bounds.v1 - bounds.v0) * piece.image.height : 96;
      const size = Math.min(512, Math.max(64, nextPow2(Math.max(sourceW, sourceH) + CELL_PAD * 2)));
      return { ...piece, bounds, size };
    });
  if (prepared.length === 0 && !beam) {
    const canvas = createCanvas(4, 4);
    return { canvas, width: 4, height: 4, pieceUvs: [], beamUv: null };
  }
  const sizes = prepared.map((piece) => ({ w: piece.size, h: piece.size }));
  if (beam) sizes.push({ w: LAMP_BEAM_CELL, h: LAMP_BEAM_CELL });
  const layout = packCells(sizes, LAMP_ATLAS_MAX);
  const atlas = new ImageData(layout.width, layout.height);
  prepared.forEach((piece, index) => paintLampCell(atlas, layout.cells[index], piece, tint, glowParams));
  let beamUv = null;
  if (beam) {
    const cell = layout.cells[prepared.length];
    // 光束可以单独指定颜色，默认跟随点亮颜色
    paintBeamCell(atlas, cell, beam, beam.color ? hexToRgb(beam.color) : tint);
    // 内缩一像素，避免双线性采样吃到相邻格子
    beamUv = {
      u0: (cell.x + 1) / layout.width,
      v0: (cell.y + 1) / layout.height,
      u1: (cell.x + cell.w - 1) / layout.width,
      v1: (cell.y + cell.h - 1) / layout.height,
    };
  }
  const canvas = createCanvas(layout.width, layout.height);
  canvas.getContext('2d').putImageData(atlas, 0, 0);
  const pieceUvs = prepared.map((piece, index) => {
    const cell = layout.cells[index];
    const innerW = cell.w - CELL_PAD * 2;
    const innerH = cell.h - CELL_PAD * 2;
    const { u0, v0, u1, v1 } = piece.bounds;
    const out = new Float32Array(piece.vertexCount * 2);
    for (let i = 0; i < piece.vertexCount; i++) {
      const u = (piece.uv[i * 2] - u0) / (u1 - u0);
      const v = (piece.uv[i * 2 + 1] - v0) / (v1 - v0);
      out[i * 2] = (cell.x + CELL_PAD + u * innerW) / layout.width;
      out[i * 2 + 1] = (cell.y + CELL_PAD + v * innerH) / layout.height;
    }
    return out;
  });
  return { canvas, width: layout.width, height: layout.height, pieceUvs, beamUv };
}

/** 灭灯态使用的内嵌全透明贴图（官方每个灯位内嵌一张 24×24 透明图） */
export function createTransparentLampCanvas(size = 24) {
  const canvas = createCanvas(size, size);
  canvas.getContext('2d').clearRect(0, 0, size, size);
  return canvas;
}
