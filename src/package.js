import JSZip from 'jszip';
import { MeshoptSimplifier } from 'meshoptimizer';
import { SLOT_BY_ID, animationNamesOf, buildKeyframes, parseColor } from './bindings.js';
import { createCarShadowCanvas, shadowFootprint } from './shadow.js';
import { selectedTriangles } from './selection.js';

const CARSELF_HEADER_URL = './templates/hcmodel-header.bin';
const TAIL = new Uint8Array([0x0b, 0x00, 0x00, 0x00]);
const GLB_BUDGET = 32 * 1024 * 1024 - 4096;
// 车机实时渲染预算：比旧版 100k 保守得多，优先保留车身轮廓和曲面细节。
const DEVICE_TRIANGLE_TARGET = 300000;
let headerPromise = null;
// 灯/闪烁槽位的材质不做方向渐变：灭灯态（textureId=-1）显示的是 baseColorFactor，必须保持纯色
const LAMP_SLOT_IDS = new Set(
  [...SLOT_BY_ID.values()].filter((slot) => slot.kind === 'lamp' || slot.kind === 'blink').map((slot) => slot.id),
);

export async function makeBydCar({ sourceBytes, sourceName, transform, stats, bindings, deletions }) {
  const parsed = parseGlb(sourceBytes);
  const baked = await bakeMaterialsForVehicle(parsed);
  const lamps = [];
  const normalizedState = await normalizeParsedGlb(baked, transform, bindings, lamps, deletions);
  await fitGlbBudget(normalizedState);
  await simplifyMeshToBudget(normalizedState);
  const normalized = buildGlb(normalizedState.json, normalizedState.bin);
  const outputStats = collectGlbStats(normalizedState.json);
  // 外部 CarSelf_Main.png 必须与最终 GLB 内嵌主贴图逐像素一致，原厂资源也是这个约定。
  const mainTexture = await extractMainTexture(normalizedState);
  const shadowTexture = extractNamedTexture(normalizedState, 'CS_Shadow');
  const dat = await wrapCarSelf(normalized);
  const datHash = await sha256(dat);
  const glbHash = await sha256(normalized);
  const manifest = {
    format: 'com.byd.launchermap.bydcar',
    formatVersion: 1,
    name: sourceName.replace(/\.glb$/i, ''),
    generator: 'byd-car-converter-web/0.1.0',
    target: 'lane-car-v1',
    model: {
      path: 'payload/CarSelf.dat',
      size: dat.byteLength,
      sha256: datHash,
      glbSize: normalized.byteLength,
      glbSha256: glbHash,
      scene: 0,
      rootNode: 'CS_Car',
      stats,
      outputStats,
    },
  };

  const files = [
    { path: 'payload/Texture/CarSelf_Main.png', bytes: mainTexture.bytes },
    { path: 'payload/Texture/CS_Shadow.png', bytes: shadowTexture.bytes },
  ];
  // 每个灯位随包附带一张纯色贴图，车机点亮时按 CS_XXX.png 取用
  for (const lamp of lamps) {
    files.push({ path: `payload/Texture/${lamp.slotId}.png`, bytes: await makeLampTexture(lamp.color) });
  }
  manifest.resources = [];
  for (const file of files) {
    manifest.resources.push({
      path: file.path, size: file.bytes.byteLength, sha256: await sha256(file.bytes),
    });
  }
  if (bindings?.length) {
    manifest.bindings = bindings.map((binding) => ({
      slot: binding.slotId, source: binding.sourceName || '', region: Boolean(binding.region),
    }));
  }

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2), { createFolders: false });
  zip.file('payload/CarSelf.dat', dat, { compression: 'STORE', createFolders: false });
  for (const file of files) {
    zip.file(file.path, file.bytes, { compression: 'STORE', createFolders: false });
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  return { bytes, manifest, dat, glb: normalized };
}

/** 灯位贴图：整图纯色。官方是共享 UV 图集，自定义模型没有那套 UV 约定，纯色才通用。 */
async function makeLampTexture(color) {
  const [r, g, b] = parseColor(color);
  const canvas = makeCanvas(64, 64);
  const context = canvas.getContext('2d');
  context.fillStyle = `rgb(${r},${g},${b})`;
  context.fillRect(0, 0, 64, 64);
  return encodeCanvasPng(canvas);
}

/**
 * 车机渲染器只支持底色贴图 + 简单光照（无环境反射、无自发光/法线/AO、
 * 不认 sheen/clearcoat/transmission 扩展）。
 * 这里把 PBR 观感按像素烘焙进底色贴图：AO 相乘、金属变暗补偿、自发光相加，
 * 并按“金属度 + 光泽度”补一项常数环境反射——黑色金属漆/钢琴漆的观感全靠反射天空，
 * 没有这一项在车机上会烘成纯黑剪影（实车已验证）。
 */
const METAL_DARKEN = 0.45;
const ENV_REFLECT = 0.08; // 带贴图材质的均匀环境补偿（轻量，避免整体发白）
const GLOSS_REFLECT = 0.35; // 非金属但高光泽（清漆/玻璃）按光泽度折算的反射比例

/**
 * 无贴图的高反射纯色材质（典型：车漆）走“方向渐变”烘焙，照抄官方黑车的做法：
 * 官方 U8L 实测——车顶画成接近底色的深色（线性 0.012，保住“黑车”身份），
 * 车身侧面把天空反光直接画进贴图（线性 0.39，质感全靠它）。
 * 这里程序化复刻：UV.v 编码世界法线仰角，采样一条“顶暗侧亮”的渐变；
 * 所有渐变材质共用一张图集（每材质一列），不挤占车机 16 张贴图的上限。
 */
const GRAD_SIDE = 0.35; // 侧面（水平法线）反射峰值，对齐官方侧板亮度
const GRAD_POWER = 2.4; // 压低大面积垂直侧面的亮度，把高光收进曲面转折
const GRAD_MARK = '__gradientBake';

/** 环境反射强度：金属反射整个环境，非金属按光泽度反射一小份 */
function reflectStrength(metal, roughness) {
  const gloss = Math.max(0, 1 - roughness);
  return metal + (1 - metal) * gloss * GLOSS_REFLECT;
}

async function bakeMaterialsForVehicle(parsed) {
  const json = structuredClone(parsed.json);
  const state = { json, bin: parsed.bin };
  if (!Array.isArray(json.materials)) return state;

  const bakedCache = new Map();
  for (const material of json.materials) {
    const pbr = material.pbrMetallicRoughness || (material.pbrMetallicRoughness = {});

    const sheen = material.extensions?.KHR_materials_sheen;
    if (Array.isArray(sheen?.sheenColorFactor)) {
      const base = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : [1, 1, 1, 1];
      pbr.baseColorFactor = [
        Math.max(base[0], sheen.sheenColorFactor[0] || 0),
        Math.max(base[1], sheen.sheenColorFactor[1] || 0),
        Math.max(base[2], sheen.sheenColorFactor[2] || 0),
        base[3] ?? 1,
      ];
    }

    const metallicFactor = pbr.metallicFactor ?? 1;
    const roughnessFactor = pbr.roughnessFactor ?? 1;
    const factor = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : [1, 1, 1, 1];
    const baseImage = imageIndexOf(json, pbr.baseColorTexture);
    const mrImage = metallicFactor > 0 ? imageIndexOf(json, pbr.metallicRoughnessTexture) : undefined;
    const aoImage = imageIndexOf(json, material.occlusionTexture);
    const occlusionStrength = material.occlusionTexture?.strength ?? 1;
    const emissiveFactor = Array.isArray(material.emissiveFactor) ? material.emissiveFactor : [0, 0, 0];
    const emisImage = emissiveFactor.some((value) => value > 0)
      ? imageIndexOf(json, material.emissiveTexture) : undefined;

    // 车机对 baseColorFactor 的支持不可靠：带贴图的颜色系数必须烘进像素，否则黑漆会按白贴图显示成银灰。
    // 反射补偿又是加法，同样无法只靠 factor 表达，所以凡是有底色贴图的材质都统一烘焙。
    const ambientVisible = ENV_REFLECT * reflectStrength(metallicFactor, roughnessFactor) >= 0.02;
    const needsPixelBake = Number.isInteger(baseImage)
      ? true
      : Number.isInteger(emisImage);
    if (needsPixelBake) {
      const cacheKey = [baseImage, mrImage, aoImage, emisImage, metallicFactor, roughnessFactor,
        occlusionStrength, factor.join(','), emissiveFactor.join(',')].join('|');
      let bakedTexture = bakedCache.get(cacheKey);
      if (bakedTexture === undefined) {
        bakedTexture = null;
        try {
          const png = await bakeAlbedoPng(state, {
            baseImage, factor, mrImage, metallicFactor, roughnessFactor,
            aoImage, occlusionStrength, emisImage, emissiveFactor,
          });
          const bufferView = appendImageToBin(state, png);
          if (!Array.isArray(json.images)) json.images = [];
          if (!Array.isArray(json.textures)) json.textures = [];
          json.images.push({ mimeType: 'image/png', bufferView });
          json.textures.push({ source: json.images.length - 1 });
          bakedTexture = json.textures.length - 1;
        } catch (error) {
          console.warn('材质烘焙失败，保留原贴图', error);
        }
        bakedCache.set(cacheKey, bakedTexture);
      }
      if (bakedTexture !== null) {
        pbr.baseColorTexture = { index: bakedTexture };
        pbr.baseColorFactor = [1, 1, 1, 1];
      }
    } else {
      const reflect = reflectStrength(metallicFactor, roughnessFactor);
      const darken = 1 - METAL_DARKEN * metallicFactor;
      const ambient = Math.min(0.025, ENV_REFLECT * reflect * 0.35);
      if (metallicFactor > 0 || ambientVisible) {
        // 纯色材质闭式保底：金属压暗漫反射，再按反射强度补一点均匀环境色
        const fallbackAmbient = ENV_REFLECT * reflect;
        pbr.baseColorFactor = [
          Math.min(1, factor[0] * darken + fallbackAmbient),
          Math.min(1, factor[1] * darken + fallbackAmbient),
          Math.min(1, factor[2] * darken + fallbackAmbient),
          factor[3] ?? 1,
        ];
      }
      // 所有无贴图材质都进入同一张图集，彻底消除对 baseColorFactor 的依赖。
      // 高反射材质得到“顶暗侧亮”渐变，普通材质则是同底色的纯色列。
      material.extras = {
        ...(material.extras || {}),
        [GRAD_MARK]: {
          // 极暗车漆补少量环境底光，避免地图简单光照再次压成纯黑剪影。
          base: [factor[0] * darken + ambient, factor[1] * darken + ambient, factor[2] * darken + ambient],
          reflect,
          alpha: factor[3] ?? 1,
        },
      };
    }

    pbr.metallicFactor = 0;
    // 官方四套 CarSelf 材质均使用 0.5；保持一致，避免 0.9 把所有漆面高光抹平。
    pbr.roughnessFactor = 0.5;
    delete pbr.metallicRoughnessTexture;
    delete material.normalTexture;
    delete material.occlusionTexture;
    delete material.emissiveTexture;
    material.emissiveFactor = [0, 0, 0];
    delete material.extensions;
  }
  return state;
}

