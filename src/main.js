import './style.css';
import { ModelPreview } from './preview.js';
import { makeBydCar, makeVehiclePreviewGlb } from './package.js';
import { SLOT_BY_ID, defaultParams, slotGroups, suggestRegion } from './bindings.js';
import {
  createIcons,
  ArrowLeft,
  ArrowLeftRight,
  BoxSelect,
  CheckCircle2,
  Download,
  Eye,
  Gauge,
  Layers3,
  Maximize2,
  MousePointer2,
  Paintbrush,
  Play,
  Redo2,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  Wrench,
} from 'lucide';
import { emptySelection, selectionGroupCount, selectionTriangleCount } from './selection.js';

const app = document.querySelector('#app');

app.innerHTML = `
  <div class="editor-shell" data-stage="0">
    <header class="commandbar">
      <div class="file-context">
        <img class="brand-mark" src="./logo.svg" alt="" />
        <div class="file-copy">
          <strong>BYD 车模编辑器</strong>
          <span id="file-name">尚未选择模型</span>
        </div>
        <span class="dirty-dot" id="dirty-state" title="未保存的修改" hidden></span>
      </div>
      <div class="command-center">
        <button class="icon-btn" id="undo" disabled title="撤销"><i data-lucide="undo-2"></i></button>
        <button class="icon-btn" id="redo" disabled title="重做"><i data-lucide="redo-2"></i></button>
        <button class="icon-btn" id="reset-rotation" disabled title="重置模型"><i data-lucide="rotate-ccw"></i></button>
        <span class="command-divider"></span>
        <div class="segmented compact" aria-label="预览质感">
          <button class="active" id="mode-web" disabled>网页质感</button>
          <button id="mode-device" disabled>车机质感</button>
        </div>
      </div>
      <div class="command-actions">
        <button class="btn command-check" data-panel-target="check"><i data-lucide="check-circle-2"></i><span>检查</span></button>
        <button class="btn primary" id="generate" disabled><i data-lucide="download"></i><span>生成车模包</span></button>
      </div>
    </header>

    <div class="editor-workspace">
      <nav class="task-rail" aria-label="编辑任务">
        <button class="task-entry active" data-panel-target="model">
          <i data-lucide="wrench"></i><span>模型</span><small id="analysis-state">等待导入</small>
        </button>
        <div class="rail-section">
          <div class="rail-heading">
            <span><i data-lucide="layers-3"></i>联动</span>
            <span id="binding-summary">未配置</span>
          </div>
          <button class="rail-action" id="demo-all" disabled><i data-lucide="play"></i>全部演示</button>
          <div id="binding-groups"></div>
        </div>
        <button class="task-entry" data-panel-target="check">
          <i data-lucide="check-circle-2"></i><span>检查</span><small>车机兼容性</small>
        </button>
      </nav>

      <section class="canvas-stage">
        <div class="canvas-toolbar">
          <div class="view-actions" aria-label="预览视角">
            <button class="tool-btn active" data-view="perspective">透视</button>
            <button class="tool-btn" data-view="front">前</button>
            <button class="tool-btn" data-view="back">后</button>
            <button class="tool-btn" data-view="left">左</button>
            <button class="tool-btn" data-view="right">右</button>
            <button class="tool-btn" data-view="top">顶</button>
          </div>
          <button class="icon-btn canvas-reset" data-view="perspective" title="适应视图"><i data-lucide="maximize-2"></i></button>
        </div>
        <div class="viewport">
          <canvas id="preview"></canvas>
          <label class="empty-state" id="empty-state" for="model-file" tabindex="0" role="button">
            <i data-lucide="upload"></i>
            <strong>导入 GLB 车模</strong>
            <span>点击或拖入文件，最大 32MB</span>
          </label>
          <div class="import-progress" id="import-progress" role="status" aria-live="polite" aria-valuemin="0" aria-valuemax="100" hidden>
            <div class="import-progress-copy">
              <span class="spinner" aria-hidden="true"></span>
              <strong id="import-progress-label">正在读取模型</strong>
              <span id="import-progress-percent">0%</span>
            </div>
            <div class="import-progress-track" aria-hidden="true"><span id="import-progress-bar"></span></div>
          </div>
          <input id="model-file" class="visually-hidden" type="file" accept=".glb,model/gltf-binary" />
          <div class="selection-hud" id="selection-hud" hidden></div>
        </div>
        <footer class="workspace-status">
          <span><i data-lucide="gauge"></i><b id="workspace-triangles">0</b> 面</span>
          <span><i data-lucide="box-select"></i><b id="workspace-selection">0</b> 个选区</span>
          <span id="workspace-mode">浏览模式</span>
          <span class="status-spacer"></span>
          <span id="workspace-index">精细索引未启用</span>
        </footer>
      </section>

      <aside class="inspector">
        <section class="inspector-panel active" data-panel="model">
          <div class="inspector-title">
            <div><span>模型</span><h2>导入与调整</h2></div>
            <label class="icon-btn" for="model-file" title="导入或更换模型"><i data-lucide="upload"></i></label>
          </div>
          <div class="inspector-scroll">
            <section class="tool-section">
              <div class="section-title"><h3>模型信息</h3><span>GLB · 32MB 上限</span></div>
              <div class="stats">
                ${stat('大小', 'stat-bytes')}
                ${stat('三角形', 'stat-triangles')}
                ${stat('节点', 'stat-nodes')}
                ${stat('网格', 'stat-meshes')}
                ${stat('材质', 'stat-materials')}
                ${stat('纹理', 'stat-textures')}
              </div>
            </section>
            <section class="tool-section">
              <div class="section-title"><h3>朝向与尺寸</h3><span>蓝色箭头为车头</span></div>
              <div class="field-grid">
                ${numberField('旋转 X°', 'rotation-x', 0)}
                ${numberField('旋转 Y°', 'rotation-y', 0)}
                ${numberField('旋转 Z°', 'rotation-z', 0)}
              </div>
              <div class="quick-row">
                <button class="btn small" data-rotate="y:90">左转 90°</button>
                <button class="btn small" data-rotate="y:-90">右转 90°</button>
                <button class="btn small" data-rotate="y:180">反向</button>
              </div>
              <div class="field-grid two-cols">
                <div class="field"><label for="target-length">车身最长边（米）</label><input id="target-length" type="number" min="0.5" max="10" step="0.1" value="5.2" disabled /></div>
                <div class="field"><label for="height-offset">离地高度（米）</label><input id="height-offset" type="number" min="0" max="3" step="0.05" value="0" disabled /></div>
              </div>
            </section>
            <section class="tool-section">
              <div class="section-title"><h3>删除多余部分</h3><span id="delete-summary">未删除</span></div>
              <button class="btn" id="delete-start" disabled><i data-lucide="trash-2"></i>框选删除区域</button>
              <div id="delete-panel"></div>
            </section>
          </div>
        </section>

        <section class="inspector-panel" data-panel="binding">
          <div class="inspector-title binding-inspector-title">
            <button class="icon-btn inspector-back" id="binding-back" type="button" title="返回联动列表" hidden><i data-lucide="arrow-left"></i></button>
            <div><span>联动</span><h2 id="binding-editor-title">选择一个联动槽位</h2></div>
          </div>
          <div class="inspector-scroll" id="binding-editor-host">
            <div class="inspector-placeholder"><i data-lucide="mouse-pointer-2"></i><span>从左侧选择灯光、车轮或开合槽位</span></div>
          </div>
        </section>

        <section class="inspector-panel" data-panel="check">
          <div class="inspector-title"><div><span>检查</span><h2>车机兼容性</h2></div><span class="profile-badge">profile v1</span></div>
          <div class="inspector-scroll">
            <div class="status-list" id="status-list">${status('warn', '…', '导入模型后开始检查')}</div>
            <button class="btn primary inspector-generate" id="mobile-generate" disabled><i data-lucide="download"></i>生成车模包</button>
          </div>
        </section>
      </aside>
    </div>

    <div class="mobile-dock">
      <button class="icon-btn" id="mobile-reset" title="重置"><i data-lucide="rotate-ccw"></i></button>
      <button class="dock-task active" data-panel-target="model">模型</button>
      <button class="dock-task" data-panel-target="binding">联动</button>
      <button class="dock-task" data-panel-target="check">检查</button>
      <button class="icon-btn primary" id="mobile-generate-shortcut" disabled title="生成"><i data-lucide="download"></i></button>
    </div>
  </div>
`;

function stat(label, id) {
  return `<div class="stat"><span class="stat-label">${label}</span><strong class="stat-value" id="${id}">—</strong></div>`;
}

function numberField(label, id, value) {
  return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" step="1" value="${value}" disabled /></div>`;
}

function status(kind, icon, text) {
  return `<div class="status ${kind}"><span class="status-icon">${icon}</span><span>${text}</span></div>`;
}

const ui = Object.fromEntries([
  'model-file', 'drop-zone', 'file-name', 'analysis-state', 'empty-state',
  'rotation-x', 'rotation-y', 'rotation-z', 'target-length', 'height-offset', 'status-list',
  'generate', 'mobile-generate', 'reset-rotation', 'mobile-reset', 'mode-web', 'mode-device',
  'binding-groups', 'binding-summary', 'binding-editor-host', 'binding-editor-title', 'demo-all',
  'delete-start', 'delete-panel', 'delete-summary', 'undo', 'redo', 'dirty-state',
  'workspace-triangles', 'workspace-selection', 'workspace-mode', 'workspace-index',
  'import-progress', 'import-progress-label', 'import-progress-percent', 'import-progress-bar',
  'binding-back',
].map((id) => [id, document.getElementById(id)]));
// 空状态本身就是拖入区域；兼容旧逻辑保留 drop-zone 别名。
ui['drop-zone'] ||= ui['empty-state'];

const preview = new ModelPreview(document.getElementById('preview'), updateStats);
let current = null;
let dirty = false;
let activePanel = 'model';

window.addEventListener('beforeunload', (event) => {
  const importing = document.querySelector('.editor-shell')?.classList.contains('is-importing');
  if (!current && !importing) return;
  event.preventDefault();
  event.returnValue = '';
});

const lucideIcons = {
  ArrowLeft, ArrowLeftRight, BoxSelect, CheckCircle2, Download, Eye, Gauge, Layers3, Maximize2, MousePointer2,
  Paintbrush, Play, Redo2, RotateCcw, Settings2, Sparkles, Square, Trash2, Undo2, Upload, Wrench,
};

function renderIcons() {
  createIcons({ icons: lucideIcons, attrs: { 'stroke-width': 1.8 } });
}

function setDirty(value = true) {
  dirty = value;
  ui['dirty-state'].hidden = !dirty;
  ui['file-name'].classList.toggle('modified', dirty);
}

function setActivePanel(panel) {
  if (panel !== 'model' && deleteDraft) cancelDeleteDraft(false);
  activePanel = panel;
  document.querySelectorAll('.inspector-panel').forEach((element) => {
    element.classList.toggle('active', element.dataset.panel === panel);
  });
  document.querySelectorAll('[data-panel-target]').forEach((element) => {
    element.classList.toggle('active', element.dataset.panelTarget === panel);
  });
  if (panel !== 'binding') {
    closePreviewTools();
    ui['workspace-mode'].textContent = panel === 'check' ? '兼容性检查' : '浏览模式';
  }
  if (panel === 'binding' && openSlot) {
    const slot = SLOT_BY_ID.get(openSlot);
    const binding = bindings.get(openSlot);
    if (binding?.selection && selectionEditingSlot === slot.id) startFineSelection(slot, { preserveState: true });
  }
}

function markDevicePreviewStale() {
  deviceGlbCache = null;
  deviceGlbCacheKey = '';
}

renderIcons();

