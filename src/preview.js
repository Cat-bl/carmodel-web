import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import {
  actionKindOf,
  animationNamesOf,
  buildKeyframes,
  isLampSlot,
  normalizeLampBeam,
  normalizeLampGlow,
  normalizeOtherPlayback,
} from './bindings.js';
import { createCarShadowCanvas, shadowFootprint } from './shadow.js';
import { inferModelFront } from './orientation.js';
import {
  beamLobes,
  beamQuadGeometry,
  buildLampArtwork,
  lampOverlayOffset,
  synthesizePlanarUv,
} from './lamp.js';
import {
  applyTriangleOperation,
  buildTriangleTopology,
  connectedTriangles,
  emptySelection,
  geometryTriangleCount,
  robustWheelPivot,
  selectionFromMap,
  selectionKey,
  selectionToMap,
  selectedTriangles,
  selectionGroupCount,
  selectionTriangleCount,
  splitTriangleIslands,
  triangleVertexIndices,
} from './selection.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const TARGET = Object.freeze({ x: 5.2, y: 1.8, z: 2.0 });

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function trimThreeTrack(track, start, end, speed) {
  const points = [start];
  for (const time of track.times) {
    if (time > start && time < end) points.push(Number(time));
  }
  if (end > start && points[points.length - 1] !== end) points.push(end);
  const components = track.getValueSize();
  const interpolant = track.createInterpolant(new Float32Array(components));
  const values = [];
  for (const point of points) values.push(...Array.from(interpolant.evaluate(point), Number));
  const times = points.map((point) => (point - start) / speed);
  return new track.constructor(track.name, times, values, track.getInterpolation());
}

function reverseThreeTrack(track) {
  const components = track.getValueSize();
  const duration = Number(track.times[track.times.length - 1]) || 0;
  const times = Array.from(track.times, (_, index) => duration - track.times[track.times.length - 1 - index]);
  const values = [];
  for (let frame = track.times.length - 1; frame >= 0; frame--) {
    for (let component = 0; component < components; component++) {
      values.push(track.values[frame * components + component]);
    }
  }
  return new track.constructor(track.name, times, values, track.getInterpolation());
}

function pingPongThreeTrack(track) {
  const components = track.getValueSize();
  const duration = Number(track.times[track.times.length - 1]) || 0;
  const times = Array.from(track.times, Number);
  const values = Array.from(track.values, Number);
  for (let frame = track.times.length - 2; frame >= 0; frame--) {
    times.push(duration + (duration - track.times[frame]));
    for (let component = 0; component < components; component++) {
      values.push(track.values[frame * components + component]);
    }
  }
  return new track.constructor(track.name, times, values, track.getInterpolation());
}

function configuredThreeClip(source, playback, { reverse = false } = {}) {
  const normalized = normalizeOtherPlayback(null, playback);
  const start = source.duration * normalized.range.start;
  const end = source.duration * normalized.range.end;
  let tracks = source.tracks.map((track) => trimThreeTrack(track, start, end, normalized.speed));
  if (normalized.direction === 'reverse') tracks = tracks.map(reverseThreeTrack);
  if (normalized.mode === 'pingpong') tracks = tracks.map(pingPongThreeTrack);
  if (reverse) tracks = tracks.map(reverseThreeTrack);
  const duration = tracks.reduce((max, track) => Math.max(max, Number(track.times[track.times.length - 1]) || 0), 0);
  return new THREE.AnimationClip(source.name, duration, tracks);
}

function staticTrackValue(root, track) {
  const values = new Float32Array(track.getValueSize());
  let binding = null;
  try {
    binding = THREE.PropertyBinding.create(root, track.name);
    binding.bind();
    binding.getValue(values, 0);
    return Array.from(values, Number).every(Number.isFinite) ? Array.from(values, Number) : null;
  } catch {
    return null;
  } finally {
    binding?.unbind?.();
  }
}

/** 网页质感使用与导出相同的静态姿态 → 动作首帧 smoothstep 过渡。 */
function enterThreeClip(root, active, transitionMs, name) {
  const duration = Math.max(0, Number(transitionMs) || 0) / 1000;
  if (!(duration > 0)) return null;
  const frameCount = 8;
  const times = Array.from({ length: frameCount }, (_, frame) => duration * frame / (frameCount - 1));
  const tracks = active.tracks.map((track) => {
    const components = track.getValueSize();
    const end = Array.from(track.values.slice(0, components), Number);
    const start = staticTrackValue(root, track) || end;
    const values = [];
    const isQuaternion = track instanceof THREE.QuaternionKeyframeTrack;
    const startQuaternion = isQuaternion ? new THREE.Quaternion().fromArray(start).normalize() : null;
    const endQuaternion = isQuaternion ? new THREE.Quaternion().fromArray(end).normalize() : null;
    for (let frame = 0; frame < frameCount; frame++) {
      const progress = frame / (frameCount - 1);
      const eased = progress * progress * (3 - 2 * progress);
      if (isQuaternion) {
        values.push(...startQuaternion.clone().slerp(endQuaternion, eased).toArray());
      } else {
        values.push(...start.map((value, index) => value + (end[index] - value) * eased));
      }
    }
    return new track.constructor(track.name, times, values, THREE.InterpolateLinear);
  });
  return tracks.length ? new THREE.AnimationClip(name, duration, tracks) : null;
}

function captureTrackRestValues(root, tracks, existing = null) {
  const values = new Map(existing || []);
  for (const track of tracks || []) {
    if (values.has(track.name)) continue;
    const value = staticTrackValue(root, track);
    if (value) values.set(track.name, value);
  }
  return values;
}

/** 从网页当前实际显示姿态平滑回到首次播放前的模型静态姿态。 */
function resetThreeClip(root, source, restValues, transitionMs, name) {
  const duration = Math.max(0, Number(transitionMs) || 0) / 1000;
  if (!(duration > 0) || !source?.tracks?.length) return null;
  const frameCount = 8;
  const times = Array.from({ length: frameCount }, (_, frame) => duration * frame / (frameCount - 1));
  const tracks = [];
  for (const track of source.tracks) {
    const start = staticTrackValue(root, track);
    const end = restValues?.get(track.name);
    if (!start || !end || start.length !== end.length) continue;
    const values = [];
    const isQuaternion = track instanceof THREE.QuaternionKeyframeTrack;
    const startQuaternion = isQuaternion ? new THREE.Quaternion().fromArray(start).normalize() : null;
    const endQuaternion = isQuaternion ? new THREE.Quaternion().fromArray(end).normalize() : null;
    for (let frame = 0; frame < frameCount; frame++) {
      const progress = frame / (frameCount - 1);
      const eased = progress * progress * (3 - 2 * progress);
      if (isQuaternion) {
        values.push(...startQuaternion.clone().slerp(endQuaternion, eased).toArray());
      } else {
        values.push(...start.map((value, index) => value + (end[index] - value) * eased));
      }
    }
    tracks.push(new track.constructor(track.name, times, values, THREE.InterpolateLinear));
  }
  return tracks.length ? new THREE.AnimationClip(name, duration, tracks) : null;
}

function isShadowObject(object) {
  const materials = object?.isMesh
    ? (Array.isArray(object.material) ? object.material : [object.material])
    : [];
  return String(object?.name || '').startsWith('CS_Shadow')
    || String(object?.name || '').startsWith('Imported_CS_Shadow')
    || materials.some((material) => String(material?.name || '').startsWith('CS_Shadow'));
}

function readFileWithProgress(file, onProgress) {
  if (typeof FileReader === 'undefined') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total) onProgress?.(event.loaded / event.total);
    };
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取模型文件失败'));
    reader.onabort = () => reject(new Error('读取模型文件已取消'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 游戏模型常把剪切贴图标成 BLEND，three 会因此关掉深度写入：同一节点里后画的面会盖住先画的贴片
 * （脸皮盖掉眼睛、头发盖掉蝴蝶结）。恢复深度写入并丢弃全透明像素，效果与游戏内一致。
 */
function fixTransparentMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (!material?.transparent) continue;
      material.depthWrite = true;
      if (!(material.alphaTest > 0)) material.alphaTest = 0.05;
      material.needsUpdate = true;
    }
  });
}

