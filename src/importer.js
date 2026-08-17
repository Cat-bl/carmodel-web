import * as THREE from 'three';
import JSZip from 'jszip';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';

const WHITE_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIAKpWnWQAAAABJRU5ErkJggg==';
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga']);
const FORMAT_LABELS = Object.freeze({
  glb: 'GLB', gltf: 'glTF ZIP', fbx: 'FBX', 'fbx-zip': 'FBX ZIP', 'obj-zip': 'OBJ ZIP',
});

export const MODEL_FILE_ACCEPT = '.glb,.fbx,.zip,model/gltf-binary,application/zip';
export const MODEL_FORMAT_HINT = 'GLB · glTF ZIP · FBX · OBJ ZIP';

export async function prepareModelImport(file, onProgress = null) {
  if (!file) throw new Error('没有选择模型文件');
  const report = (progress, label, indeterminate = false) => onProgress?.({ progress, label, indeterminate });
  const extension = fileExtension(file.name);
  const warnings = [];
  report(0.02, '正在读取模型文件');
  const sourceBytes = new Uint8Array(await readFileWithProgress(file, (ratio) => {
    report(0.02 + ratio * 0.18, '正在读取模型文件');
  }));

  if (extension === 'glb') {
    return { bytes: sourceBytes, name: `${baseName(file.name)}.glb`, sourceName: file.name, sourceFormat: 'glb', formatLabel: FORMAT_LABELS.glb, warnings };
  }

  let scene;
  let sourceFormat;
  let modelName = baseName(file.name);
  if (extension === 'fbx') {
    report(0.26, '正在解析 FBX 模型', true);
    scene = (await parseFbx(sourceBytes, null, '', warnings)).scene;
    sourceFormat = 'fbx';
  } else if (extension === 'zip') {
    report(0.22, '正在解压模型资源', true);
    const archive = await readArchive(sourceBytes, (ratio) => report(0.22 + ratio * 0.24, '正在解压模型资源'));
    const primary = findPrimaryModel(archive);
    if (!primary) throw new Error('ZIP 中没有找到 .gltf、.fbx 或 .obj 主模型');
    modelName = baseName(primary.path);
    if (primary.extension === 'gltf') {
      sourceFormat = 'gltf';
      report(0.5, '正在解析 glTF 与关联资源', true);
      scene = (await parseGltf(primary, archive)).scene;
    } else if (primary.extension === 'fbx') {
      sourceFormat = 'fbx-zip';
      report(0.5, '正在解析 FBX 与关联贴图', true);
      scene = (await parseFbx(primary.bytes, archive, directoryOf(primary.path), warnings)).scene;
    } else {
      sourceFormat = 'obj-zip';
      report(0.5, '正在解析 OBJ、MTL 与贴图', true);
      scene = (await parseObj(primary, archive, warnings)).scene;
    }
  } else if (extension === 'gltf' || extension === 'obj') {
    throw new Error(`${extension.toUpperCase()} 通常依赖 BIN、MTL 或贴图，请把模型及其资源一起压缩为 ZIP 后导入`);
  } else {
    throw new Error('支持 GLB、glTF ZIP、FBX、FBX ZIP 和 OBJ ZIP');
  }

  report(0.72, '正在转换为内嵌资源 GLB', true);
  const bytes = await exportSceneToGlb(scene);
  report(0.98, '格式转换完成');
  return {
    bytes,
    name: `${modelName || baseName(file.name)}.glb`,
    sourceName: file.name,
    sourceFormat,
    formatLabel: FORMAT_LABELS[sourceFormat],
    warnings: [...new Set(warnings)],
  };
}

async function parseGltf(primary, archive) {
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(primary.bytes));
  } catch {
    throw new Error('ZIP 中的 glTF JSON 无法解析');
  }
  const root = directoryOf(primary.path);
  for (const buffer of json.buffers || []) {
    if (!buffer.uri || isEmbeddedUri(buffer.uri)) continue;
    const resource = resolveArchiveEntry(archive, buffer.uri, root);
    if (!resource) throw new Error(`glTF 缺少缓冲文件：${buffer.uri}`);
    buffer.uri = bytesToDataUri(resource.bytes, 'application/octet-stream');
  }
  for (const image of json.images || []) {
    if (!image.uri || isEmbeddedUri(image.uri)) continue;
    const resource = resolveArchiveEntry(archive, image.uri, root);
    if (!resource) throw new Error(`glTF 缺少贴图：${image.uri}`);
    image.uri = bytesToDataUri(resource.bytes, mimeTypeFor(resource.path));
  }
  return { scene: (await new GLTFLoader().parseAsync(JSON.stringify(json), '')).scene };
}

async function parseFbx(bytes, archive, basePath, warnings) {
  const manager = createResourceManager(archive, basePath, warnings);
  const tracker = trackLoadingManager(manager);
  let scene;
  try {
    scene = new FBXLoader(manager).parse(toArrayBuffer(bytes), basePath);
  } catch (error) {
    await tracker.finish();
    throw new Error(`FBX 解析失败：${error.message || '文件结构无效'}`);
  }
  await tracker.finish();
  return { scene };
}