function wireMobileInspectorDrag() {
  const inspector = document.querySelector('.inspector');
  const workspace = document.querySelector('.editor-workspace');
  document.querySelectorAll('.inspector-title').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (!window.matchMedia('(max-width: 860px)').matches) return;
      if (!current) return;
      if (event.target.closest('button, label, input, select')) return;
      const pointerId = event.pointerId;
      handle.setPointerCapture?.(pointerId);
      const move = (moveEvent) => {
        const landscape = window.matchMedia('(orientation: landscape)').matches;
        const minHeight = landscape ? 104 : 180;
        const maxRatio = landscape ? 0.62 : 0.74;
        const workspaceRect = workspace.getBoundingClientRect();
        const height = Math.max(minHeight, Math.min(workspaceRect.height * maxRatio, workspaceRect.bottom - moveEvent.clientY));
        inspector.style.height = `${height}px`;
      };
      const stop = () => {
        handle.releasePointerCapture?.(pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    });
  });
}

wireMobileInspectorDrag();

const stepElements = [...document.querySelectorAll('.steps .step')];
/** 步骤条随实际进度点亮：0 导入前 → 3 模型就绪（可调整/联动/检查）→ 4 已生成 */
function updateSteps(stage) {
  document.querySelector('.editor-shell').dataset.stage = String(stage);
  stepElements.forEach((element, index) => element.classList.toggle('active', index <= stage));
}

function updateImportProgress({ progress = 0, label = '正在读取模型', indeterminate = false } = {}) {
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  ui['import-progress'].hidden = false;
  ui['import-progress'].classList.toggle('indeterminate', indeterminate);
  ui['import-progress'].setAttribute('aria-valuenow', String(percent));
  ui['import-progress-label'].textContent = label;
  ui['import-progress-percent'].textContent = indeterminate ? '处理中' : `${percent}%`;
  ui['import-progress-bar'].style.width = `${percent}%`;
}

function finishImportProgress() {
  ui['import-progress'].hidden = true;
  ui['import-progress'].classList.remove('indeterminate');
}

ui['model-file'].addEventListener('change', (event) => loadFile(event.target.files?.[0]));
ui['drop-zone'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') ui['model-file'].click();
});
for (const eventName of ['dragenter', 'dragover']) {
  ui['drop-zone'].addEventListener(eventName, (event) => {
    event.preventDefault();
    ui['drop-zone'].classList.add('drag');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  ui['drop-zone'].addEventListener(eventName, (event) => {
    event.preventDefault();
    ui['drop-zone'].classList.remove('drag');
  });
}
ui['drop-zone'].addEventListener('drop', (event) => loadFile(event.dataTransfer.files?.[0]));

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => preview.view(button.dataset.view));
});

// 车道级车头约定为 -X：Y 轴正向旋转会把车头从 -X 转到 +Z，即车辆左转。
document.querySelectorAll('[data-rotate]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!current) return;
    snapshot();
    const [axis, delta] = button.dataset.rotate.split(':');
    const input = ui[`rotation-${axis}`];
    input.value = normalizeDegrees(Number(input.value) + Number(delta));
    updateRotation();
  });
});

for (const axis of ['x', 'y', 'z']) ui[`rotation-${axis}`].addEventListener('input', updateRotation);
// 尺寸与离地高度不改旋转，变换后可把删除框/选区/旋转中心无损迁移到新坐标
ui['target-length'].addEventListener('input', () => {
  renormalizeAndMigrate(() => preview.setTargetLength(ui['target-length'].value));
});
ui['height-offset'].addEventListener('input', () => {
  renormalizeAndMigrate(() => {
    preview.heightOffset = Math.min(3, Math.max(0, Number(ui['height-offset'].value) || 0));
    preview.normalize();
  });
});
ui['reset-rotation'].addEventListener('click', reset);
ui['mobile-reset'].addEventListener('click', reset);
ui.generate.addEventListener('click', generatePackage);
ui['mobile-generate'].addEventListener('click', () => ui.generate.click());
ui['demo-all'].addEventListener('click', () => { demoAll(); });
ui.redo.addEventListener('click', redo);
document.querySelectorAll('[data-panel-target]').forEach((element) => {
  element.addEventListener('click', () => {
    const target = element.dataset.panelTarget;
    if (element.classList.contains('dock-task') && target === 'binding' && activePanel === 'binding' && openSlot) {
      closeBindingEditor();
      return;
    }
    setActivePanel(target);
  });
});
document.querySelector('.command-check')?.addEventListener('click', () => setActivePanel('check'));
document.getElementById('mobile-generate-shortcut')?.addEventListener('click', generatePackage);
ui['binding-back'].addEventListener('click', closeBindingEditor);

let deviceGlbCache = null;
let deviceGlbCacheKey = '';
async function setPreviewMode(device) {
  if (!current || preview.deviceMode === device) return;
  stopFineSelection();
  ui['mode-web'].disabled = true;
  ui['mode-device'].disabled = true;
  try {
    // 预览复用最终导出管线：变换、联动切分或删除区域改变时都要重烘。
    const transform = preview.getExportTransform();
    const previewBindings = bindingsForOutput();
    const previewDeletions = deletions.map((item) => item.region);
    const cacheKey = JSON.stringify({ transform, bindings: previewBindings, deletions: previewDeletions });
    if (device && (!deviceGlbCache || deviceGlbCacheKey !== cacheKey)) {
      ui['mode-device'].textContent = '烘焙中…';
      deviceGlbCache = await makeVehiclePreviewGlb(current.bytes, transform, previewBindings, previewDeletions);
      deviceGlbCacheKey = cacheKey;
      ui['mode-device'].textContent = '车机质感';
    }
    await preview.setDeviceMode(device, deviceGlbCache, transform);
    ui['mode-web'].classList.toggle('active', !device);
    ui['mode-device'].classList.toggle('active', device);
    // 模型实例换了，删除区域、部件映射与打开中的联动工具都要跟着重建
    preview.setDeletions(deletions.map((item) => item.region));
    refreshParts();
    if (openSlot) {
      const slot = SLOT_BY_ID.get(openSlot);
      const binding = bindings.get(openSlot);
      if (binding?.region) {
        openRegionBox(slot);
        applyRegionMode(slot, binding);
      } else if (binding?.selection && !device) {
        startFineSelection(slot, { preserveState: true });
        playCurrentBinding();
      } else if (binding) {
        playCurrentBinding();
        syncPivotTools(slot, binding);
      }
    }
  } catch (error) {
    console.error(error);
    ui['mode-device'].textContent = '车机质感';
    setStatuses([['bad', '×', `车机质感预览失败：${error.message}`]]);
  } finally {
    ui['mode-web'].disabled = false;
    ui['mode-device'].disabled = false;
  }
}
ui['mode-web'].addEventListener('click', () => setPreviewMode(false));
ui['mode-device'].addEventListener('click', () => setPreviewMode(true));

async function loadFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.glb')) {
    setStatuses([['bad', '×', '首版只接受完整的 .glb 文件']]);
    return;
  }
  if (file.size > 32 * 1024 * 1024) {
    setStatuses([['bad', '×', '模型超过 32MB 硬限制']]);
    return;
  }
  ui['file-name'].textContent = file.name;
  ui['analysis-state'].textContent = '解析中…';
  ui['model-file'].disabled = true;
  document.querySelector('.editor-shell').classList.add('is-importing');
  ui['empty-state'].hidden = true;
  updateImportProgress({ progress: 0.02, label: '准备读取模型' });
  setStatuses([['warn', '…', '正在解析模型，请稍候']]);
  try {
    const loaded = await preview.load(file, updateImportProgress);
    updateImportProgress({ progress: 0.96, label: '正在初始化编辑工具' });
    current = { file, ...loaded };
    setDirty(false);
    ui['rotation-x'].value = 0;
    ui['rotation-y'].value = loaded.orientation.rotationY;
    ui['rotation-z'].value = 0;
    markDevicePreviewStale();
    refreshParts();
    deletions = [];
    deleteDraft = null;
    undoStack.length = 0;
    ui.undo.disabled = true;
    ui['height-offset'].value = 0;
    preview.heightOffset = 0;
    treeQuery = '';
    expandedGroups = new Set();
    renderDeletePanel();
    resetBindings();
    ui['mode-web'].classList.add('active');
    ui['mode-device'].classList.remove('active');
    ui['mode-device'].textContent = '车机质感';
    ui['analysis-state'].textContent = '解析完成';
    ui['empty-state'].hidden = true;
    setControls(true);
    setActivePanel('model');
    updateSteps(3);
    validateStats(loaded.stats, loaded.orientation);
    updateImportProgress({ progress: 1, label: '模型导入完成' });
  } catch (error) {
    console.error(error);
    current = null;
    setDirty(false);
    ui['analysis-state'].textContent = '解析失败';
    setControls(false);
    updateSteps(0);
    ui['empty-state'].hidden = false;
    setStatuses([['bad', '×', `无法读取此 GLB：${error.message || '文件结构无效'}`]]);
  } finally {
    ui['model-file'].disabled = false;
    ui['model-file'].value = '';
    document.querySelector('.editor-shell').classList.remove('is-importing');
    finishImportProgress();
  }
}

function updateStats(stats) {
  const values = {
    bytes: formatBytes(stats.bytes), triangles: stats.triangles.toLocaleString(), nodes: stats.nodes,
    meshes: stats.meshes, materials: stats.materials, textures: stats.textures,
  };
  for (const [key, value] of Object.entries(values)) document.getElementById(`stat-${key}`).textContent = value;
  ui['workspace-triangles'].textContent = stats.triangles.toLocaleString();
  ui['workspace-mode'].textContent = '浏览模式';
  ui['workspace-index'].textContent = '精细索引未启用';
}

function validateStats(stats, orientation) {
  const results = [];
  if (stats.triangles > 300000) results.push(['warn', '!', `三角形较多（${stats.triangles.toLocaleString()}），生成时会按车机渲染预算保留约 300,000 面`]);
  else if (stats.triangles > 60000) results.push(['warn', '!', `三角形较多（${stats.triangles.toLocaleString()}），建议后续简化`]);
  else results.push(['good', '✓', `三角形数量适合车机（${stats.triangles.toLocaleString()}）`]);

  if (stats.materials > 32) results.push(['bad', '×', `材质 ${stats.materials} 个，超过 32 个硬限制`]);
  else results.push(['good', '✓', `材质数量 ${stats.materials} 个`]);

  if (stats.skinned) results.push(['warn', '!', '检测到骨骼蒙皮，首版会转换为当前静态姿态']);
  if (stats.morphs) results.push(['warn', '!', '检测到 Morph，首版会保留当前静态形状']);
  if (stats.animations) results.push(['warn', '!', `检测到 ${stats.animations} 段动画，首版不作为车模动画导出`]);
  if (orientation?.detected && orientation.method === 'semantic') {
    results.push(['good', '✓', `已自动识别模型正面并对齐车头（Y ${orientation.rotationY}°，${orientation.reason}）`]);
  } else if (orientation?.detected) {
    results.push(['warn', '!', `已按车辆轮廓推测正面并对齐车头（Y ${orientation.rotationY}°），请在预览中确认`]);
  } else {
    results.push(['warn', '!', '未能从部件中可靠识别正面，已按常见 GLB 约定默认左转 90°（Y 270°），可在预览中手动校正']);
  }
  results.push(['good', '✓', '纹理和模型数据全部在浏览器本地处理']);
  setStatuses(results);
  const blocked = results.some(([kind]) => kind === 'bad');
  ui.generate.disabled = blocked;
  ui['mobile-generate'].disabled = blocked;
  document.getElementById('mobile-generate-shortcut').disabled = blocked;
  ui.generate.title = blocked ? '存在未通过的兼容性检查，请先查看检查结果' : '生成车模包';
}

function setStatuses(items) {
  ui['status-list'].innerHTML = items.map(([kind, icon, text]) => status(kind, icon, text)).join('');
}

function setControls(enabled) {
  for (const id of ['rotation-x', 'rotation-y', 'rotation-z', 'target-length', 'height-offset']) ui[id].disabled = !enabled;
  ui.generate.disabled = !enabled;
  ui['mobile-generate'].disabled = !enabled;
  document.getElementById('mobile-generate-shortcut').disabled = !enabled;
  ui['mode-web'].disabled = !enabled;
  ui['mode-device'].disabled = !enabled;
  ui['reset-rotation'].disabled = !enabled;
  ui['mobile-reset'].disabled = !enabled;
}

function updateRotation() {
  for (const axis of ['x', 'y', 'z']) preview.setRotation(axis, Number(ui[`rotation-${axis}`].value) || 0);
  setDirty();
  markDevicePreviewStale();
  refreshBindingTools();
}