export class ModelPreview {
  constructor(canvas, onStats) {
    this.canvas = canvas;
    this.onStats = onStats;
    this.model = null;
    this.original = null;
    this.exportTransform = null;
    this.rotation = { x: 0, y: 0, z: 0 };
    this.targetLength = TARGET.x;
    this.heightOffset = 0;
    this.removeShadow = false;
    this.modelBrightness = 1;
    this.nodeObjects = [];
    this.loadedAnimations = [];
    this.mixer = null;
    this.bindingPreview = null;
    // 车机质感：导出管线生成的各灯位点亮图集；网页质感：源贴图像素缓存（生成点亮贴图用）
    this.deviceLampTextures = new Map();
    this.lampImageCache = new Map();
    this.highlight = null;
    this.selectionOverlay = null;
    this.selectionMeshes = new Map();
    this.selectionBvh = new WeakMap();
    this.selectionTopology = new WeakMap();
    this.selectionState = null;
    this.selectionPointer = null;
    this.selectionStatus = null;
    this.selectionStrokeSerial = 0;
    this.clock = new THREE.Clock();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0xd7e0ea, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));

    this.scene = new THREE.Scene();
    // 远处路面渐隐进天色，模拟车道级画面的纵深
    this.scene.fog = new THREE.Fog(0xd7e0ea, 38, 110);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
    this.camera.position.set(7.5, 4.6, 7.5);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.zoomToCursor = true;
    this.controls.target.set(0, 0.8, 0);
    this.controls.minDistance = 2;
    this.controls.maxDistance = 40;
    this.orbitLocks = new Set();

    const hemi = new THREE.HemisphereLight(0xffffff, 0x7d8ca3, 2.25);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(-4, 8, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbad7ff, 1.4);
    fill.position.set(7, 3, -5);
    this.scene.add(fill);
    // 车机质感要如实反映车机：光照远弱于网页模式（按实车照片标定），过暗的车漆在这里就该看得出来
    this.lightRig = {
      lights: { hemi, key, fill },
      web: { hemi: 2.25, key: 3.2, fill: 1.4 },
      device: { hemi: 0.85, key: 0.7, fill: 0.2 },
    };

    this.createRoadScene();
    this.createAutomaticShadow();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.animate = this.animate.bind(this);
    this.animate();
  }

  createAutomaticShadow() {
    const texture = new THREE.CanvasTexture(createCarShadowCanvas(false));
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.autoShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.autoShadow.rotation.x = -Math.PI / 2;
    this.autoShadow.position.y = 0.012;
    this.autoShadow.renderOrder = 2;
    this.autoShadow.visible = false;
    this.scene.add(this.autoShadow);
  }

  updateAutomaticShadow(box) {
    if (!this.autoShadow || this.removeShadow || this.deviceMode || !box || box.isEmpty()) {
      if (this.autoShadow) this.autoShadow.visible = false;
      return;
    }
    const footprint = shadowFootprint(
      [box.min.x, box.min.y, box.min.z],
      [box.max.x, box.max.y, box.max.z],
      this.groundShadowSamples(box),
    );
    this.autoShadow.position.set(footprint.centerX, 0.012, footprint.centerZ);
    this.autoShadow.scale.set(footprint.sizeX, footprint.sizeZ, 1);
    this.autoShadow.visible = true;
  }

  setRemoveShadow(enabled) {
    this.removeShadow = Boolean(enabled);
    this.syncModelShadowVisibility();
    if (!this.model) {
      if (this.autoShadow) this.autoShadow.visible = false;
      return;
    }
    this.updateAutomaticShadow(new THREE.Box3().setFromObject(this.model));
  }

  setBrightness(value) {
    const number = Number(value);
    this.modelBrightness = Number.isFinite(number) ? Math.min(3, Math.max(0.5, number)) : 1;
    if (!this.deviceMode) this.applyModelBrightness();
  }

  applyModelBrightness() {
    if (!this.model) return;
    const brightness = this.modelBrightness;
    this.model.traverse((object) => {
      if (!object.isMesh || !object.material || isShadowObject(object)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        material.userData ||= {};
        if (!material.userData.modelBrightnessBase) {
          material.userData.modelBrightnessBase = {
            color: material.color?.clone() || null,
            emissive: material.emissive?.clone() || null,
          };
        }
        const base = material.userData.modelBrightnessBase;
        if (base.color && material.color) material.color.copy(base.color).multiplyScalar(brightness);
        if (base.emissive && material.emissive) material.emissive.copy(base.emissive).multiplyScalar(brightness);
      }
    });
  }

  syncModelShadowVisibility() {
    this.model?.traverse((object) => {
      if (isShadowObject(object)) object.visible = Boolean(this.deviceMode && !this.removeShadow);
    });
  }

  groundShadowSamples(box) {
    const meshes = [];
    let totalVertices = 0;
    this.model?.traverse((object) => {
      if (!object.isMesh || isShadowObject(object)) return;
      const position = object.geometry?.attributes?.position;
      if (!position) return;
      meshes.push({ object, position });
      totalVertices += position.count;
    });
    const stride = Math.max(1, Math.ceil(totalVertices / 20000));
    const groundY = box.min.y + Math.max(0.03, (box.max.y - box.min.y) * 0.12);
    const point = new THREE.Vector3();
    const samples = [];
    for (const { object, position } of meshes) {
      for (let i = 0; i < position.count; i += stride) {
        point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
        if (point.y <= groundY) samples.push(point.x, point.z);
      }
    }
    return samples;
  }

  /**
   * 车道级路面场景：三条 3.5 米车道的沥青路，车停在中间车道，
   * 白色分道虚线与边线可直接当作尺寸参照（真车约占车道一半宽），
   * 路面直行箭头兼作车头方向标识（车头朝 −X）。
   * 标线用 polygonOffset 抬到路面之上、路外地面与路面零重叠拼接，
   * 避免镜头拉远时的深度冲突闪烁。
   */
  createRoadScene() {
    const laneWidth = 3.5;
    const roadLength = 500;
    const roadWidth = laneWidth * 3;
    const road = new THREE.Group();

    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(roadLength, roadWidth),
      new THREE.MeshLambertMaterial({ color: 0x4a515c }),
    );
    asphalt.rotation.x = -Math.PI / 2;
    road.add(asphalt);

    // 路外地面分成左右两块，与路面同一平面但互不重叠，从根上消除 z-fighting
    const sideWidth = 240;
    const groundMaterial = new THREE.MeshLambertMaterial({ color: 0xd0d7cd });
    for (const side of [-1, 1]) {
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(roadLength, sideWidth), groundMaterial);
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(0, 0, side * (roadWidth / 2 + sideWidth / 2));
      road.add(ground);
    }

    // 标线：不写深度 + 深度偏移拉近，任何距离下都稳定压在路面上且仍会被车身遮挡
    const lineMaterial = new THREE.MeshBasicMaterial({
      color: 0xeff3f7,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const addLine = (mesh) => {
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 1; // 保证在路面之后绘制
      road.add(mesh);
    };
    const edgeGeometry = new THREE.PlaneGeometry(roadLength, 0.16);
    for (const z of [-roadWidth / 2 + 0.24, roadWidth / 2 - 0.24]) {
      const line = new THREE.Mesh(edgeGeometry, lineMaterial);
      addLine(line);
      line.position.set(0, 0.004, z);
    }
    const dashGeometry = new THREE.PlaneGeometry(2.6, 0.15);
    for (const z of [-laneWidth / 2, laneWidth / 2]) {
      for (let x = -roadLength / 2 + 2; x < roadLength / 2; x += 6.5) {
        const dash = new THREE.Mesh(dashGeometry, lineMaterial);
        addLine(dash);
        dash.position.set(x, 0.004, z);
      }
    }

    // 路面直行导向箭头（指向车头 −X）
    const arrowMaterial = new THREE.MeshBasicMaterial({
      color: 0xeff3f7,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const stem = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.34), arrowMaterial);
    addLine(stem);
    stem.position.set(-5.1, 0.004, 0);
    const head = new THREE.Mesh(new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.75, 0, 0, 0.55, 0.6, 0, 0.55, -0.6, 0], 3),
    ), arrowMaterial);
    addLine(head);
    head.position.set(-6.75, 0.004, 0);

    this.scene.add(road);

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256;
    labelCanvas.height = 72;
    const ctx = labelCanvas.getContext('2d');
    ctx.font = '600 28px system-ui';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(23, 32, 45, 0.55)';
    ctx.strokeText('车头方向', 38, 45);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('车头方向', 38, 45);
    const texture = new THREE.CanvasTexture(labelCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.position.set(-5.6, 0.62, 1.75);
    sprite.scale.set(2.1, 0.6, 1);
    this.scene.add(sprite);
  }

  async load(source, onProgress = null, { modelType = 'vehicle' } = {}) {
    const report = (progress, label, indeterminate = false) => onProgress?.({ progress, label, indeterminate });
    report(0.04, '正在读取规范化模型');
    const bytes = source?.bytes
      ? new Uint8Array(source.bytes)
      : new Uint8Array(await readFileWithProgress(source, (ratio) => report(0.04 + ratio * 0.22, '正在读取模型文件')));
    report(0.3, '正在解析模型与纹理', true);
    await nextPaint();
    const gltf = await new Promise((resolve, reject) => {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      new GLTFLoader().parse(buffer, '', resolve, reject);
    });
    report(0.64, '正在建立预览场景');
    await nextPaint();
    this.disposeModel();
    this.original = bytes.slice(0);
    this.deviceMode = false;
    this.hiddenMaterials = null;
    this.model = gltf.scene;
    this.loadedAnimations = gltf.animations || [];
    this.model.name = 'CS_Car';
    this.otherModel = modelType === 'other';
    if (this.otherModel) fixTransparentMaterials(this.model);
    this.scene.add(this.model);
    this.applyModelBrightness();
    this.syncModelShadowVisibility();
    const isVehicle = modelType !== 'other';
    report(0.72, isVehicle ? '正在分析模型朝向' : '正在保留模型原始朝向');
    const orientation = isVehicle
      ? inferModelFront(this.model)
      : { detected: false, rotationY: 0, confidence: 1, method: 'original', reason: '其他模型保持原始朝向' };
    this.rotation = { x: 0, y: orientation.rotationY, z: 0 };
    this.normalize();
    this.frameObject();
    report(0.82, '正在建立部件索引');
    await this.indexNodes(gltf, (ratio) => report(0.82 + ratio * 0.1, '正在建立部件索引'));
    report(0.94, '正在统计模型信息');
    const stats = collectStats(gltf, bytes.byteLength);
    this.onStats?.(stats);
    return { gltf, bytes, stats, orientation };
  }

  /**
   * 建立 glTF 节点索引 → Three 对象的映射。
   * 用 parser.getDependency 而不是按名字匹配，因为节点名可能重复或缺失。
   */
  async indexNodes(gltf, onProgress = null) {
    this.nodeObjects = [];
    this.nodeObjectSet = null;
    this.selectionMeshes = new Map();
    this.gltfJson = gltf.parser?.json || null;
    const nodes = gltf.parser?.json?.nodes || [];
    const progressStride = Math.max(1, Math.ceil(nodes.length / 80));
    for (let i = 0; i < nodes.length; i++) {
      try {
        this.nodeObjects[i] = await gltf.parser.getDependency('node', i);
      } catch {
        this.nodeObjects[i] = null;
      }
      if ((i + 1) % progressStride === 0 || i === nodes.length - 1) onProgress?.((i + 1) / nodes.length);
    }
    if (!nodes.length) onProgress?.(1);
    this.nodeObjects.forEach((_, nodeIndex) => {
      this.meshesOfNode(nodeIndex).forEach((mesh, primitiveIndex) => {
        if (!mesh?.geometry) return;
        this.selectionMeshes.set(mesh, { nodeIndex, primitiveIndex });
      });
    });
  }

  /** Lists source clips that can be preserved as normal glTF TRS animations.
   * The built-in R1 model proves that the renderer accepts skinned meshes and
   * multi-channel clips. CUBICSPLINE samplers and matrix nodes are baked into
   * LINEAR TRS on export; morph targets stay excluded because the renderer
   * has no vertex animation. */
  listBindableAnimations() {
    const json = this.gltfJson;
    if (!json?.animations?.length) return [];
    const scene = json.scenes?.[Number.isInteger(json.scene) ? json.scene : 0];
    const nodeIndices = [];
    const seen = new Set();
    const visit = (index) => {
      if (seen.has(index)) return;
      seen.add(index);
      const node = json.nodes?.[index];
      if (!node) return;
      if (Number.isInteger(node.mesh)) nodeIndices.push(index);
      for (const child of node.children || []) visit(child);
    };
    for (const root of scene?.nodes || []) visit(root);
    if (nodeIndices.length === 0) return [];
    const options = [];
    json.animations.forEach((animation, index) => {
      const channels = animation.channels || [];
      if (channels.length === 0) return;
      let valid = true;
      for (const channel of channels) {
        const path = channel.target?.path;
        const targetNodeIndex = channel.target?.node;
        const sampler = animation.samplers?.[channel.sampler];
        if (!Number.isInteger(targetNodeIndex)
          || !['translation', 'rotation', 'scale'].includes(path)
          || !sampler) {
          valid = false;
          break;
        }
      }
      if (!valid) return;
      const clip = this.loadedAnimations[index];
      if (!clip || clip.tracks.length === 0 || !(Number(clip.duration) > 0)) return;
      options.push({
        index,
        name: String(animation.name || clip.name || `动画 ${index + 1}`),
        duration: Number(clip.duration) || 0,
        channelCount: channels.length,
        skinned: nodeIndices.some((nodeIndex) => Number.isInteger(json.nodes?.[nodeIndex]?.skin)),
        nodeIndices: [...nodeIndices],
      });
    });
    return options;
  }

  /**
   * 某个 glTF 节点自己持有的网格（不含子节点的）。
   * 多 primitive 的节点会被 GLTFLoader 展开成 Group + 若干子 Mesh，
   * 直接用 isMesh 判断会漏掉它们；这里的口径与导出端 extractPart 一致。
   */
  /** 隐藏指定材质的子网格（按源 glTF 材质下标）；车机质感预览用的是已剔除的导出结果，不需要再隐藏。 */
  setHiddenMaterials(materialIndices) {
    this.hiddenMaterials = new Set(materialIndices || []);
    this.applyHiddenMaterials();
  }

  applyHiddenMaterials() {
    if (!this.model || this.deviceMode || !this.gltfJson) return;
    for (const [mesh, meta] of this.selectionMeshes) {
      mesh.visible = !this.hiddenMaterials?.has(this.primitiveOf(meta)?.material);
    }
  }

  primitiveOf({ nodeIndex, primitiveIndex }) {
    const meshIndex = this.gltfJson?.nodes?.[nodeIndex]?.mesh;
    return this.gltfJson?.meshes?.[meshIndex]?.primitives?.[primitiveIndex];
  }

  /** 鼠标悬停子网格列表时框出该材质的所有网格。 */
  highlightSubmesh(materialIndex) {
    this.clearHighlight();
    if (!this.model || this.deviceMode || !this.gltfJson) return;
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const temp = new THREE.Vector3();
    for (const [mesh, meta] of this.selectionMeshes) {
      if (this.primitiveOf(meta)?.material === materialIndex) this.expandByMeshVertices(box, mesh, temp);
    }
    this.showHighlightBox(box);
  }

  /** 游戏模型的各子网格常共用一份顶点缓冲，几何包围盒是全身；只取该网格索引到的顶点，并带上蒙皮变换。 */
  expandByMeshVertices(box, mesh, point) {
    const position = mesh.geometry?.attributes?.position;
    if (!position) return;
    const index = mesh.geometry.index;
    const vertices = index ? new Set(index.array) : Array.from({ length: position.count }, (_, i) => i);
    for (const vertex of vertices) {
      point.fromBufferAttribute(position, vertex);
      if (mesh.isSkinnedMesh) mesh.applyBoneTransform(vertex, point);
      box.expandByPoint(point.applyMatrix4(mesh.matrixWorld));
    }
  }

  meshesOfNode(index) {
    const object = this.nodeObjects?.[index];
    if (!object) return [];
    if (object.isMesh) return [object];
    if (!this.nodeObjectSet) this.nodeObjectSet = new Set((this.nodeObjects || []).filter(Boolean));
    return (object.children || []).filter((child) => child.isMesh && !this.nodeObjectSet.has(child));
  }

  /** 只算该网格自身几何的世界包围盒，忽略挂在它下面的子节点 */
  expandByMeshGeometry(box, mesh, temp) {
    if (!mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    temp.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    box.union(temp);
  }

  /** 可供绑定的部件列表；包围盒用世界坐标（= 车机最终空间），与选区、导出同一空间。 */
  listParts() {
    const parts = [];
    const temp = new THREE.Box3();
    this.model?.updateMatrixWorld(true);
    (this.nodeObjects || []).forEach((object, index) => {
      const meshes = this.meshesOfNode(index);
      if (meshes.length === 0) return;
      let triangles = 0;
      const box = new THREE.Box3();
      for (const mesh of meshes) {
        const geometry = mesh.geometry;
        triangles += geometry?.index
          ? geometry.index.count / 3
          : (geometry?.attributes?.position?.count || 0) / 3;
        this.expandByMeshGeometry(box, mesh, temp);
      }
      if (box.isEmpty()) return;
      parts.push({
        nodeIndex: index,
        name: object.name || `节点 ${index}`,
        triangles: Math.round(triangles),
        bounds: { min: box.min.toArray(), max: box.max.toArray() },
      });
    });
    return parts;
  }

  /**
   * 两层部件分组：从场景根往下钻过“独生链”（单孩子且自身无网格的组织节点），
   * 到达第一个分叉层，把该层每个子树归为一组。下载的模型通常正是在这一层
   * 按部件命名（Door_FL、hood、trunk…），正好用作整组勾选的粒度。
   */
  listPartGroups() {
    const json = this.gltfJson;
    if (!json?.nodes) return [];
    let level = (json.scenes?.[json.scene ?? 0]?.nodes || []).slice();
    while (level.length === 1) {
      const node = json.nodes[level[0]];
      const kids = node?.children || [];
      if (Number.isInteger(node?.mesh) || kids.length === 0) break;
      level = kids.slice();
    }
    const groups = [];
    for (const rootIndex of level) {
      const leaves = [];
      const walk = (index) => {
        const node = json.nodes[index];
        if (!node) return;
        if (Number.isInteger(node.mesh) && this.meshesOfNode(index).length) leaves.push(index);
        for (const child of node.children || []) walk(child);
      };
      walk(rootIndex);
      if (leaves.length === 0) continue;
      groups.push({ name: json.nodes[rootIndex].name || `部件 ${rootIndex}`, leaves });
    }
    return groups;
  }

  /** 精细选面工作台：selection 以原始节点/primitive/triangle ordinal 保存。 */
  setTriangleSelection(enabled, selection, options = {}) {
    if (!enabled) {
      const pointerId = this.selectionPointer?.pointerId;
      this.selectionState = null;
      this.selectionPointer = null;
      this.canvas.style.cursor = '';
      this.clearSelectionOverlay();
      this.setOrbitLocked('triangle-selection', false);
      if (pointerId !== undefined && this.canvas.hasPointerCapture?.(pointerId)) {
        this.canvas.releasePointerCapture(pointerId);
      }
      return;
    }
    this.selectionState = {
      map: selectionToMap(selection || emptySelection()),
      mode: options.mode || 'smart',
      operation: options.operation || 'add',
      brushRadius: Number(options.brushRadius) || 28,
      angle: Number(options.angle) || 38,
      visibleOnly: options.visibleOnly !== false,
      onChange: options.onChange || null,
      onStatus: options.onStatus || null,
    };
    this.canvas.style.cursor = this.selectionState.mode === 'brush' ? 'cell' : 'crosshair';
    this.updateSelectionOverlay();
    this.emitSelectionStatus('ready');
    if (this.selectionPointerWired) return;
    this.selectionPointerWired = true;
    const runPaint = (pointer, clientX, clientY) => {
      if (!this.selectionState || this.selectionPointer !== pointer || !pointer.painting || pointer.cancelled) return;
      pointer.lastX = clientX;
      pointer.lastY = clientY;
      pointer.paintX = clientX;
      pointer.paintY = clientY;
      pointer.busy = true;
      this.applyBrushAt(clientX, clientY, { strokeId: pointer.strokeId }).finally(() => {
        if (this.selectionPointer !== pointer) return;
        pointer.busy = false;
        if (pointer.cancelled) {
          this.selectionPointer = null;
        } else if (pointer.pending) {
          const [targetX, targetY] = pointer.pending;
          const dx = targetX - pointer.paintX;
          const dy = targetY - pointer.paintY;
          const distance = Math.hypot(dx, dy);
          const spacing = Math.max(4, (this.selectionState?.brushRadius || 28) * 0.65);
          if (distance <= spacing) pointer.pending = null;
          const ratio = distance > spacing ? spacing / distance : 1;
          runPaint(pointer, pointer.paintX + dx * ratio, pointer.paintY + dy * ratio);
        } else if (!pointer.active) {
          this.selectionPointer = null;
        }
      });
    };
    const paintAt = (pointer, clientX, clientY) => {
      if (!this.selectionState || this.selectionPointer !== pointer || !pointer.painting || pointer.cancelled) return;
      pointer.lastX = clientX;
      pointer.lastY = clientY;
      if (pointer.busy) {
        // BVH 首次建立或大选区刷新期间保留最新位置，完成后沿路径自动补点。
        pointer.pending = [clientX, clientY];
        return;
      }
      runPaint(pointer, clientX, clientY);
    };
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.selectionState) return;
      const painting = this.selectionState.mode === 'brush' && this.hasSelectableSurfaceAt(event.clientX, event.clientY);
      const pointer = {
        active: true,
        busy: false,
        painting,
        pending: null,
        cancelled: false,
        strokeId: painting ? ++this.selectionStrokeSerial : null,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      this.selectionPointer = pointer;
      // 智能点选只把短点击识别为选面，拖动仍交给 OrbitControls。
      // 画笔从空白处起笔时同样用于转动视角，只有落在模型上才锁定相机并涂选。
      if (!painting) return;
      this.canvas.setPointerCapture?.(event.pointerId);
      this.setOrbitLocked('triangle-selection', true);
      paintAt(pointer, event.clientX, event.clientY);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.selectionState || !this.selectionPointer?.active) return;
      if (this.selectionState.mode !== 'brush' || !this.selectionPointer.painting) return;
      paintAt(this.selectionPointer, event.clientX, event.clientY);
    });
    const finishPointer = (event, cancelled = false) => {
      const pointer = this.selectionPointer;
      if (!pointer || (event.pointerId !== undefined && event.pointerId !== pointer.pointerId)) return;
      const clientX = Number.isFinite(event.clientX) ? event.clientX : pointer.lastX;
      const clientY = Number.isFinite(event.clientY) ? event.clientY : pointer.lastY;
      const moved = Math.hypot(clientX - pointer.startX, clientY - pointer.startY);
      const mode = this.selectionState.mode;
      pointer.active = false;
      pointer.cancelled = cancelled;
      if (cancelled) pointer.pending = null;
      this.setOrbitLocked('triangle-selection', false);
      if (this.canvas.hasPointerCapture?.(pointer.pointerId)) this.canvas.releasePointerCapture(pointer.pointerId);
      if (mode === 'smart') {
        this.selectionPointer = null;
        if (!cancelled && moved <= 7) this.selectSmartTriangle(clientX, clientY);
      } else if (!pointer.busy && !pointer.pending) {
        this.selectionPointer = null;
      }
    };
    this.canvas.addEventListener('pointerup', (event) => {
      if (!this.selectionState) return;
      finishPointer(event);
    });
    this.canvas.addEventListener('pointercancel', (event) => finishPointer(event, true));
    // 正常 pointerup 也会先触发 lostpointercapture，延迟到微任务后再判断，
    // 这样只恢复真正丢失的手势，不会误取消一次正常点击或画笔收尾。
    this.canvas.addEventListener('lostpointercapture', (event) => {
      const pointer = this.selectionPointer;
      if (!pointer) return;
      queueMicrotask(() => {
        if (this.selectionPointer === pointer && pointer.active) finishPointer(event, true);
      });
    });
  }

  setTriangleSelectionOptions(options = {}) {
    if (!this.selectionState) return;
    Object.assign(this.selectionState, options);
    this.canvas.style.cursor = this.selectionState.mode === 'brush' ? 'cell' : 'crosshair';
    this.emitSelectionStatus('ready');
  }

  getTriangleSelection() {
    return this.selectionState ? selectionFromMap(this.selectionState.map) : emptySelection();
  }

  selectionStats(selection = this.getTriangleSelection()) {
    const map = selectionToMap(selection);
    const points = [];
    const islandCenters = [];
    for (const [key, triangles] of map) {
      const [nodeIndex, primitiveIndex] = key.split(':').map(Number);
      const mesh = [...this.selectionMeshes.entries()].find(([, meta]) => (
        meta.nodeIndex === nodeIndex && meta.primitiveIndex === primitiveIndex
      ))?.[0];
      if (!mesh) continue;
      const position = mesh.geometry.attributes?.position;
      if (!position) continue;
      for (const island of splitTriangleIslands(mesh.geometry, triangles)) {
        const center = new THREE.Vector3();
        let count = 0;
        for (const triangle of island) {
          const indices = triangleVertexIndices(mesh.geometry, triangle);
          for (const index of indices) {
            const point = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
            points.push(point.toArray());
            center.add(point);
            count++;
          }
        }
        if (count) islandCenters.push(center.multiplyScalar(1 / count).toArray());
      }
    }
    const pivot = robustWheelPivot(points, islandCenters);
    return {
      groups: selectionGroupCount(selection),
      triangles: selectionTriangleCount(selection),
      points,
      islandCenters,
      pivot,
    };
  }

  selectionFromRegion(region) {
    const map = new Map();
    const center = new THREE.Vector3();
    const point = new THREE.Vector3();
    for (const [mesh, meta] of this.selectionMeshes) {
      const position = mesh.geometry.attributes?.position;
      if (!position) continue;
      const triangles = new Set();
      const count = geometryTriangleCount(mesh.geometry);
      for (let triangle = 0; triangle < count; triangle++) {
        const vertices = triangleVertexIndices(mesh.geometry, triangle);
        center.set(0, 0, 0);
        for (const index of vertices) {
          point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
          center.add(point);
        }
        center.multiplyScalar(1 / 3);
        if (insideRegion(region, center.x, center.y, center.z)) triangles.add(triangle);
      }
      if (triangles.size) map.set(selectionKey(meta.nodeIndex, meta.primitiveIndex), triangles);
    }
    return selectionFromMap(map);
  }

  async ensureSelectionBvh(mesh) {
    if (mesh.geometry.boundsTree) return mesh.geometry.boundsTree;
    this.emitSelectionStatus('building');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    mesh.geometry.boundsTree = new MeshBVH(mesh.geometry, { indirect: true, targetLeafSize: 12 });
    this.emitSelectionStatus('ready');
    return mesh.geometry.boundsTree;
  }

  async pickTriangleAt(clientX, clientY) {
    if (!this.model) return null;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    raycaster.setFromCamera(pointer, this.camera);
    for (const hit of raycaster.intersectObject(this.model, true)) {
      if (hit.object.userData?.selectionOverlay) continue;
      if (!this.selectionMeshes.has(hit.object)) continue;
      const visible = hit.object.visible && hit.object.parent?.visible !== false;
      if (!visible) continue;
      await this.ensureSelectionBvh(hit.object);
      let triangle = Number.isInteger(hit.faceIndex) ? hit.faceIndex : -1;
      if (triangle < 0) continue;
      return { ...hit, mesh: hit.object, triangle, meta: this.selectionMeshes.get(hit.object) };
    }
    return null;
  }

  hasSelectableSurfaceAt(clientX, clientY) {
    if (!this.model) return false;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    raycaster.setFromCamera(pointer, this.camera);
    return raycaster.intersectObject(this.model, true).some((hit) => (
      !hit.object.userData?.selectionOverlay
      && this.selectionMeshes.has(hit.object)
      && hit.object.visible
      && hit.object.parent?.visible !== false
    ));
  }

  async selectSmartTriangle(clientX, clientY) {
    const state = this.selectionState;
    if (!state) return;
    const hit = await this.pickTriangleAt(clientX, clientY);
    if (!hit || this.selectionState !== state) return;
    const topology = this.selectionTopology.get(hit.mesh.geometry) || buildTriangleTopology(hit.mesh.geometry);
    this.selectionTopology.set(hit.mesh.geometry, topology);
    const triangles = connectedTriangles(topology, hit.triangle, state.angle);
    this.applySelectionOperation(hit.meta, triangles);
  }

  async applyBrushAt(clientX, clientY, change = {}) {
    const state = this.selectionState;
    if (!state) return;
    const hit = await this.pickTriangleAt(clientX, clientY);
    if (!hit || this.selectionState !== state) return;
    const geometry = hit.mesh.geometry;
    const tree = await this.ensureSelectionBvh(hit.mesh);
    if (this.selectionState !== state) return;
    const rect = this.canvas.getBoundingClientRect();
    const distance = hit.distance || this.camera.position.distanceTo(hit.point);
    const worldRadius = Math.max(0.002, distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 2 * state.brushRadius / rect.height);
    const inverse = hit.mesh.matrixWorld.clone().invert();
    const sphere = new THREE.Sphere(hit.point.clone().applyMatrix4(inverse), worldRadius);
    const candidates = new Set();
    const tri = new THREE.Triangle();
    const position = geometry.attributes?.position;
    if (!position) return;
    tree.shapecast({
      intersectsBounds: (box) => box.intersectsSphere(sphere),
      intersectsTriangle: (triangle, index) => {
        if (triangle instanceof THREE.Triangle) tri.copy(triangle);
        const center = tri.getMidpoint(new THREE.Vector3());
        const worldCenter = center.clone().applyMatrix4(hit.mesh.matrixWorld);
        const projected = worldCenter.clone().project(this.camera);
        const sx = rect.left + ((projected.x + 1) / 2) * rect.width;
        const sy = rect.top + ((1 - projected.y) / 2) * rect.height;
        if (Math.hypot(sx - clientX, sy - clientY) > state.brushRadius) return false;
        if (state.visibleOnly && !this.isTriangleVisible(hit.mesh, index, worldCenter)) return false;
        candidates.add(index);
        return false;
      },
    });
    this.applySelectionOperation(hit.meta, candidates, change);
  }

  isTriangleVisible(mesh, triangleIndex, worldCenter) {
    const tree = mesh.geometry.boundsTree;
    if (!tree) return true;
    const inverse = mesh.matrixWorld.clone().invert();
    const origin = this.camera.position.clone().applyMatrix4(inverse);
    const localCenter = worldCenter.clone().applyMatrix4(inverse);
    const direction = localCenter.clone().sub(origin);
    const distance = direction.length();
    if (distance < 1e-6) return true;
    direction.normalize();
    const hit = tree.raycastFirst(new THREE.Ray(origin, direction), THREE.DoubleSide);
    return !hit || hit.distance >= distance - 1e-4;
  }

  applySelectionOperation(meta, triangles, change = {}) {
    if (!triangles?.size || !this.selectionState) return;
    const key = selectionKey(meta.nodeIndex, meta.primitiveIndex);
    if (!this.selectionState.map.has(key)) this.selectionState.map.set(key, new Set());
    applyTriangleOperation(this.selectionState.map.get(key), triangles, this.selectionState.operation);
    if (this.selectionState.map.get(key).size === 0) this.selectionState.map.delete(key);
    this.updateSelectionOverlay();
    this.selectionState.onChange?.(selectionFromMap(this.selectionState.map), this.selectionStats(), change);
    this.emitSelectionStatus('ready');
  }

  emitSelectionStatus(state) {
    this.selectionStatus = state;
    this.selectionState?.onStatus?.({ state, selection: this.getTriangleSelection(), stats: this.selectionStats() });
  }

  updateSelectionOverlay() {
    this.clearSelectionOverlay();
    if (!this.selectionState || !this.model) return;
    const group = new THREE.Group();
    group.name = 'SelectionOverlay';
    for (const [key, triangles] of this.selectionState.map) {
      const [nodeIndex, primitiveIndex] = key.split(':').map(Number);
      const mesh = [...this.selectionMeshes.entries()].find(([, meta]) => meta.nodeIndex === nodeIndex && meta.primitiveIndex === primitiveIndex)?.[0];
      if (!mesh) continue;
      const indices = [];
      for (const triangle of triangles) indices.push(...triangleVertexIndices(mesh.geometry, triangle));
      if (!indices.length) continue;
      const overlay = new THREE.Mesh(
        withIndices(mesh.geometry, indices),
        new THREE.MeshBasicMaterial({
          color: 0x00b8d9,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          side: THREE.DoubleSide,
        }),
      );
      overlay.userData.selectionOverlay = true;
      overlay.matrix.copy(mesh.matrixWorld);
      overlay.matrixAutoUpdate = false;
      group.add(overlay);
    }
    this.scene.add(group);
    this.selectionOverlay = group;
  }

  clearSelectionOverlay() {
    if (!this.selectionOverlay) return;
    this.selectionOverlay.traverse((object) => {
      object.geometry?.dispose?.();
      object.material?.dispose?.();
    });
    this.selectionOverlay.removeFromParent();
    this.selectionOverlay = null;
  }

  /** 点选模式：光标变十字，点击模型返回命中的节点索引（拖动视角不会误触发） */
  setPickMode(enabled, onPick) {
    this.pickHandler = enabled ? onPick : null;
    this.canvas.style.cursor = enabled ? 'crosshair' : '';
    if (this.pickWired) return;
    this.pickWired = true;
    let downAt = null;
    this.canvas.addEventListener('pointerdown', (event) => {
      downAt = [event.clientX, event.clientY];
    });
    this.canvas.addEventListener('pointerup', (event) => {
      if (!this.pickHandler || !downAt) return;
      if (Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 6) return;
      const index = this.pickNodeAt(event.clientX, event.clientY);
      if (index !== null) this.pickHandler(index);
    });
  }

  pickNodeAt(clientX, clientY) {
    if (!this.model) return null;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    if (!this.nodeObjectSet) this.nodeObjectSet = new Set((this.nodeObjects || []).filter(Boolean));
    for (const hit of raycaster.intersectObject(this.model, true)) {
      // Raycaster 不理会 visible，预览动画时被隐藏的原件要手动跳过
      let visible = true;
      for (let o = hit.object; o; o = o.parent) {
        if (o.visible === false) { visible = false; break; }
      }
      if (!visible) continue;
      let object = hit.object;
      while (object && !this.nodeObjectSet.has(object)) object = object.parent;
      if (!object) continue;
      const index = this.nodeObjects.indexOf(object);
      if (index >= 0) return index;
    }
    return null;
  }

  /** 整个模型作为一个部件时的世界包围盒（只统计源模型网格，忽略选区盒等辅助对象） */
  wholeBounds() {
    if (!this.model) return null;
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const temp = new THREE.Box3();
    (this.nodeObjects || []).forEach((_, index) => {
      for (const mesh of this.meshesOfNode(index)) this.expandByMeshGeometry(box, mesh, temp);
    });
    if (box.isEmpty()) return null;
    return { min: box.min.toArray(), max: box.max.toArray() };
  }

  /**
   * 循环预览某个联动的动作。
   * 预览组挂在场景根，位置/旋转轴直接用世界坐标（= 车机最终空间），
   * 关键帧与导出用同一份 buildKeyframes，保证所见即所得；
   * 灯光/闪烁类会把目标换成点亮纯色，对应车机端换纯色贴图的效果。
   */
  startSourceResetPreview(slot, playback) {
    const current = this.bindingPreview?.sourceEvent && this.bindingPreview.eventId === slot.id
      ? this.bindingPreview
      : null;
    if (!current || !this.mixer || !(playback.transitionMs > 0)) {
      this.stopBindingPreview();
      return false;
    }
    const clip = resetThreeClip(
      this.model,
      current.currentClip,
      current.restValues,
      playback.transitionMs,
      `BYD_RST_${slot.id}_PREVIEW`,
    );
    if (!clip) {
      this.stopBindingPreview();
      return false;
    }
    const mixer = this.mixer;
    for (const handler of current.mixerFinishedHandlers || []) mixer.removeEventListener('finished', handler);
    current.mixerFinishedHandlers = [];
    current.currentAction?.stop();
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    current.currentAction = action;
    current.currentClip = clip;
    const onFinished = (event) => {
      if (event.action !== action || this.mixer !== mixer || this.bindingPreview !== current) return;
      mixer.removeEventListener('finished', onFinished);
      current.mixerFinishedHandlers = current.mixerFinishedHandlers
        .filter((handler) => handler !== onFinished);
      this.stopBindingPreview();
    };
    mixer.addEventListener('finished', onFinished);
    current.mixerFinishedHandlers.push(onFinished);
    action.reset().play();
    return true;
  }

  previewBinding(slot, params, phase = 'on') {
    if (!this.model || !slot) return;
    if (this.deviceMode && this.previewExportedBinding(slot, params, phase)) return;
    if (Number.isInteger(params.sourceAnimationIndex)) {
      const playback = normalizeOtherPlayback(slot, params.playback);
      if (phase === 'off' && playback.endMode === 'reset') {
        this.startSourceResetPreview(slot, playback);
        return;
      }
      const source = this.loadedAnimations[params.sourceAnimationIndex];
      if (!source) return;
      const clip = configuredThreeClip(source, playback, { reverse: phase === 'off' && playback.endMode === 'reverse' });
      const previous = phase === 'on' && this.bindingPreview?.sourceEvent
        && this.bindingPreview.eventId !== slot.id && this.mixer
        ? this.bindingPreview
        : null;
      if (!previous) this.stopBindingPreview();
      if (!this.mixer) this.mixer = new THREE.AnimationMixer(this.model);
      const mixer = this.mixer;
      const action = this.mixer.clipAction(clip);
      const loop = phase === 'on' && ['loop', 'pingpong'].includes(playback.mode);
      action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      action.clampWhenFinished = phase === 'off'
        ? playback.endMode !== 'reverse'
        : playback.mode === 'hold';
      const nextPreview = {
        sourceEvent: true,
        eventId: slot.id,
        currentAction: action,
        currentClip: clip,
        restValues: captureTrackRestValues(this.model, clip.tracks, previous?.restValues),
        mixerFinishedHandlers: [],
        transitionTimers: previous?.transitionTimers || new Set(),
      };
      const startActive = () => {
        action.reset();
        if (phase === 'off' && playback.endMode === 'hold') {
          action.time = clip.duration;
          action.paused = true;
        }
        action.play();
        if (action.paused) this.mixer?.update(0);
      };
      if ((phase === 'on' && playback.mode === 'once')
        || (phase === 'off' && playback.endMode === 'reverse')) {
        const onFinished = (event) => {
          if (event.action !== action || this.mixer !== mixer || this.bindingPreview !== nextPreview) return;
          mixer.removeEventListener('finished', onFinished);
          nextPreview.mixerFinishedHandlers = nextPreview.mixerFinishedHandlers
            .filter((handler) => handler !== onFinished);
          this.startSourceResetPreview(slot, playback);
        };
        mixer.addEventListener('finished', onFinished);
        nextPreview.mixerFinishedHandlers.push(onFinished);
      }
      if (previous) {
        for (const handler of previous.mixerFinishedHandlers || []) mixer.removeEventListener('finished', handler);
        previous.mixerFinishedHandlers = [];
        startActive();
        const duration = Math.max(0, playback.transitionMs) / 1000;
        if (duration > 0 && previous.currentAction) {
          previous.currentAction.crossFadeTo(action, duration, false);
          let timer = null;
          timer = setTimeout(() => {
            previous.currentAction?.stop();
            nextPreview.transitionTimers.delete(timer);
          }, playback.transitionMs + 34);
          nextPreview.transitionTimers.add(timer);
        } else {
          previous.currentAction?.stop();
        }
        this.bindingPreview = nextPreview;
        return;
      }
      this.bindingPreview = nextPreview;
      const enter = phase === 'on'
        ? enterThreeClip(this.model, clip, playback.transitionMs, `BYD_EVT_${slot.id}_ENTER`)
        : null;
      if (enter) {
        const enterAction = mixer.clipAction(enter);
        nextPreview.currentAction = enterAction;
        nextPreview.currentClip = enter;
        enterAction.setLoop(THREE.LoopOnce, 1);
        enterAction.clampWhenFinished = true;
        const onFinished = (event) => {
          if (event.action !== enterAction || this.mixer !== mixer) return;
          mixer.removeEventListener('finished', onFinished);
          nextPreview.mixerFinishedHandlers = nextPreview.mixerFinishedHandlers
            .filter((handler) => handler !== onFinished);
          startActive();
          nextPreview.currentAction = action;
          nextPreview.currentClip = clip;
          enterAction.stop();
        };
        mixer.addEventListener('finished', onFinished);
        this.bindingPreview.mixerFinishedHandlers.push(onFinished);
        enterAction.reset().play();
      } else {
        startActive();
      }
      return;
    }
    this.stopBindingPreview();
    const selectionNodes = (params.selection?.groups || []).map((group) => group.nodeIndex);
    const targetIndices = selectionNodes.length ? [...new Set(selectionNodes)] : (params.nodeIndices || []);
    const targets = targetIndices.flatMap((i) => this.meshesOfNode(i));
    if (targets.length === 0) return;

    const pivot = new THREE.Vector3().fromArray(params.pivot || [0, 0, 0]);
    const group = new THREE.Group();
    group.position.copy(pivot);
    this.model.updateMatrixWorld(true);

    if (isLampSlot(slot)) {
      // 灯光是叠加层：原灯罩保持可见，副本外推贴在表面并换成点亮图集，与导出结构一致
      if (!this.buildLampPreviewGroup(slot, params, targets, pivot, group)) return;
      this.scene.add(group);
      this.bindingPreview = { group, staticGroup: null, hidden: [] };
    } else {
      const staticGroup = params.region || params.selection ? new THREE.Group() : null;
      const hidden = [];
      for (const object of targets) {
        const makeClone = (geometry, material) => {
          const clone = new THREE.Mesh(geometry || object.geometry, material || object.material);
          clone.matrix.copy(object.matrixWorld);
          clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
          return clone;
        };
        if (params.region || params.selection) {
          // 精细选面与旧框选都真正切成两半，预览与导出使用同一 triangle ordinal。
          const meta = this.selectionMeshes.get(object);
          const selected = params.selection && meta
            ? selectedTriangles(params.selection, meta.nodeIndex, meta.primitiveIndex)
            : null;
          if (params.selection && !selected?.size) continue;
          const split = selected
            ? splitGeometryBySelection(object, selected)
            : splitGeometryByRegion(object, params.region);
          if (!split.inside) continue; // 完全在框外：原件原样保留
          const moving = makeClone(split.inside, null);
          moving.position.sub(pivot);
          group.add(moving);
          if (split.outside) staticGroup.add(makeClone(split.outside, null));
        } else {
          const clone = makeClone(null, null);
          clone.position.sub(pivot);
          group.add(clone);
        }
        object.visible = false;
        hidden.push(object);
      }
      if (group.children.length === 0) {
        for (const object of hidden) object.visible = true;
        return;
      }
      this.scene.add(group);
      if (staticGroup) this.scene.add(staticGroup);
      this.bindingPreview = { group, staticGroup, hidden };
    }

    const names = animationNamesOf(slot);
    if (names.length === 0 || group.children.length === 0) return;
    const keyframes = buildKeyframes(slot, params, names[0]);
    const track = keyframes.path === 'rotation'
      ? new THREE.QuaternionKeyframeTrack('.quaternion', keyframes.times, keyframes.values)
      : new THREE.VectorKeyframeTrack('.scale', keyframes.times, keyframes.values);
    // 时长跟随关键帧（转动/开合支持自定义用时）
    const clip = new THREE.AnimationClip(names[0], keyframes.times[keyframes.times.length - 1], [track]);
    this.mixer = new THREE.AnimationMixer(group);
    const action = this.mixer.clipAction(clip);
    // 开合类来回播放，正好演示开→关；转动与闪烁单向循环
    action.setLoop(['hinge', 'scale'].includes(actionKindOf(slot, params)) ? THREE.LoopPingPong : THREE.LoopRepeat, Infinity);
    action.play();
  }

  /** 车机模式直接播放最终 GLB 中导出的节点和动画，不再依赖原模型节点下标。 */
  startExportedResetPreview(slot, playback, phaseIndex = null) {
    const current = this.bindingPreview?.sourceEvent && this.bindingPreview.eventId === slot.id
      ? this.bindingPreview
      : null;
    if (!current || !this.mixer || !(playback.transitionMs > 0)) {
      this.stopBindingPreview();
      return false;
    }
    const sourceDuration = current.currentClip?.duration || 0;
    const sourceTime = current.currentAction?.time || 0;
    const progress = sourceDuration > 0
      ? ((sourceTime % sourceDuration) + sourceDuration) % sourceDuration / sourceDuration
      : 0;
    const index = phaseIndex === null
      ? Math.min(3, Math.max(0, Math.round(progress * 3)))
      : Math.min(3, Math.max(0, phaseIndex));
    const clip = this.loadedAnimations.find(
      (animation) => animation.name === `BYD_RST_${slot.id}_P${index}`,
    );
    if (!clip) {
      this.stopBindingPreview();
      return false;
    }
    const mixer = this.mixer;
    for (const handler of current.mixerFinishedHandlers || []) mixer.removeEventListener('finished', handler);
    current.mixerFinishedHandlers = [];
    current.currentAction?.stop();
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    current.currentAction = action;
    current.currentClip = clip;
    const onFinished = (event) => {
      if (event.action !== action || this.mixer !== mixer || this.bindingPreview !== current) return;
      mixer.removeEventListener('finished', onFinished);
      current.mixerFinishedHandlers = current.mixerFinishedHandlers
        .filter((handler) => handler !== onFinished);
      this.stopBindingPreview();
    };
    mixer.addEventListener('finished', onFinished);
    current.mixerFinishedHandlers.push(onFinished);
    action.reset().play();
    return true;
  }

  previewExportedBinding(slot, params, phase = 'on') {
    // 其他模型导出时保留完整骨架，并统一用 CS_Car 作为事件部件；
    // 车辆模式仍然使用各槽位自己的 CS_* 节点。
    const isSourceAnimation = Number.isInteger(params.sourceAnimationIndex);
    const playback = normalizeOtherPlayback(slot, params.playback);
    if (isSourceAnimation && phase === 'off' && playback.endMode === 'reset') {
      this.startExportedResetPreview(slot, playback);
      return true;
    }
    const previous = isSourceAnimation && phase === 'on' && this.bindingPreview?.sourceEvent
      && this.bindingPreview.eventId !== slot.id && this.mixer
      ? this.bindingPreview
      : null;
    if (!previous) this.stopBindingPreview();
    const exportedRootName = isSourceAnimation ? 'CS_Car' : slot.id;
    const nodeIndex = this.gltfJson?.nodes?.findIndex((node) => node.name === exportedRootName) ?? -1;
    if (nodeIndex < 0) return isSourceAnimation;
    const target = this.nodeObjects?.[nodeIndex];
    const meshes = this.meshesOfNode(nodeIndex);
    // CS_Car 可能只是骨架/控制根，没有直接 mesh；只要节点存在即可交给
    // AnimationMixer 驱动其整个子树。
    if (!target || (!isSourceAnimation && meshes.length === 0)) return isSourceAnimation;

    const activeAnimationName = `BYD_EVT_${slot.id}_${playback.mode === 'pingpong' ? 'PINGPONG' : playback.mode === 'loop' ? 'LOOP' : 'ON'}`;
    const expectedEventAnimation = phase === 'off'
      ? (playback.endMode === 'reverse'
        ? `BYD_EVT_${slot.id}_OFF`
        : playback.endMode === 'hold'
          ? `BYD_EVT_${slot.id}_HOLD`
          : playback.endMode === 'finish' ? activeAnimationName : '')
      : activeAnimationName;
    const animationName = isSourceAnimation
      ? (this.gltfJson?.animations || [])
        .map((animation) => animation.name)
        .find((name) => name === expectedEventAnimation)
      : animationNamesOf(slot)[0];
    const clip = animationName
      ? this.loadedAnimations.find((animation) => animation.name === animationName)
      : null;
    const materialRestores = [];
    if (!isSourceAnimation && isLampSlot(slot)) {
      // 导出 GLB 里的灯位已经是叠加层（内嵌透明图），点亮 = 换成随预览生成的点亮图集，与车机行为一致
      const lampTexture = this.deviceLampTextures.get(slot.id) || null;
      for (const mesh of meshes) {
        const original = mesh.material;
        const originals = Array.isArray(original) ? original : [original];
        const replacements = originals.map(() => (lampTexture
          ? makeLampPreviewMaterial(lampTexture, true)
          : makeLitMaterial(params.color || slot.color)));
        mesh.material = Array.isArray(original) ? replacements : replacements[0];
        materialRestores.push({ mesh, original, replacements });
      }
    }
    // 车机质感只能播放最终导出的动画。缓存异常时保留上一动作，不能拿
    // 原模型的动画下标去误播导出 GLB 中的另一段动画。
    if (!clip) {
      if (materialRestores.length === 0) return true;
      // 近光/刹车这类只换贴图、没有动画的灯位：点亮即完成
      this.bindingPreview = {
        sourceEvent: false,
        eventId: null,
        currentAction: null,
        currentClip: null,
        materialRestores,
        mixerFinishedHandlers: [],
        transitionTimers: new Set(),
      };
      return true;
    }

    const nextPreview = {
      sourceEvent: isSourceAnimation,
      eventId: isSourceAnimation ? slot.id : null,
      currentAction: null,
      currentClip: null,
      deviceTarget: previous?.deviceTarget || {
        object: target,
        position: target.position.clone(),
        quaternion: target.quaternion.clone(),
        scale: target.scale.clone(),
      },
      materialRestores,
      mixerFinishedHandlers: [],
      transitionTimers: previous?.transitionTimers || new Set(),
    };

    if (!this.mixer) this.mixer = new THREE.AnimationMixer(this.model);
    const action = this.mixer.clipAction(clip);
    const mixer = this.mixer;
    if (previous) {
      for (const handler of previous.mixerFinishedHandlers || []) mixer.removeEventListener('finished', handler);
      previous.mixerFinishedHandlers = [];
    }
    this.bindingPreview = nextPreview;
    const registerFinished = (handler) => {
      mixer.addEventListener('finished', handler);
      nextPreview.mixerFinishedHandlers.push(handler);
    };
    const unregisterFinished = (handler) => {
      mixer.removeEventListener('finished', handler);
      nextPreview.mixerFinishedHandlers = nextPreview.mixerFinishedHandlers
        .filter((candidate) => candidate !== handler);
    };
    const startActive = () => {
      action.reset().play();
      nextPreview.currentAction = action;
      nextPreview.currentClip = clip;
    };
    if (isSourceAnimation) {
      const isLoop = (phase === 'on' && ['loop', 'pingpong'].includes(playback.mode))
        || (phase === 'off' && playback.endMode === 'hold');
      action.setLoop(isLoop ? THREE.LoopRepeat : THREE.LoopOnce, isLoop ? Infinity : 1);
      action.clampWhenFinished = phase === 'on' ? playback.mode === 'hold' : false;
    } else {
      action.setLoop(['hinge', 'scale'].includes(actionKindOf(slot, params)) ? THREE.LoopPingPong : THREE.LoopRepeat, Infinity);
    }
    if ((isSourceAnimation && phase === 'on' && playback.mode === 'once')
      || (isSourceAnimation && phase === 'off' && playback.endMode === 'reverse')) {
      const resetPhase = phase === 'off' ? 0 : 3;
      const onFinished = (event) => {
        if (event.action !== action || this.mixer !== mixer || this.bindingPreview !== nextPreview) return;
        unregisterFinished(onFinished);
        this.startExportedResetPreview(slot, playback, resetPhase);
      };
      registerFinished(onFinished);
    }
    let pairTransitionClip = null;
    if (previous && playback.transitionMs > 0) {
      const sourceClip = previous.currentClip;
      const sourceAction = previous.currentAction;
      const progress = sourceClip?.duration > 0 && sourceAction
        ? ((sourceAction.time % sourceClip.duration) + sourceClip.duration) % sourceClip.duration / sourceClip.duration
        : 0;
      const phaseIndex = Math.min(3, Math.max(0, Math.round(progress * 3)));
      pairTransitionClip = this.loadedAnimations.find(
        (animation) => animation.name === `BYD_TR_${previous.eventId}_${slot.id}_P${phaseIndex}`,
      ) || null;
    }
    if (pairTransitionClip) {
      previous.currentAction?.stop();
      const transitionAction = mixer.clipAction(pairTransitionClip);
      nextPreview.currentAction = transitionAction;
      nextPreview.currentClip = pairTransitionClip;
      transitionAction.setLoop(THREE.LoopOnce, 1);
      transitionAction.clampWhenFinished = true;
      const onFinished = (event) => {
        if (event.action !== transitionAction || this.mixer !== mixer) return;
        unregisterFinished(onFinished);
        startActive();
        transitionAction.stop();
      };
      registerFinished(onFinished);
      transitionAction.reset().play();
      return true;
    }
    if (isSourceAnimation && phase === 'off' && playback.endMode === 'finish') {
      const holdName = `BYD_EVT_${slot.id}_HOLD`;
      const holdClip = this.loadedAnimations.find((animation) => animation.name === holdName);
      const onFinished = (event) => {
        if (event.action !== action || this.mixer !== mixer) return;
        unregisterFinished(onFinished);
        if (!holdClip) return;
        const holdAction = mixer.clipAction(holdClip);
        holdAction.setLoop(THREE.LoopRepeat, Infinity);
        holdAction.reset().play();
        nextPreview.currentAction = holdAction;
        nextPreview.currentClip = holdClip;
      };
      registerFinished(onFinished);
    }
    if (previous) previous.currentAction?.stop();
    const enterClip = isSourceAnimation && phase === 'on' && playback.transitionMs > 0
      ? this.loadedAnimations.find((animation) => animation.name === `BYD_EVT_${slot.id}_ENTER`)
      : null;
    if (enterClip) {
      const enterAction = mixer.clipAction(enterClip);
      nextPreview.currentAction = enterAction;
      nextPreview.currentClip = enterClip;
      enterAction.setLoop(THREE.LoopOnce, 1);
      enterAction.clampWhenFinished = true;
      const onFinished = (event) => {
        if (event.action !== enterAction || this.mixer !== mixer) return;
        unregisterFinished(onFinished);
        startActive();
        enterAction.stop();
      };
      registerFinished(onFinished);
      enterAction.reset().play();
    } else {
      startActive();
    }
    return true;
  }

  stopBindingPreview() {
    if (this.bindingPreview?.transitionTimer) {
      clearTimeout(this.bindingPreview.transitionTimer);
      this.bindingPreview.transitionTimer = null;
    }
    for (const timer of this.bindingPreview?.transitionTimers || []) {
      clearTimeout(timer);
    }
    this.bindingPreview?.transitionTimers?.clear();
    if (this.mixer) {
      const handlers = this.bindingPreview?.mixerFinishedHandlers || [];
      for (const handler of handlers) {
        this.mixer.removeEventListener('finished', handler);
      }
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    if (this.bindingPreview) {
      const { group, staticGroup, hidden, deviceTarget, materialRestores } = this.bindingPreview;
      for (const container of [group, staticGroup]) {
        if (!container) continue;
        container.traverse((object) => {
          // 只释放切分出来的临时几何与点亮材质，克隆体共享的原材质仍属于原模型
          if (!object.isMesh) return;
          if (object.geometry?.userData?.temporary) object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            if (!material?.userData?.temporary) continue;
            if (material.userData.ownsMap) material.map?.dispose();
            material.dispose();
          }
        });
        container.removeFromParent();
      }
      for (const object of hidden || []) object.visible = true;
      if (deviceTarget?.object) {
        deviceTarget.object.position.copy(deviceTarget.position);
        deviceTarget.object.quaternion.copy(deviceTarget.quaternion);
        deviceTarget.object.scale.copy(deviceTarget.scale);
        deviceTarget.object.updateMatrixWorld(true);
      }
      for (const { mesh, original, replacements } of materialRestores || []) {
        mesh.material = original;
        for (const material of replacements) material.dispose();
      }
      this.bindingPreview = null;
    }
  }

  /** 用包围盒线框标出当前选中的部件 */
  highlightPart(nodeIndices) {
    this.clearHighlight();
    this.model?.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const temp = new THREE.Box3();
    for (const index of nodeIndices || []) {
      for (const mesh of this.meshesOfNode(index)) this.expandByMeshGeometry(box, mesh, temp);
    }
    this.showHighlightBox(box);
  }

  showHighlightBox(box) {
    if (box.isEmpty()) return;
    const helper = new THREE.Box3Helper(box, 0x1769e0);
    helper.material.depthTest = false;
    this.scene.add(helper);
    this.highlight = helper;
  }

  clearHighlight() {
    if (this.highlight) {
      this.highlight.removeFromParent();
      this.highlight.geometry?.dispose();
      this.highlight.material?.dispose();
      this.highlight = null;
    }
  }

  /* ---------- 区域框选 ---------- */

  setOrbitLocked(owner, locked) {
    if (locked) this.orbitLocks.add(owner);
    else this.orbitLocks.delete(owner);
    this.controls.enabled = this.orbitLocks.size === 0;
  }

  wireTransformGizmo(gizmo, onCommit) {
    let disposed = false;
    const handleDragging = (event) => {
      this.setOrbitLocked(gizmo, Boolean(event.value));
      if (!event.value && !disposed) onCommit?.();
    };
    const recover = () => {
      if (disposed) return;
      if (gizmo.dragging) gizmo.pointerUp(null);
      this.setOrbitLocked(gizmo, false);
    };
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') recover();
    };
    gizmo.addEventListener('dragging-changed', handleDragging);
    this.canvas.addEventListener('pointercancel', recover);
    this.canvas.addEventListener('lostpointercapture', recover);
    window.addEventListener('blur', recover);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      disposed = true;
      if (gizmo.dragging) gizmo.pointerUp(null);
      this.setOrbitLocked(gizmo, false);
      gizmo.removeEventListener('dragging-changed', handleDragging);
      this.canvas.removeEventListener('pointercancel', recover);
      this.canvas.removeEventListener('lostpointercapture', recover);
      window.removeEventListener('blur', recover);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }

  /**
   * 显示可拖拽缩放的选区盒。盒子挂在场景根，位置与尺寸就是世界坐标
   * （= 车机最终空间），与 listParts 的包围盒、打包时的切分空间一致。
   */
  showRegionBox(bounds, onChange) {
    this.hideRegionBox();
    if (!this.model) return;
    const size = [0, 1, 2].map((i) => Math.max(bounds.max[i] - bounds.min[i], 1e-4));
    const center = [0, 1, 2].map((i) => (bounds.max[i] + bounds.min[i]) / 2);

    const box = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x1769e0, transparent: true, opacity: 0.16, depthTest: false }),
    );
    box.scale.set(size[0], size[1], size[2]);
    box.position.set(center[0], center[1], center[2]);
    box.renderOrder = 999;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x1769e0, depthTest: false }),
    );
    box.add(edges);
    this.scene.add(box);

    const gizmo = new TransformControls(this.camera, this.renderer.domElement);
    gizmo.setMode('translate');
    // 触屏上手柄太小很难点中，放大一档
    if (window.matchMedia?.('(pointer: coarse)').matches) gizmo.setSize(1.4);
    gizmo.attach(box);
    // 仅在真正拖动手柄时停掉轨道控制；触摸被系统取消时也会自动恢复。
    const cleanupGizmo = this.wireTransformGizmo(gizmo, () => {
      // 缩放手柄拖过零点会得到负值，视觉上盒子照样存在但 min/max 颠倒，必须归正
      box.scale.set(
        Math.max(Math.abs(box.scale.x), 1e-4),
        Math.max(Math.abs(box.scale.y), 1e-4),
        Math.max(Math.abs(box.scale.z), 1e-4),
      );
      onChange?.(this.getRegionBounds());
    });
    const helper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
    this.scene.add(helper);
    this.regionBox = { box, gizmo, helper, onChange, cleanupGizmo };
    onChange?.(this.getRegionBounds());
  }

  setRegionMode(mode) {
    if (this.regionBox) this.regionBox.gizmo.setMode(mode);
  }

  /** 选区盒在世界坐标下的包围盒 */
  getRegionBounds() {
    if (!this.regionBox) return null;
    const { box } = this.regionBox;
    const half = [Math.abs(box.scale.x) / 2, Math.abs(box.scale.y) / 2, Math.abs(box.scale.z) / 2];
    return {
      min: [box.position.x - half[0], box.position.y - half[1], box.position.z - half[2]],
      max: [box.position.x + half[0], box.position.y + half[1], box.position.z + half[2]],
    };
  }

  hideRegionBox() {
    if (!this.regionBox) return;
    const { box, gizmo, helper, cleanupGizmo } = this.regionBox;
    cleanupGizmo?.();
    gizmo.detach();
    gizmo.dispose?.();
    helper.removeFromParent();
    box.removeFromParent();
    box.geometry.dispose();
    box.material.dispose();
    this.regionBox = null;
  }

  /**
   * 统计落在选区内的三角形数，并给出框内几何的实际包围盒
   * （用作默认旋转中心，比框自身的中心更贴合部件，框大了也不会“甩”）。
   * 始终统计源模型网格（预览时原件只是被临时隐藏，几何还在），空间与选区一致。
   */
  measureRegion(bounds) {
    if (!this.model) return { inside: 0, total: 0, bounds: null };
    this.model.updateMatrixWorld(true);
    const point = new THREE.Vector3();
    let inside = 0;
    let total = 0;
    const gmin = [Infinity, Infinity, Infinity];
    const gmax = [-Infinity, -Infinity, -Infinity];
    for (let nodeIndex = 0; nodeIndex < (this.nodeObjects || []).length; nodeIndex++) {
      for (const object of this.meshesOfNode(nodeIndex)) {
        const position = object.geometry?.attributes?.position;
        if (!position || !object.visible) continue;
        const index = object.geometry.index;
        const count = index ? index.count : position.count;
        const matrix = object.matrixWorld;
        for (let t = 0; t + 2 < count; t += 3) {
          if (index && index.getX(t) === index.getX(t + 1) && index.getX(t) === index.getX(t + 2)) continue;
          total++;
          let cx = 0;
          let cy = 0;
          let cz = 0;
          for (let k = 0; k < 3; k++) {
            const v = index ? index.getX(t + k) : t + k;
            point.fromBufferAttribute(position, v).applyMatrix4(matrix);
            cx += point.x; cy += point.y; cz += point.z;
          }
          cx /= 3; cy /= 3; cz /= 3;
          if (cx >= bounds.min[0] && cx <= bounds.max[0]
            && cy >= bounds.min[1] && cy <= bounds.max[1]
            && cz >= bounds.min[2] && cz <= bounds.max[2]) {
            inside++;
            if (cx < gmin[0]) gmin[0] = cx;
            if (cy < gmin[1]) gmin[1] = cy;
            if (cz < gmin[2]) gmin[2] = cz;
            if (cx > gmax[0]) gmax[0] = cx;
            if (cy > gmax[1]) gmax[1] = cy;
            if (cz > gmax[2]) gmax[2] = cz;
          }
        }
      }
    }
    return { inside, total, bounds: inside ? { min: gmin, max: gmax } : null };
  }

  /* ---------- 删除区域 ---------- */

  /**
   * 应用“删除区域”列表：按三角形质心（世界空间）过滤每个网格的索引。
   * 原始几何保留在 userData 里，列表清空即完全恢复；
   * 显示用“共享顶点属性 + 独立索引”的替身，所以联动预览、面数统计、
   * 切分导出读到的都是删除后的几何，全链路自动一致。
   */
  setDeletions(regions) {
    this.deletions = Array.isArray(regions) ? regions : [];
    if (!this.model) return;
    this.model.updateMatrixWorld(true);
    const point = new THREE.Vector3();
    for (let nodeIndex = 0; nodeIndex < (this.nodeObjects || []).length; nodeIndex++) {
      for (const mesh of this.meshesOfNode(nodeIndex)) {
        const data = mesh.userData;
        if (!data.baseGeometry) {
          const position = mesh.geometry?.attributes?.position;
          if (!position) continue;
          data.baseGeometry = mesh.geometry;
          data.baseIndex = mesh.geometry.index
            ? Uint32Array.from(mesh.geometry.index.array)
            : Uint32Array.from({ length: position.count }, (_, i) => i);
        }
        if (this.deletions.length === 0) {
          if (mesh.geometry !== data.baseGeometry) {
            mesh.geometry.dispose();
            mesh.geometry = data.baseGeometry;
          }
          continue;
        }

        const base = data.baseGeometry;
        const position = base.attributes.position;
        const matrix = mesh.matrixWorld;
        // 保持索引长度与原始三角 ordinal 不变：被删面退化成零面积三角形。
        // 这样删除后再精细选面，Raycaster/BVH/Overlay/导出仍共享原始编号。
        const kept = [];
        let visibleTriangleCount = 0;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        const indexArray = data.baseIndex;
        for (let t = 0; t + 2 < indexArray.length; t += 3) {
          let cx = 0;
          let cy = 0;
          let cz = 0;
          for (let k = 0; k < 3; k++) {
            point.fromBufferAttribute(position, indexArray[t + k]).applyMatrix4(matrix);
            cx += point.x; cy += point.y; cz += point.z;
          }
          cx /= 3; cy /= 3; cz /= 3;
          const removed = this.deletions.some((region) => cx >= region.min[0] && cx <= region.max[0]
            && cy >= region.min[1] && cy <= region.max[1]
            && cz >= region.min[2] && cz <= region.max[2]);
          if (removed) {
            kept.push(indexArray[t], indexArray[t], indexArray[t]);
            continue;
          }
          visibleTriangleCount++;
          for (let k = 0; k < 3; k++) {
            const v = indexArray[t + k];
            kept.push(v);
            const x = position.getX(v);
            const y = position.getY(v);
            const z = position.getZ(v);
            if (x < min[0]) min[0] = x;
            if (y < min[1]) min[1] = y;
            if (z < min[2]) min[2] = z;
            if (x > max[0]) max[0] = x;
            if (y > max[1]) max[1] = y;
            if (z > max[2]) max[2] = z;
          }
        }

        const geometry = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(base.attributes)) {
          geometry.setAttribute(name, attribute);
        }
        geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(kept), 1));
        // 包围盒按剩余面精确给出（computeBoundingBox 会按全量顶点算，删完还包含旧区域）
        geometry.boundingBox = visibleTriangleCount
          ? new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))
          : new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
        if (mesh.geometry !== data.baseGeometry) mesh.geometry.dispose();
        mesh.geometry = geometry;
      }
    }
  }

  /* ---------- 旋转中心标记 ---------- */

  /**
   * 显示旋转中心（橙色小球）与穿过它的旋转轴（虚线）。
   * draggable 时挂 gizmo 可直接拖动；重复调用只做轻量更新，不重建 gizmo。
   */
  showPivotMarker(pivot, axis, options = {}) {
    const wantGizmo = Boolean(options.draggable && options.onChange);
    if (this.pivotMarker && Boolean(this.pivotMarker.gizmo) === wantGizmo) {
      this.pivotMarker.onChange = options.onChange || null;
      this.setPivotPosition(pivot);
      this.setPivotAxis(axis);
      return;
    }
    this.hidePivotMarker();
    if (!this.model) return;

    const marker = new THREE.Group();
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xff7a00, depthTest: false }),
    );
    sphere.renderOrder = 1000;
    marker.add(sphere);
    const line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xff7a00, dashSize: 0.12, gapSize: 0.07, depthTest: false }),
    );
    line.renderOrder = 1000;
    marker.add(line);
    marker.position.fromArray(pivot || [0, 0, 0]);
    this.scene.add(marker);
    this.pivotMarker = { marker, line, gizmo: null, helper: null, onChange: options.onChange || null };
    this.setPivotAxis(axis);

    if (wantGizmo) {
      const gizmo = new TransformControls(this.camera, this.renderer.domElement);
      gizmo.setMode('translate');
      if (window.matchMedia?.('(pointer: coarse)').matches) gizmo.setSize(1.4);
      gizmo.attach(marker);
      const cleanupGizmo = this.wireTransformGizmo(gizmo, () => {
        this.pivotMarker?.onChange?.([marker.position.x, marker.position.y, marker.position.z]);
      });
      const helper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
      this.scene.add(helper);
      this.pivotMarker.gizmo = gizmo;
      this.pivotMarker.helper = helper;
      this.pivotMarker.cleanupGizmo = cleanupGizmo;
    }
  }

  setPivotPosition(pivot) {
    this.pivotMarker?.marker.position.fromArray(pivot || [0, 0, 0]);
  }

  /** 轴线随所选旋转轴换向 */
  setPivotAxis(axis) {
    if (!this.pivotMarker) return;
    const dir = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis] || [0, 0, 1];
    const length = 4;
    const points = [
      new THREE.Vector3(dir[0], dir[1], dir[2]).multiplyScalar(-length),
      new THREE.Vector3(dir[0], dir[1], dir[2]).multiplyScalar(length),
    ];
    this.pivotMarker.line.geometry.setFromPoints(points);
    this.pivotMarker.line.computeLineDistances();
  }

  hidePivotMarker() {
    if (!this.pivotMarker) return;
    const { marker, gizmo, helper, cleanupGizmo } = this.pivotMarker;
    cleanupGizmo?.();
    gizmo?.detach();
    gizmo?.dispose?.();
    helper?.removeFromParent();
    marker.removeFromParent();
    marker.traverse((object) => {
      object.geometry?.dispose?.();
      object.material?.dispose?.();
    });
    this.pivotMarker = null;
  }

  /** 选区盒 gizmo 与旋转中心 gizmo 互斥时，临时停用/恢复选区盒的手柄 */
  setRegionGizmoEnabled(enabled) {
    if (!this.regionBox) return;
    this.regionBox.gizmo.enabled = enabled;
    if (this.regionBox.helper) this.regionBox.helper.visible = enabled;
  }

  /** 车机质感：加载烘焙后的 GLB 并换成无反射的简单光照材质，所见即车机所得。 */
  async setDeviceMode(enabled, bakedBytes, exportTransform, lamps = []) {
    if (!this.original) return;
    const source = enabled ? bakedBytes : this.original;
    const buffer = source instanceof Uint8Array
      ? source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
      : source.slice(0);
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer, '', resolve, reject);
    });
    const keepRotation = { ...this.rotation };
    this.disposeModel({ keepOriginal: true });
    this.model = gltf.scene;
    this.model.name = 'CS_Car';
    this.loadedAnimations = gltf.animations || [];
    if (this.otherModel) fixTransparentMaterials(this.model);
    if (enabled) {
      this.model.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        child.material = materials.map((material) => new THREE.MeshLambertMaterial({
          map: material.map || null,
          color: material.color?.clone() || new THREE.Color(0xffffff),
          flatShading: material.flatShading || !child.geometry?.attributes?.normal,
          transparent: material.transparent || false,
          opacity: material.opacity ?? 1,
          depthWrite: material.depthWrite !== false,
          alphaTest: material.alphaTest || 0,
          side: material.side,
        }));
        if (child.material.length === 1) child.material = child.material[0];
      });
      await this.loadDeviceLampTextures(lamps);
    }
    if (!enabled) this.applyModelBrightness();
    this.scene.add(this.model);
    this.deviceMode = enabled;
    this.syncModelShadowVisibility();
    this.autoShadow.visible = false;
    this.exportTransform = enabled && exportTransform ? structuredClone(exportTransform) : null;
    const rig = this.lightRig[enabled ? 'device' : 'web'];
    this.lightRig.lights.hemi.intensity = rig.hemi;
    this.lightRig.lights.key.intensity = rig.key;
    this.lightRig.lights.fill.intensity = rig.fill;
    this.rotation = keepRotation;
    if (enabled) {
      // bakedBytes 已是最终导出坐标，外层场景必须保持单位矩阵，否则会把用户变换重复应用一次。
      this.model.position.set(0, 0, 0);
      this.model.quaternion.identity();
      this.model.scale.set(1, 1, 1);
      this.model.updateMatrixWorld(true);
      this.onBounds?.(new THREE.Box3().setFromObject(this.model));
      this.frameObject();
    } else {
      this.normalize();
    }
    // 模型换了实例，节点映射必须重建，否则联动预览会指向已废弃的对象
    await this.indexNodes(gltf);
    this.applyHiddenMaterials();
  }

  setRotation(axis, degrees) {
    this.rotation[axis] = degrees;
    this.normalize();
  }

  /** 撤销恢复用：直接还原快照里的模型矩阵，不经 normalize 重新推导 */
  setTransform(transform) {
    if (!this.model || !transform) return;
    if (this.deviceMode) {
      // 车机预览的外层模型已经烘焙到最终坐标，保持单位矩阵；这里只恢复下一次重烘焙要用的编辑态变换。
      this.exportTransform = structuredClone(transform);
      return;
    }
    this.model.position.fromArray(transform.translation);
    this.model.quaternion.fromArray(transform.rotation);
    this.model.scale.fromArray(transform.scale);
    this.model.updateMatrixWorld(true);
    this.updateAutomaticShadow(new THREE.Box3().setFromObject(this.model));
  }

  /** 导出始终取网页编辑态的变换；车机预览场景自身已经烘焙过，不能读取它的单位外层矩阵。 */
  getExportTransform() {
    if (this.deviceMode && this.exportTransform) return structuredClone(this.exportTransform);
    if (!this.model) return null;
    const q = this.model.quaternion;
    return {
      translation: [this.model.position.x, this.model.position.y, this.model.position.z],
      rotation: [q.x, q.y, q.z, q.w],
      scale: [this.model.scale.x, this.model.scale.y, this.model.scale.z],
    };
  }

  setTargetLength(value) {
    this.targetLength = Math.min(10, Math.max(0.2, Number(value) || TARGET.x));
    this.normalize();
  }

  normalize() {
    if (!this.model) return;
    this.model.rotation.set(
      THREE.MathUtils.degToRad(this.rotation.x),
      THREE.MathUtils.degToRad(this.rotation.y),
      THREE.MathUtils.degToRad(this.rotation.z),
    );
    this.model.scale.setScalar(1);
    this.model.position.set(0, 0, 0);
    this.model.updateMatrixWorld(true);

    let box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    // 按含高度的最长边缩放：竖高的模型（人物、灯笼等）也能落到合适大小
    const scale = this.targetLength / Math.max(size.x, size.y, size.z, 1e-6);
    this.model.scale.setScalar(scale);
    this.model.updateMatrixWorld(true);

    box = new THREE.Box3().setFromObject(this.model);
    const center = box.getCenter(new THREE.Vector3());
    this.model.position.x -= center.x;
    this.model.position.z -= center.z;
    this.model.position.y -= box.min.y;
    this.model.position.y += this.heightOffset || 0;
    this.model.updateMatrixWorld(true);
    const finalBox = new THREE.Box3().setFromObject(this.model);
    this.updateAutomaticShadow(finalBox);
    this.onBounds?.(finalBox);
  }

  view(name) {
    const target = this.controls.target;
    const distance = 8;
    const positions = {
      perspective: [7.5, 4.6, 7.5],
      front: [-distance, 1.2, 0],
      back: [distance, 1.2, 0],
      left: [0, 1.2, distance],
      right: [0, 1.2, -distance],
      top: [0, distance, 0.001],
    };
    this.camera.position.fromArray(positions[name] || positions.perspective);
    target.set(0, 0.9, 0);
    this.camera.lookAt(target);
    this.controls.update();
  }

  frameObject() {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.82;
    this.controls.target.copy(center);
    this.camera.position.set(center.x + radius, center.y + radius * 0.65, center.z + radius);
    this.camera.near = Math.max(radius / 100, 0.01);
    this.camera.far = Math.max(radius * 100, 100);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const width = Math.max(1, parent.clientWidth);
    const height = Math.max(1, parent.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  animate() {
    this.controls.update();
    if (this.mixer) this.mixer.update(this.clock.getDelta());
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  }

  /** 车机质感：把导出管线生成的各灯位点亮图集解码成贴图（flipY=false，与 glTF UV 方向一致） */
  async loadDeviceLampTextures(lamps) {
    this.disposeDeviceLampTextures();
    for (const lamp of lamps || []) {
      if (!lamp?.slotId || !lamp.png) continue;
      const url = URL.createObjectURL(new Blob([lamp.png], { type: 'image/png' }));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const texture = new THREE.Texture(image);
        texture.flipY = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;
        this.deviceLampTextures.set(lamp.slotId, texture);
      } catch (error) {
        console.warn(`灯位 ${lamp.slotId} 点亮贴图解码失败`, error);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  disposeDeviceLampTextures() {
    for (const texture of this.deviceLampTextures.values()) texture.dispose();
    this.deviceLampTextures.clear();
  }

  /** 网页质感：读取源材质贴图像素（缓存），供点亮贴图保留灯罩纹理 */
  lampSourceImageOf(material) {
    const texture = material?.map;
    const image = texture?.image;
    if (!image || !(image.width > 0) || !(image.height > 0)) return null;
    const key = texture.uuid;
    if (this.lampImageCache.has(key)) return this.lampImageCache.get(key);
    let data = null;
    try {
      // 采样用的是归一化 UV，超大贴图缩到 2048 内即可，避免占用过多内存
      const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);
      data = context.getImageData(0, 0, width, height);
      // GLTFLoader 的贴图 flipY=false，像素行序与 glTF UV 一致；其它来源若翻转则翻回来
      if (texture.flipY) {
        const row = width * 4;
        const flipped = new Uint8ClampedArray(data.data.length);
        for (let y = 0; y < height; y++) flipped.set(data.data.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
        data = new ImageData(flipped, width, height);
      }
    } catch (error) {
      console.warn('读取灯罩贴图像素失败，改用材质底色', error);
      data = null;
    }
    this.lampImageCache.set(key, data);
    return data;
  }

  /**
   * 网页质感的灯光预览：按导出同样的规则把选区副本做成叠加层，
   * 生成点亮图集（含路面光束）后贴上去。返回 false 表示没有可预览的几何。
   */
  buildLampPreviewGroup(slot, params, targets, pivot, group) {
    const bounds = this.wholeBounds();
    if (!bounds) return false;
    const carLength = bounds.max[0] - bounds.min[0];
    const carWidth = bounds.max[2] - bounds.min[2];
    const offset = lampOverlayOffset(carLength);
    const pieces = [];
    const geometries = [];
    const zValues = [];
    for (const object of targets) {
      let source = object.geometry;
      if (params.region || params.selection) {
        const meta = this.selectionMeshes.get(object);
        const selected = params.selection && meta
          ? selectedTriangles(params.selection, meta.nodeIndex, meta.primitiveIndex)
          : null;
        if (params.selection && !selected?.size) continue;
        const split = selected
          ? splitGeometryBySelection(object, selected)
          : splitGeometryByRegion(object, params.region);
        split.outside?.dispose();
        if (!split.inside) continue;
        source = split.inside;
      }
      const geometry = compactLampGeometry(source, object.matrixWorld, offset);
      if (source !== object.geometry) source.dispose();
      if (!geometry) continue;
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      const position = geometry.attributes.position;
      const uvAttribute = geometry.attributes.uv;
      pieces.push({
        uv: uvAttribute ? Float32Array.from(uvAttribute.array) : synthesizePlanarUv(position.array, position.count),
        indices: geometry.index.array,
        vertexCount: position.count,
        image: uvAttribute ? this.lampSourceImageOf(material) : null,
        baseColor: material?.color ? material.color.toArray() : [1, 1, 1],
      });
      for (let i = 0; i < position.count; i++) zValues.push(position.getZ(i));
      geometries.push(geometry);
    }
    if (geometries.length === 0) return false;

    const beam = normalizeLampBeam(slot, params.beam);
    let quad = null;
    let beamSpec = null;
    if (beam?.enabled) {
      quad = beamQuadGeometry({ direction: beam.direction, bounds, beam });
      beamSpec = {
        ...beam,
        lobes: beamLobes(zValues, { centerZ: quad.centerZ, halfWidth: quad.halfWidth, carWidth }, beam),
      };
    }
    const art = buildLampArtwork({
      pieces,
      beam: beamSpec,
      color: params.color || slot.color,
      glow: normalizeLampGlow(params.glow),
    });
    const texture = new THREE.CanvasTexture(art.canvas);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    const material = makeLampPreviewMaterial(texture, this.deviceMode, { ownsMap: true });
    geometries.forEach((geometry, index) => {
      geometry.setAttribute('uv', new THREE.BufferAttribute(art.pieceUvs[index], 2));
      const mesh = new THREE.Mesh(geometry, material);
      // 几何已是世界坐标，预览组挂在枢轴上，网格反向平移回去
      mesh.position.set(-pivot.x, -pivot.y, -pivot.z);
      mesh.renderOrder = 2;
      group.add(mesh);
    });
    if (quad && art.beamUv) {
      const { u0, v0, u1, v1 } = art.beamUv;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(quad.positions), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(quad.normals), 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from([u0, v1, u1, v1, u1, v0, u0, v0]), 2));
      geometry.setIndex(new THREE.BufferAttribute(Uint16Array.from(quad.indices), 1));
      geometry.userData.temporary = true;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(-pivot.x, -pivot.y, -pivot.z);
      mesh.renderOrder = 1;
      group.add(mesh);
    }
    return true;
  }

  disposeModel() {
    this.stopBindingPreview();
    this.clearHighlight();
    this.setTriangleSelection(false);
    this.hideRegionBox();
    this.hidePivotMarker();
    this.setPickMode(false, null);
    this.disposeDeviceLampTextures();
    this.lampImageCache.clear();
    this.nodeObjects = [];
    this.nodeObjectSet = null;
    this.selectionMeshes = new Map();
    this.selectionTopology = new WeakMap();
    this.gltfJson = null;
    this.loadedAnimations = [];
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((object) => {
      object.geometry?.dispose();
      // 删除区域备份的原始几何也要释放
      if (object.userData?.baseGeometry && object.userData.baseGeometry !== object.geometry) {
        object.userData.baseGeometry.dispose();
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.filter(Boolean).forEach((material) => {
        Object.values(material).forEach((value) => value?.isTexture && value.dispose());
        material.dispose?.();
      });
    });
    this.model = null;
  }
}

/**
 * 按选区把网格切成两份。判定规则与打包端 collectPrimitives 保持一致：
 * 世界坐标（= 烘焙后的最终空间）下按三角形质心归属，保证预览所见与最终导出结果相同。
 */
function insideRegion(region, x, y, z) {
  return Boolean(region)
    && x >= region.min[0] && x <= region.max[0]
    && y >= region.min[1] && y <= region.max[1]
    && z >= region.min[2] && z <= region.max[2];
}

function splitGeometryByRegion(object, region) {
  const geometry = object.geometry;
  const position = geometry?.attributes?.position;
  if (!position) return { inside: null, outside: null };
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const matrix = object.matrixWorld;
  const point = new THREE.Vector3();
  const inside = [];
  const outside = [];

  for (let t = 0; t + 2 < count; t += 3) {
    const tri = [0, 1, 2].map((k) => (index ? index.getX(t + k) : t + k));
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const v of tri) {
      point.fromBufferAttribute(position, v).applyMatrix4(matrix);
      cx += point.x; cy += point.y; cz += point.z;
    }
    cx /= 3; cy /= 3; cz /= 3;
    const hit = cx >= region.min[0] && cx <= region.max[0]
      && cy >= region.min[1] && cy <= region.max[1]
      && cz >= region.min[2] && cz <= region.max[2];
    (hit ? inside : outside).push(...tri);
  }
  return {
    inside: inside.length ? withIndices(geometry, inside) : null,
    outside: outside.length ? withIndices(geometry, outside) : null,
  };
}

function splitGeometryBySelection(object, selected) {
  const geometry = object.geometry;
  const position = geometry?.attributes?.position;
  if (!position || !selected?.size) return { inside: null, outside: null };
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const inside = [];
  const outside = [];
  for (let triangle = 0, offset = 0; offset + 2 < count; triangle++, offset += 3) {
    const tri = [0, 1, 2].map((k) => (index ? index.getX(offset + k) : offset + k));
    (selected.has(triangle) ? inside : outside).push(...tri);
  }
  return {
    inside: inside.length ? withIndices(geometry, inside) : null,
    outside: outside.length ? withIndices(geometry, outside) : null,
  };
}

/** 复用原顶点属性，只换一套索引 */
function withIndices(source, indices) {
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(name, attribute);
  }
  const array = source.attributes.position.count > 65535
    ? new Uint32Array(indices) : new Uint16Array(indices);
  geometry.setIndex(new THREE.BufferAttribute(array, 1));
  geometry.userData.temporary = true;
  return geometry;
}