async function parseObj(primary, archive, warnings) {
  const basePath = directoryOf(primary.path);
  const manager = createResourceManager(archive, basePath, warnings);
  const tracker = trackLoadingManager(manager);
  const objText = new TextDecoder().decode(primary.bytes);
  const objLoader = new OBJLoader(manager);
  const mtlEntry = findObjMaterial(objText, archive, basePath);
  if (mtlEntry) {
    const materials = new MTLLoader(manager).parse(new TextDecoder().decode(mtlEntry.bytes), directoryOf(mtlEntry.path));
    materials.preload();
    objLoader.setMaterials(materials);
  } else {
    warnings.push('OBJ 中没有找到 MTL，已使用模型自带的默认材质');
  }
  let scene;
  try {
    scene = objLoader.parse(objText);
  } catch (error) {
    await tracker.finish();
    throw new Error(`OBJ 解析失败：${error.message || '文件结构无效'}`);
  }
  await tracker.finish();
  return { scene };
}

async function exportSceneToGlb(scene) {
  if (!scene) throw new Error('模型没有可转换的场景');
  let meshCount = 0;
  const materialCache = new Map();
  scene.traverse((object) => {
    if (!object.isMesh || !object.geometry?.attributes?.position) return;
    meshCount++;
    if (!object.geometry.attributes.normal) object.geometry.computeVertexNormals();
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => standardizeMaterial(material, materialCache))
      : standardizeMaterial(object.material, materialCache);
    object.frustumCulled = false;
  });
  if (!meshCount) throw new Error('模型中没有可用的三角网格');
  scene.name ||= 'ImportedModel';
  scene.updateMatrixWorld(true);
  try {
    const result = await new GLTFExporter().parseAsync(scene, {
      binary: true, onlyVisible: false, trs: false, maxTextureSize: Infinity, animations: [],
    });
    return new Uint8Array(result);
  } catch (error) {
    throw new Error(`转换 GLB 失败：${error.message || '材质或几何不兼容'}`);
  }
}

function standardizeMaterial(material, cache) {
  if (!material || material.isMeshStandardMaterial) return material;
  if (cache.has(material)) return cache.get(material);
  const shininess = Number(material.shininess);
  const roughness = Number.isFinite(shininess)
    ? THREE.MathUtils.clamp(Math.sqrt(2 / (shininess + 2)), 0.08, 1)
    : 0.72;
  const converted = new THREE.MeshStandardMaterial({
    name: material.name || '',
    color: material.color?.clone?.() || new THREE.Color(0xffffff),
    map: material.map || null,
    alphaMap: material.alphaMap || null,
    aoMap: material.aoMap || null,
    aoMapIntensity: material.aoMapIntensity ?? 1,
    emissive: material.emissive?.clone?.() || new THREE.Color(0x000000),
    emissiveMap: material.emissiveMap || null,
    emissiveIntensity: material.emissiveIntensity ?? 1,
    normalMap: material.normalMap || material.bumpMap || null,
    normalScale: material.normalScale?.clone?.() || new THREE.Vector2(1, 1),
    roughness,
    metalness: 0,
    transparent: Boolean(material.transparent || (material.opacity ?? 1) < 1),
    opacity: material.opacity ?? 1,
    alphaTest: material.alphaTest || 0,
    side: material.side,
    vertexColors: Boolean(material.vertexColors),
    flatShading: Boolean(material.flatShading),
    depthTest: material.depthTest !== false,
    depthWrite: material.depthWrite !== false,
  });
  if (material.bumpMap && !material.normalMap) converted.normalScale.setScalar(material.bumpScale ?? 1);
  converted.map?.updateMatrix?.();
  converted.alphaMap?.updateMatrix?.();
  converted.emissiveMap?.updateMatrix?.();
  converted.normalMap?.updateMatrix?.();
  cache.set(material, converted);
  return converted;
}