/** 模型变换（旋转/尺寸）变化后，删除区域、部件包围盒与联动所在的世界坐标都变了，全部重算 */
function refreshBindingTools() {
  if (!current) return;
  if (deletions.length) {
    preview.setDeletions(deletions.map((item) => item.region));
    renderDeletePanel();
  }
  refreshParts();
  if (!openSlot) return;
  renderPartTree();
  const binding = bindings.get(openSlot);
  if (!binding) return;
  if (binding.region) updateRegionCount(binding);
  if (binding.selection) updateWorkspaceSelection(preview.selectionStats(binding.selection));
  playCurrentBinding();
}

function reset() {
  if (current) snapshot();
  if (!current) return;
  ui['rotation-x'].value = 0;
  ui['rotation-y'].value = current?.orientation?.rotationY || 0;
  ui['rotation-z'].value = 0;
  ui['target-length'].value = 5.2;
  preview.targetLength = 5.2;
  ui['height-offset'].value = 0;
  preview.heightOffset = 0;
  updateRotation();
  preview.view('perspective');
}

/* ---------- 联动配置 ---------- */

const bindings = new Map();
let parts = [];
let partGroups = [];
let openSlot = null;
let regionMode = 'translate';
let demoRun = null;
let pickingFor = null;
let selectionEditingSlot = null;
let selectionHistory = [];
let selectionLast = emptySelection();
let previewSelectionMode = 'smart';
let previewSelectionOperation = 'add';
let previewSelectionVisibleOnly = true;
let previewSelectionRadius = 28;
let previewSelectionAngle = 38;
let treeQuery = '';
let expandedGroups = new Set();
const partTreeScrollBySlot = new Map();
let pendingPartTreeReveal = null;

/** parts 与两层部件分组一起刷新，并给每一项算好中文方位标签 */
function refreshParts() {
  parts = preview.listParts();
  const whole = preview.wholeBounds();
  for (const part of parts) part.place = positionLabel(part.bounds, whole);
  const byIndex = new Map(parts.map((part) => [part.nodeIndex, part]));
  partGroups = preview.listPartGroups()
    .map((group, order) => {
      const leaves = group.leaves.map((index) => byIndex.get(index)).filter(Boolean);
      if (leaves.length === 0) return null;
      const bounds = mergeBounds(leaves.map((leaf) => leaf.bounds));
      return {
        key: `g${order}`,
        name: group.name,
        leaves,
        bounds,
        triangles: leaves.reduce((sum, leaf) => sum + leaf.triangles, 0),
        place: positionLabel(bounds, whole),
      };
    })
    .filter(Boolean);
}

function mergeBounds(list) {
  if (!list.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const bounds of list) {
    for (let i = 0; i < 3; i++) {
      if (bounds.min[i] < min[i]) min[i] = bounds.min[i];
      if (bounds.max[i] > max[i]) max[i] = bounds.max[i];
    }
  }
  return { min, max };
}

function boundsFromPoints(points) {
  if (!points?.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], point[i]);
      max[i] = Math.max(max[i], point[i]);
    }
  }
  return { min, max };
}

/** 包围盒微微外扩，保证边界上的三角形质心也稳落在框内 */
function padBounds(bounds) {
  if (!bounds) return null;
  const min = [];
  const max = [];
  for (let i = 0; i < 3; i++) {
    const pad = Math.max((bounds.max[i] - bounds.min[i]) * 0.01, 0.002);
    min.push(bounds.min[i] - pad);
    max.push(bounds.max[i] + pad);
  }
  return { min, max };
}

let toastTimer = null;
function toast(message) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

/**
 * 部件相对整车的中文方位（预览坐标：车头 −X、左侧 +Z、上 +Y）。
 * 下载模型的节点名多是 Object_339 这类无意义英文，方位标签是用户认部件的主要线索。
 */
function positionLabel(bounds, whole) {
  if (!bounds || !whole) return '';
  const tags = [];
  const offsets = [0, 1, 2].map((i) => {
    const size = whole.max[i] - whole.min[i];
    if (size < 1e-6) return 0;
    return ((bounds.min[i] + bounds.max[i]) / 2 - (whole.min[i] + whole.max[i]) / 2) / size;
  });
  if (offsets[0] < -0.12) tags.push('前');
  else if (offsets[0] > 0.12) tags.push('后');
  if (offsets[2] > 0.12) tags.push('左');
  else if (offsets[2] < -0.12) tags.push('右');
  if (offsets[1] > 0.18) tags.push('上');
  else if (offsets[1] < -0.18) tags.push('下');
  return tags.join('·');
}

/* ---------- 撤销 ---------- */

const undoStack = [];
const redoStack = [];

function captureSnapshot() {
  return {
    bindings: [...bindings.entries()].map(([id, binding]) => [id, structuredClone(binding)]),
    deletions: structuredClone(deletions),
    rotation: ['x', 'y', 'z'].map((axis) => Number(ui[`rotation-${axis}`].value) || 0),
    targetLength: Number(ui['target-length'].value) || 5.2,
    heightOffset: Number(ui['height-offset'].value) || 0,
    transform: preview.getExportTransform(),
    openSlot,
  };
}

/** 在每个会改变配置的操作之前调用，把当前完整状态压栈（最多 30 步） */
function snapshot() {
  undoStack.push(captureSnapshot());
  if (undoStack.length > 30) undoStack.shift();
  redoStack.length = 0;
  ui.undo.disabled = false;
  ui.redo.disabled = true;
  setDirty();
  markDevicePreviewStale();
}

function restoreSnapshot(snap) {
  if (!snap) return;
  stopDemo();
  cancelDeleteDraft(true);
  bindings.clear();
  for (const [id, binding] of snap.bindings) bindings.set(id, binding);
  deletions = snap.deletions;
  ['x', 'y', 'z'].forEach((axis, i) => {
    ui[`rotation-${axis}`].value = snap.rotation[i];
    preview.rotation[axis] = snap.rotation[i];
  });
  ui['target-length'].value = snap.targetLength;
  preview.targetLength = snap.targetLength;
  ui['height-offset'].value = snap.heightOffset;
  preview.heightOffset = snap.heightOffset;
  // 直接还原快照时刻的模型矩阵——删除框/选区/旋转中心都是与它配套的世界坐标，
  // 不能经 normalize 重新推导（落地缩放会随删除后的几何变化而漂移）
  preview.setTransform(snap.transform);
  preview.setDeletions(deletions.map((item) => item.region));
  refreshParts();
  openSlot = snap.openSlot;
  regionMode = 'translate';
  closePreviewTools();
  renderDeletePanel();
  renderBindings();
  if (openSlot) {
    const slot = SLOT_BY_ID.get(openSlot);
    const binding = bindings.get(openSlot);
    if (binding?.region) openRegionBox(slot);
    else if (binding) playCurrentBinding();
  }
  setDirty();
  markDevicePreviewStale();
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  redoStack.push(captureSnapshot());
  restoreSnapshot(snap);
  ui.undo.disabled = undoStack.length === 0;
  ui.redo.disabled = false;
}

function redo() {
  const snap = redoStack.pop();
  if (!snap) return;
  undoStack.push(captureSnapshot());
  restoreSnapshot(snap);
  ui.undo.disabled = false;
  ui.redo.disabled = redoStack.length === 0;
}

ui.undo.addEventListener('click', undo);
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || !['z', 'y'].includes(event.key.toLowerCase())) return;
  // 输入框里保留浏览器自带的文本撤销
  if (event.target instanceof HTMLElement && event.target.matches('input, select, textarea')) return;
  event.preventDefault();
  if (event.key.toLowerCase() === 'y' || event.shiftKey) redo();
  else undo();
});

/* ---------- 删除多余部分 ---------- */

let deletions = [];
let deleteDraft = null;
let deleteMode = 'translate';

/** 开始框选一块要删除的区域（与联动编辑器互斥占用选区盒） */
function startDeleteDraft() {
  if (!current) return;
  stopDemo();
  openSlot = null;
  closePreviewTools();
  renderBindings();
  const bounds = preview.wholeBounds();
  if (!bounds) return;
  const height = bounds.max[1] - bounds.min[1];
  // 默认框住模型底部一段：底座/背景布这类要删的东西通常在最下面
  deleteDraft = {
    region: {
      min: [bounds.min[0], bounds.min[1], bounds.min[2]],
      max: [bounds.max[0], bounds.min[1] + height * 0.28, bounds.max[2]],
    },
    inside: 0,
  };
  deleteMode = 'translate';
  ui['workspace-mode'].textContent = '删除区域';
  preview.showRegionBox(deleteDraft.region, (region) => {
    if (!region || !deleteDraft) return;
    deleteDraft.region = region;
    const measured = preview.measureRegion(region);
    deleteDraft.inside = measured.inside;
    const label = document.getElementById('delete-count');
    if (label) {
      label.textContent = measured.inside === 0
        ? '框内没有面片，拖动选框套住要删除的部分'
        : `框内 ${measured.inside.toLocaleString()} 面将被删除（剩 ${(measured.total - measured.inside).toLocaleString()} 面）`;
      label.style.color = measured.inside === 0 ? '#c0392b' : '';
    }
    const confirm = document.getElementById('delete-confirm');
    if (confirm) confirm.disabled = measured.inside === 0;
  });
  renderDeletePanel();
}

function confirmDelete() {
  if (!deleteDraft || deleteDraft.inside === 0) return;
  snapshot();
  deletions.push({ region: deleteDraft.region, faces: deleteDraft.inside });
  deleteDraft = null;
  preview.hideRegionBox();
  applyDeletionsAndRenormalize();
  renderDeletePanel();
  renderBindings();
  ui['workspace-mode'].textContent = '浏览模式';
}

function cancelDeleteDraft(keepBox) {
  if (!deleteDraft) return;
  deleteDraft = null;
  if (!keepBox) preview.hideRegionBox();
  renderDeletePanel();
  ui['workspace-mode'].textContent = openSlot ? '联动预览' : '浏览模式';
}

function restoreDeletion(index) {
  snapshot();
  deletions.splice(index, 1);
  applyDeletionsAndRenormalize();
  renderDeletePanel();
  renderBindings();
}

/**
 * 应用删除并让模型按剩余几何重新落地、缩放（删掉底座后车应贴地而不是悬空）。
 * 落地会改变模型的世界矩阵，而删除框、联动选区与旋转中心都存世界坐标，
 * 必须按新旧变换（旋转不变时是纯缩放+平移）迁移，否则会与模型错位。
 */
function applyDeletionsAndRenormalize() {
  const before = preview.getExportTransform();
  preview.setDeletions(deletions.map((item) => item.region));
  preview.normalize();
  migrateWorldData(before, preview.getExportTransform());
  refreshParts();
}

/** 按新旧变换（旋转不变：纯均匀缩放+平移）把所有世界坐标数据无损迁移 */
function migrateWorldData(before, after) {
  const k = before.scale[0] ? after.scale[0] / before.scale[0] : 1;
  const map = (p) => [
    after.translation[0] + k * (p[0] - before.translation[0]),
    after.translation[1] + k * (p[1] - before.translation[1]),
    after.translation[2] + k * (p[2] - before.translation[2]),
  ];
  const mapBounds = (bounds) => ({ min: map(bounds.min), max: map(bounds.max) });
  for (const item of deletions) item.region = mapBounds(item.region);
  for (const binding of bindings.values()) {
    if (binding.region) binding.region = mapBounds(binding.region);
    if (binding.bounds) binding.bounds = mapBounds(binding.bounds);
    if (binding.geomBounds) binding.geomBounds = mapBounds(binding.geomBounds);
    if (Array.isArray(binding.pivot)) binding.pivot = map(binding.pivot);
  }
}

/** 尺寸/离地高度这类不改旋转的调整：应用后迁移世界数据并刷新打开中的编辑器 */
function renormalizeAndMigrate(apply) {
  if (!current || !preview.model) {
    apply();
    return;
  }
  const before = preview.getExportTransform();
  apply();
  migrateWorldData(before, preview.getExportTransform());
  refreshOpenEditor();
}