function imageIndexOf(json, textureRef) {
  const source = json.textures?.[textureRef?.index]?.source;
  return Number.isInteger(source) ? source : undefined;
}

function appendImageToBin(state, bytes) {
  const aligned = pad(state.bin, 0);
  const merged = new Uint8Array(aligned.byteLength + bytes.byteLength);
  merged.set(aligned);
  merged.set(bytes, aligned.byteLength);
  if (!Array.isArray(state.json.bufferViews)) state.json.bufferViews = [];
  state.json.bufferViews.push({ buffer: 0, byteOffset: aligned.byteLength, byteLength: bytes.byteLength });
  state.bin = merged;
  if (state.json.buffers?.[0]) state.json.buffers[0].byteLength = merged.byteLength;
  return state.json.bufferViews.length - 1;
}

function imageBytesOf(state, imageIndex) {
  const image = state.json.images?.[imageIndex];
  if (!image || !Number.isInteger(image.bufferView)) return null;
  const view = state.json.bufferViews?.[image.bufferView];
  if (!view || view.buffer !== 0) return null;
  const offset = view.byteOffset || 0;
  if (offset + view.byteLength > state.bin.byteLength) return null;
  return { bytes: state.bin.slice(offset, offset + view.byteLength), mimeType: image.mimeType };
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  return Object.assign(document.createElement('canvas'), { width, height });
}

async function encodeCanvasPng(canvas) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve, reject) => canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('贴图编码失败'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function decodeToImageData(state, imageIndex, width, height) {
  const raw = imageBytesOf(state, imageIndex);
  if (!raw) return null;
  const bitmap = await createImageBitmap(new Blob([raw.bytes], { type: raw.mimeType }));
  try {
    const w = width || bitmap.width;
    const h = height || bitmap.height;
    const canvas = makeCanvas(w, h);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, w, h);
    return context.getImageData(0, 0, w, h);
  } finally {
    bitmap.close?.();
  }
}

async function bakeAlbedoPng(state, options) {
  const {
    baseImage, factor, mrImage, metallicFactor, roughnessFactor,
    aoImage, occlusionStrength, emisImage, emissiveFactor,
  } = options;
  const probe = Number.isInteger(baseImage) ? baseImage : emisImage;
  const probeRaw = imageBytesOf(state, probe);
  if (!probeRaw) throw new Error('贴图数据缺失');
  const probeBitmap = await createImageBitmap(new Blob([probeRaw.bytes], { type: probeRaw.mimeType }));
  const width = probeBitmap.width;
  const height = probeBitmap.height;
  probeBitmap.close?.();

  const base = Number.isInteger(baseImage) ? await decodeToImageData(state, baseImage, width, height) : null;
  const mr = Number.isInteger(mrImage) ? await decodeToImageData(state, mrImage, width, height) : null;
  const ao = Number.isInteger(aoImage) ? await decodeToImageData(state, aoImage, width, height) : null;
  const emissive = Number.isInteger(emisImage) ? await decodeToImageData(state, emisImage, width, height) : null;

  const out = new ImageData(width, height);
  const dst = out.data;
  const count = width * height * 4;
  for (let i = 0; i < count; i += 4) {
    let r = (base ? base.data[i] / 255 : 1) * factor[0];
    let g = (base ? base.data[i + 1] / 255 : 1) * factor[1];
    let b = (base ? base.data[i + 2] / 255 : 1) * factor[2];
    const alpha = Math.round((base ? base.data[i + 3] : 255) * (factor[3] ?? 1));
    if (ao) {
      // glTF 规范：遮蔽存 R 通道
      const shade = 1 - occlusionStrength * (1 - ao.data[i] / 255);
      r *= shade; g *= shade; b *= shade;
    }
    {
      // glTF 规范：金属度存 B 通道、粗糙度存 G 通道；无 MR 贴图时用材质系数
      const metal = metallicFactor * (mr ? mr.data[i + 2] / 255 : 1);
      const rough = roughnessFactor * (mr ? mr.data[i + 1] / 255 : 1);
      const scale = 1 - METAL_DARKEN * metal;
      const ambient = ENV_REFLECT * reflectStrength(metal, rough);
      r = r * scale + ambient; g = g * scale + ambient; b = b * scale + ambient;
    }
    if (emissive) {
      r += (emissive.data[i] / 255) * emissiveFactor[0];
      g += (emissive.data[i + 1] / 255) * emissiveFactor[1];
      b += (emissive.data[i + 2] / 255) * emissiveFactor[2];
    }
    dst[i] = Math.min(255, Math.round(r * 255));
    dst[i + 1] = Math.min(255, Math.round(g * 255));
    dst[i + 2] = Math.min(255, Math.round(b * 255));
    dst[i + 3] = alpha;
  }
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext('2d');
  context.putImageData(out, 0, 0);
  return encodeCanvasPng(canvas);
}

/**
 * 顶点法线焊接：下载模型常按贴图/部件把同一块曲面的顶点拆开，拆缝两侧法线不一致，
 * 在车机的简单光照下显成一块块色斑（“车门像被撞过”）。原模型靠法线贴图掩盖，车机不支持。
 * 同一网格内位置重合、夹角 < 60° 的法线取平均；真正的硬边（≥60°）保留。
 */
function smoothMeshNormals(state) {
  const { json } = state;
  for (const mesh of json.meshes || []) {
    const sets = (mesh.primitives || [])
      .filter((primitive) => (primitive.mode ?? 4) === 4)
      .map((primitive) => ({
        primitive,
        pos: readAttributeAsFloat(state, primitive.attributes?.POSITION),
        nrm: readAttributeAsFloat(state, primitive.attributes?.NORMAL),
      }))
      .filter((set) => set.pos && set.nrm && set.pos.data.length === set.nrm.data.length);
    if (!sets.length) continue;

    // 量化步长按网格尺度自适应（对角线的十万分之一）
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const set of sets) {
      const d = set.pos.data;
      for (let i = 0; i < d.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          if (d[i + c] < min[c]) min[c] = d[i + c];
          if (d[i + c] > max[c]) max[c] = d[i + c];
        }
      }
    }
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    if (!(diag > 0)) continue;
    const step = diag * 1e-5;

    const outputs = sets.map((set) => Float32Array.from(set.nrm.data));
    const buckets = new Map();
    sets.forEach((set, si) => {
      const d = set.pos.data;
      const count = d.length / 3;
      for (let i = 0; i < count; i++) {
        const key = `${Math.round(d[i * 3] / step)},${Math.round(d[i * 3 + 1] / step)},${Math.round(d[i * 3 + 2] / step)}`;
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(si, i);
      }
    });

    let changed = false;
    for (const list of buckets.values()) {
      if (list.length <= 2) continue;
      const entries = [];
      for (let e = 0; e < list.length; e += 2) {
        const n = sets[list[e]].nrm.data;
        const i = list[e + 1];
        const length = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]) || 1;
        entries.push({ si: list[e], vi: i, n: [n[i * 3] / length, n[i * 3 + 1] / length, n[i * 3 + 2] / length] });
      }
      // 贪心聚类：与簇种子夹角 < 60° 才归入同簇，硬边两侧不互相拉扯
      const clusters = [];
      for (const entry of entries) {
        let target = null;
        for (const cluster of clusters) {
          if (cluster.seed[0] * entry.n[0] + cluster.seed[1] * entry.n[1] + cluster.seed[2] * entry.n[2] >= 0.5) {
            target = cluster;
            break;
          }
        }
        if (!target) clusters.push((target = { seed: entry.n, sum: [0, 0, 0], members: [] }));
        target.sum[0] += entry.n[0];
        target.sum[1] += entry.n[1];
        target.sum[2] += entry.n[2];
        target.members.push(entry);
      }
      for (const cluster of clusters) {
        if (cluster.members.length < 2) continue;
        const length = Math.hypot(cluster.sum[0], cluster.sum[1], cluster.sum[2]) || 1;
        const avg = [cluster.sum[0] / length, cluster.sum[1] / length, cluster.sum[2] / length];
        for (const member of cluster.members) {
          const out = outputs[member.si];
          out[member.vi * 3] = avg[0];
          out[member.vi * 3 + 1] = avg[1];
          out[member.vi * 3 + 2] = avg[2];
        }
        changed = true;
      }
    }
    if (!changed) continue;
    sets.forEach((set, si) => {
      set.primitive.attributes.NORMAL = writeAccessor(state, outputs[si], 5126, 'VEC3');
    });
  }
}

/**
 * 方向渐变烘焙（官方黑车同款“顶暗侧亮”）：
 * 被标记的纯色高反射材质共享一张图集，每材质占一列；
 * 重写 UV——u 定位到材质所在列，v 编码世界法线仰角，
 * 顶面采到接近底色的暗部（黑车还是黑车），侧面采到天空反光的亮部（质感）。
 * excludeNames：灯位材质仍进图集，但把反射强度归零，灭灯态保持纯色。
 */