/** 点亮图集缺失时的兜底：无光照纯色 */
function makeLitMaterial(color) {
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color || '#ffffff'),
    toneMapped: false,
  });
  material.userData.temporary = true;
  return material;
}

/**
 * 灯光叠加层的“点亮”材质。车机质感用 Lambert（与其余车身一致、如实反映车机简单光照），
 * 网页质感用无光照 Basic 便于编辑时看清贴图本身。BLEND 叠加层不写深度，避免遮住车窗等透明件。
 */
function makeLampPreviewMaterial(texture, device, { ownsMap = false } = {}) {
  const options = { map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide };
  const material = device
    ? new THREE.MeshLambertMaterial(options)
    : new THREE.MeshBasicMaterial({ ...options, toneMapped: false });
  material.userData.temporary = true;
  material.userData.ownsMap = ownsMap;
  return material;
}

/**
 * 把（切分后的）几何压成只含用到的顶点的世界坐标副本，并沿法线外推成叠加层。
 * 与导出端 collectPrimitives + buildLampOverlay 的处理一致：镜像矩阵时翻转环绕方向。
 */
function compactLampGeometry(source, matrixWorld, offset) {
  const position = source?.attributes?.position;
  if (!position) return null;
  const index = source.index;
  const count = index ? index.count : position.count;
  if (count < 3) return null;
  const remap = new Map();
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const old = index ? index.getX(i) : i;
    let next = remap.get(old);
    if (next === undefined) {
      next = remap.size;
      remap.set(old, next);
    }
    indices[i] = next;
  }
  if (matrixWorld.determinant() < 0) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const swap = indices[t + 1];
      indices[t + 1] = indices[t + 2];
      indices[t + 2] = swap;
    }
  }
  const vertexCount = remap.size;
  const positions = new Float32Array(vertexCount * 3);
  const sourceNormal = source.attributes.normal;
  const normals = sourceNormal ? new Float32Array(vertexCount * 3) : null;
  const sourceUv = source.attributes.uv;
  const uv = sourceUv ? new Float32Array(vertexCount * 2) : null;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrixWorld);
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const [old, next] of remap) {
    point.fromBufferAttribute(position, old).applyMatrix4(matrixWorld);
    positions[next * 3] = point.x;
    positions[next * 3 + 1] = point.y;
    positions[next * 3 + 2] = point.z;
    if (normals) {
      normal.fromBufferAttribute(sourceNormal, old).applyMatrix3(normalMatrix).normalize();
      normals[next * 3] = normal.x;
      normals[next * 3 + 1] = normal.y;
      normals[next * 3 + 2] = normal.z;
    }
    if (uv) {
      uv[next * 2] = sourceUv.getX(old);
      uv[next * 2 + 1] = sourceUv.getY(old);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (uv) geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (!normals) geometry.computeVertexNormals();
  const finalNormal = geometry.attributes.normal;
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] += finalNormal.getX(i) * offset;
    positions[i * 3 + 1] += finalNormal.getY(i) * offset;
    positions[i * 3 + 2] += finalNormal.getZ(i) * offset;
  }
  geometry.attributes.position.needsUpdate = true;
  geometry.userData.temporary = true;
  return geometry;
}

function collectStats(gltf, bytes) {
  const stats = {
    bytes,
    scenes: gltf.parser.json.scenes?.length || 0,
    nodes: gltf.parser.json.nodes?.length || 0,
    meshes: gltf.parser.json.meshes?.length || 0,
    materials: gltf.parser.json.materials?.length || 0,
    textures: gltf.parser.json.textures?.length || 0,
    animations: gltf.animations?.length || 0,
    triangles: 0,
    skinned: false,
    morphs: false,
  };
  gltf.scene.traverse((object) => {
    if (object.isMesh) {
      const geometry = object.geometry;
      stats.triangles += geometry.index ? geometry.index.count / 3 : (geometry.attributes.position?.count || 0) / 3;
      stats.skinned ||= object.isSkinnedMesh;
      stats.morphs ||= Boolean(object.morphTargetInfluences?.length);
    }
  });
  stats.triangles = Math.round(stats.triangles);
  return stats;
}