/** 世界坐标变化后重建部件列表，并把打开中的选区盒/旋转中心挪到新位置 */
function refreshOpenEditor() {
  refreshParts();
  renderBindings();
  if (!openSlot) return;
  const slot = SLOT_BY_ID.get(openSlot);
  const binding = bindings.get(openSlot);
  if (binding?.region) openRegionBox(slot);
  else if (binding?.selection) startFineSelection(slot, { preserveState: true });
  else if (binding) playCurrentBinding();
}

function renderDeletePanel() {
  ui['delete-start'].disabled = !current || Boolean(deleteDraft);
  ui['delete-summary'].textContent = deletions.length
    ? `已删除 ${deletions.reduce((sum, item) => sum + item.faces, 0).toLocaleString()} 面`
    : '未删除';
  const rows = [];
  if (deleteDraft) {
    rows.push(`
      <div class="quick-row" style="margin-top:10px">
        <button class="btn small${deleteMode === 'translate' ? ' primary' : ''}" data-delete-mode="translate">移动框</button>
        <button class="btn small${deleteMode === 'scale' ? ' primary' : ''}" data-delete-mode="scale">缩放框</button>
      </div>
      <p class="hint" id="delete-count" style="margin:8px 0 0">正在统计…</p>
      <div class="quick-row">
        <button class="btn small danger" id="delete-confirm">删除这些面</button>
        <button class="btn small" id="delete-cancel">取消</button>
      </div>`);
  }
  deletions.forEach((item, index) => {
    rows.push(`
      <div class="delete-item">
        <span>区域 ${index + 1}：已删 ${item.faces.toLocaleString()} 面</span>
        <button class="btn small" data-restore="${index}">恢复</button>
      </div>`);
  });
  ui['delete-panel'].innerHTML = rows.join('');
  ui['delete-panel'].querySelectorAll('[data-delete-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      deleteMode = button.dataset.deleteMode;
      preview.setRegionMode(deleteMode);
      renderDeletePanel();
    });
  });
  document.getElementById('delete-confirm')?.addEventListener('click', confirmDelete);
  document.getElementById('delete-cancel')?.addEventListener('click', () => cancelDeleteDraft(false));
  ui['delete-panel'].querySelectorAll('[data-restore]').forEach((button) => {
    button.addEventListener('click', () => restoreDeletion(Number(button.dataset.restore)));
  });
  // 面板重绘后把统计与确认按钮状态补上
  if (deleteDraft) {
    const measured = preview.measureRegion(deleteDraft.region);
    deleteDraft.inside = measured.inside;
    const label = document.getElementById('delete-count');
    if (label && measured.total) {
      label.textContent = measured.inside === 0
        ? '框内没有面片，拖动选框套住要删除的部分'
        : `框内 ${measured.inside.toLocaleString()} 面将被删除（剩 ${(measured.total - measured.inside).toLocaleString()} 面）`;
      label.style.color = measured.inside === 0 ? '#c0392b' : '';
    }
    const confirm = document.getElementById('delete-confirm');
    if (confirm) confirm.disabled = measured.inside === 0;
  }
}

ui['delete-start'].addEventListener('click', startDeleteDraft);

// 开发调试钩子：控制台/自动化测试用，读取当前配置状态
window.__carmodelDebug = {
  get state() {
    return {
      deletions: structuredClone(deletions),
      bindings: [...bindings.entries()].map(([id, binding]) => [id, structuredClone(binding)]),
      transform: preview.getExportTransform(),
    };
  },
  preview,
};

/** 左右对称槽位：配好一侧后另一侧可一键镜像（车机坐标 +Z 左 / −Z 右） */
const MIRROR_PAIRS = {
  CS_LF: 'CS_RF', CS_RF: 'CS_LF',
  CS_LB: 'CS_RB', CS_RB: 'CS_LB',
  CS_LDirection: 'CS_RDirection', CS_RDirection: 'CS_LDirection',
};

/** 左右独立槽位必须限制在各自半车；车机坐标 +Z 左 / -Z 右。 */
const LATERAL_SLOT_SIDE = {
  CS_LDirection: 'left',
  CS_RDirection: 'right',
  CS_LF: 'left',
  CS_RF: 'right',
  CS_LB: 'left',
  CS_RB: 'right',
};

function constrainRegionToSlotSide(slot, region) {
  if (!region) return null;
  const side = LATERAL_SLOT_SIDE[slot?.id];
  if (!side) return structuredClone(region);
  const constrained = structuredClone(region);
  const whole = preview.wholeBounds();
  const centerZ = whole ? (whole.min[2] + whole.max[2]) / 2 : 0;
  if (side === 'left') constrained.min[2] = Math.max(constrained.min[2], centerZ);
  else constrained.max[2] = Math.min(constrained.max[2], centerZ);
  // 极端情况下点中的部件完全在错误半边，不能制造反向 min/max。
  if (constrained.min[2] >= constrained.max[2]) return structuredClone(region);
  return constrained;
}

/** 预览与生成共用相同的左右半车裁剪，也兼容修改前保存在内存里的跨中线选区。 */
function bindingsForOutput() {
  return [...bindings.values()].filter((binding) => {
    if (!binding.selection) return true;
    return selectionTriangleCount(binding.selection) > 0;
  }).map((binding) => {
    const copy = structuredClone(binding);
    if (!copy.region) return copy;
    const slot = SLOT_BY_ID.get(copy.slotId);
    copy.region = constrainRegionToSlotSide(slot, copy.region);
    copy.bounds = copy.region;
    return copy;
  });
}

function resetBindings() {
  stopDemo();
  stopFineSelection();
  bindings.clear();
  openSlot = null;
  closePreviewTools();
  renderBindings();
}

/** 把对侧的配置沿车身中线镜像到当前槽位（框选镜像选区；选部件则自动找对称部件） */
function mirrorBindingInto(slot) {
  const sourceId = MIRROR_PAIRS[slot.id];
  const source = bindings.get(sourceId);
  if (!source) return;

  // 精细三角面编号属于源 primitive，左右模型通常不是同一个 primitive，
  // 不能把 selection 静默降级成整部件镜像，否则会扩大绑定范围。
  if (source.selection) {
    toast('精细选面暂不支持一键镜像，请在当前模型上手动补选对应区域。');
    return;
  }

  if (!source.region) {
    mirrorNodeBindingInto(slot, source);
    return;
  }
  snapshot();
  const region = {
    min: [source.region.min[0], source.region.min[1], -source.region.max[2]],
    max: [source.region.max[0], source.region.max[1], -source.region.min[2]],
  };
  const axis = source.axis || slot.axis;
  // 镜像会反转旋转手性：绕 X/Y 轴的角度取反；绕 Z 轴（轴向自身被镜像）保持原值
  const angle = Number.isFinite(source.angle)
    ? (axis === 'z' ? source.angle : -source.angle)
    : slot.angle;
  const measured = preview.measureRegion(region);
  bindings.set(slot.id, {
    slotId: slot.id,
    whole: false,
    region,
    nodeIndices: parts.map((item) => item.nodeIndex),
    sourceName: '框选区域（镜像）',
    bounds: region,
    geomBounds: measured.bounds,
    pivot: source.pivotCustom
      ? [source.pivot[0], source.pivot[1], -source.pivot[2]]
      : defaultParams(slot, measured.bounds || region).pivot,
    pivotCustom: Boolean(source.pivotCustom),
    axis,
    angle,
    duration: source.duration ?? 0.8,
    reverse: Boolean(source.reverse),
    color: source.color || slot.color,
  });
  regionMode = 'translate';
  renderBindings();
  openRegionBox(slot);
}

/**
 * 选部件绑定的镜像：把对侧每块部件的包围盒沿 z=0 翻过来，
 * 在未占用的部件里找中心最近、尺寸相当的那块（Door_FL ↔ Door_FR 这类对称结构一找一个准）。
 */
function mirrorNodeBindingInto(slot, source) {
  const claimed = claimedByOthers(slot);
  const sourceSet = new Set(source.nodeIndices || []);
  const candidates = parts.filter((part) => !claimed.has(part.nodeIndex) && !sourceSet.has(part.nodeIndex));
  const matched = new Set();
  for (const index of source.nodeIndices || []) {
    const part = parts.find((item) => item.nodeIndex === index);
    if (!part) continue;
    const mirrored = {
      min: [part.bounds.min[0], part.bounds.min[1], -part.bounds.max[2]],
      max: [part.bounds.max[0], part.bounds.max[1], -part.bounds.min[2]],
    };
    const center = [0, 1, 2].map((i) => (mirrored.min[i] + mirrored.max[i]) / 2);
    const size = [0, 1, 2].map((i) => mirrored.max[i] - mirrored.min[i]);
    const diag = Math.hypot(size[0], size[1], size[2]) || 1;
    let best = null;
    let bestScore = Infinity;
    for (const candidate of candidates) {
      if (matched.has(candidate.nodeIndex)) continue;
      const cCenter = [0, 1, 2].map((i) => (candidate.bounds.min[i] + candidate.bounds.max[i]) / 2);
      const cSize = [0, 1, 2].map((i) => candidate.bounds.max[i] - candidate.bounds.min[i]);
      const distance = Math.hypot(...center.map((v, i) => v - cCenter[i]));
      const sizeDiff = Math.hypot(...size.map((v, i) => v - cSize[i]));
      if (distance > diag * 0.5 || sizeDiff > diag * 0.35) continue;
      const score = distance + sizeDiff;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best) matched.add(best.nodeIndex);
  }
  if (matched.size === 0) {
    ui['binding-summary'].textContent = '没找到对称的部件，请手动勾选';
    return;
  }
  const axis = source.axis || slot.axis;
  const angle = Number.isFinite(source.angle)
    ? (axis === 'z' ? source.angle : -source.angle)
    : slot.angle;
  setBindingNodes(slot, [...matched]);
  const binding = bindings.get(slot.id);
  if (!binding) return;
  binding.axis = axis;
  binding.angle = angle;
  binding.duration = source.duration ?? 0.8;
  binding.reverse = Boolean(source.reverse);
  binding.color = source.color || slot.color;
  if (source.pivotCustom) {
    binding.pivot = [source.pivot[0], source.pivot[1], -source.pivot[2]];
    binding.pivotCustom = true;
  }
  renderBindings();
  playCurrentBinding();
}