async function bakeDirectionalGradient(state, baseMatrix, excludeNames) {
  const { json } = state;
  const marked = [];
  (json.materials || []).forEach((material, index) => {
    const mark = material.extras?.[GRAD_MARK];
    if (mark) marked.push({ index, mark: excludeNames?.has(material.name) ? { ...mark, reflect: 0 } : mark });
  });

  if (marked.length) {
    const width = marked.length * 4;
    const height = 256;
    const image = new ImageData(width, height);
    const lin2srgb = (value) => {
      const c = Math.min(1, Math.max(0, value));
      return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
    };
    marked.forEach(({ mark }, order) => {
      const baseLuma = mark.base[0] * 0.2126 + mark.base[1] * 0.7152 + mark.base[2] * 0.0722;
      // 深色漆不能把全部环境反射等量加到整个侧面，否则黑车会被烘成银灰。
      // 随底色亮度逐渐放开反射：汉车型黑漆约取原峰值的 34%。
      const colorScale = 0.18 + 0.82 * Math.sqrt(Math.min(1, Math.max(0, baseLuma)));
      for (let row = 0; row < height; row++) {
        const ny = 1 - (2 * row) / (height - 1); // v=0 在图顶，对应法线朝天
        const absNy = Math.abs(ny);
        const verticalSide = (1 - absNy) ** GRAD_POWER;
        // 高光峰值放在车肩/曲面转折（|ny|≈0.28），垂直门板只保留较弱的轮廓光。
        const shoulder = Math.exp(-(((absNy - 0.28) / 0.18) ** 2));
        const profile = Math.min(1, verticalSide * 0.35 + shoulder * 0.65);
        const boost = GRAD_SIDE * mark.reflect * colorScale * profile;
        const rgb = [lin2srgb(mark.base[0] + boost), lin2srgb(mark.base[1] + boost), lin2srgb(mark.base[2] + boost)];
        for (let px = 0; px < 4; px++) {
          const at = (row * width + order * 4 + px) * 4;
          image.data[at] = rgb[0];
          image.data[at + 1] = rgb[1];
          image.data[at + 2] = rgb[2];
          image.data[at + 3] = Math.round(255 * mark.alpha);
        }
      }
    });
    const canvas = makeCanvas(width, height);
    canvas.getContext('2d').putImageData(image, 0, 0);
    const png = await encodeCanvasPng(canvas);
    const bufferView = appendImageToBin(state, png);
    if (!Array.isArray(json.images)) json.images = [];
    if (!Array.isArray(json.textures)) json.textures = [];
    if (!Array.isArray(json.samplers)) json.samplers = [];
    json.samplers.push({ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 });
    json.images.push({ mimeType: 'image/png', bufferView, name: 'CS_EnvGradient' });
    json.textures.push({ source: json.images.length - 1, sampler: json.samplers.length - 1 });
    const gradTexture = json.textures.length - 1;
    const columnOf = new Map(marked.map(({ index }, order) => [index, order]));

    const parents = parentMapOf(json);
    for (let nodeIndex = 0; nodeIndex < (json.nodes || []).length; nodeIndex++) {
      const node = json.nodes[nodeIndex];
      const mesh = json.meshes?.[node?.mesh];
      if (!mesh) continue;
      let world = worldMatrixOf(json, nodeIndex, parents);
      if (baseMatrix) world = mat4Multiply(baseMatrix, world);
      for (const primitive of mesh.primitives || []) {
        const column = columnOf.get(primitive.material);
        if (column === undefined) continue;
        const position = readAttributeAsFloat(state, primitive.attributes?.POSITION);
        if (!position) continue;
        const normal = readAttributeAsFloat(state, primitive.attributes?.NORMAL);
        const count = position.data.length / 3;
        const u = (column * 4 + 2) / width;
        const uv = new Float32Array(count * 2);
        for (let i = 0; i < count; i++) {
          let v = 0; // 缺法线就落在顶部（≈底色），与保底观感一致
          if (normal) {
            const n = transformNormal(world, normal.data[i * 3], normal.data[i * 3 + 1], normal.data[i * 3 + 2]);
            const length = Math.hypot(n[0], n[1], n[2]) || 1;
            v = (1 - n[1] / length) / 2;
          }
          uv[i * 2] = u;
          uv[i * 2 + 1] = v;
        }
        primitive.attributes.TEXCOORD_0 = writeAccessor(state, uv, 5126, 'VEC2');
      }
    }

    for (const { index, mark } of marked) {
      const material = json.materials[index];
      const pbr = material.pbrMetallicRoughness || (material.pbrMetallicRoughness = {});
      pbr.baseColorTexture = { index: gradTexture };
      pbr.baseColorFactor = [1, 1, 1, 1];
    }
  }

  for (const material of json.materials || []) {
    if (material.extras && GRAD_MARK in material.extras) {
      delete material.extras[GRAD_MARK];
      if (Object.keys(material.extras).length === 0) delete material.extras;
    }
  }
}

/**
 * 最终网格按“渲染预算 + 文件预算”取更严格的一项减面。
 * 旧逻辑只因超过 12 万面就把本模型从 46.8 万面砍到 11.9 万面，
 * 即使最终包只有约 6MiB 也照砍，车身曲面和缝线损失没有必要。
 */
async function simplifyMeshToBudget(state) {
  repackBin(state);
  const { json } = state;
  const primitives = [];
  let totalTriangles = 0;
  for (const mesh of json.meshes || []) {
    if (mesh.name === 'CS_Shadow') continue;
    for (const primitive of mesh.primitives || []) {
      if (!Number.isInteger(primitive.indices)) continue;
      if ((primitive.mode ?? 4) !== 4) continue;
      const indexAccessor = json.accessors?.[primitive.indices];
      if (!indexAccessor) continue;
      totalTriangles += Math.floor(indexAccessor.count / 3);
      primitives.push(primitive);
    }
  }
  if (!totalTriangles) return 0;
  const sizeRatio = glbSizeOf(state) > GLB_BUDGET
    ? (GLB_BUDGET / glbSizeOf(state)) * 0.95 : 1;
  const qualityRatio = DEVICE_TRIANGLE_TARGET / totalTriangles;
  const ratio = Math.min(1, sizeRatio, qualityRatio);
  if (ratio >= 0.999) return 0;
  await MeshoptSimplifier.ready;
  let removed = 0;
  for (const primitive of primitives) {
    try {
      const indices = readIndices(state, primitive.indices);
      const positions = readPositions(state, primitive.attributes?.POSITION);
      if (!indices || !positions) continue;
      const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
      if (target >= indices.length) continue;
      const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.01, ['LockBorder']);
      if (!simplified || simplified.length >= indices.length) continue;
      const bytes = new Uint8Array(simplified.buffer, simplified.byteOffset, simplified.byteLength);
      const bufferView = appendImageToBin(state, bytes.slice());
      json.accessors[primitive.indices] = {
        bufferView, byteOffset: 0, componentType: 5125, count: simplified.length, type: 'SCALAR',
      };
      removed += (indices.length - simplified.length) / 3;
    } catch (error) {
      console.warn('减面失败，保留原始网格', error);
    }
  }
  repackBin(state);
  if (glbSizeOf(state) > GLB_BUDGET) {
    throw new Error('模型过大：贴图与网格已按导入上限压缩，仍超过 32MiB，请先在建模工具里简化模型');
  }
  return removed;
}

function readIndices(state, accessorIndex) {
  const accessor = state.json.accessors?.[accessorIndex];
  const view = state.json.bufferViews?.[accessor?.bufferView];
  if (!accessor || !view || view.buffer !== 0) return null;
  const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const { bin } = state;
  if (accessor.componentType === 5125) {
    return new Uint32Array(bin.buffer, bin.byteOffset + offset, accessor.count).slice();
  }
  if (accessor.componentType === 5123) {
    return Uint32Array.from(new Uint16Array(bin.buffer, bin.byteOffset + offset, accessor.count));
  }
  return null;
}

function readPositions(state, accessorIndex) {
  const accessor = state.json.accessors?.[accessorIndex];
  const view = state.json.bufferViews?.[accessor?.bufferView];
  if (!accessor || !view || view.buffer !== 0) return null;
  if (accessor.componentType !== 5126 || accessor.type !== 'VEC3') return null;
  const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const stride = view.byteStride || 12;
  const { bin } = state;
  if (stride === 12) {
    return new Float32Array(bin.buffer, bin.byteOffset + offset, accessor.count * 3).slice();
  }
  const out = new Float32Array(accessor.count * 3);
  const dataView = new DataView(bin.buffer, bin.byteOffset);
  for (let i = 0; i < accessor.count; i++) {
    const at = offset + i * stride;
    out[i * 3] = dataView.getFloat32(at, true);
    out[i * 3 + 1] = dataView.getFloat32(at + 4, true);
    out[i * 3 + 2] = dataView.getFloat32(at + 8, true);
  }
  return out;
}

/* ---------- 部件提取 ----------
 * 把选中的几何重建成官方那种结构：节点 translation 落在枢轴上，
 * 顶点用相对枢轴的局部坐标，节点名与材质名同为 CS_XXX。
 * 这样旋转/缩放动画天然绕枢轴发生，且不依赖"partsStyle 按节点名还是材质名匹配"这一未知项。
 */

const COMPONENT_INFO = {
  5120: { Array: Int8Array, size: 1 },
  5121: { Array: Uint8Array, size: 1 },
  5122: { Array: Int16Array, size: 2 },
  5123: { Array: Uint16Array, size: 2 },
  5125: { Array: Uint32Array, size: 4 },
  5126: { Array: Float32Array, size: 4 },
};
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
// 车机渲染只认这几种顶点属性；TANGENT/多套 UV/JOINTS/WEIGHTS 都属于死重量
const COPY_ATTRIBUTES = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'];
const KEEP_ATTRIBUTES = new Set(COPY_ATTRIBUTES);
// normalized 整型属性换算成浮点用的分母
const NORMALIZED_SCALE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** 读属性并统一转成 Float32（处理 normalized 整型存储的 UV/顶点色） */
function readAttributeAsFloat(state, accessorIndex) {
  if (!Number.isInteger(accessorIndex)) return null;
  const raw = readAccessorData(state, accessorIndex);
  if (!raw) return null;
  if (raw.data instanceof Float32Array) return raw;
  const scale = raw.accessor.normalized ? NORMALIZED_SCALE[raw.accessor.componentType] || 1 : 1;
  const data = new Float32Array(raw.data.length);
  for (let i = 0; i < raw.data.length; i++) data[i] = Math.max(raw.data[i] / scale, -1);
  return { data, comps: raw.comps, accessor: raw.accessor };
}

/** 列主序 mat4 左上 3x3 的行列式；负值说明该变换带镜像（会翻转三角形环绕方向） */
function det3(m) {
  return m[0] * (m[5] * m[10] - m[6] * m[9])
    - m[4] * (m[1] * m[10] - m[2] * m[9])
    + m[8] * (m[1] * m[6] - m[2] * m[5]);
}

/** 用余子式矩阵变换法线（等价逆转置，负缩放下方向也正确），随后调用方需归一化 */
function transformNormal(m, x, y, z) {
  const c00 = m[5] * m[10] - m[6] * m[9];
  const c01 = m[6] * m[8] - m[4] * m[10];
  const c02 = m[4] * m[9] - m[5] * m[8];
  const c10 = m[2] * m[9] - m[1] * m[10];
  const c11 = m[0] * m[10] - m[2] * m[8];
  const c12 = m[1] * m[8] - m[0] * m[9];
  const c20 = m[1] * m[6] - m[2] * m[5];
  const c21 = m[2] * m[4] - m[0] * m[6];
  const c22 = m[0] * m[5] - m[1] * m[4];
  return [c00 * x + c10 * y + c20 * z, c01 * x + c11 * y + c21 * z, c02 * x + c12 * y + c22 * z];
}

