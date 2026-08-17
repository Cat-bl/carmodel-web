import JSZip from 'jszip';

export const PROJECT_FILE_ACCEPT = '.bydcarproj,application/zip,application/octet-stream';
export const PROJECT_FORMAT = 'com.byd.launchermap.bydcar-project';
export const PROJECT_FORMAT_VERSION = 1;

const MODEL_PATH = 'source/model.glb';

export async function makeProjectFile({ modelBytes, metadata, editorState }, onProgress = null) {
  const bytes = toUint8Array(modelBytes);
  if (!isGlb(bytes)) throw new Error('当前项目没有可保存的标准 GLB 模型');
  report(onProgress, 0.08, '正在校验模型数据');
  const modelHash = await sha256(bytes);
  const savedAt = new Date().toISOString();
  const manifest = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    generator: 'byd-car-converter-web/0.1.0',
    savedAt,
    metadata: sanitizeMetadata(metadata),
    model: {
      path: MODEL_PATH,
      size: bytes.byteLength,
      sha256: modelHash,
    },
    editorState,
  };

  report(onProgress, 0.28, '正在写入编辑配置');
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(manifest, null, 2), {
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    createFolders: false,
  });
  zip.file(MODEL_PATH, bytes, { compression: 'STORE', createFolders: true });
  const output = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }, ({ percent }) => {
    report(onProgress, 0.28 + (percent / 100) * 0.7, '正在打包项目文件');
  });
  report(onProgress, 1, '项目文件已生成');
  return { bytes: output, manifest };
}

export async function readProjectFile(file, onProgress = null) {
  if (!file) throw new Error('没有选择项目文件');
  if (!/\.bydcarproj$/i.test(file.name || '')) throw new Error('请选择 .bydcarproj 项目文件');
  report(onProgress, 0.03, '正在读取项目文件');
  const archiveBytes = new Uint8Array(await readFileWithProgress(file, (ratio) => {
    report(onProgress, 0.03 + ratio * 0.17, '正在读取项目文件');
  }));

  report(onProgress, 0.23, '正在解析项目配置');
  let zip;
  try {
    zip = await JSZip.loadAsync(archiveBytes);
  } catch {
    throw new Error('项目文件损坏或不是有效的 .bydcarproj 文件');
  }
  const manifestEntry = zip.file('project.json');
  if (!manifestEntry) throw new Error('项目文件缺少 project.json');
  let manifest;
  try {
    manifest = JSON.parse(await manifestEntry.async('string'));
  } catch {
    throw new Error('项目配置无法解析');
  }
  validateManifest(manifest);

  report(onProgress, 0.42, '正在读取项目模型');
  const modelEntry = zip.file(manifest.model.path);
  if (!modelEntry) throw new Error(`项目文件缺少模型：${manifest.model.path}`);
  const modelBytes = await modelEntry.async('uint8array', ({ percent }) => {
    report(onProgress, 0.42 + (percent / 100) * 0.34, '正在读取项目模型');
  });
  if (!isGlb(modelBytes)) throw new Error('项目中的模型不是有效的 GLB 2.0 文件');
  if (modelBytes.byteLength !== manifest.model.size) throw new Error('项目中的模型大小校验失败');

  report(onProgress, 0.8, '正在校验项目完整性');
  if (await sha256(modelBytes) !== manifest.model.sha256) throw new Error('项目中的模型 SHA-256 校验失败');
  report(onProgress, 1, '项目读取完成');
  return {
    manifest,
    metadata: sanitizeMetadata(manifest.metadata),
    editorState: manifest.editorState,
    modelBytes,
  };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('项目配置为空');
  if (manifest.format !== PROJECT_FORMAT) throw new Error('这不是 BYD 车模编辑器项目文件');
  const version = Number(manifest.formatVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error('项目格式版本无效');
  if (version > PROJECT_FORMAT_VERSION) throw new Error('该项目由更新版本的编辑器创建，请升级网页后再打开');
  if (!manifest.model || manifest.model.path !== MODEL_PATH) throw new Error('项目配置缺少模型信息');
  if (!Number.isFinite(manifest.model.size) || manifest.model.size <= 0) throw new Error('项目模型大小无效');
  if (!/^[a-f0-9]{64}$/i.test(manifest.model.sha256 || '')) throw new Error('项目模型校验值无效');
  if (!manifest.editorState || typeof manifest.editorState !== 'object') throw new Error('项目缺少编辑进度');
}

function sanitizeMetadata(metadata) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    displayName: cleanText(source.displayName, '未命名车模'),
    modelName: cleanText(source.modelName, 'custom-model.glb'),
    sourceFormat: cleanText(source.sourceFormat, 'glb'),
    formatLabel: cleanText(source.formatLabel, 'GLB'),
    warnings: Array.isArray(source.warnings) ? source.warnings.filter((item) => typeof item === 'string').slice(0, 100) : [],
  };
}

function cleanText(value, fallback) {
  const output = typeof value === 'string' ? value.trim() : '';
  return output ? output.slice(0, 500) : fallback;
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持项目完整性校验');
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function isGlb(bytes) {
  return bytes.byteLength >= 12
    && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) === 2;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('项目模型数据无效');
}

function report(callback, progress, label) {
  callback?.({ progress: Math.max(0, Math.min(1, Number(progress) || 0)), label });
}

function readFileWithProgress(file, onProgress) {
  if (typeof FileReader === 'undefined') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total) onProgress?.(event.loaded / event.total);
    };
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取项目文件失败'));
    reader.onabort = () => reject(new Error('读取项目文件已取消'));
    reader.readAsArrayBuffer(file);
  });
}