/** 依次播放全部已配置的联动，整体检查一遍 */
async function demoAll() {
  if (demoRun) {
    stopDemo();
    return;
  }
  if (!current || bindings.size === 0) return;
  const run = { cancelled: false };
  demoRun = run;
  openSlot = null;
  closePreviewTools();
  renderBindings();
  setDemoButton(true);
  for (const [slotId, binding] of [...bindings]) {
    if (run.cancelled) break;
    const slot = SLOT_BY_ID.get(slotId);
    if (!slot) continue;
    ui['binding-summary'].textContent = `演示中：${slot.label}`;
    preview.previewBinding(slot, binding);
    // 开合/转动播完两个来回（或两圈），灯光亮足看清的时长
    const seconds = Math.max(1.6, (binding.duration ?? 0.8) * 2);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
  // 被 stopDemo 取消时收尾已由 stopDemo 完成，这里不能再停掉用户刚开的新预览
  if (!run.cancelled) {
    preview.stopBindingPreview();
    demoRun = null;
    setDemoButton(false);
    ui['binding-summary'].textContent = bindings.size ? `已配置 ${bindings.size} 项` : '未配置';
  }
}

function stopDemo() {
  if (!demoRun) return;
  demoRun.cancelled = true;
  demoRun = null;
  preview.stopBindingPreview();
  setDemoButton(false);
  ui['binding-summary'].textContent = bindings.size ? `已配置 ${bindings.size} 项` : '未配置';
}

/** 被其他槽位（非框选）占用的叶子 → 槽位名，占用的部位不能重复绑定 */
function claimedByOthers(slot) {
  const claimed = new Map();
  for (const [id, other] of bindings) {
    if (id === slot.id || other.region) continue;
    const label = SLOT_BY_ID.get(id)?.label || id;
    for (const nodeIndex of other.nodeIndices || []) claimed.set(nodeIndex, label);
  }
  return claimed;
}

function sourceNameOf(chosen, whole) {
  if (whole) return '整个模型';
  if (chosen.length === 1) return chosen[0].name;
  const set = new Set(chosen.map((item) => item.nodeIndex));
  const touched = partGroups.filter((group) => group.leaves.some((leaf) => set.has(leaf.nodeIndex)));
  if (touched.length === 1 && touched[0].leaves.every((leaf) => set.has(leaf.nodeIndex))) {
    return `${touched[0].name}（整组 ${chosen.length} 块）`;
  }
  return `${touched[0]?.name || chosen[0].name} 等 ${chosen.length} 块`;
}

/** 树勾选变化的唯一入口：为空删除绑定，否则重建绑定并保留已调好的参数 */
function setBindingNodes(slot, nodeIndices, { revealNodeIndex = null } = {}) {
  if (Number.isInteger(revealNodeIndex)) {
    pendingPartTreeReveal = { slotId: slot.id, nodeIndex: revealNodeIndex };
  }
  snapshot();
  const chosen = parts.filter((part) => nodeIndices.includes(part.nodeIndex));
  if (chosen.length === 0) {
    bindings.delete(slot.id);
    preview.stopBindingPreview();
    preview.clearHighlight();
    preview.hidePivotMarker();
    renderBindings();
    return;
  }
  const previous = bindings.get(slot.id);
  const bounds = mergeBounds(chosen.map((item) => item.bounds));
  const defaults = defaultParams(slot, bounds);
  preview.hideRegionBox();
  const whole = chosen.length === parts.length;
  bindings.set(slot.id, {
    slotId: slot.id,
    whole,
    nodeIndices: chosen.map((item) => item.nodeIndex),
    sourceName: sourceNameOf(chosen, whole),
    bounds,
    pivot: previous?.pivotCustom ? previous.pivot : defaults.pivot,
    pivotCustom: Boolean(previous?.pivotCustom),
    axis: previous?.axis || defaults.axis,
    angle: previous?.angle ?? defaults.angle,
    duration: previous?.duration ?? 0.8,
    reverse: Boolean(previous?.reverse),
    color: previous?.color || defaults.color,
  });
  renderBindings();
  playCurrentBinding();
}

function partTreeHtml(slot, binding) {
  const selected = new Set(binding && !binding.region ? binding.nodeIndices : []);
  const claimed = claimedByOthers(slot);
  const query = treeQuery.trim().toLowerCase();
  const rows = [];
  for (const group of partGroups) {
    const groupHit = !query || group.name.toLowerCase().includes(query);
    const leaves = groupHit
      ? group.leaves
      : group.leaves.filter((leaf) => leaf.name.toLowerCase().includes(query));
    if (leaves.length === 0) continue;
    const free = group.leaves.filter((leaf) => !claimed.has(leaf.nodeIndex));
    const pickedCount = free.filter((leaf) => selected.has(leaf.nodeIndex)).length;
    const allPicked = free.length > 0 && pickedCount === free.length;
    const somePicked = pickedCount > 0 && !allPicked;
    const expanded = expandedGroups.has(group.key) || (query && !groupHit);
    const single = group.leaves.length === 1;
    rows.push(`
      <div class="pt-group">
        <div class="pt-row${allPicked || (single && pickedCount) ? ' picked' : ''}" data-group-row="${group.key}"${single ? ` data-node-index="${group.leaves[0].nodeIndex}"` : ''} data-hover="${group.leaves.map((l) => l.nodeIndex).join(',')}">
          <input type="checkbox" data-group="${group.key}"${allPicked ? ' checked' : ''}${somePicked ? ' data-mixed="1"' : ''}${free.length === 0 ? ' disabled' : ''} aria-label="选择 ${escapeHtml(group.name)}" />
          ${single ? '<span class="pt-toggle"></span>'
            : `<button type="button" class="pt-toggle" data-toggle="${group.key}" aria-label="展开">${expanded ? '▾' : '▸'}</button>`}
          <span class="pt-name">${escapeHtml(group.name)}</span>
          ${group.place ? `<span class="pt-tag">${group.place}</span>` : ''}
          <span class="pt-meta">${single ? '' : `${group.leaves.length} 块 · `}${group.triangles.toLocaleString()} 面</span>
        </div>
        ${expanded && !single ? `<div class="pt-leaves">${leaves.map((leaf) => {
          const usedBy = claimed.get(leaf.nodeIndex);
          return `
          <div class="pt-row leaf${selected.has(leaf.nodeIndex) ? ' picked' : ''}" data-node-index="${leaf.nodeIndex}" data-hover="${leaf.nodeIndex}">
            <input type="checkbox" data-leaf="${leaf.nodeIndex}"${selected.has(leaf.nodeIndex) ? ' checked' : ''}${usedBy ? ' disabled' : ''} aria-label="选择 ${escapeHtml(leaf.name)}" />
            <span class="pt-name">${escapeHtml(leaf.name)}</span>
            ${leaf.place ? `<span class="pt-tag">${leaf.place}</span>` : ''}
            <span class="pt-meta">${usedBy ? `已用于${usedBy}` : `${leaf.triangles.toLocaleString()} 面`}</span>
          </div>`;
        }).join('')}</div>` : ''}
      </div>`);
  }
  const total = selected.size;
  return `
    <div class="part-tree" data-slot-id="${slot.id}">${rows.join('') || '<p class="hint" style="margin:8px">没有匹配的部件</p>'}</div>
    <div class="pt-foot">
      <span>已选 ${total ? `${total} 块` : '0 块（勾选或点模型）'}</span>
      ${total ? `<button type="button" class="btn small" id="part-clear">清空</button>` : ''}
    </div>`;
}

function capturePartTreeScroll() {
  const tree = document.querySelector('.part-tree[data-slot-id]');
  if (!tree?.dataset.slotId) return;
  partTreeScrollBySlot.set(tree.dataset.slotId, tree.scrollTop);
}

function restorePartTreeScroll(slot) {
  const tree = document.querySelector(`.part-tree[data-slot-id="${slot.id}"]`);
  if (!tree) return;
  const reveal = pendingPartTreeReveal?.slotId === slot.id ? pendingPartTreeReveal : null;
  if (!reveal) {
    tree.scrollTop = partTreeScrollBySlot.get(slot.id) || 0;
    return;
  }

  pendingPartTreeReveal = null;
  const row = tree.querySelector(`[data-node-index="${reveal.nodeIndex}"]`);
  if (!row) return;
  const targetTop = row.offsetTop - (tree.clientHeight - row.offsetHeight) / 2;
  tree.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  partTreeScrollBySlot.set(slot.id, Math.max(0, targetTop));
}

function renderPartTree({ resetScroll = false } = {}) {
  if (!openSlot) return;
  const wrap = document.getElementById('part-tree-wrap');
  if (!wrap) return;
  const slot = SLOT_BY_ID.get(openSlot);
  capturePartTreeScroll();
  if (resetScroll) partTreeScrollBySlot.set(slot.id, 0);
  wrap.innerHTML = partTreeHtml(slot, bindings.get(openSlot));
  wirePartTree(slot);
  restorePartTreeScroll(slot);
}

function wirePartTree(slot) {
  const wrap = document.getElementById('part-tree-wrap');
  if (!wrap) return;
  const binding = bindings.get(slot.id);
  const selected = new Set(binding && !binding.region ? binding.nodeIndices : []);
  wrap.querySelectorAll('[data-mixed]').forEach((input) => { input.indeterminate = true; });
  wrap.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const key = button.dataset.toggle;
      if (expandedGroups.has(key)) expandedGroups.delete(key);
      else expandedGroups.add(key);
      renderPartTree();
    });
  });
  wrap.querySelectorAll('input[data-group]').forEach((input) => {
    input.addEventListener('change', () => {
      const group = partGroups.find((item) => item.key === input.dataset.group);
      if (!group) return;
      const claimed = claimedByOthers(slot);
      const free = group.leaves.filter((leaf) => !claimed.has(leaf.nodeIndex));
      const next = new Set(selected);
      for (const leaf of free) {
        if (input.checked) next.add(leaf.nodeIndex);
        else next.delete(leaf.nodeIndex);
      }
      setBindingNodes(slot, [...next]);
    });
  });
  wrap.querySelectorAll('input[data-leaf]').forEach((input) => {
    input.addEventListener('change', () => {
      const index = Number(input.dataset.leaf);
      const next = new Set(selected);
      if (input.checked) next.add(index);
      else next.delete(index);
      setBindingNodes(slot, [...next]);
    });
  });
  // 悬停整行 → 在 3D 视图里用蓝框标出该部件
  wrap.querySelectorAll('[data-hover]').forEach((row) => {
    row.addEventListener('mouseenter', () => {
      preview.highlightPart(row.dataset.hover.split(',').map(Number));
    });
    row.addEventListener('mouseleave', () => {
      if (selected.size) preview.highlightPart([...selected]);
      else preview.clearHighlight();
    });
  });
  document.getElementById('part-clear')?.addEventListener('click', () => setBindingNodes(slot, []));
}

/** 点选模式：点击 3D 模型直接选中所在的整组部件，再点一次取消 */
function togglePickMode(slot) {
  const enable = pickingFor !== slot.id;
  pickingFor = enable ? slot.id : null;
  preview.setPickMode(enable, enable ? (nodeIndex) => onPickNode(slot, nodeIndex) : null);
  const button = document.getElementById('part-pick');
  if (button) {
    button.classList.toggle('primary', enable);
    button.textContent = enable ? '点选中，点模型试试' : '在模型上点选';
  }
}

function onPickNode(slot, nodeIndex) {
  const binding = bindings.get(slot.id);
  if (binding?.region) return;
  const claimed = claimedByOthers(slot);
  const group = partGroups.find((item) => item.leaves.some((leaf) => leaf.nodeIndex === nodeIndex));
  const all = group ? group.leaves : parts.filter((part) => part.nodeIndex === nodeIndex);
  const leaves = all.filter((leaf) => !claimed.has(leaf.nodeIndex));
  if (leaves.length === 0) {
    // 整组都被别的槽位占走（比如整盏灯已绑刹车）：自动转框选，从对方几何上切一块出来
    if (all.length === 0) return;
    const owner = claimed.get(nodeIndex) || claimed.get(all[0].nodeIndex) || '其他联动';
    const region = constrainRegionToSlotSide(slot, padBounds(mergeBounds(all.map((leaf) => leaf.bounds))));
    if (!region) return;
    createRegionBinding(slot, region);
    const sideText = LATERAL_SLOT_SIDE[slot.id] ? `并限制在车身${LATERAL_SLOT_SIDE[slot.id] === 'left' ? '左' : '右'}半边` : '';
    toast(`「${group?.name || all[0].name}」已整体绑给「${owner}」。已自动切换为框选${sideText}，请确认蓝框只套住本槽位区域。`);
    return;
  }
  const selected = new Set(binding && !binding.region ? binding.nodeIndices : []);
  const allIn = leaves.every((leaf) => selected.has(leaf.nodeIndex));
  for (const leaf of leaves) {
    if (allIn) selected.delete(leaf.nodeIndex);
    else selected.add(leaf.nodeIndex);
  }
  if (group && group.leaves.length > 1) expandedGroups.add(group.key);
  setBindingNodes(slot, [...selected], { revealNodeIndex: nodeIndex });
}