function mat4FromNode(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function mat4Multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
        + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function parentMapOf(json) {
  const parents = new Map();
  (json.nodes || []).forEach((node, index) => {
    for (const child of node.children || []) parents.set(child, index);
  });
  return parents;
}

/** 节点相对场景根的累计矩阵 */
function worldMatrixOf(json, nodeIndex, parents) {
  let matrix = mat4FromNode(json.nodes[nodeIndex]);
  let current = parents.get(nodeIndex);
  while (current !== undefined) {
    matrix = mat4Multiply(mat4FromNode(json.nodes[current]), matrix);
    current = parents.get(current);
  }
  return matrix;
}

function readComponent(view, at, componentType) {
  switch (componentType) {
    case 5120: return view.getInt8(at);
    case 5121: return view.getUint8(at);
    case 5122: return view.getInt16(at, true);
    case 5123: return view.getUint16(at, true);
    case 5125: return view.getUint32(at, true);
    default: return view.getFloat32(at, true);
  }
}

/** 通用 accessor 读取，自动处理 byteStride 交错布局 */
function readAccessorData(state, index) {
  const accessor = state.json.accessors?.[index];
  if (!accessor) return null;
  const info = COMPONENT_INFO[accessor.componentType];
  const comps = TYPE_COMPONENTS[accessor.type];
  if (!info || !comps) return null;
  const out = new info.Array(accessor.count * comps);
  const view = state.json.bufferViews?.[accessor.bufferView];
  if (!view) return { data: out, comps, accessor };
  const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const stride = view.byteStride || info.size * comps;
  const dataView = new DataView(state.bin.buffer, state.bin.byteOffset, state.bin.byteLength);
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < comps; c++) {
      out[i * comps + c] = readComponent(dataView, base + i * stride + c * info.size, accessor.componentType);
    }
  }
  return { data: out, comps, accessor };
}

function writeAccessor(state, data, componentType, type, extra) {
  const comps = TYPE_COMPONENTS[type];
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const bufferView = appendImageToBin(state, bytes.slice());
  if (!Array.isArray(state.json.accessors)) state.json.accessors = [];
  state.json.accessors.push({
    bufferView, byteOffset: 0, componentType, count: data.length / comps, type, ...(extra || {}),
  });
  return state.json.accessors.length - 1;
}

function insideRegion(region, x, y, z) {
  return x >= region.min[0] && x <= region.max[0]
    && y >= region.min[1] && y <= region.max[1]
    && z >= region.min[2] && z <= region.max[2];
}

/**
 * 从一组源节点提取部件。
 * region 为空 → 整个节点；否则按三角形质心是否落在区域内筛选。
 * 此阶段只创建独立副本，不修改源网格；所有绑定完成后再统一消费源几何，
 * 从而允许任意槽位使用完全重叠或部分重叠的选区。
 * pivot 与 region 均使用烘焙后的最终坐标（界面里的选区与枢轴就是这个空间）；
 * bake 是 CS_Car 的全局变换，会被烘进顶点，好让部件节点平铺到场景根后仍处在正确位置。
 */
function extractPart(state, { nodeIndices, region, selection, pivot, name, label, bake }) {
  const { json } = state;
  const origin = (pivot || [0, 0, 0]).slice();
  const parents = parentMapOf(json);
  const primitives = [];
  let taken = 0;

  for (const nodeIndex of nodeIndices) {
    const node = json.nodes?.[nodeIndex];
    const mesh = json.meshes?.[node?.mesh];
    if (!mesh) continue;
    let world = worldMatrixOf(json, nodeIndex, parents);
    if (bake) world = mat4Multiply(bake, world);
    taken += collectPrimitives(state, mesh, world, nodeIndex, region, selection, origin, primitives);
  }

  if (primitives.length === 0) throw new Error(`${label || name}：所选范围内没有面片`);
  json.meshes.push({ name, primitives });
  json.nodes.push({ name, mesh: json.meshes.length - 1, translation: [origin[0], origin[1], origin[2]] });
  return { nodeIndex: json.nodes.length - 1, triangles: taken };
}

function collectPrimitives(state, mesh, world, nodeIndex, region, selection, origin, primitives) {
  const { json } = state;
  let taken = 0;
  for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives || []).length; primitiveIndex++) {
    const primitive = mesh.primitives[primitiveIndex];
    if ((primitive.mode ?? 4) !== 4) continue;
    const source = readAccessorData(state, primitive.attributes?.POSITION);
    if (!source) continue;

    // 顶点搬到烘焙后的最终坐标系；区域判定也在这个空间进行
    const vertexCount = source.data.length / 3;
    const worldPositions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      const [x, y, z] = [source.data[i * 3], source.data[i * 3 + 1], source.data[i * 3 + 2]];
      const p = transformPoint(world, x, y, z);
      worldPositions[i * 3] = p[0];
      worldPositions[i * 3 + 1] = p[1];
      worldPositions[i * 3 + 2] = p[2];
    }

    let indices = Number.isInteger(primitive.indices)
      ? readAccessorData(state, primitive.indices)?.data
      : null;
    if (!indices) {
      indices = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) indices[i] = i;
    }

    const mine = [];
    // 带镜像的世界矩阵烘进顶点后三角形环绕方向会翻转，这里换手性保住背面剔除
    const flip = det3(world) < 0;
    const exact = selection ? selectedTriangles(selection, nodeIndex, primitiveIndex) : null;
    if (selection && !exact?.size) continue;
    for (let t = 0, triangle = 0; t + 2 < indices.length; t += 3, triangle++) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
      let belongs = exact ? exact.has(triangle) : true;
      if (!exact && region) {
        // 按三角形质心归属，避免同一个三角形被两边同时持有
        const cx = (worldPositions[a * 3] + worldPositions[b * 3] + worldPositions[c * 3]) / 3;
        const cy = (worldPositions[a * 3 + 1] + worldPositions[b * 3 + 1] + worldPositions[c * 3 + 1]) / 3;
        const cz = (worldPositions[a * 3 + 2] + worldPositions[b * 3 + 2] + worldPositions[c * 3 + 2]) / 3;
        belongs = insideRegion(region, cx, cy, cz);
      }
      if (belongs) mine.push(a, ...(flip ? [c, b] : [b, c]));
    }
    if (mine.length === 0) continue;
    taken += mine.length / 3;

    // 顶点重映射：部件只保留自己用到的顶点
    const remap = new Map();
    const partIndices = new Uint32Array(mine.length);
    for (let i = 0; i < mine.length; i++) {
      const old = mine[i];
      let next = remap.get(old);
      if (next === undefined) {
        next = remap.size;
        remap.set(old, next);
      }
      partIndices[i] = next;
    }

    const attributes = {};
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const key of COPY_ATTRIBUTES) {
      const attribute = readAttributeAsFloat(state, primitive.attributes?.[key]);
      if (!attribute) continue;
      const comps = attribute.comps;
      const out = new Float32Array(remap.size * comps);
      for (const [old, next] of remap) {
        if (key === 'POSITION') {
          // 世界坐标减枢轴 → 局部坐标
          for (let c = 0; c < 3; c++) {
            const value = worldPositions[old * 3 + c] - origin[c];
            out[next * 3 + c] = value;
            if (value < min[c]) min[c] = value;
            if (value > max[c]) max[c] = value;
          }
        } else if (key === 'NORMAL') {
          // 法线跟着世界矩阵走（逆转置），否则旋转过的节点光照会错
          const n = transformNormal(world, attribute.data[old * 3], attribute.data[old * 3 + 1], attribute.data[old * 3 + 2]);
          const length = Math.hypot(n[0], n[1], n[2]) || 1;
          out[next * 3] = n[0] / length;
          out[next * 3 + 1] = n[1] / length;
          out[next * 3 + 2] = n[2] / length;
        } else {
          for (let c = 0; c < comps; c++) out[next * comps + c] = attribute.data[old * comps + c];
        }
      }
      const type = comps === 1 ? 'SCALAR' : `VEC${comps}`;
      const extra = key === 'POSITION' ? { min, max } : undefined;
      attributes[key] = writeAccessor(state, out, 5126, type, extra);
    }
    if (!Number.isInteger(attributes.POSITION)) continue;

    primitives.push({
      attributes,
      indices: writeAccessor(state, partIndices, 5125, 'SCALAR'),
      ...(Number.isInteger(primitive.material) ? { material: primitive.material } : {}),
    });

  }
  return taken;
}

function sourceNodeIndicesOf(binding) {
  const selectedNodes = (binding.selection?.groups || []).map((group) => group.nodeIndex);
  const indices = selectedNodes.length
    ? selectedNodes
    : (binding.nodeIndices?.length ? binding.nodeIndices : [binding.nodeIndex]);
  return [...new Set(indices.filter(Number.isInteger))];
}

function preservesSourceGeometry(binding) {
  return binding.preserveSource === true || binding.slotId === 'CS_Emergency';
}

/**
 * 所有区域部件都复制完成后，再按选区并集一次性从静态源网格扣除面片。
 * 同一个面片可以存在于任意多个联动副本中，但只会从静态车身删除一次。
 */
function consumeBindingRegions(state, bindings, sourceRoots, bake) {
  const { json } = state;
  const filtersByNode = new Map();
  const filterFor = (nodeIndex) => {
    if (!filtersByNode.has(nodeIndex)) filtersByNode.set(nodeIndex, { regions: [], selections: new Map() });
    return filtersByNode.get(nodeIndex);
  };
  for (const binding of bindings) {
    if (preservesSourceGeometry(binding)) continue;
    if (binding.selection) {
      for (const group of binding.selection.groups || []) {
        const filter = filterFor(group.nodeIndex);
        if (!filter.selections.has(group.primitiveIndex)) filter.selections.set(group.primitiveIndex, new Set());
        const target = filter.selections.get(group.primitiveIndex);
        for (const [start, count] of group.ranges || []) {
          for (let i = 0; i < count; i++) target.add(start + i);
        }
      }
    } else if (binding.region) {
      for (const nodeIndex of sourceNodeIndicesOf(binding)) filterFor(nodeIndex).regions.push(binding.region);
    }
  }
  if (filtersByNode.size === 0) return;

  const parents = parentMapOf(json);
  const meshUsers = new Map();
  for (const node of json.nodes || []) {
    if (!Number.isInteger(node.mesh)) continue;
    meshUsers.set(node.mesh, (meshUsers.get(node.mesh) || 0) + 1);
  }

  for (const [nodeIndex, filter] of filtersByNode) {
    const node = json.nodes?.[nodeIndex];
    let mesh = json.meshes?.[node?.mesh];
    if (!mesh) continue;

    // glTF 允许多个节点实例化同一 mesh。区域判定使用节点世界坐标，
    // 因此修改索引前先让当前节点拥有独立 mesh，避免误删其他实例的面片。
    const sourceMeshIndex = node.mesh;
    if ((meshUsers.get(sourceMeshIndex) || 0) > 1) {
      json.meshes.push(structuredClone(mesh));
      node.mesh = json.meshes.length - 1;
      meshUsers.set(sourceMeshIndex, meshUsers.get(sourceMeshIndex) - 1);
      meshUsers.set(node.mesh, 1);
      mesh = json.meshes[node.mesh];
    }

    let world = worldMatrixOf(json, nodeIndex, parents);
    if (bake) world = mat4Multiply(bake, world);
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives || []).length; primitiveIndex++) {
      const primitive = mesh.primitives[primitiveIndex];
      if ((primitive.mode ?? 4) !== 4) continue;
      const source = readAccessorData(state, primitive.attributes?.POSITION);
      if (!source) continue;
      const vertexCount = source.data.length / 3;
      const positions = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        const p = transformPoint(world, source.data[i * 3], source.data[i * 3 + 1], source.data[i * 3 + 2]);
        positions[i * 3] = p[0];
        positions[i * 3 + 1] = p[1];
        positions[i * 3 + 2] = p[2];
      }

      let indices = Number.isInteger(primitive.indices)
        ? readAccessorData(state, primitive.indices)?.data
        : null;
      if (!indices) {
        indices = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) indices[i] = i;
      }

      const kept = [];
      let removedAny = false;
      const exact = filter.selections.get(primitiveIndex);
      for (let t = 0, triangle = 0; t + 2 < indices.length; t += 3, triangle++) {
        const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
        const cx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
        const cy = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
        const cz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
        if (exact?.has(triangle) || filter.regions.some((region) => insideRegion(region, cx, cy, cz))) {
          removedAny = true;
          continue;
        }
        kept.push(a, b, c);
      }
      if (!removedAny) continue;
      if (kept.length === 0) primitive.__drop = true;
      else primitive.indices = writeAccessor(state, Uint32Array.from(kept), 5125, 'SCALAR');
    }
    mesh.primitives = (mesh.primitives || []).filter((primitive) => !primitive.__drop);
    if (mesh.primitives.length === 0) detachNode(json, sourceRoots, nodeIndex);
  }
}