function createResourceManager(archive, basePath, warnings) {
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga(?:$|[?#])/i, new TGALoader(manager));
  const urls = new Map();
  manager.setURLModifier((url) => {
    if (isEmbeddedUri(url) || String(url).startsWith('blob:')) return url;
    const resource = archive ? resolveArchiveEntry(archive, url, basePath) : null;
    if (resource) {
      if (!urls.has(resource.key)) urls.set(resource.key, URL.createObjectURL(new Blob([resource.bytes], { type: mimeTypeFor(resource.path) })));
      return urls.get(resource.key);
    }
    const extension = fileExtension(url.split(/[?#]/)[0]);
    if (IMAGE_EXTENSIONS.has(extension)) {
      warnings.push(`缺少外部贴图：${cleanResourceLabel(url)}，已用白色占位；建议把贴图和模型一起压缩为 ZIP`);
      return WHITE_PIXEL;
    }
    return url;
  });
  manager.onError = (url) => warnings.push(`资源加载失败：${cleanResourceLabel(url)}`);
  manager.userData = { revoke: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  return manager;
}

function trackLoadingManager(manager) {
  let active = 0;
  let parsingFinished = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const originalStart = manager.itemStart.bind(manager);
  const originalEnd = manager.itemEnd.bind(manager);
  manager.itemStart = (url) => { active++; originalStart(url); };
  manager.itemEnd = (url) => {
    active = Math.max(0, active - 1);
    originalEnd(url);
    if (parsingFinished && active === 0) resolveDone();
  };
  return {
    async finish() {
      parsingFinished = true;
      if (active === 0) resolveDone();
      try { await done; } finally { manager.userData?.revoke?.(); }
    },
  };
}

async function readArchive(bytes, onProgress) {
  let zip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error('ZIP 文件损坏或不是有效压缩包'); }
  const files = Object.values(zip.files).filter((entry) => !entry.dir && !isIgnoredArchivePath(entry.name));
  if (!files.length) throw new Error('ZIP 中没有可读取的模型资源');
  const entries = [];
  for (let index = 0; index < files.length; index++) {
    const entry = files[index];
    entries.push(makeArchiveEntry(entry.name, await entry.async('uint8array')));
    onProgress?.((index + 1) / files.length);
  }
  return { entries, byKey: new Map(entries.map((entry) => [entry.key, entry])) };
}

function findPrimaryModel(archive) {
  const priority = { gltf: 0, fbx: 1, obj: 2 };
  return archive.entries.filter((entry) => Object.hasOwn(priority, entry.extension)).sort((a, b) => (
    priority[a.extension] - priority[b.extension] || pathDepth(a.path) - pathDepth(b.path) || a.path.length - b.path.length
  ))[0] || null;
}

function findObjMaterial(objText, archive, basePath) {
  for (const line of objText.split(/\r?\n/)) {
    const match = line.match(/^\s*mtllib\s+(.+?)\s*$/i);
    if (match) {
      const resource = resolveArchiveEntry(archive, match[1], basePath);
      if (resource) return resource;
    }
  }
  return archive.entries.find((entry) => entry.extension === 'mtl') || null;
}

function resolveArchiveEntry(archive, requested, basePath = '') {
  const raw = decodeResourcePath(requested);
  for (const candidate of [raw, joinPath(basePath, raw)]) {
    const found = archive.byKey.get(normalizeArchiveKey(candidate));
    if (found) return found;
  }
  const basename = normalizeArchiveKey(raw).split('/').pop();
  const matches = archive.entries.filter((entry) => entry.key.split('/').pop() === basename);
  return matches.length === 1 ? matches[0] : null;
}

function makeArchiveEntry(path, bytes) {
  const normalized = normalizeArchivePath(path);
  return { path: normalized, key: normalized.toLowerCase(), extension: fileExtension(normalized), bytes };
}

function normalizeArchiveKey(path) { return normalizeArchivePath(path).toLowerCase(); }

function normalizeArchivePath(path) {
  const output = [];
  for (const part of String(path || '').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') output.pop(); else output.push(part);
  }
  return output.join('/');
}

function decodeResourcePath(value) {
  let path = String(value || '').split(/[?#]/)[0].replace(/^zip:\/\/?/i, '').replace(/\\/g, '/');
  try { path = decodeURIComponent(path); } catch { /* 保留无法解码的原路径 */ }
  return normalizeArchivePath(path);
}

function joinPath(base, relative) { return normalizeArchivePath(base ? `${base}/${relative}` : relative); }

function directoryOf(path) {
  const normalized = normalizeArchivePath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : `${normalized.slice(0, index)}/`;
}

function pathDepth(path) { return normalizeArchivePath(path).split('/').length; }

function isIgnoredArchivePath(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  return normalized.startsWith('__MACOSX/') || normalized.split('/').some((part) => part.startsWith('._'));
}

function isEmbeddedUri(value) { return /^(?:data:|blob:)/i.test(String(value || '')); }

function mimeTypeFor(path) {
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    bmp: 'image/bmp', tga: 'image/x-tga', bin: 'application/octet-stream',
  }[fileExtension(path)] || 'application/octet-stream';
}

function bytesToDataUri(bytes, mimeType) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function toArrayBuffer(bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }

function fileExtension(name) {
  const clean = String(name || '').split(/[?#]/)[0];
  const index = clean.lastIndexOf('.');
  return index < 0 ? '' : clean.slice(index + 1).toLowerCase();
}

function baseName(name) {
  const leaf = String(name || '').replace(/\\/g, '/').split('/').pop() || 'custom-model';
  return leaf.replace(/\.(?:glb|gltf|fbx|obj|zip)$/i, '') || 'custom-model';
}

function cleanResourceLabel(url) {
  const value = String(url || '未知资源');
  return value.length > 100 ? `${value.slice(0, 97)}...` : value;
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