function bindingEditor(slot) {
  const binding = bindings.get(slot.id);
  const isSelection = Boolean(binding?.selection) || selectionEditingSlot === slot.id;
  const isRegion = Boolean(binding?.region);
  const rows = [`
    <div class="source-tabs" role="tablist" aria-label="绑定来源">
      <button type="button" class="btn small${!isSelection && !isRegion ? ' primary' : ''}" data-source-tab="parts">整部件</button>
      <button type="button" class="btn small${isSelection ? ' primary' : ''}" data-source-tab="selection">精细选面</button>
      <button type="button" class="btn small${isRegion ? ' primary' : ''}" data-source-tab="region">旧框选</button>
    </div>`];

  // 对侧已配置时提供一键镜像（框选与选部件两种来源都支持）
  const mirrorFromId = MIRROR_PAIRS[slot.id];
  const mirrorFrom = mirrorFromId ? bindings.get(mirrorFromId) : null;
  if (mirrorFrom) {
    const mirrorSelectionDisabled = Boolean(mirrorFrom.selection);
    rows.push(`
      <div class="quick-row" style="margin-top:0">
        <button type="button" class="btn small" id="bind-mirror"${mirrorSelectionDisabled ? ' disabled title="精细选面暂不支持自动镜像，请在模型上手动补选"' : ''}><i data-lucide="arrow-left-right"></i>${mirrorSelectionDisabled ? '精细选面请手动补选' : `从「${SLOT_BY_ID.get(mirrorFromId).label}」镜像过来`}</button>
      </div>`);
  }

  if (!isSelection && !isRegion) {
    rows.push(`
      <div class="part-tools">
        <input type="search" id="part-search" placeholder="搜索部件名…" value="${escapeHtml(treeQuery)}" />
        <button type="button" class="btn small${pickingFor === slot.id ? ' primary' : ''}" id="part-pick">${
          pickingFor === slot.id ? '点选中，点模型试试' : '在模型上点选'}</button>
      </div>
      <div id="part-tree-wrap">${partTreeHtml(slot, binding)}</div>`);
    if (!binding) {
      rows.push(`<p class="hint" style="margin:8px 0 0">车门这类多块的部件直接勾整组（内饰会跟着动）；也可以点“在模型上点选”后直接点击 3D 模型。点到已被其他联动占用的部件（比如同一盏灯）会自动转为框选，从它上面切一块出来。</p>`);
      return `<div class="binding-editor">${rows.join('')}</div>`;
    }
  }

  if (isSelection) {
    const selection = binding?.selection || emptySelection();
    const stats = preview.selectionStats(selection);
    const editing = selectionEditingSlot === slot.id;
    if (!editing) {
      rows.push(`
      <div class="selection-workbench">
        <div class="tool-heading"><strong>精细选面</strong><span>已保存选区</span></div>
        <div class="selection-summary">${stats.triangles.toLocaleString()} 面 · ${stats.groups} 个网格区域</div>
        <div class="quick-row selection-actions">
          <button type="button" class="btn small primary" id="selection-edit"><i data-lucide="paintbrush"></i>继续编辑选区</button>
        </div>
      </div>`);
    } else rows.push(`
      <div class="selection-workbench">
        <div class="tool-heading"><strong>精细选面</strong><span>${editing ? '点击模型添加区域' : '已保存选区'}</span></div>
        <div class="segmented selection-mode" role="tablist" aria-label="精细选择工具">
          <button type="button" class="${previewSelectionMode === 'smart' ? 'active' : ''}" data-selection-mode="smart"><i data-lucide="sparkles"></i>智能点选</button>
          <button type="button" class="${previewSelectionMode === 'brush' ? 'active' : ''}" data-selection-mode="brush"><i data-lucide="paintbrush"></i>画笔</button>
        </div>
        <div class="segmented selection-operation" role="tablist" aria-label="选区操作">
          <button type="button" class="${previewSelectionOperation === 'add' ? 'active' : ''}" data-selection-operation="add">添加</button>
          <button type="button" class="${previewSelectionOperation === 'subtract' ? 'active' : ''}" data-selection-operation="subtract">减去</button>
        </div>
        <label class="check-row"><input type="checkbox" id="selection-visible-only"${previewSelectionVisibleOnly ? ' checked' : ''} />仅可见面（避免穿透车身）</label>
        <div class="range-fields">
          <label class="range-field">画笔半径 <output id="selection-radius-output">${previewSelectionRadius}px</output><input id="selection-radius" type="range" min="8" max="90" step="1" value="${previewSelectionRadius}" /></label>
          <label class="range-field">智能扩展角度 <output id="selection-angle-output">${previewSelectionAngle}°</output><input id="selection-angle" type="range" min="5" max="80" step="1" value="${previewSelectionAngle}" /></label>
        </div>
        <div class="selection-summary" id="selection-summary">${stats.triangles.toLocaleString()} 面 · ${stats.groups} 个网格区域${stats.triangles ? '' : ' · 请在模型上选择'}</div>
        <div class="quick-row selection-actions">
          <button type="button" class="btn small" id="selection-undo"${selectionHistory.length ? '' : ' disabled'}>撤销选区</button>
          <button type="button" class="btn small" id="selection-clear"${stats.triangles ? '' : ' disabled'}>清空选区</button>
          <button type="button" class="btn small primary" id="selection-done">完成选择</button>
        </div>
        <p class="hint">智能点选会沿共享边扩展到相邻曲面；画笔可以旋转模型后继续补选另一侧。选中左右两个轮子时，它们会加入同一个槽位。</p>
      </div>`);
  }

  if (binding.region) {
    const pivotButton = (slot.kind === 'hinge' || slot.kind === 'spin')
      ? `<button class="btn small${regionMode === 'pivot' ? ' primary' : ''}" data-region-mode="pivot">拖中心点</button>`
      : '';
    rows.push(`
      <div class="quick-row" style="margin-top:0">
        <button class="btn small${regionMode === 'translate' ? ' primary' : ''}" data-region-mode="translate">移动框</button>
        <button class="btn small${regionMode === 'scale' ? ' primary' : ''}" data-region-mode="scale">缩放框</button>
        ${pivotButton}
      </div>
      <p class="hint" id="region-count" style="margin:8px 0 0">正在统计…</p>`);
  }

  if (slot.kind === 'hinge' || slot.kind === 'spin') {
    const pivot = binding?.pivot || [0, 0, 0];
    rows.push(`
      <div class="field-grid">
        ${bindNumber('旋转中心 X', 'bind-pivot-x', pivot[0])}
        ${bindNumber('旋转中心 Y', 'bind-pivot-y', pivot[1])}
        ${bindNumber('旋转中心 Z', 'bind-pivot-z', pivot[2])}
      </div>
      <div class="quick-row">
        ${binding?.selection && slot.kind === 'spin' ? '<button class="btn small" id="pivot-refit">重新自动拟合</button>' : ''}
        <button class="btn small" data-pivot="center">取中心</button>
        <button class="btn small" data-pivot="front">取车头侧</button>
        <button class="btn small" data-pivot="rear">取车尾侧</button>
      </div>
      <p class="hint" style="margin:6px 0 9px">预览里的橙色小球就是旋转中心，虚线是旋转轴，${
        binding?.region ? '切到上方“拖中心点”后可直接拖动小球' : '可直接拖动小球调整'}。</p>`);
  }
  if (slot.kind === 'hinge') {
    const axis = binding?.axis || slot.axis;
    rows.push(`
      <div class="field-grid">
        <div class="field">
          <label for="bind-axis">旋转轴</label>
          <select id="bind-axis">
            <option value="x"${axis === 'x' ? ' selected' : ''}>X 纵向</option>
            <option value="y"${axis === 'y' ? ' selected' : ''}>Y 竖直</option>
            <option value="z"${axis === 'z' ? ' selected' : ''}>Z 横向</option>
          </select>
        </div>
        ${bindNumber('开启角度°', 'bind-angle', binding?.angle ?? slot.angle)}
        ${bindNumber('开合用时 秒', 'bind-duration', binding?.duration ?? 0.8, 0.1)}
      </div>`);
  }
  if (slot.kind === 'spin') {
    const axis = binding?.axis || slot.axis;
    rows.push(`
      <div class="field">
        <label for="bind-axis">旋转轴</label>
        <select id="bind-axis">
          <option value="z"${axis === 'z' ? ' selected' : ''}>Z 横向（车轮向前滚动）</option>
          <option value="x"${axis === 'x' ? ' selected' : ''}>X 纵向（左右侧翻）</option>
          <option value="y"${axis === 'y' ? ' selected' : ''}>Y 竖直（水平打转）</option>
        </select>
      </div>
      ${bindNumber('转一圈用时（秒）', 'bind-duration', binding?.duration ?? 0.8, 0.1)}
      <label class="check-row"><input type="checkbox" id="bind-reverse"${binding?.reverse ? ' checked' : ''} />反向转动</label>
      <p class="hint" style="margin:0 0 9px">车机只有前、后两个车轮插槽，左右轮共用同一段动画同向转动。框选时把左右两个轮子一起框住，并把旋转中心放到轮轴上，轮子就会原地自转。</p>`);
  }
  if (slot.kind === 'lamp' || slot.kind === 'blink') {
    rows.push(`
      <div class="field">
        <label for="bind-color">点亮颜色</label>
        <input id="bind-color" type="color" value="${binding?.color || slot.color}" />
      </div>`);
  }
  rows.push(`
    <div class="quick-row">
      <button class="btn small" id="bind-remove">移除绑定</button>
    </div>`);
  return `<div class="binding-editor">${rows.join('')}</div>`;
}

function bindNumber(label, id, value, step = 0.05) {
  const shown = Math.round((Number(value) || 0) * 1000) / 1000;
  return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" step="${step}" value="${shown}" /></div>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderBindings() {
  capturePartTreeScroll();
  const ready = Boolean(current);
  const html = [];
  for (const [group, slots] of slotGroups()) {
    const ordered = [...slots].sort((a, b) => Number(bindings.has(b.id)) - Number(bindings.has(a.id)));
    const items = ordered.map((slot) => {
      const binding = bindings.get(slot.id);
      const open = openSlot === slot.id;
      const selectionCount = binding?.selection ? selectionTriangleCount(binding.selection) : 0;
      const state = !binding ? '未绑定' : binding.selection && selectionCount === 0 ? '需确认' : '已绑定';
      return `
        <div class="binding-item${binding ? ' bound' : ''}${open ? ' open' : ''}">
          <button class="binding-head" data-slot="${slot.id}"${ready ? '' : ' disabled'}>
            <span class="binding-name"><span class="slot-dot ${binding ? 'bound' : ''}"></span>${slot.label}</span>
            <span class="binding-state ${state === '需确认' ? 'needs-confirm' : ''}">${state}</span>
          </button>
        </div>`;
    }).join('');
    html.push(`<div class="binding-group"><h3>${group}</h3>${items}</div>`);
  }
  ui['binding-groups'].innerHTML = html.join('');
  ui['binding-summary'].textContent = bindings.size ? `已配置 ${bindings.size} 项` : '未配置';
  ui['demo-all'].disabled = !current || bindings.size === 0;
  ui['binding-back'].hidden = !openSlot;
  document.querySelector('.binding-inspector-title').classList.toggle('has-back', Boolean(openSlot));
  if (demoRun) setDemoButton(true);
  else setDemoButton(false);
  if (openSlot) {
    const slot = SLOT_BY_ID.get(openSlot);
    ui['binding-editor-title'].textContent = slot?.label || '联动编辑';
    ui['binding-editor-host'].innerHTML = slot ? bindingEditor(slot) : '';
  } else {
    ui['binding-editor-title'].textContent = '选择一个联动槽位';
    const picker = [...slotGroups()].flatMap(([, slots]) => slots).map((slot) => `
      <button class="btn small" data-mobile-slot="${slot.id}">${slot.label}${bindings.has(slot.id) ? ' · 已绑定' : ''}</button>`).join('');
    ui['binding-editor-host'].innerHTML = `<div class="inspector-placeholder"><i data-lucide="mouse-pointer-2"></i><span>从左侧选择灯光、车轮或开合槽位</span></div><div class="mobile-slot-picker">${picker}</div>`;
  }
  renderIcons();
  wireBindingEditor();
  if (openSlot) restorePartTreeScroll(SLOT_BY_ID.get(openSlot));
}

function closeBindingEditor() {
  if (!openSlot) return;
  stopDemo();
  stopFineSelection();
  openSlot = null;
  regionMode = 'translate';
  closePreviewTools();
  renderBindings();
  setActivePanel('binding');
}