/** 丢弃孤儿数据：把所有被引用的 bufferView 紧凑复制进新 BIN。 */
function repackBin(state) {
  const { json } = state;
  if (!Array.isArray(json.bufferViews)) return;
  const referenced = new Set();
  for (const accessor of json.accessors || []) {
    if (Number.isInteger(accessor.bufferView)) referenced.add(accessor.bufferView);
    if (Number.isInteger(accessor.sparse?.indices?.bufferView)) referenced.add(accessor.sparse.indices.bufferView);
    if (Number.isInteger(accessor.sparse?.values?.bufferView)) referenced.add(accessor.sparse.values.bufferView);
  }
  for (const image of json.images || []) {
    if (Number.isInteger(image.bufferView)) referenced.add(image.bufferView);
  }
  const remap = new Map();
  const kept = [];
  let total = 0;
  for (let i = 0; i < json.bufferViews.length; i++) {
    if (!referenced.has(i)) continue;
    const view = json.bufferViews[i];
    total = (total + 3) & ~3;
    const copy = { ...view, byteOffset: total };
    remap.set(i, kept.length);
    kept.push({ view: copy, from: (view.byteOffset || 0), length: view.byteLength });
    total += view.byteLength;
  }
  const merged = new Uint8Array(total);
  for (const item of kept) {
    merged.set(state.bin.subarray(item.from, item.from + item.length), item.view.byteOffset);
  }
  json.bufferViews = kept.map((item) => item.view);
  for (const accessor of json.accessors || []) {
    if (Number.isInteger(accessor.bufferView)) accessor.bufferView = remap.get(accessor.bufferView);
    if (Number.isInteger(accessor.sparse?.indices?.bufferView)) accessor.sparse.indices.bufferView = remap.get(accessor.sparse.indices.bufferView);
    if (Number.isInteger(accessor.sparse?.values?.bufferView)) accessor.sparse.values.bufferView = remap.get(accessor.sparse.values.bufferView);
  }
  for (const image of json.images || []) {
    if (Number.isInteger(image.bufferView)) image.bufferView = remap.get(image.bufferView);
  }
  state.bin = merged;
  if (json.buffers?.[0]) json.buffers[0].byteLength = merged.byteLength;
}

/** DAT 上限 32MiB（与 APK 导入器一致）：超限时逐级降采样嵌入贴图。 */
async function fitGlbBudget(state) {
  repackBin(state);
  if (glbSizeOf(state) <= GLB_BUDGET) return;
  for (const cap of [2048, 1024, 512, 256]) {
    let changed = false;
    for (let i = 0; i < (state.json.images || []).length; i++) {
      const raw = imageBytesOf(state, i);
      if (!raw) continue;
      const bitmap = await createImageBitmap(new Blob([raw.bytes], { type: raw.mimeType }));
      const { width, height } = bitmap;
      if (Math.max(width, height) <= cap) { bitmap.close?.(); continue; }
      const scale = cap / Math.max(width, height);
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = makeCanvas(w, h);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();
      const png = await encodeCanvasPng(canvas);
      state.json.images[i] = { mimeType: 'image/png', bufferView: appendImageToBin(state, png) };
      changed = true;
    }
    if (changed) repackBin(state);
    if (glbSizeOf(state) <= GLB_BUDGET) return;
  }
  // 贴图已降到最低，交给后续按最终体积触发的网格简化继续尝试。
  return false;
}

function glbSizeOf(state) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(state.json));
  return 28 + ((jsonBytes.byteLength + 3) & ~3) + ((state.bin.byteLength + 3) & ~3);
}

function collectGlbStats(json) {
  let triangles = 0;
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const count = Number.isInteger(primitive.indices)
        ? json.accessors?.[primitive.indices]?.count
        : json.accessors?.[primitive.attributes?.POSITION]?.count;
      if (Number.isFinite(count)) triangles += Math.floor(count / 3);
    }
  }
  return {
    triangles,
    nodes: json.nodes?.length || 0,
    meshes: json.meshes?.length || 0,
    materials: json.materials?.length || 0,
    textures: json.textures?.length || 0,
  };
}


async function normalizeParsedGlb(parsed, transform, bindings, lampsOut, deletions) {
  const state = { json: structuredClone(parsed.json), bin: parsed.bin };
  const { json } = state;
  const oldScene = Number.isInteger(json.scene) ? json.scene : 0;
  const scene = json.scenes?.[oldScene];
  if (!scene) throw new Error('默认场景不存在');
  if (!Array.isArray(json.nodes)) json.nodes = [];
  if (!Array.isArray(json.meshes) || json.meshes.length === 0) throw new Error('模型没有网格');

  const sourceRoots = [...(scene.nodes || [])];
  for (const node of json.nodes) {
    if (node.name === 'CS_Car') node.name = 'CS_Car_Imported';
    if (node.name === 'CS_Shadow') node.name = 'CS_Shadow_Imported';
    delete node.camera;
    delete node.skin;
  }
  // 一旦输入包自带阴影，统一换成按当前车身轮廓重建的 CS_Shadow，避免两层阴影叠加。
  for (const nodeIndex of [...sourceRoots]) {
    if (json.nodes[nodeIndex]?.name === 'CS_Shadow_Imported') detachNode(json, sourceRoots, nodeIndex);
  }

  // 车机不认的顶点属性先扔掉，重复材质合并（材质数上限 32）
  sanitizeForVehicle(state);
  dedupeMaterials(state);

  // 先切出联动部件。部件必须平铺在场景根（与官方一致）：
  // 引擎在剔除阶段按场景根节点解引用动画目标，目标若嵌在子节点里会直接段错误。
  // 因此把 CS_Car 的全局变换烘进部件顶点，部件节点自身保持单位旋转与缩放，
  // 这样动画覆盖 rotation 时也不会丢掉模型的朝向与尺寸。
  const bake = mat4FromNode(transform);
  // 必须先按原始 triangle ordinal 复制联动部件，再删除用户框选区域。
  // 否则删除会重写索引，使精细选面保存的三角形编号失效。
  const parts = applyBindings(state, bindings, sourceRoots, bake);
  applyDeletions(state, deletions, sourceRoots, bake, parts.nodeIndices);
  const validPartNodes = new Set(parts.nodeIndices.filter((nodeIndex) => Number.isInteger(json.nodes?.[nodeIndex]?.mesh)));
  parts.nodeIndices = parts.nodeIndices.filter((nodeIndex) => validPartNodes.has(nodeIndex));
  parts.animations = parts.animations.filter((animation) => (
    animation.channels || []
  ).some((channel) => validPartNodes.has(channel.target?.node)));
  if (Array.isArray(lampsOut)) lampsOut.push(...parts.lamps);

  // 剩余静态几何合并成一个节点，保证节点/网格数量在车机上限内
  consolidateStaticGeometry(state, sourceRoots);
  // 合并后再去重一次材质（extractPart 为每个部件创建了新材质，很多实际内容重复）
  dedupeMaterials(state);

  const modelBounds = boundsOfOutputGeometry(state, sourceRoots, parts.nodeIndices, bake);
  const shadowIndex = await addAutomaticShadow(state, modelBounds);

  const rootIndex = json.nodes.length;
  json.nodes.push({
    name: 'CS_Car',
    children: sourceRoots,
    translation: transform.translation,
    rotation: transform.rotation,
    scale: transform.scale,
  });
  json.scenes = [{ name: 'Scene', nodes: [rootIndex, shadowIndex, ...parts.nodeIndices] }];
  json.scene = 0;
  json.cameras = undefined;
  json.lights = undefined;

  for (const mesh of json.meshes) {
    if (!mesh.name) mesh.name = 'CS_Car';
  }
  if (json.materials?.length) json.materials[0].name = 'CS_Car';
  json.animations = parts.animations.length ? parts.animations : undefined;
  json.skins = undefined;
  json.extensionsRequired = undefined;
  json.extensionsUsed = undefined;
  json.asset = { version: '2.0', generator: 'BYD Car Model Converter' };
  // 几何定型后：焊平拆缝法线（修“简单光照下的色斑”），再做官方式“顶暗侧亮”渐变。
  // 此时部件顶点已在最终空间、静态几何挂在 CS_Car 下，worldMatrixOf 两种情况都能给出正确朝向
  smoothMeshNormals(state);
  await bakeDirectionalGradient(state, null, LAMP_SLOT_IDS);
  // 静态几何合并后原树全是孤儿：清掉空节点、死网格、死贴图与孤儿数据，
  // 最后按车机导入器的硬上限自检，超限在这里就报明确原因
  pruneOrphanNodes(state);
  pruneUnusedMeshes(state);
  pruneUnusedTextures(state);
  pruneUnusedAccessors(state);
  repackBin(state);
  assertDeviceLimits(state);
  return state;
}

function boundsOfOutputGeometry(state, sourceRoots, partNodes, bake) {
  const { json } = state;
  const parents = parentMapOf(json);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const seen = new Set();
  const entries = [];

  const includeNode = (nodeIndex, applyBake) => {
    if (seen.has(`${nodeIndex}|${applyBake ? 1 : 0}`)) return;
    seen.add(`${nodeIndex}|${applyBake ? 1 : 0}`);
    const node = json.nodes?.[nodeIndex];
    if (!node || node.name === 'CS_Shadow_Imported') return;
    const mesh = json.meshes?.[node.mesh];
    let world = worldMatrixOf(json, nodeIndex, parents);
    if (applyBake) world = mat4Multiply(bake, world);
    for (const primitive of mesh?.primitives || []) {
      const position = readAttributeAsFloat(state, primitive.attributes?.POSITION);
      if (!position) continue;
      entries.push({ position: position.data, world });
      for (let i = 0; i < position.data.length; i += 3) {
        const point = transformPoint(world, position.data[i], position.data[i + 1], position.data[i + 2]);
        for (let axis = 0; axis < 3; axis++) {
          if (point[axis] < min[axis]) min[axis] = point[axis];
          if (point[axis] > max[axis]) max[axis] = point[axis];
        }
      }
    }
    for (const child of node.children || []) includeNode(child, applyBake);
  };

  for (const root of sourceRoots) includeNode(root, true);
  for (const nodeIndex of partNodes) includeNode(nodeIndex, false);
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) throw new Error('无法计算车底阴影尺寸');
  const totalVertices = entries.reduce((sum, entry) => sum + entry.position.length / 3, 0);
  const stride = Math.max(1, Math.ceil(totalVertices / 30000));
  const groundY = min[1] + Math.max(0.03, (max[1] - min[1]) * 0.12);
  const ground = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.position.length; i += stride * 3) {
      const point = transformPoint(entry.world, entry.position[i], entry.position[i + 1], entry.position[i + 2]);
      if (point[1] <= groundY) ground.push(point[0], point[2]);
    }
  }
  return { min, max, ground };
}