function wireBindingEditor() {
  ui['binding-editor-host'].querySelectorAll('[data-mobile-slot]').forEach((button) => {
    button.addEventListener('click', () => toggleSlot(button.dataset.mobileSlot));
  });
  ui['binding-groups'].querySelectorAll('[data-slot]').forEach((button) => {
    button.addEventListener('click', () => toggleSlot(button.dataset.slot));
  });
  if (!openSlot) return;
  const slot = SLOT_BY_ID.get(openSlot);
  ui['binding-editor-host'].querySelectorAll('[data-source-tab]').forEach((button) => {
    button.addEventListener('click', () => setSourceTab(slot, button.dataset.sourceTab));
  });
  const search = document.getElementById('part-search');
  if (search) {
    search.addEventListener('input', () => {
      treeQuery = search.value;
      renderPartTree({ resetScroll: true });
    });
  }
  document.getElementById('part-pick')?.addEventListener('click', () => togglePickMode(slot));
  wirePartTree(slot);
  for (const id of ['bind-pivot-x', 'bind-pivot-y', 'bind-pivot-z', 'bind-angle', 'bind-axis', 'bind-color', 'bind-duration', 'bind-reverse']) {
    const input = document.getElementById(id);
    if (input) input.addEventListener('input', () => updateBindingFromInputs(slot));
  }
  const mirror = document.getElementById('bind-mirror');
  if (mirror) mirror.addEventListener('click', () => mirrorBindingInto(slot));
  document.getElementById('pivot-refit')?.addEventListener('click', () => refitSelectionPivot(slot));
  ui['binding-editor-host'].querySelectorAll('[data-pivot]').forEach((button) => {
    button.addEventListener('click', () => snapPivot(slot, button.dataset.pivot));
  });
  ui['binding-editor-host'].querySelectorAll('[data-region-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      regionMode = button.dataset.regionMode;
      renderBindings();
    });
  });
  const binding = bindings.get(slot.id);
  if (binding?.region) {
    updateRegionCount(binding);
    applyRegionMode(slot, binding);
  } else if (binding?.selection && selectionEditingSlot === slot.id) {
    startFineSelection(slot, { preserveState: true });
  } else if (binding) {
    syncPivotTools(slot, binding);
  }
  const remove = document.getElementById('bind-remove');
  if (remove) {
    remove.addEventListener('click', () => {
      snapshot();
      bindings.delete(slot.id);
      stopFineSelection();
      openSlot = null;
      closePreviewTools();
      renderBindings();
      setActivePanel('binding');
    });
  }
  wireFineSelection(slot);
}

function refitSelectionPivot(slot) {
  const binding = bindings.get(slot.id);
  if (!binding?.selection) return;
  const stats = preview.selectionStats(binding.selection);
  if (!stats.pivot) return;
  snapshot();
  binding.pivot = stats.pivot;
  binding.pivotCustom = false;
  renderBindings();
  if (selectionEditingSlot === slot.id) startFineSelection(slot, { preserveState: true });
  playCurrentBinding();
}

function setDemoButton(running) {
  ui['demo-all'].innerHTML = running
    ? '<i data-lucide="square"></i><span>停止演示</span>'
    : '<i data-lucide="play"></i><span>全部演示</span>';
  renderIcons();
}

function toggleSlot(slotId) {
  stopDemo();
  cancelDeleteDraft(false);
  const closing = openSlot === slotId;
  stopFineSelection();
  openSlot = closing ? null : slotId;
  regionMode = 'translate';
  closePreviewTools();
  renderBindings();
  if (closing) return;
  setActivePanel('binding');
  const slot = SLOT_BY_ID.get(slotId);
  const binding = bindings.get(slotId);
  // 框选绑定由 openRegionBox 的 onChange 负责播放，避免重复切分
  if (binding?.region) openRegionBox(slot);
  else playCurrentBinding();
}

/** 来源方式切换：整部件 / 精细选面 / 旧框选互斥。 */
function setSourceTab(slot, tab) {
  const previous = bindings.get(slot.id);
  const isRegion = Boolean(previous?.region);
  const isSelection = Boolean(previous?.selection);
  if (tab === 'selection') {
    if (isSelection) {
      startFineSelection(slot, { preserveState: true });
      renderBindings();
      return;
    }
    createSelectionBinding(slot, previous);
    return;
  }
  if (tab === 'region') {
    if (isRegion) return;
    const modelBounds = preview.wholeBounds();
    if (!modelBounds) return;
    createRegionBinding(slot, suggestRegion(slot, modelBounds));
    return;
  }
  if (!isRegion && !isSelection) return;
  snapshot();
  stopFineSelection();
  bindings.delete(slot.id);
  closePreviewTools();
  renderBindings();
}

function createSelectionBinding(slot, previous) {
  snapshot();
  let selection = previous?.selection;
  if (!selection && previous?.region) selection = preview.selectionFromRegion(previous.region);
  if (!selection) selection = emptySelection();
  const stats = preview.selectionStats(selection);
  const bounds = boundsFromPoints(stats.points) || previous?.geomBounds || previous?.bounds || preview.wholeBounds();
  if (!bounds) return;
  const defaults = defaultParams(slot, bounds);
  const next = {
    ...(previous ? structuredClone(previous) : {}),
    slotId: slot.id,
    whole: false,
    selection: structuredClone(selection),
    nodeIndices: [...new Set((selection.groups || []).map((group) => group.nodeIndex))],
    sourceName: stats.triangles ? `精细选面（${stats.triangles.toLocaleString()} 面）` : '精细选面（未完成）',
    bounds,
    geomBounds: bounds,
    pivot: previous?.pivotCustom ? previous.pivot : (slot.kind === 'spin' ? (stats.pivot || defaults.pivot) : defaults.pivot),
    pivotCustom: Boolean(previous?.pivotCustom),
    axis: previous?.axis || defaults.axis,
    angle: previous?.angle ?? defaults.angle,
    duration: previous?.duration ?? 0.8,
    reverse: Boolean(previous?.reverse),
    color: previous?.color || defaults.color,
  };
  delete next.region;
  bindings.set(slot.id, next);
  selectionEditingSlot = slot.id;
  selectionHistory = [];
  selectionLast = structuredClone(next.selection);
  renderBindings();
  startFineSelection(slot, { preserveState: true });
}

function updateSelectionBinding(slot, selection, stats) {
  const binding = bindings.get(slot.id);
  if (!binding) return;
  const nextSelection = structuredClone(selection || emptySelection());
  const previous = selectionLast || emptySelection();
  if (JSON.stringify(previous) !== JSON.stringify(nextSelection)) selectionHistory.push(structuredClone(previous));
  selectionLast = structuredClone(nextSelection);
  binding.selection = nextSelection;
  binding.nodeIndices = [...new Set((nextSelection.groups || []).map((group) => group.nodeIndex))];
  const bounds = boundsFromPoints(stats?.points) || binding.geomBounds || binding.bounds || preview.wholeBounds();
  if (bounds) {
    binding.bounds = bounds;
    binding.geomBounds = bounds;
  }
  if (slot.kind === 'spin' && !binding.pivotCustom && stats?.pivot) {
    binding.pivot = stats.pivot;
    syncPivotInputs(binding);
    syncPivotTools(slot, binding);
  }
  binding.sourceName = stats?.triangles ? `精细选面（${stats.triangles.toLocaleString()} 面）` : '精细选面（未完成）';
  markDevicePreviewStale();
  setDirty();
  updateWorkspaceSelection(stats);
  updateBindingRow(slot, binding);
  preview.previewBinding(slot, binding);
}

function updateBindingRow(slot, binding) {
  const button = ui['binding-groups'].querySelector(`[data-slot="${slot.id}"]`);
  if (!button) return;
  const state = binding?.selection && selectionTriangleCount(binding.selection) === 0 ? '需确认' : binding ? '已绑定' : '未绑定';
  const label = button.querySelector('.binding-state');
  if (label) {
    label.textContent = state;
    label.classList.toggle('needs-confirm', state === '需确认');
  }
  const dot = button.querySelector('.slot-dot');
  dot?.classList.toggle('bound', Boolean(binding && state !== '需确认'));
}

function updateWorkspaceSelection(stats = null) {
  const currentStats = stats || (openSlot && bindings.get(openSlot)?.selection
    ? preview.selectionStats(bindings.get(openSlot).selection) : null);
  const groups = currentStats?.groups || 0;
  const triangles = currentStats?.triangles || 0;
  ui['workspace-selection'].textContent = groups ? `${groups} 区域 · ${triangles.toLocaleString()} 面` : '0';
  if (currentStats?.triangles) ui['workspace-mode'].textContent = selectionEditingSlot ? '精细选面' : '联动预览';
}

function updateSelectionSummary(stats) {
  const label = document.getElementById('selection-summary');
  if (label) label.textContent = `${(stats?.triangles || 0).toLocaleString()} 面 · ${stats?.groups || 0} 个网格区域${stats?.triangles ? '' : ' · 请在模型上选择'}`;
  const clear = document.getElementById('selection-clear');
  if (clear) clear.disabled = !(stats?.triangles);
  const undoButton = document.getElementById('selection-undo');
  if (undoButton) undoButton.disabled = selectionHistory.length === 0;
  const binding = openSlot ? bindings.get(openSlot) : null;
  if (binding) updateBindingRow(SLOT_BY_ID.get(openSlot), binding);
}

function startFineSelection(slot, { preserveState = false } = {}) {
  const binding = bindings.get(slot?.id);
  if (!slot || !binding?.selection || preview.deviceMode) return;
  selectionEditingSlot = slot.id;
  if (!preserveState) {
    selectionHistory = [];
    selectionLast = structuredClone(binding.selection);
  }
  preview.setTriangleSelection(true, binding.selection, {
    mode: previewSelectionMode,
    operation: previewSelectionOperation,
    brushRadius: previewSelectionRadius,
    angle: previewSelectionAngle,
    visibleOnly: previewSelectionVisibleOnly,
    onChange: (selection, stats) => updateSelectionBinding(slot, selection, stats),
    onStatus: ({ state, stats }) => {
      ui['workspace-index'].textContent = state === 'building' ? '正在构建 BVH 索引…' : 'BVH 索引就绪';
      updateSelectionSummary(stats);
    },
  });
  ui['workspace-mode'].textContent = '精细选面';
  updateSelectionSummary(preview.selectionStats(binding.selection));
}

function stopFineSelection() {
  if (!selectionEditingSlot && !preview.selectionState) return;
  selectionEditingSlot = null;
  selectionHistory = [];
  selectionLast = emptySelection();
  preview.setTriangleSelection(false);
  ui['workspace-index'].textContent = '精细索引未启用';
  ui['workspace-mode'].textContent = openSlot ? '联动预览' : '浏览模式';
}