async function addAutomaticShadow(state, bounds) {
  const { json } = state;
  const canvas = createCarShadowCanvas();
  const png = await encodeCanvasPng(canvas);
  if (!Array.isArray(json.images)) json.images = [];
  if (!Array.isArray(json.textures)) json.textures = [];
  if (!Array.isArray(json.materials)) json.materials = [];

  const imageIndex = json.images.length;
  json.images.push({ name: 'CS_Shadow', mimeType: 'image/png', bufferView: appendImageToBin(state, png) });
  const textureIndex = json.textures.length;
  const texture = { source: imageIndex };
  if (json.samplers?.length) texture.sampler = 0;
  json.textures.push(texture);
  const materialIndex = json.materials.length;
  json.materials.push({
    name: 'CS_Shadow',
    alphaMode: 'BLEND',
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorTexture: { index: textureIndex },
      metallicFactor: 0,
      roughnessFactor: 0.5,
    },
  });

  const footprint = shadowFootprint(bounds.min, bounds.max, bounds.ground);
  const x0 = footprint.centerX - footprint.sizeX / 2;
  const x1 = footprint.centerX + footprint.sizeX / 2;
  const z0 = footprint.centerZ - footprint.sizeZ / 2;
  const z1 = footprint.centerZ + footprint.sizeZ / 2;
  const attributes = {
    POSITION: writeAccessor(state, Float32Array.from([
      x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1,
    ]), 5126, 'VEC3', { min: [x0, 0, z0], max: [x1, 0, z1] }),
    NORMAL: writeAccessor(state, Float32Array.from([
      0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]), 5126, 'VEC3'),
    TEXCOORD_0: writeAccessor(state, Float32Array.from([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 5126, 'VEC2'),
  };
  const indices = writeAccessor(state, Uint32Array.from([0, 1, 2, 0, 2, 3]), 5125, 'SCALAR');
  json.meshes.push({
    name: 'CS_Shadow',
    primitives: [{ attributes, indices, material: materialIndex }],
  });
  json.nodes.push({
    name: 'CS_Shadow',
    mesh: json.meshes.length - 1,
    translation: [0, 0.012, 0],
  });
  return json.nodes.length - 1;
}

/**
 * 删除用户框选的多余区域：按三角形质心（烘焙后空间）过滤所有网格。
 * 被清空的网格连同节点一起摘除。
 */
function applyDeletions(state, deletions, sourceRoots, bake, partNodes = []) {
  if (!Array.isArray(deletions) || deletions.length === 0) return;
  const { json } = state;
  const parents = parentMapOf(json);
  const partNodeSet = new Set(partNodes);
  for (let nodeIndex = 0; nodeIndex < (json.nodes || []).length; nodeIndex++) {
    const node = json.nodes[nodeIndex];
    const mesh = json.meshes?.[node?.mesh];
    if (!mesh) continue;
    let world = worldMatrixOf(json, nodeIndex, parents);
    if (bake && !partNodeSet.has(nodeIndex)) world = mat4Multiply(bake, world);

    for (const primitive of mesh.primitives || []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const source = readAccessorData(state, primitive.attributes?.POSITION);
      if (!source) continue;
      const vertexCount = source.data.length / 3;
      const positions = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        const p = transformPoint(world, source.data[i * 3], source.data[i * 3 + 1], source.data[i * 3 + 2]);
        positions[i * 3] = p[0];
        positions[i * 3 + 1] = p[1];
        positions[i * 3 + 2] = p[2];
      }
      let indices = Number.isInteger(primitive.indices)
        ? readAccessorData(state, primitive.indices)?.data
        : null;
      if (!indices) {
        indices = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) indices[i] = i;
      }
      const kept = [];
      let removedAny = false;
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
        const cx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
        const cy = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
        const cz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
        if (deletions.some((region) => insideRegion(region, cx, cy, cz))) {
          removedAny = true;
          continue;
        }
        kept.push(a, b, c);
      }
      if (!removedAny) continue;
      if (kept.length === 0) primitive.__drop = true;
      else primitive.indices = writeAccessor(state, Uint32Array.from(kept), 5125, 'SCALAR');
    }
    mesh.primitives = (mesh.primitives || []).filter((primitive) => !primitive.__drop);
    if (mesh.primitives.length === 0) {
      if (partNodeSet.has(nodeIndex)) delete node.mesh;
      else detachNode(json, sourceRoots, nodeIndex);
    }
  }
}

/** 删除场景不可达的节点，并重映射场景、子节点与动画目标里的下标 */
function pruneOrphanNodes(state) {
  const { json } = state;
  const reachable = new Set();
  const walk = (index) => {
    if (reachable.has(index)) return;
    reachable.add(index);
    for (const child of json.nodes[index]?.children || []) walk(child);
  };
  for (const root of json.scenes?.[0]?.nodes || []) walk(root);
  if (reachable.size === json.nodes.length) return;

  const remap = new Map();
  const kept = [];
  json.nodes.forEach((node, index) => {
    if (!reachable.has(index)) return;
    remap.set(index, kept.length);
    kept.push(node);
  });
  json.nodes = kept;
  for (const node of json.nodes) {
    if (Array.isArray(node.children)) node.children = node.children.map((c) => remap.get(c));
  }
  json.scenes[0].nodes = json.scenes[0].nodes.map((n) => remap.get(n));
  for (const animation of json.animations || []) {
    for (const channel of animation.channels || []) {
      channel.target.node = remap.get(channel.target.node);
    }
  }
}

/**
 * 把节点从场景里彻底摘除：断开场景根与所有父节点的引用，并清掉网格引用，
 * 这样后续 pruneUnusedMeshes 才能识别出它的网格已成孤儿。
 * 不从 json.nodes 里删除，避免所有节点下标发生位移。
 */
function detachNode(json, sourceRoots, nodeIndex) {
  const at = sourceRoots.indexOf(nodeIndex);
  if (at >= 0) sourceRoots.splice(at, 1);
  for (const node of json.nodes || []) {
    if (!Array.isArray(node.children)) continue;
    const child = node.children.indexOf(nodeIndex);
    if (child >= 0) node.children.splice(child, 1);
  }
  delete json.nodes[nodeIndex].mesh;
}

/** 删除已经没有节点引用的网格，并重映射节点上的 mesh 下标 */
function pruneUnusedMeshes(state) {
  const { json } = state;
  if (!Array.isArray(json.meshes)) return;
  const used = new Set();
  for (const node of json.nodes || []) {
    if (Number.isInteger(node.mesh)) used.add(node.mesh);
  }
  const remap = new Map();
  const kept = [];
  json.meshes.forEach((mesh, index) => {
    if (!used.has(index)) return;
    remap.set(index, kept.length);
    kept.push(mesh);
  });
  json.meshes = kept;
  for (const node of json.nodes || []) {
    if (Number.isInteger(node.mesh)) node.mesh = remap.get(node.mesh);
  }
}

/**
 * 车机预处理：把材质 baseColor 用的 UV 挪到 TEXCOORD_0，
 * 然后把车机不认识的顶点属性（TANGENT、多余 UV、蒙皮权重）与 morph target 全部丢掉。
 * 这些死数据是下载模型体积虚高的主因之一。
 */
function sanitizeForVehicle(state) {
  const { json } = state;
  const texCoordOf = new Map();
  (json.materials || []).forEach((material, index) => {
    const ref = material.pbrMetallicRoughness?.baseColorTexture;
    if (ref && Number.isInteger(ref.texCoord) && ref.texCoord > 0) {
      texCoordOf.set(index, ref.texCoord);
      delete ref.texCoord;
    }
  });
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      const texCoord = texCoordOf.get(primitive.material);
      const uvKey = `TEXCOORD_${texCoord}`;
      if (texCoord && Number.isInteger(primitive.attributes?.[uvKey])) {
        primitive.attributes.TEXCOORD_0 = primitive.attributes[uvKey];
      }
      for (const key of Object.keys(primitive.attributes || {})) {
        if (!KEEP_ATTRIBUTES.has(key)) delete primitive.attributes[key];
      }
      delete primitive.targets;
    }
    delete mesh.weights;
  }
}

/**
 * 合并参数完全相同的材质（很多下载模型会复制出几十份同样的材质）。
 * 灯光材质是车机运行时按名称独立换贴图的控制边界，哪怕内容相同也不能
 * 与车身原材质或其他灯位合并，否则踩刹车会把所有共享材质的灯一起点亮。
 */
function dedupeMaterials(state) {
  const { json } = state;
  if (!Array.isArray(json.materials) || json.materials.length === 0) return;
  const remap = new Map();
  const byKey = new Map();
  const kept = [];
  json.materials.forEach((material, index) => {
    const { name, ...rest } = material;
    const contentKey = JSON.stringify(rest);
    const key = LAMP_SLOT_IDS.has(name) ? `${name}|${contentKey}` : contentKey;
    if (byKey.has(key)) {
      remap.set(index, byKey.get(key));
      return;
    }
    byKey.set(key, kept.length);
    remap.set(index, kept.length);
    kept.push(material);
  });
  if (kept.length === json.materials.length) return;
  json.materials = kept;
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      if (Number.isInteger(primitive.material)) primitive.material = remap.get(primitive.material);
    }
  }
}

/**
 * 把没绑定联动的静态几何全部合并成一个节点（按材质分组 primitive）。
 * 下载模型动辄几百个节点，而车机导入器上限是 256 节点 / 128 网格，
 * 只有联动部件才需要独立节点，其余合并后数量骤减一个量级。
 * 顶点烘的是节点在源场景里的累计矩阵（不含 CS_Car 的全局变换），
 * 因为合并节点仍挂在 CS_Car 下继承那份变换。
 */
function consolidateStaticGeometry(state, sourceRoots) {
  const { json } = state;
  const parents = parentMapOf(json);
  const reachable = [];
  const seen = new Set();
  const walk = (index) => {
    if (seen.has(index)) return;
    seen.add(index);
    const node = json.nodes?.[index];
    if (!node) return;
    if (json.meshes?.[node.mesh]) reachable.push(index);
    for (const child of node.children || []) walk(child);
  };
  for (const root of sourceRoots) walk(root);
  if (reachable.length === 0) return;

  const groups = new Map();
  for (const nodeIndex of reachable) {
    const node = json.nodes[nodeIndex];
    const mesh = json.meshes[node.mesh];
    const world = worldMatrixOf(json, nodeIndex, parents);
    const flip = det3(world) < 0;
    for (const primitive of mesh.primitives || []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const position = readAttributeAsFloat(state, primitive.attributes?.POSITION);
      if (!position) continue;
      const normal = readAttributeAsFloat(state, primitive.attributes?.NORMAL);
      const uv = readAttributeAsFloat(state, primitive.attributes?.TEXCOORD_0);
      const color = readAttributeAsFloat(state, primitive.attributes?.COLOR_0);
      const material = Number.isInteger(primitive.material) ? primitive.material : -1;
      const key = [material, normal ? 1 : 0, uv ? 1 : 0, color ? color.comps : 0].join('|');
      let group = groups.get(key);
      if (!group) {
        group = { material, hasNormal: Boolean(normal), hasUV: Boolean(uv),
          colorComps: color ? color.comps : 0, positions: [], normals: [], uvs: [], colors: [], indices: [], vertexBase: 0 };
        groups.set(key, group);
      }

      const vertexCount = position.data.length / 3;
      let indices = Number.isInteger(primitive.indices)
        ? readAccessorData(state, primitive.indices)?.data
        : null;
      if (!indices) {
        indices = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) indices[i] = i;
      }

      // 只搬 indices 真正引用的顶点：减面后的模型顶点数据里大部分已经是死顶点
      const remap = new Map();
      const base = group.vertexBase;
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const tri = [indices[t], indices[t + 1], indices[t + 2]];
        if (flip) [tri[1], tri[2]] = [tri[2], tri[1]];
        for (const old of tri) {
          let next = remap.get(old);
          if (next === undefined) {
            next = remap.size;
            remap.set(old, next);
          }
          group.indices.push(base + next);
        }
      }
      for (const [old] of remap) {
        const p = transformPoint(world, position.data[old * 3], position.data[old * 3 + 1], position.data[old * 3 + 2]);
        group.positions.push(p[0], p[1], p[2]);
        if (group.hasNormal) {
          const source = normal ? [normal.data[old * 3], normal.data[old * 3 + 1], normal.data[old * 3 + 2]] : [0, 1, 0];
          const n = transformNormal(world, source[0], source[1], source[2]);
          const length = Math.hypot(n[0], n[1], n[2]) || 1;
          group.normals.push(n[0] / length, n[1] / length, n[2] / length);
        }
        if (group.hasUV) group.uvs.push(uv ? uv.data[old * 2] : 0, uv ? uv.data[old * 2 + 1] : 0);
        if (group.colorComps) {
          for (let c = 0; c < group.colorComps; c++) group.colors.push(color ? color.data[old * group.colorComps + c] : 1);
        }
      }
      group.vertexBase += remap.size;
    }
  }

  const primitives = [];
  for (const group of groups.values()) {
    if (group.indices.length === 0) continue;
    const positions = Float32Array.from(group.positions);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        if (positions[i + c] < min[c]) min[c] = positions[i + c];
        if (positions[i + c] > max[c]) max[c] = positions[i + c];
      }
    }
    const attributes = { POSITION: writeAccessor(state, positions, 5126, 'VEC3', { min, max }) };
    if (group.hasNormal) attributes.NORMAL = writeAccessor(state, Float32Array.from(group.normals), 5126, 'VEC3');
    if (group.hasUV) attributes.TEXCOORD_0 = writeAccessor(state, Float32Array.from(group.uvs), 5126, 'VEC2');
    if (group.colorComps) {
      attributes.COLOR_0 = writeAccessor(state, Float32Array.from(group.colors), 5126, `VEC${group.colorComps}`);
    }
    primitives.push({
      attributes,
      indices: writeAccessor(state, Uint32Array.from(group.indices), 5125, 'SCALAR'),
      ...(group.material >= 0 ? { material: group.material } : {}),
    });
  }
  if (primitives.length === 0) return;

  json.meshes.push({ name: 'CarBody', primitives });
  json.nodes.push({ name: 'CarBody', mesh: json.meshes.length - 1 });
  sourceRoots.length = 0;
  sourceRoots.push(json.nodes.length - 1);
}

/** 修剪材质没有引用的贴图/图片/采样器（材质烘焙会把旧贴图变成死数据） */
function pruneUnusedTextures(state) {
  const { json } = state;
  const refs = [];
  for (const material of json.materials || []) {
    const pbr = material.pbrMetallicRoughness;
    for (const ref of [pbr?.baseColorTexture, pbr?.metallicRoughnessTexture,
      material.normalTexture, material.occlusionTexture, material.emissiveTexture]) {
      if (Number.isInteger(ref?.index)) refs.push(ref);
    }
  }
  const usedTextures = new Set(refs.map((ref) => ref.index));
  const textureRemap = new Map();
  const textures = [];
  (json.textures || []).forEach((texture, index) => {
    if (!usedTextures.has(index)) return;
    textureRemap.set(index, textures.length);
    textures.push(texture);
  });
  for (const ref of refs) ref.index = textureRemap.get(ref.index);
  json.textures = textures.length ? textures : undefined;

  const usedImages = new Set();
  const usedSamplers = new Set();
  for (const texture of textures) {
    if (Number.isInteger(texture.source)) usedImages.add(texture.source);
    if (Number.isInteger(texture.sampler)) usedSamplers.add(texture.sampler);
  }
  const imageRemap = new Map();
  const images = [];
  (json.images || []).forEach((image, index) => {
    if (!usedImages.has(index)) return;
    imageRemap.set(index, images.length);
    images.push(image);
  });
  const samplerRemap = new Map();
  const samplers = [];
  (json.samplers || []).forEach((sampler, index) => {
    if (!usedSamplers.has(index)) return;
    samplerRemap.set(index, samplers.length);
    samplers.push(sampler);
  });
  for (const texture of textures) {
    if (Number.isInteger(texture.source)) texture.source = imageRemap.get(texture.source);
    if (Number.isInteger(texture.sampler)) texture.sampler = samplerRemap.get(texture.sampler);
  }
  json.images = images.length ? images : undefined;
  json.samplers = samplers.length ? samplers : undefined;
}

/** 修剪没被网格/动画引用的 accessor 条目（几何合并后旧条目全是孤儿，还占 JSON 体积） */
function pruneUnusedAccessors(state) {
  const { json } = state;
  if (!Array.isArray(json.accessors)) return;
  const used = new Set();
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      for (const value of Object.values(primitive.attributes || {})) used.add(value);
      if (Number.isInteger(primitive.indices)) used.add(primitive.indices);
    }
  }
  for (const animation of json.animations || []) {
    for (const sampler of animation.samplers || []) {
      used.add(sampler.input);
      used.add(sampler.output);
    }
  }
  if (used.size >= json.accessors.length) return;
  const remap = new Map();
  const kept = [];
  json.accessors.forEach((accessor, index) => {
    if (!used.has(index)) return;
    remap.set(index, kept.length);
    kept.push(accessor);
  });
  json.accessors = kept;
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      for (const key of Object.keys(primitive.attributes || {})) {
        primitive.attributes[key] = remap.get(primitive.attributes[key]);
      }
      if (Number.isInteger(primitive.indices)) primitive.indices = remap.get(primitive.indices);
    }
  }
  for (const animation of json.animations || []) {
    for (const sampler of animation.samplers || []) {
      sampler.input = remap.get(sampler.input);
      sampler.output = remap.get(sampler.output);
    }
  }
}

/** 与车机 CarSelfDatValidator 相同的硬上限，超限时在打包阶段就给出明确原因 */
function assertDeviceLimits(state) {
  const { json } = state;
  const checks = [
    [json.nodes?.length || 0, 256, '节点'],
    [json.meshes?.length || 0, 128, '网格'],
    [json.materials?.length || 0, 32, '材质'],
    [json.textures?.length || 0, 16, '贴图'],
  ];
  for (const [count, limit, label] of checks) {
    if (count > limit) {
      throw new Error(`超出车机导入上限：${label} ${count} 个（上限 ${limit}），请减少绑定项或简化模型`);
    }
  }
  const jsonSize = new TextEncoder().encode(JSON.stringify(json)).byteLength;
  if (jsonSize > 1024 * 1024) {
    throw new Error(`超出车机导入上限：模型描述 ${(jsonSize / 1024).toFixed(0)}KB（上限 1024KB），请简化模型`);
  }
}

function primitiveTriangleCount(json, primitive) {
  const accessorIndex = Number.isInteger(primitive.indices)
    ? primitive.indices
    : primitive.attributes?.POSITION;
  const count = json.accessors?.[accessorIndex]?.count || 0;
  return Math.floor(count / 3);
}

/**
 * 灯光选区可能同时切到灯罩、灯壳和车身等多个原始材质。车机要求一个
 * CS_* 灯节点只绑定一个同名材质，所以从中挑最像灯罩的材质作为灭灯外观：
 * 先看名称语义，再看透明/自发光属性，最后用覆盖三角形数打破平局。
 */
function chooseLampMaterial(json, primitives) {
  const candidates = new Map();
  for (const primitive of primitives || []) {
    if (!Number.isInteger(primitive.material) || !json.materials?.[primitive.material]) continue;
    const triangles = primitiveTriangleCount(json, primitive);
    candidates.set(primitive.material, (candidates.get(primitive.material) || 0) + triangles);
  }

  let best = null;
  for (const [materialIndex, triangles] of candidates) {
    const material = json.materials[materialIndex];
    const name = String(material.name || '').toLowerCase();
    const semantic = /light|lamp|glass|lens|led|emiss|red/.test(name) ? 1 : 0;
    const emissive = Number.isInteger(material.emissiveTexture?.index)
      || (Array.isArray(material.emissiveFactor) && material.emissiveFactor.some((value) => Number(value) > 0));
    const appearance = material.alphaMode === 'BLEND' || emissive ? 1 : 0;
    const score = [semantic, appearance, triangles];
    if (!best || score.some((value, index) => value !== best.score[index]
      && value > best.score[index]
      && score.slice(0, index).every((item, prior) => item === best.score[prior]))) {
      best = { material, score };
    }
  }

  return structuredClone(best?.material || {
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
  });
}

/**
 * 按用户配置切出部件、命名材质、生成动画。
 * bindings: [{ slotId, nodeIndex, region, pivot, axis, angle, color }]
 */