function wireFineSelection(slot) {
  if (!bindings.get(slot.id)?.selection) return;
  document.getElementById('selection-edit')?.addEventListener('click', () => {
    startFineSelection(slot);
    renderBindings();
  });
  ui['binding-editor-host'].querySelectorAll('[data-selection-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      previewSelectionMode = button.dataset.selectionMode;
      preview.setTriangleSelectionOptions({ mode: previewSelectionMode });
      ui['binding-editor-host'].querySelectorAll('[data-selection-mode]').forEach((item) => item.classList.toggle('active', item === button));
      startFineSelection(slot, { preserveState: true });
    });
  });
  ui['binding-editor-host'].querySelectorAll('[data-selection-operation]').forEach((button) => {
    button.addEventListener('click', () => {
      previewSelectionOperation = button.dataset.selectionOperation;
      preview.setTriangleSelectionOptions({ operation: previewSelectionOperation });
      ui['binding-editor-host'].querySelectorAll('[data-selection-operation]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  document.getElementById('selection-visible-only')?.addEventListener('change', (event) => {
    previewSelectionVisibleOnly = event.target.checked;
    preview.setTriangleSelectionOptions({ visibleOnly: previewSelectionVisibleOnly });
  });
  document.getElementById('selection-radius')?.addEventListener('input', (event) => {
    previewSelectionRadius = Number(event.target.value) || 28;
    document.getElementById('selection-radius-output').textContent = `${previewSelectionRadius}px`;
    preview.setTriangleSelectionOptions({ brushRadius: previewSelectionRadius });
  });
  document.getElementById('selection-angle')?.addEventListener('input', (event) => {
    previewSelectionAngle = Number(event.target.value) || 38;
    document.getElementById('selection-angle-output').textContent = `${previewSelectionAngle}°`;
    preview.setTriangleSelectionOptions({ angle: previewSelectionAngle });
  });
  document.getElementById('selection-undo')?.addEventListener('click', () => {
    const previous = selectionHistory.pop();
    if (!previous) return;
    const stats = preview.selectionStats(previous);
    selectionLast = structuredClone(previous);
    const binding = bindings.get(slot.id);
    if (binding) {
      binding.selection = structuredClone(previous);
      binding.nodeIndices = [...new Set((previous.groups || []).map((group) => group.nodeIndex))];
      binding.sourceName = stats.triangles ? `精细选面（${stats.triangles.toLocaleString()} 面）` : '精细选面（未完成）';
      if (slot.kind === 'spin' && !binding.pivotCustom && stats.pivot) binding.pivot = stats.pivot;
      preview.setTriangleSelection(true, previous, {
        mode: previewSelectionMode,
        operation: previewSelectionOperation,
        brushRadius: previewSelectionRadius,
        angle: previewSelectionAngle,
        visibleOnly: previewSelectionVisibleOnly,
        onChange: (selection, nextStats) => updateSelectionBinding(slot, selection, nextStats),
        onStatus: ({ state, stats: nextStats }) => {
          ui['workspace-index'].textContent = state === 'building' ? '正在构建 BVH 索引…' : 'BVH 索引就绪';
          updateSelectionSummary(nextStats);
        },
      });
      updateSelectionSummary(stats);
      updateWorkspaceSelection(stats);
      markDevicePreviewStale();
      setDirty();
      preview.previewBinding(slot, binding);
    }
  });
  document.getElementById('selection-clear')?.addEventListener('click', () => {
    const binding = bindings.get(slot.id);
    if (!binding) return;
    const previous = structuredClone(binding.selection || emptySelection());
    selectionHistory.push(previous);
    const next = emptySelection();
    selectionLast = structuredClone(next);
    binding.selection = next;
    binding.nodeIndices = [];
    binding.sourceName = '精细选面（未完成）';
    preview.setTriangleSelection(true, next, { mode: previewSelectionMode, operation: previewSelectionOperation, brushRadius: previewSelectionRadius, angle: previewSelectionAngle, visibleOnly: previewSelectionVisibleOnly, onChange: (selection, stats) => updateSelectionBinding(slot, selection, stats), onStatus: ({ state, stats }) => { ui['workspace-index'].textContent = state === 'building' ? '正在构建 BVH 索引…' : 'BVH 索引就绪'; updateSelectionSummary(stats); } });
    updateSelectionSummary({ groups: 0, triangles: 0 });
    updateWorkspaceSelection({ groups: 0, triangles: 0 });
    markDevicePreviewStale();
    setDirty();
  });
  document.getElementById('selection-done')?.addEventListener('click', () => {
    stopFineSelection();
    renderBindings();
    playCurrentBinding();
  });
}

/** 把当前槽位设为框选来源并打开选区盒，region 为初始选区（烘焙后坐标） */
function createRegionBinding(slot, region) {
  const previous = bindings.get(slot.id);
  snapshot();
  stopPicking();
  const constrainedRegion = constrainRegionToSlotSide(slot, region);
  const measured = preview.measureRegion(constrainedRegion);
  // 框选从所有网格节点里切，因为选区可能跨越多个节点
  bindings.set(slot.id, {
    slotId: slot.id,
    whole: false,
    region: constrainedRegion,
    nodeIndices: parts.map((item) => item.nodeIndex),
    sourceName: '框选区域',
    bounds: constrainedRegion,
    geomBounds: measured.bounds,
    pivot: previous?.pivotCustom ? previous.pivot : defaultParams(slot, measured.bounds || constrainedRegion).pivot,
    pivotCustom: Boolean(previous?.pivotCustom),
    axis: previous?.axis || slot.axis,
    angle: previous?.angle ?? slot.angle,
    duration: previous?.duration ?? 0.8,
    reverse: Boolean(previous?.reverse),
    color: previous?.color || slot.color,
  });
  regionMode = 'translate';
  renderBindings();
  openRegionBox(slot);
}

/** 打开选区盒，拖动结束后同步范围、刷新面数、跟随旋转中心并重播动作 */
function openRegionBox(slot) {
  const binding = bindings.get(slot.id);
  if (!binding?.region) return;
  // 车机质感加载的是已经切好并重排过节点的最终 GLB，不能再拿它重算、改写源模型选区。
  // 此时直接播放导出节点上的真实动画；切回网页质感后再恢复选区编辑手柄。
  if (preview.deviceMode) {
    preview.previewBinding(slot, binding);
    return;
  }
  // 打开旧配置时立刻把左右槽位收进各自半边，界面看到的范围即最终导出范围。
  binding.region = constrainRegionToSlotSide(slot, binding.region);
  binding.bounds = binding.region;
  updateRegionCount(binding);
  let firstSync = true;
  preview.showRegionBox(binding.region, (region) => {
    if (!region) return;
    // 首次回调只是初始同步，不算用户操作；之后每次拖动结束都可撤销
    if (firstSync) firstSync = false;
    else snapshot();
    binding.region = region;
    binding.bounds = region;
    updateRegionCount(binding);
    // 用户手动调过旋转中心就不再自动跟随选区；否则跟随框内实际几何的中心
    if (!binding.pivotCustom) {
      binding.pivot = defaultParams(slot, binding.geomBounds || region).pivot;
      syncPivotInputs(binding);
    }
    syncPivotTools(slot, binding);
    preview.previewBinding(slot, binding);
  });
  preview.setRegionMode(regionMode === 'pivot' ? 'translate' : regionMode);
}

function updateRegionCount(binding) {
  if (!binding?.region) return;
  const measured = preview.measureRegion(binding.region);
  binding.geomBounds = measured.bounds;
  const label = document.getElementById('region-count');
  if (!label) return;
  label.textContent = measured.inside === 0
    ? '框内没有面片，请调整选区'
    : `框内 ${measured.inside.toLocaleString()} 面 / 全模型 ${measured.total.toLocaleString()} 面`;
  label.style.color = measured.inside === 0 ? '#c0392b' : '';
}

/**
 * 旋转中心可视化：橙色小球 + 穿过它的轴向虚线。
 * 非框选绑定（或框选切到“拖中心点”模式）时小球可直接拖动。
 */
function syncPivotTools(slot, binding) {
  if (!slot || !binding || !(slot.kind === 'hinge' || slot.kind === 'spin')) {
    preview.hidePivotMarker();
    return;
  }
  const draggable = !binding.region || regionMode === 'pivot';
  preview.showPivotMarker(binding.pivot, binding.axis || slot.axis, {
    draggable,
    onChange: (pivot) => {
      snapshot();
      binding.pivot = pivot;
      binding.pivotCustom = true;
      syncPivotInputs(binding);
      playCurrentBinding();
    },
  });
}

/** 框选模式切换：移动/缩放操作选区盒，“拖中心点”把手柄让给旋转中心 */
function applyRegionMode(slot, binding) {
  if (regionMode === 'pivot') {
    preview.setRegionGizmoEnabled(false);
  } else {
    preview.setRegionGizmoEnabled(true);
    preview.setRegionMode(regionMode);
  }
  syncPivotTools(slot, binding);
}

/** 选区变化后枢轴会跟着变，把新值写回输入框 */
function syncPivotInputs(binding) {
  ['x', 'y', 'z'].forEach((axis, i) => {
    const input = document.getElementById(`bind-pivot-${axis}`);
    if (input) input.value = Math.round(binding.pivot[i] * 1000) / 1000;
  });
}

function closePreviewTools() {
  stopFineSelection();
  stopPicking();
  preview.stopBindingPreview();
  preview.clearHighlight();
  preview.hideRegionBox();
  preview.hidePivotMarker();
  if (!openSlot) {
    ui['workspace-mode'].textContent = deleteDraft ? '删除区域' : '浏览模式';
    ui['workspace-index'].textContent = '精细索引未启用';
  }
}

function stopPicking() {
  if (!pickingFor) return;
  pickingFor = null;
  preview.setPickMode(false, null);
}

function updateBindingFromInputs(slot) {
  const binding = bindings.get(slot.id);
  if (!binding) return;
  const pivotX = document.getElementById('bind-pivot-x');
  if (pivotX) {
    const next = ['x', 'y', 'z'].map((axis) => Number(document.getElementById(`bind-pivot-${axis}`)?.value) || 0);
    if (next.some((value, i) => Math.abs(value - (binding.pivot?.[i] ?? 0)) > 1e-9)) binding.pivotCustom = true;
    binding.pivot = next;
  }
  const axis = document.getElementById('bind-axis');
  if (axis) binding.axis = axis.value;
  const angle = document.getElementById('bind-angle');
  if (angle) binding.angle = Number(angle.value) || 0;
  const duration = document.getElementById('bind-duration');
  if (duration) binding.duration = Math.min(5, Math.max(0.2, Number(duration.value) || 0.8));
  const reverse = document.getElementById('bind-reverse');
  if (reverse) binding.reverse = reverse.checked;
  const color = document.getElementById('bind-color');
  if (color) binding.color = color.value;
  setDirty();
  markDevicePreviewStale();
  syncPivotTools(slot, binding);
  playCurrentBinding();
}

function snapPivot(slot, mode) {
  const binding = bindings.get(slot.id);
  // 框选时按框内实际几何取位，比按框自身更贴合部件
  const source = binding?.geomBounds || binding?.bounds;
  if (!source) return;
  snapshot();
  const { min, max } = source;
  const center = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
  if (mode === 'center') binding.pivot = center;
  if (mode === 'front') binding.pivot = [min[0], center[1], center[2]];
  if (mode === 'rear') binding.pivot = [max[0], center[1], center[2]];
  binding.pivotCustom = true;
  renderBindings();
  playCurrentBinding();
}

function playCurrentBinding() {
  if (!openSlot) return;
  const slot = SLOT_BY_ID.get(openSlot);
  const binding = bindings.get(openSlot);
  if (!slot || !binding) return;
  // 框选时已经有选区盒了，再叠一个高亮框只会互相干扰
  if (!binding.region && !binding.selection) preview.highlightPart(binding.nodeIndices);
  preview.previewBinding(slot, binding);
}

async function generatePackage() {
  if (!current || !preview.model) return;
  const buttons = [ui.generate, ui['mobile-generate'], document.getElementById('mobile-generate-shortcut')];
  const labels = buttons.map((button) => button?.innerHTML || '');
  buttons.forEach((button) => { if (button) { button.disabled = true; button.classList.add('busy'); } });
  ui.generate.innerHTML = '<span class="spinner"></span><span>生成中…</span>';
  ui['mobile-generate'].innerHTML = '<span class="spinner"></span>生成中…';
  setStatuses([['warn', '…', '正在规范化 GLB 并生成车模包']]);
  try {
    const result = await makeBydCar({
      sourceBytes: current.bytes,
      sourceName: current.file.name,
      transform: preview.getExportTransform(),
      stats: current.stats,
      bindings: bindingsForOutput(),
      deletions: deletions.map((item) => item.region),
    });
    const blob = new Blob([result.bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName(result.manifest.name)}.bydcar`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDirty(false);
    updateSteps(4);
    setStatuses([
      ['good', '✓', `车模包已生成：${formatBytes(result.bytes.byteLength)}`],
      ['good', '✓', `几何：${current.stats.triangles.toLocaleString()} → ${result.manifest.model.outputStats.triangles.toLocaleString()} 三角形${current.stats.triangles === result.manifest.model.outputStats.triangles ? '（未减面）' : ''}`],
      ['good', '✓', 'CarSelf.dat 和 GLB 均已写入 SHA-256 校验值'],
      ['warn', '!', '导入地图后需要重启地图进程才能生效'],
    ]);
  } catch (error) {
    console.error(error);
    setStatuses([['bad', '×', `生成失败：${error.message || '未知错误'}`]]);
  } finally {
    buttons.forEach((button, index) => {
      if (!button) return;
      button.disabled = false;
      button.classList.remove('busy');
      button.innerHTML = labels[index];
    });
    renderIcons();
  }
}

function safeName(value) {
  const name = value.replace(/[\\/:*?"<>|]/g, '_').trim();
  return name || 'custom-model';
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