function applyBindings(state, bindings, sourceRoots, bake) {
  const result = { nodeIndices: [], animations: [], lamps: [] };
  if (!Array.isArray(bindings) || bindings.length === 0) return result;
  const { json } = state;
  const lampMaterialBySlot = new Map();

  // 第一阶段只复制：每个绑定都面对同一份未被其他绑定切过的源几何，
  // 因此完全重叠、部分重叠以及整节点与区域混用都不依赖处理顺序。
  for (const binding of bindings) {
    const slot = SLOT_BY_ID.get(binding.slotId);
    if (!slot) continue;
    const part = extractPart(state, {
      nodeIndices: sourceNodeIndicesOf(binding),
      region: binding.region || null,
      selection: binding.selection || null,
      pivot: binding.pivot,
      name: slot.id,
      label: slot.label,
      bake,
    });

    // 材质名与节点名保持一致，官方就是这么做的。灯光节点必须进一步保证
    // 所有 primitive 只使用一个同名独立材质：地图按材质名换灯光贴图，若与
    // 其他槽位或车身共享材质，就会出现“踩刹车所有灯一起亮”。
    const partMesh = json.meshes[json.nodes[part.nodeIndex].mesh];
    const isLamp = slot.kind === 'lamp' || slot.kind === 'blink';
    if (isLamp) {
      let materialIndex = lampMaterialBySlot.get(slot.id);
      if (materialIndex === undefined) {
        const material = chooseLampMaterial(json, partMesh.primitives);
        material.name = slot.id;
        if (!Array.isArray(json.materials)) json.materials = [];
        json.materials.push(material);
        materialIndex = json.materials.length - 1;
        lampMaterialBySlot.set(slot.id, materialIndex);
      }
      for (const primitive of partMesh.primitives) primitive.material = materialIndex;
    } else {
      // 轮胎、车门等机械部件保留各自原始材质，只把副本命名为对应槽位。
      const materialMap = new Map(); // 原材质索引 → 新材质索引
      for (const primitive of partMesh.primitives) {
        if (Number.isInteger(primitive.material) && json.materials?.[primitive.material]) {
          let newIndex = materialMap.get(primitive.material);
          if (newIndex === undefined) {
            const cloned = structuredClone(json.materials[primitive.material]);
            cloned.name = slot.id;
            json.materials.push(cloned);
            newIndex = json.materials.length - 1;
            materialMap.set(primitive.material, newIndex);
          }
          primitive.material = newIndex;
        }
      }
    }

    for (const animationName of animationNamesOf(slot)) {
      const keyframes = buildKeyframes(slot, binding, animationName);
      const input = writeAccessor(state, Float32Array.from(keyframes.times), 5126, 'SCALAR', {
        min: [keyframes.times[0]], max: [keyframes.times[keyframes.times.length - 1]],
      });
      const output = writeAccessor(state, Float32Array.from(keyframes.values), 5126,
        keyframes.path === 'rotation' ? 'VEC4' : 'VEC3');
      result.animations.push({
        name: animationName,
        samplers: [{ input, output, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: part.nodeIndex, path: keyframes.path } }],
      });
    }

    result.nodeIndices.push(part.nodeIndex);
    if (isLamp) {
      result.lamps.push({ slotId: slot.id, color: binding.color || slot.color });
    }
  }

  // 第二阶段统一消费静态源几何。区域绑定按并集扣除；整节点绑定只摘一次。
  // preserveSource（目前为双闪）只生成副本，不参与任何源几何删除。
  consumeBindingRegions(state, bindings, sourceRoots, bake);
  const detached = new Set();
  for (const binding of bindings) {
    if (binding.region || binding.selection || preservesSourceGeometry(binding)) continue;
    for (const nodeIndex of sourceNodeIndicesOf(binding)) {
      if (detached.has(nodeIndex) || !json.nodes?.[nodeIndex]?.mesh) continue;
      detachNode(json, sourceRoots, nodeIndex);
      detached.add(nodeIndex);
    }
  }
  return result;
}

function parseGlb(bytes) {
  const data = new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (readAscii(data, 0, 4) !== 'glTF' || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength) {
    throw new Error('不是有效的 GLB v2 文件');
  }
  let offset = 12;
  const chunks = [];
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) throw new Error('GLB chunk 越界');
    const length = view.getUint32(offset, true);
    const type = readAscii(data, offset + 4, 4);
    offset += 8;
    if (length % 4 || offset + length > data.byteLength) throw new Error('GLB chunk 长度无效');
    chunks.push({ type, bytes: data.slice(offset, offset + length) });
    offset += length;
  }
  if (chunks[0]?.type !== 'JSON') throw new Error('GLB 缺少 JSON chunk');
  const json = JSON.parse(new TextDecoder().decode(chunks[0].bytes).replace(/[\u0000 ]+$/, ''));
  if (json.asset?.version !== '2.0') throw new Error('只支持 glTF 2.0');
  const bin = chunks.find((chunk) => chunk.type === 'BIN\0')?.bytes || new Uint8Array();
  return { json, bin };
}

async function extractMainTexture({ json, bin }) {
  const mainMaterialIndex = json.meshes?.flatMap((mesh) => mesh.primitives || [])
    .map((primitive) => primitive.material)
    .find(Number.isInteger);
  const textureIndex = json.materials?.[mainMaterialIndex]?.pbrMetallicRoughness?.baseColorTexture?.index;
  const imageIndex = json.textures?.[textureIndex]?.source;
  const image = json.images?.[imageIndex];
  if (!image || !Number.isInteger(image.bufferView)) throw new Error('首版要求 GLB 内嵌至少一张主贴图');
  if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') {
    throw new Error(`不支持的主贴图格式：${image.mimeType || '未知'}`);
  }
  const view = json.bufferViews?.[image.bufferView];
  if (!view || view.buffer !== 0) throw new Error('主贴图 bufferView 无效');
  const offset = view.byteOffset || 0;
  const end = offset + view.byteLength;
  if (offset < 0 || end > bin.byteLength) throw new Error('主贴图数据越界');
  const bytes = bin.slice(offset, end);
  const png = image.mimeType === 'image/png' ? bytes : await transcodeToPng(bytes, image.mimeType);
  return { bytes: await fitPngBudget(png, 16 * 1024 * 1024 - 4096), mimeType: 'image/png' };
}

function extractNamedTexture({ json, bin }, materialName) {
  const material = json.materials?.find((item) => item.name === materialName);
  const textureIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
  const imageIndex = json.textures?.[textureIndex]?.source;
  const image = json.images?.[imageIndex];
  const view = json.bufferViews?.[image?.bufferView];
  if (!image || image.mimeType !== 'image/png' || !view || view.buffer !== 0) {
    throw new Error(`${materialName} 贴图无效`);
  }
  const offset = view.byteOffset || 0;
  const end = offset + view.byteLength;
  if (offset < 0 || end > bin.byteLength) throw new Error(`${materialName} 贴图数据越界`);
  return { bytes: bin.slice(offset, end), mimeType: 'image/png' };
}

/** 导入器单张贴图上限 16MiB：超限时降采样重编码。 */
async function fitPngBudget(bytes, budget) {
  let current = bytes;
  while (current.byteLength > budget) {
    const bitmap = await createImageBitmap(new Blob([current], { type: 'image/png' }));
    const w = Math.max(1, Math.round(bitmap.width / 2));
    const h = Math.max(1, Math.round(bitmap.height / 2));
    if (bitmap.width <= 128 || bitmap.height <= 128) {
      bitmap.close?.();
      throw new Error('主贴图无法压缩到 16MiB 以内');
    }
    const canvas = makeCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    current = await encodeCanvasPng(canvas);
  }
  return current;
}

/** 车机按 CarSelf_Main.png 读取外部贴图，JPEG 需要先转成 PNG。 */
async function transcodeToPng(bytes, mimeType) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持 2D 画布，无法转换主贴图');
    context.drawImage(bitmap, 0, 0);
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve, reject) => canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('主贴图编码失败'))), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close?.();
  }
}

function buildGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json, (_, value) => value === undefined ? undefined : value));
  const jsonPadded = pad(jsonBytes, 0x20);
  const binPadded = pad(bin, 0);
  const total = 12 + 8 + jsonPadded.byteLength + 8 + binPadded.byteLength;
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  writeAscii(output, 0, 'glTF');
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let offset = 12;
  view.setUint32(offset, jsonPadded.byteLength, true); writeAscii(output, offset + 4, 'JSON'); offset += 8;
  output.set(jsonPadded, offset); offset += jsonPadded.byteLength;
  view.setUint32(offset, binPadded.byteLength, true); writeAscii(output, offset + 4, 'BIN\0'); offset += 8;
  output.set(binPadded, offset);
  return output;
}

async function wrapCarSelf(glb) {
  if (!headerPromise) headerPromise = fetch(CARSELF_HEADER_URL).then((response) => {
    if (!response.ok) throw new Error('缺少 CarSelf 头模板');
    return response.arrayBuffer();
  });
  const headerBuffer = await headerPromise;
  const header = new Uint8Array(headerBuffer);
  if (header.byteLength !== 116) throw new Error('CarSelf 头模板长度错误');
  const output = new Uint8Array(116 + glb.byteLength + TAIL.byteLength);
  output.set(header, 0); output.set(glb, 116); output.set(TAIL, 116 + glb.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(12, output.byteLength, true);
  view.setUint32(100, glb.byteLength + 92, true);
  view.setUint32(108, glb.byteLength + 16, true);
  view.setUint32(112, glb.byteLength, true);
  return output;
}

async function sha256(bytes) {
  if (crypto?.subtle?.digest) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return toHex(new Uint8Array(hash));
  }
  // 局域网 IP 走 HTTP 时不是安全上下文，crypto.subtle 不存在，改用纯 JS 实现。
  return toHex(sha256Bytes(bytes));
}

function toHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value, count) {
  return ((value >>> count) | (value << (32 - count))) >>> 0;
}

function sha256Bytes(input) {
  const source = input instanceof Uint8Array ? input : new Uint8Array(input);
  const total = ((source.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(total);
  padded.set(source);
  padded[source.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = source.length * 8;
  view.setUint32(total - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(total - 4, bitLength >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let block = 0; block < total; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const output = new Uint8Array(32);
  const out = new DataView(output.buffer);
  for (let i = 0; i < 8; i++) out.setUint32(i * 4, h[i], false);
  return output;
}

function pad(bytes, fill) {
  const padding = (4 - (bytes.byteLength % 4)) % 4;
  const output = new Uint8Array(bytes.byteLength + padding);
  output.fill(fill); output.set(bytes); return output;
}
function readAscii(bytes, offset, length) { return String.fromCharCode(...bytes.slice(offset, offset + length)); }
function writeAscii(bytes, offset, value) { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); }

/** 生成与最终 .bydcar 完全同管线的 GLB，供“车机质感”预览。 */
export async function makeVehiclePreviewGlb(sourceBytes, transform, bindings = [], deletions = []) {
  const parsed = parseGlb(sourceBytes);
  const baked = await bakeMaterialsForVehicle(parsed);
  const normalized = await normalizeParsedGlb(baked, transform, bindings, [], deletions);
  await fitGlbBudget(normalized);
  await simplifyMeshToBudget(normalized);
  return buildGlb(normalized.json, normalized.bin);
}
