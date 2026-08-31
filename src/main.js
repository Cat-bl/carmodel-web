import './style.css';
import { ModelPreview } from './preview.js';
import { bakeSubmeshVisibility, combineAnimations, makeBydCar, makeVehiclePreviewGlb, normalizeComboSegments, removeAnimation } from './package.js';
import { listSubmeshes, recommendedHiddenSubmeshes } from './submeshes.js';
import { MODEL_FILE_ACCEPT, MODEL_FORMAT_HINT, prepareModelImport } from './importer.js';
import { PROJECT_FILE_ACCEPT, makeProjectFile, readProjectFile } from './project.js';
import {
  animationNamesOf,
  BEAM_LOBE_MODES,
  BEAM_SHAPES,
  EVENT_PRIORITY_LEVELS,
  LAMP_BEAM_LIMITS,
  LAMP_GLOW_LIMITS,
  MAX_EVENT_VARIANTS,
  SLOT_BY_ID,
  defaultParams,
  eventVariantsOf,
  isLampSlot,
  isSustainedEvent,
  normalizeEventPriority,
  normalizeRerollCycles,
  normalizeYawDegrees,
  normalizeIdleDelaySeconds,
  PARKED_DELAY_MIN_SECONDS,
  normalizeVariantWeight,
  variantChances,
  normalizeLampBeam,
  normalizeLampGlow,
  normalizeOtherPlayback,
  playbackDurationOf,
  slotForMode,
  slotGroups,
  suggestRegion,
} from './bindings.js';
import {
  createIcons,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  Box,
  BoxSelect,
  CarFront,
  CheckCircle2,
  CornerDownRight,
  Dices,
  Download,
  Eye,
  Film,
  FolderOpen,
  Gauge,
  Info,
  Layers3,
  Maximize2,
  MousePointer2,
  Paintbrush,
  Play,
  Redo2,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  Wrench,
  X,
} from 'lucide';
import { emptySelection, selectionGroupCount, selectionTriangleCount } from './selection.js';

const app = document.querySelector('#app');

app.innerHTML = `
  <section class="model-type-home" id="model-type-home" aria-labelledby="model-type-title">
    <header class="model-type-homebar">
      <div class="model-type-brand">
        <img class="brand-mark" src="./logo.svg" alt="" />
        <div>
          <strong>BYD 模型编辑器</strong>
          <span>模型工作区</span>
        </div>
      </div>
      <button class="btn home-project-button" id="home-open-project" type="button">
        <i data-lucide="folder-open"></i>打开已有项目
      </button>
    </header>
    <main class="model-type-main">
      <div class="model-type-heading">
        <span>新建项目</span>
        <h1 id="model-type-title">选择模型类型</h1>
        <p>模型类型将决定初始朝向和后续编辑方式。</p>
      </div>
      <div class="model-type-options" aria-label="模型类型">
        <button class="model-type-option vehicle" type="button" data-model-type="vehicle" aria-label="选择车辆模型">
          <span class="model-type-icon"><i data-lucide="car-front"></i></span>
          <span class="model-type-copy">
            <strong>车辆</strong>
            <small>轿车、SUV、卡车及其他道路车辆</small>
          </span>
          <span class="model-type-enter">进入工作区 <i data-lucide="arrow-left-right"></i></span>
        </button>
        <button class="model-type-option other" type="button" data-model-type="other" aria-label="选择其他模型">
          <span class="model-type-icon"><i data-lucide="box"></i></span>
          <span class="model-type-copy">
            <strong>其他</strong>
            <small>人物、机器人、物品及非车辆模型</small>
          </span>
          <span class="model-type-enter">进入工作区 <i data-lucide="arrow-left-right"></i></span>
        </button>
      </div>
      <button class="home-project-link" id="home-open-project-mobile" type="button">
        <i data-lucide="folder-open"></i><span>打开已有 .bydcarproj 项目</span>
      </button>
    </main>
    <footer class="model-type-footer">
      <span>支持 ${MODEL_FORMAT_HINT}</span>
      <span>项目进度可保存为 .bydcarproj</span>
    </footer>
  </section>

  <div class="editor-shell" id="editor-shell" data-stage="0" hidden>
    <header class="commandbar">
      <div class="file-context">
        <img class="brand-mark" src="./logo.svg" alt="" />
        <div class="file-copy">
          <strong id="editor-brand-title">BYD 车模编辑器</strong>
          <span id="file-name">尚未选择模型</span>
          <small id="save-status">项目文件未保存</small>
        </div>
        <button class="model-type-badge" id="model-type-switch" type="button" title="返回首页重新选择模型类型">
          <i id="model-type-icon" data-lucide="car-front"></i><span id="model-type-label">车辆</span>
        </button>
        <span class="dirty-dot" id="dirty-state" title="有尚未保存到项目文件的修改" hidden></span>
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
        <label class="btn command-import" for="model-file" title="更换当前模型，有未保存的修改时会先提示保存项目"><i data-lucide="upload"></i><span>重新导入模型</span></label>
        <button class="icon-btn project-action" id="open-project" type="button" title="打开项目"><i data-lucide="folder-open"></i></button>
        <button class="icon-btn project-action" id="save-project" type="button" title="保存项目 (Ctrl+S)" disabled><i data-lucide="save"></i></button>
        <button class="btn command-check" data-panel-target="check"><i data-lucide="check-circle-2"></i><span>检查</span></button>
        <button class="btn primary" id="generate" disabled><i data-lucide="download"></i><span id="generate-label">原始 · 生成车模包</span></button>
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
          <div class="other-mode-note" id="other-mode-note" hidden>
            <strong>模型动画绑定</strong>
            <span>选择车机事件，再从模型自带动画中选择要触发的动作</span>
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
          <div class="segmented compact mobile-preview-mode" aria-label="移动端预览质感">
            <button class="active" id="mode-web-mobile" disabled>网页质感</button>
            <button id="mode-device-mobile" disabled>车机质感</button>
          </div>
          <button class="icon-btn canvas-reset" data-view="perspective" title="适应视图"><i data-lucide="maximize-2"></i></button>
        </div>
        <div class="viewport">
          <canvas id="preview"></canvas>
          <div class="empty-state" id="empty-state">
            <i data-lucide="upload"></i>
            <strong id="empty-state-title">开始制作车模</strong>
            <span>${MODEL_FORMAT_HINT}</span>
            <div class="empty-actions">
              <label class="btn primary" for="model-file"><i data-lucide="upload"></i>导入模型</label>
              <label class="btn" for="project-file"><i data-lucide="folder-open"></i>打开项目</label>
            </div>
          </div>
          <div class="import-progress" id="import-progress" role="status" aria-live="polite" aria-valuemin="0" aria-valuemax="100" hidden>
            <div class="import-progress-copy">
              <span class="spinner" aria-hidden="true"></span>
              <strong id="import-progress-label">正在读取模型</strong>
              <span id="import-progress-percent">0%</span>
            </div>
            <div class="import-progress-track" aria-hidden="true"><span id="import-progress-bar"></span></div>
          </div>
          <input id="model-file" class="visually-hidden" type="file" accept="${MODEL_FILE_ACCEPT}" />
          <input id="project-file" class="visually-hidden" type="file" accept="${PROJECT_FILE_ACCEPT}" />
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
            <button class="icon-btn" id="inspector-open-project" type="button" title="打开项目"><i data-lucide="folder-open"></i></button>
          </div>
          <div class="inspector-scroll">
            <section class="tool-section">
              <div class="section-title"><h3>模型信息</h3><span id="source-format-label">等待导入</span></div>
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
              <div class="section-title"><h3>朝向与尺寸</h3><span id="orientation-mode-hint">蓝色箭头为车头</span></div>
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
                <div class="field"><label for="target-length" id="target-length-label">车身最长边（米）</label><input id="target-length" type="number" min="0.5" max="10" step="0.1" value="5.2" disabled /></div>
                <div class="field"><label for="height-offset">离地高度（米）</label><input id="height-offset" type="number" max="3" step="0.05" value="0" disabled /></div>
              </div>
              <label class="range-field model-brightness-field" for="model-brightness">
                模型自身亮度
                <output id="model-brightness-output" for="model-brightness">100%</output>
                <input id="model-brightness" type="range" min="50" max="300" step="5" value="100" disabled />
              </label>
              <label class="setting-switch" for="remove-shadow">
                <span>去掉模型阴影</span>
                <input id="remove-shadow" type="checkbox" role="switch" disabled />
                <span class="setting-switch-track" aria-hidden="true"><span></span></span>
              </label>
            </section>
            <section class="tool-section">
              <div class="section-title"><h3>删除多余部分</h3><span id="delete-summary">未删除</span></div>
              <button class="btn" id="delete-start" disabled><i data-lucide="trash-2"></i>框选删除区域</button>
              <div id="delete-panel"></div>
            </section>
            <section class="tool-section" id="submesh-section" hidden>
              <div class="section-title"><h3>子网格显隐</h3><span id="submesh-summary"></span></div>
              <p class="hint" id="submesh-hint">取消勾选会把该子网格从预览和导出里剔除；模型自带的按动画显隐规则会自动生效。</p>
              <div class="submesh-list" id="submesh-list"></div>
              <div class="quick-row">
                <button class="btn small" id="submesh-show-all">全部显示</button>
                <button class="btn small" id="submesh-recommend">恢复推荐</button>
              </div>
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
            <section class="tool-section export-quality">
              <div class="section-title"><h3>导出质量</h3><span id="quality-summary">原始 · 不限</span></div>
              <div class="quality-presets" role="radiogroup" aria-label="导出质量">
                <button type="button" data-quality="smooth" role="radio" aria-checked="false">流畅</button>
                <button type="button" data-quality="balanced" role="radio" aria-checked="false">均衡</button>
                <button type="button" data-quality="high" role="radio" aria-checked="false">高清</button>
                <button type="button" class="active" data-quality="original" role="radio" aria-checked="true">原始</button>
                <button type="button" data-quality="custom" role="radio" aria-checked="false">自定义</button>
              </div>
              <div class="quality-custom" id="quality-custom" hidden>
                <div class="field">
                  <label for="quality-triangles">三角面上限</label>
                  <input id="quality-triangles" type="number" min="0" step="10000" value="300000" inputmode="numeric" />
                </div>
                <div class="field">
                  <label for="quality-texture-size">贴图最长边</label>
                  <input id="quality-texture-size" type="number" min="0" step="256" value="4096" inputmode="numeric" />
                </div>
              </div>
              <div class="quality-metrics" id="quality-metrics">
                <span>全部面片</span><span>原始贴图</span>
              </div>
            </section>
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
      <button class="icon-btn" id="mobile-save-project" disabled title="保存项目"><i data-lucide="save"></i></button>
      <button class="icon-btn primary" id="mobile-generate-shortcut" disabled title="生成"><i data-lucide="download"></i></button>
    </div>
  </div>

  <div class="generate-dialog" id="generate-dialog" role="dialog" aria-modal="true" aria-labelledby="generate-dialog-title" hidden>
    <div class="generate-dialog-panel">
      <div class="generate-dialog-header">
        <div><span>导出设置</span><h2 id="generate-dialog-title">生成车模包</h2></div>
        <button class="icon-btn" id="generate-dialog-close" type="button" title="关闭"><i data-lucide="x"></i></button>
      </div>
      <div class="generate-dialog-body">
        <div class="section-title"><h3>选择导出质量</h3><span id="generate-quality-summary">原始 · 不限</span></div>
        <div class="quality-presets generate-quality-presets" role="radiogroup" aria-label="生成质量">
          <button type="button" data-quality="smooth" role="radio" aria-checked="false">流畅</button>
          <button type="button" data-quality="balanced" role="radio" aria-checked="false">均衡</button>
          <button type="button" data-quality="high" role="radio" aria-checked="false">高清</button>
          <button type="button" class="active" data-quality="original" role="radio" aria-checked="true">原始</button>
          <button type="button" data-quality="custom" role="radio" aria-checked="false">自定义</button>
        </div>
        <div class="quality-custom" id="generate-quality-custom" hidden>
          <div class="field">
            <label for="generate-quality-triangles">三角面上限</label>
            <input id="generate-quality-triangles" type="number" min="0" step="10000" value="300000" inputmode="numeric" />
          </div>
          <div class="field">
            <label for="generate-quality-texture-size">贴图最长边</label>
            <input id="generate-quality-texture-size" type="number" min="0" step="256" value="4096" inputmode="numeric" />
          </div>
        </div>
        <div class="quality-metrics" id="generate-quality-metrics">
          <span>全部面片</span><span>原始贴图</span>
        </div>
        <p class="generate-quality-note">原始档不会主动减少面片或缩小贴图；其他档位只按所选质量优化。</p>
      </div>
      <div class="generate-dialog-actions">
        <button class="btn" id="generate-dialog-cancel" type="button">取消</button>
        <button class="btn primary" id="generate-confirm" type="button"><i data-lucide="download"></i><span>按原始质量生成</span></button>
      </div>
    </div>
  </div>
  <div class="generate-dialog" id="combo-dialog" role="dialog" aria-labelledby="combo-dialog-title" hidden>
    <div class="generate-dialog-panel combo-dialog-panel">
      <div class="generate-dialog-header">
        <div><span>模型动画</span><h2 id="combo-dialog-title">组合动画</h2></div>
        <button class="icon-btn" id="combo-dialog-close" type="button" title="关闭"><i data-lucide="x"></i></button>
      </div>
      <div class="generate-dialog-body">
        <p class="hint combo-intro">把几段动画首尾相接合成一段新动画，比如「起手 → 循环」。</p>
        <div class="combo-step"><b>第 1 步</b><span>挑动画：点一下在视口里播放，按 ＋ 加到顺序里</span></div>
        <div class="combo-list combo-library" id="combo-library"></div>
        <div class="combo-step"><b>第 2 步</b><span>排顺序：每段可以连播几次，▲▼ 调顺序</span></div>
        <div class="combo-list" id="combo-segments"></div>
        <p class="combo-summary" id="combo-summary"></p>
        <div class="combo-step"><b>第 3 步</b><span>结尾与衔接</span></div>
        <div class="combo-options">
          <label class="check-row"><input type="radio" name="combo-ending" value="end" checked />播完最后一段就结束</label>
          <label class="check-row"><input type="radio" name="combo-ending" value="loop" />最后一段一直循环<small>（前面的段只播一次，适合「起手 → 循环」）</small></label>
          <label class="check-row"><input type="radio" name="combo-blend" value="cut" checked />段与段直接相接</label>
          <label class="check-row"><input type="radio" name="combo-blend" value="smooth" />段与段平滑过渡<span class="combo-blend-ms" id="combo-blend-ms" hidden><input id="combo-blend" type="number" min="10" max="1000" step="10" value="150" />毫秒</span></label>
        </div>
        <div class="combo-step"><b>第 4 步</b><span>起个名字，试播满意后生成</span></div>
        <div class="field"><input id="combo-name" type="text" placeholder="例如：跳舞（起手 + 循环）" /></div>
        <p class="combo-status" id="combo-status"></p>
        <div class="combo-section-title">已有的组合动画</div>
        <div class="combo-list" id="combo-existing"></div>
      </div>
      <div class="generate-dialog-actions">
        <button class="btn" id="combo-dialog-preview" type="button" disabled title="按当前顺序从头连播一遍，看衔接效果"><i data-lucide="play"></i><span>试播整段</span></button>
        <button class="btn" id="combo-dialog-cancel" type="button">取消</button>
        <button class="btn primary" id="combo-dialog-confirm" type="button" disabled><i data-lucide="film"></i><span>生成组合动画</span></button>
      </div>
    </div>
  </div>

  <div class="generate-dialog" id="leave-dialog" role="dialog" aria-modal="true" aria-labelledby="leave-dialog-title" hidden>
    <div class="generate-dialog-panel leave-dialog-panel">
      <div class="generate-dialog-header">
        <div><span>当前项目</span><h2 id="leave-dialog-title">先保存进度吗？</h2></div>
        <button class="icon-btn" id="leave-dialog-close" type="button" title="关闭"><i data-lucide="x"></i></button>
      </div>
      <div class="generate-dialog-body leave-dialog-body">
        <p id="leave-dialog-message"></p>
        <p class="leave-dialog-hint">保存为 .bydcarproj 项目文件后，下次直接打开就能还原到现在的进度：模型、朝向、所有联动绑定和动画设置都会原样带回来。</p>
      </div>
      <div class="generate-dialog-actions leave-dialog-actions">
        <button class="btn" id="leave-dialog-cancel" type="button">取消</button>
        <button class="btn" id="leave-dialog-discard" type="button">不保存，继续</button>
        <button class="btn primary" id="leave-dialog-save" type="button"><i data-lucide="save"></i><span>保存项目并继续</span></button>
      </div>
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
  'model-type-home', 'editor-shell', 'home-open-project', 'home-open-project-mobile', 'model-type-switch',
  'model-type-icon', 'model-type-label', 'editor-brand-title', 'empty-state-title', 'model-file', 'project-file', 'drop-zone', 'file-name', 'save-status', 'analysis-state', 'empty-state',
  'source-format-label',
  'rotation-x', 'rotation-y', 'rotation-z', 'target-length', 'target-length-label', 'height-offset',
  'model-brightness', 'model-brightness-output', 'remove-shadow', 'orientation-mode-hint', 'status-list',
  'generate', 'mobile-generate', 'mobile-generate-shortcut', 'save-project', 'mobile-save-project',
  'open-project', 'inspector-open-project', 'reset-rotation', 'mobile-reset', 'mode-web', 'mode-device',
  'mode-web-mobile', 'mode-device-mobile',
  'binding-groups', 'binding-summary', 'binding-editor-host', 'binding-editor-title', 'demo-all', 'other-mode-note',
  'delete-start', 'delete-panel', 'delete-summary', 'undo', 'redo', 'dirty-state',
  'submesh-section', 'submesh-summary', 'submesh-list', 'submesh-show-all', 'submesh-recommend',
  'workspace-triangles', 'workspace-selection', 'workspace-mode', 'workspace-index',
  'import-progress', 'import-progress-label', 'import-progress-percent', 'import-progress-bar',
  'binding-back', 'quality-summary', 'quality-custom', 'quality-triangles', 'quality-texture-size',
  'quality-metrics', 'generate-dialog', 'generate-dialog-close', 'generate-dialog-cancel',
  'leave-dialog', 'leave-dialog-message', 'leave-dialog-close', 'leave-dialog-cancel', 'leave-dialog-discard', 'leave-dialog-save',
  'combo-dialog', 'combo-dialog-close', 'combo-dialog-cancel', 'combo-dialog-confirm', 'combo-dialog-preview',
  'combo-name', 'combo-library', 'combo-segments', 'combo-summary', 'combo-status', 'combo-blend', 'combo-blend-ms', 'combo-existing',
  'generate-confirm', 'generate-quality-summary', 'generate-quality-custom',
  'generate-quality-triangles', 'generate-quality-texture-size', 'generate-quality-metrics',
].map((id) => [id, document.getElementById(id)]));
// 空状态本身就是拖入区域；兼容旧逻辑保留 drop-zone 别名。
ui['drop-zone'] ||= ui['empty-state'];

const preview = new ModelPreview(document.getElementById('preview'), updateStats);
let current = null;
let modelType = null;
let dirty = false;
let projectSaved = false;
let activePanel = 'model';
let removeShadow = false;
let modelBrightness = 1;
const QUALITY_PRESETS = {
  smooth: { label: '流畅', triangleTarget: 80000, textureMaxSize: 1024 },
  balanced: { label: '均衡', triangleTarget: 160000, textureMaxSize: 2048 },
  high: { label: '高清', triangleTarget: 300000, textureMaxSize: 4096 },
  original: { label: '原始', triangleTarget: null, textureMaxSize: null },
};
let selectedQuality = 'original';
const customQuality = { triangleTarget: 300000, textureMaxSize: 4096 };
let qualityPreviewTimer = 0;

const MODEL_TYPES = {
  vehicle: { label: '车辆', icon: 'car-front', orientationHint: '蓝色箭头为车头', lengthLabel: '车身最长边（米）', emptyTitle: '开始制作车模' },
  other: { label: '其他', icon: 'box', orientationHint: '保持导入时的原始朝向', lengthLabel: '模型最长边（米）', emptyTitle: '开始制作模型' },
};

function normalizeModelType(value) {
  return value === 'other' ? 'other' : 'vehicle';
}

function normalizeModelBrightness(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(3, Math.max(0.5, number)) : 1;
}

function renderModelBrightness() {
  const percent = Math.round(modelBrightness * 100);
  ui['model-brightness'].value = percent;
  ui['model-brightness-output'].value = `${percent}%`;
  ui['model-brightness-output'].textContent = `${percent}%`;
}

function activeSlot(slotOrId) {
  return slotForMode(slotOrId, modelType || 'vehicle');
}

function activeSlotGroups() {
  return slotGroups(modelType || 'vehicle');
}

function updateModelTypeUi() {
  if (!modelType) return;
  const config = MODEL_TYPES[modelType];
  ui['model-type-label'].textContent = config.label;
  ui['model-type-icon'].setAttribute('data-lucide', config.icon);
  ui['editor-brand-title'].textContent = modelType === 'other' ? 'BYD 模型编辑器' : 'BYD 车模编辑器';
  ui['orientation-mode-hint'].textContent = config.orientationHint;
  ui['target-length-label'].textContent = config.lengthLabel;
  ui['empty-state-title'].textContent = config.emptyTitle;
  ui['model-type-switch'].classList.toggle('other', modelType === 'other');
  ui['other-mode-note'].hidden = modelType !== 'other';
  document.querySelector('.editor-shell')?.setAttribute('data-model-type', modelType);
  renderIcons();
}

function enterEditorForType(type) {
  modelType = normalizeModelType(type);
  ui['model-type-home'].hidden = true;
  ui['editor-shell'].hidden = false;
  updateModelTypeUi();
  renderBindings();
  if (!current) {
    ui['empty-state'].hidden = false;
    ui['analysis-state'].textContent = '等待导入';
    updateSteps(0);
  }
  requestAnimationFrame(() => preview.resize());
}

function resetWorkspaceForTypeSelection() {
  closeComboDialog();
  stopDemo();
  closePreviewTools();
  preview.disposeModel();
  current = null;
  modelType = null;
  dirty = false;
  projectSaved = false;
  selectedQuality = 'original';
  removeShadow = false;
  modelBrightness = 1;
  customQuality.triangleTarget = 300000;
  customQuality.textureMaxSize = 4096;
  deletions = [];
  deleteDraft = null;
  submeshes = [];
  hiddenSubmeshes = new Set();
  renderSubmeshPanel();
  bindings.clear();
  bindableAnimations = [];
  openSlot = null;
  parts = [];
  partGroups = [];
  ui['file-name'].textContent = '尚未选择模型';
  ui['file-name'].classList.remove('modified');
  ui['analysis-state'].textContent = '等待导入';
  ui['source-format-label'].textContent = '等待导入';
  ui['save-status'].textContent = '项目文件未保存';
  ui['save-status'].classList.remove('saving', 'error');
  ui['dirty-state'].hidden = true;
  ui['empty-state'].hidden = false;
  ui['workspace-triangles'].textContent = '0';
  ui['workspace-selection'].textContent = '0';
  ui['workspace-mode'].textContent = '浏览模式';
  ui['workspace-index'].textContent = '精细索引未启用';
  ui['editor-shell'].removeAttribute('data-model-type');
  ui['rotation-x'].value = 0;
  ui['rotation-y'].value = 0;
  ui['rotation-z'].value = 0;
  ui['target-length'].value = 5.2;
  ui['height-offset'].value = 0;
  renderModelBrightness();
  ui['remove-shadow'].checked = false;
  preview.targetLength = 5.2;
  preview.heightOffset = 0;
  preview.setBrightness(1);
  preview.setRemoveShadow(false);
  undoStack.length = 0;
  redoStack.length = 0;
  syncUndoRedoButtons();
  markDevicePreviewStale();
  for (const id of ['stat-bytes', 'stat-triangles', 'stat-nodes', 'stat-meshes', 'stat-materials', 'stat-textures']) {
    document.getElementById(id).textContent = '—';
  }
  renderDeletePanel();
  renderBindings();
  renderQualityControls();
  setControls(false);
  setStatuses([['warn', '…', '导入模型后开始检查']]);
  setActivePanel('model');
  updateSteps(0);
}

async function returnToModelTypeHome() {
  if (current && !(await confirmLeaveProject('返回首页'))) return;
  resetWorkspaceForTypeSelection();
  ui['editor-shell'].hidden = true;
  ui['model-type-home'].hidden = false;
  requestAnimationFrame(() => renderIcons());
}

window.addEventListener('beforeunload', (event) => {
  const importing = document.querySelector('.editor-shell')?.classList.contains('is-importing');
  if (!current && !importing) return;
  event.preventDefault();
  event.returnValue = '';
});

const lucideIcons = {
  AlertCircle, AlertTriangle, ArrowLeft, ArrowLeftRight, Box, BoxSelect, CarFront, CheckCircle2, CornerDownRight,
  Dices, Download, Eye, Film, FolderOpen, Gauge, Info, Layers3, Maximize2, MousePointer2, Paintbrush, Play,
  Redo2, RotateCcw, Save, Settings2, Sparkles, Square, Trash2, Undo2, Upload, Wrench, X,
};

function renderIcons() {
  createIcons({ icons: lucideIcons, attrs: { 'stroke-width': 1.8 } });
}

function setDirty(value = true) {
  dirty = value;
  if (value) projectSaved = false;
  ui['dirty-state'].hidden = !dirty;
  ui['file-name'].classList.toggle('modified', dirty);
  ui['save-status'].classList.remove('saving', 'error');
  ui['save-status'].textContent = value ? '有未保存修改' : projectSaved ? '项目已保存' : '项目文件未保存';
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
    const slot = activeSlot(openSlot);
    const binding = bindings.get(openSlot);
    if (binding?.selection && selectionEditingSlot === slot.id) startFineSelection(slot, { preserveState: true });
  }
}

function markDevicePreviewStale() {
  deviceGlbCache = null;
  deviceGlbCacheKey = '';
}

function positiveQualityValue(input) {
  const value = Math.floor(Number(input) || 0);
  return value > 0 ? value : null;
}

function exportQuality() {
  if (selectedQuality === 'custom') {
    return {
      preset: 'custom',
      label: '自定义',
      triangleTarget: positiveQualityValue(customQuality.triangleTarget),
      textureMaxSize: positiveQualityValue(customQuality.textureMaxSize),
    };
  }
  return { preset: selectedQuality, ...QUALITY_PRESETS[selectedQuality] };
}

function renderQualityControls() {
  const quality = exportQuality();
  document.querySelectorAll('[data-quality]').forEach((button) => {
    const active = button.dataset.quality === selectedQuality;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
  document.querySelectorAll('.quality-custom').forEach((element) => {
    element.hidden = selectedQuality !== 'custom';
  });
  const summary = `${quality.label} · ${quality.triangleTarget || quality.textureMaxSize ? '按档位优化' : '不限'}`;
  ui['quality-summary'].textContent = summary;
  ui['generate-quality-summary'].textContent = summary;
  const metrics = `
    <span>${quality.triangleTarget ? `${quality.triangleTarget.toLocaleString()} 面` : '全部面片'}</span>
    <span>${quality.textureMaxSize ? `${quality.textureMaxSize}px 贴图` : '原始贴图'}</span>
  `;
  ui['quality-metrics'].innerHTML = metrics;
  ui['generate-quality-metrics'].innerHTML = metrics;
  const generateLabel = document.getElementById('generate-label');
  if (generateLabel) generateLabel.textContent = `${quality.label} · 生成车模包`;
  ui['generate-confirm'].querySelector('span').textContent = `按${quality.label}质量生成`;
  document.getElementById('mobile-generate-shortcut').title = `${quality.label}质量生成`;
}

function refreshDevicePreviewForQuality() {
  clearTimeout(qualityPreviewTimer);
  if (!current || !preview.deviceMode) return;
  qualityPreviewTimer = window.setTimeout(() => {
    setPreviewMode(true).catch((error) => {
      console.error(error);
      showMessage(`车机质感刷新失败：${error.message}`, 'error');
    });
  }, 320);
}

function qualityChanged() {
  renderQualityControls();
  markDevicePreviewStale();
  if (current) setDirty(true);
  refreshDevicePreviewForQuality();
}

document.querySelectorAll('[data-quality]').forEach((button) => {
  button.addEventListener('click', () => {
    if (current && selectedQuality !== button.dataset.quality) snapshot({ scope: 'quality' });
    selectedQuality = button.dataset.quality;
    qualityChanged();
  });
});
const qualityInputConfig = {
  'quality-triangles': ['triangleTarget', 'generate-quality-triangles'],
  'generate-quality-triangles': ['triangleTarget', 'quality-triangles'],
  'quality-texture-size': ['textureMaxSize', 'generate-quality-texture-size'],
  'generate-quality-texture-size': ['textureMaxSize', 'quality-texture-size'],
};
for (const [id, [key, mirrorId]] of Object.entries(qualityInputConfig)) {
  ui[id].addEventListener('input', () => {
    selectedQuality = 'custom';
    customQuality[key] = Math.max(0, Math.floor(Number(ui[id].value) || 0));
    ui[mirrorId].value = ui[id].value;
    qualityChanged();
  });
  wireContinuousHistory(ui[id], { scope: 'quality-input' });
}
renderQualityControls();

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

document.querySelectorAll('[data-model-type]').forEach((button) => {
  button.addEventListener('click', () => enterEditorForType(button.dataset.modelType));
});
for (const id of ['home-open-project', 'home-open-project-mobile']) {
  ui[id].addEventListener('click', () => ui['project-file'].click());
}
ui['model-type-switch'].addEventListener('click', returnToModelTypeHome);

ui['model-file'].addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file && await confirmReplaceCurrent()) loadFile(file);
  else event.target.value = '';
});
ui['project-file'].addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file && await confirmReplaceCurrent()) loadProject(file);
  else event.target.value = '';
});
for (const id of ['open-project', 'inspector-open-project']) {
  ui[id].addEventListener('click', () => ui['project-file'].click());
}
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
ui['drop-zone'].addEventListener('drop', async (event) => {
  const file = event.dataTransfer.files?.[0];
  if (!file || !(await confirmReplaceCurrent())) return;
  if (/\.bydcarproj$/i.test(file.name)) loadProject(file);
  else loadFile(file);
});

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

for (const axis of ['x', 'y', 'z']) {
  const input = ui[`rotation-${axis}`];
  input.addEventListener('input', updateRotation);
  wireContinuousHistory(input, { scope: 'model-input', field: `rotation-${axis}` });
}
// 尺寸与离地高度不改旋转，变换后可把删除框/选区/旋转中心无损迁移到新坐标
ui['target-length'].addEventListener('input', () => {
  renormalizeAndMigrate(() => preview.setTargetLength(ui['target-length'].value));
});
wireContinuousHistory(ui['target-length'], { scope: 'model-input', field: 'target-length' });
ui['height-offset'].addEventListener('input', () => {
  renormalizeAndMigrate(() => {
    const value = Number(ui['height-offset'].value);
    preview.heightOffset = Number.isFinite(value) ? Math.min(3, value) : 0;
    preview.normalize();
  });
});
wireContinuousHistory(ui['height-offset'], { scope: 'model-input', field: 'height-offset' });
ui['model-brightness'].addEventListener('input', () => {
  if (!current) return;
  modelBrightness = normalizeModelBrightness(Number(ui['model-brightness'].value) / 100);
  renderModelBrightness();
  preview.setBrightness(modelBrightness);
  markDevicePreviewStale();
  setDirty();
  refreshDevicePreviewForQuality();
});
wireContinuousHistory(ui['model-brightness'], { scope: 'model-input', field: 'model-brightness' });
ui['remove-shadow'].addEventListener('change', () => {
  if (!current) return;
  snapshot({ scope: 'shadow' });
  removeShadow = ui['remove-shadow'].checked;
  preview.setRemoveShadow(removeShadow);
  markDevicePreviewStale();
  setDirty();
  refreshDevicePreviewForQuality();
});
ui['reset-rotation'].addEventListener('click', reset);
ui['mobile-reset'].addEventListener('click', reset);

function openGenerateDialog() {
  if (!current || !preview.model) return;
  renderQualityControls();
  ui['generate-dialog'].hidden = false;
  ui['generate-confirm'].focus();
}

function closeGenerateDialog() {
  ui['generate-dialog'].hidden = true;
}

ui.generate.addEventListener('click', openGenerateDialog);
ui['mobile-generate'].addEventListener('click', openGenerateDialog);
document.getElementById('mobile-generate-shortcut')?.addEventListener('click', openGenerateDialog);
ui['save-project'].addEventListener('click', saveProject);
ui['mobile-save-project'].addEventListener('click', saveProject);
ui['generate-dialog-close'].addEventListener('click', closeGenerateDialog);
ui['generate-dialog-cancel'].addEventListener('click', closeGenerateDialog);
ui['generate-dialog'].addEventListener('click', (event) => {
  if (event.target === ui['generate-dialog']) closeGenerateDialog();
});
ui['generate-confirm'].addEventListener('click', () => {
  closeGenerateDialog();
  generatePackage();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (current) saveProject();
    return;
  }
  if (event.key === 'Escape' && !ui['generate-dialog'].hidden) closeGenerateDialog();
});
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
ui['binding-back'].addEventListener('click', closeBindingEditor);

let deviceGlbCache = null;
let deviceGlbCacheKey = '';
let previewModeRequestId = 0;
let previewModeTask = Promise.resolve();

function setPreviewMode(device, { bindingPhase = 'on' } = {}) {
  const requestId = ++previewModeRequestId;
  const run = () => requestId === previewModeRequestId
    ? applyPreviewMode(device, requestId, bindingPhase)
    : false;
  previewModeTask = previewModeTask.then(run, run);
  return previewModeTask;
}

async function applyPreviewMode(device, requestId, bindingPhase) {
  if (!current || (preview.deviceMode === device && (!device || deviceGlbCache))) return;
  stopFineSelection();
  for (const id of ['mode-web', 'mode-device', 'mode-web-mobile', 'mode-device-mobile']) ui[id].disabled = true;
  try {
    // 预览复用最终导出管线：变换、联动切分或删除区域改变时都要重烘。
    const transform = preview.getExportTransform();
    const previewBindings = bindingsForOutput();
    const previewDeletions = deletions.map((item) => item.region);
    const quality = exportQuality();
    const cacheKey = JSON.stringify({
      modelType, transform, bindings: previewBindings, deletions: previewDeletions,
      quality, removeShadow, modelBrightness, hidden: [...hiddenSubmeshes],
    });
    if (device && (!deviceGlbCache || deviceGlbCacheKey !== cacheKey)) {
      ui['mode-device'].textContent = '烘焙中…';
      ui['mode-device-mobile'].textContent = '处理中…';
      updateImportProgress({ progress: 0, label: '正在准备车机质感预览' });
      const nextDeviceGlb = await makeVehiclePreviewGlb(
        current.bytes,
        transform,
        previewBindings,
        previewDeletions,
        quality,
        modelType,
        removeShadow,
        modelBrightness,
        updateImportProgress,
        [...hiddenSubmeshes],
      );
      if (requestId !== previewModeRequestId) return false;
      deviceGlbCache = nextDeviceGlb;
      deviceGlbCacheKey = cacheKey;
      ui['mode-device'].textContent = '车机质感';
      ui['mode-device-mobile'].textContent = '车机质感';
    }
    if (requestId !== previewModeRequestId) return false;
    await preview.setDeviceMode(device, deviceGlbCache?.glb ?? null, transform, deviceGlbCache?.lamps || []);
    if (requestId !== previewModeRequestId) return false;
    for (const id of ['mode-web', 'mode-web-mobile']) ui[id].classList.toggle('active', !device);
    for (const id of ['mode-device', 'mode-device-mobile']) ui[id].classList.toggle('active', device);
    // 模型实例换了，删除区域、部件映射与打开中的联动工具都要跟着重建
    preview.setDeletions(deletions.map((item) => item.region));
    refreshParts();
    if (openSlot) {
      const slot = activeSlot(openSlot);
      const binding = bindings.get(openSlot);
      if (binding?.region) {
        openRegionBox(slot);
        applyRegionMode(slot, binding);
      } else if (binding?.selection && !device) {
        startFineSelection(slot, { preserveState: true });
        playCurrentBinding(bindingPhase);
      } else if (binding) {
        playCurrentBinding(bindingPhase);
        syncPivotTools(slot, binding);
      }
    }
    return true;
  } catch (error) {
    if (requestId !== previewModeRequestId) return false;
    console.error(error);
    ui['mode-device'].textContent = '车机质感';
    ui['mode-device-mobile'].textContent = '车机质感';
    setStatuses([['bad', '×', `车机质感预览失败：${error.message}`]]);
    showMessage(`车机质感预览失败：${error.message}`, 'error');
    return false;
  } finally {
    if (requestId === previewModeRequestId) {
      finishImportProgress();
      for (const id of ['mode-web', 'mode-device', 'mode-web-mobile', 'mode-device-mobile']) ui[id].disabled = false;
    }
  }
}
ui['mode-web'].addEventListener('click', () => setPreviewMode(false));
ui['mode-device'].addEventListener('click', () => setPreviewMode(true));
ui['mode-web-mobile'].addEventListener('click', () => setPreviewMode(false));
ui['mode-device-mobile'].addEventListener('click', () => setPreviewMode(true));

async function loadFile(file) {
  if (!file) return;
  if (!modelType) enterEditorForType('vehicle');
  const extension = file.name.toLowerCase().split('.').pop();
  if (!['glb', 'fbx', 'zip'].includes(extension)) {
    setStatuses([['bad', '×', '支持 GLB、glTF ZIP、FBX、FBX ZIP 和 OBJ ZIP']]);
    showMessage('文件格式不支持，请选择 GLB、glTF ZIP、FBX、FBX ZIP 或 OBJ ZIP', 'warning');
    return;
  }
  const previousName = ui['file-name'].textContent;
  beginFileLoad(file.name, '准备读取模型');
  try {
    const prepared = await prepareModelImport(file, ({ progress, label, indeterminate }) => {
      updateImportProgress({ progress: progress * 0.55, label, indeterminate });
    });
    await activatePreparedModel(prepared, {
      displayName: file.name,
      sourceFile: file,
      previewProgressStart: 0.55,
      previewProgressScale: 0.43,
    });
    showMessage('模型导入完成', 'success');
  } catch (error) {
    console.error(error);
    handleLoadFailure(error, previousName, '无法读取此模型');
  } finally {
    ui['model-file'].disabled = false;
    ui['model-file'].value = '';
    endFileLoad();
  }
}

async function loadProject(file) {
  if (!file) return;
  const openedFromHome = ui['editor-shell'].hidden || !modelType;
  const previousModelType = modelType;
  if (openedFromHome) {
    ui['model-type-home'].hidden = true;
    ui['editor-shell'].hidden = false;
    requestAnimationFrame(() => preview.resize());
  }
  const previousName = ui['file-name'].textContent;
  beginFileLoad(file.name, '准备打开项目');
  ui['project-file'].disabled = true;
  try {
    const project = await readProjectFile(file, ({ progress, label }) => {
      updateImportProgress({ progress: progress * 0.46, label });
    });
    modelType = normalizeModelType(project.metadata.modelType);
    updateModelTypeUi();
    const editorState = normalizeProjectState(project.editorState);
    const prepared = {
      bytes: project.modelBytes,
      name: project.metadata.modelName,
      sourceName: project.metadata.modelName,
      sourceFormat: project.metadata.sourceFormat,
      formatLabel: project.metadata.formatLabel,
      warnings: project.metadata.warnings,
      modelType,
      fromProject: true,
    };
    await activatePreparedModel(prepared, {
      displayName: project.metadata.displayName,
      sourceFile: file,
      editorState,
      previewProgressStart: 0.46,
      previewProgressScale: 0.51,
    });
    showMessage('项目进度已完整恢复', 'success');
  } catch (error) {
    console.error(error);
    handleLoadFailure(error, previousName, '无法打开此项目');
    if (openedFromHome && !current) {
      modelType = null;
      ui['editor-shell'].hidden = true;
      ui['model-type-home'].hidden = false;
    } else if (current) {
      modelType = normalizeModelType(previousModelType);
      updateModelTypeUi();
    }
  } finally {
    ui['project-file'].disabled = false;
    ui['project-file'].value = '';
    endFileLoad();
  }
}

async function activatePreparedModel(prepared, {
  displayName,
  sourceFile,
  editorState = null,
  previewProgressStart,
  previewProgressScale,
}) {
  const activeModelType = normalizeModelType(modelType || prepared.modelType);
  modelType = activeModelType;
  modelBrightness = normalizeModelBrightness(editorState?.modelBrightness ?? 1);
  renderModelBrightness();
  preview.setBrightness(modelBrightness);
  removeShadow = editorState?.removeShadow === true;
  ui['remove-shadow'].checked = removeShadow;
  preview.setRemoveShadow(removeShadow);
  updateModelTypeUi();
  // 站点导出的模型自带按动画显隐子网格的规则，先烘成标准动画通道，预览/导出/项目文件才一致
  prepared = { ...prepared, bytes: bakeSubmeshVisibility(prepared.bytes) };
  const loaded = await preview.load(prepared, ({ progress, label, indeterminate }) => {
    updateImportProgress({ progress: previewProgressStart + progress * previewProgressScale, label, indeterminate });
  }, { modelType: activeModelType });
  updateImportProgress({ progress: 0.98, label: '正在初始化编辑工具' });
  current = {
    ...prepared,
    ...loaded,
    file: { name: prepared.name, size: prepared.bytes.byteLength },
    sourceName: prepared.name,
    sourceFile,
    sourceFormat: prepared.sourceFormat,
    modelType: activeModelType,
  };
  bindableAnimations = activeModelType === 'other' ? preview.listBindableAnimations() : [];
  submeshes = listSubmeshes(preview.gltfJson);
  // 项目恢复时以项目里存的为准（restoreSnapshot 会覆盖）；新导入按命名规则给默认隐藏
  hiddenSubmeshes = editorState ? new Set() : recommendedHiddenSubmeshes(submeshes);
  applyHiddenSubmeshes();
  projectSaved = Boolean(editorState);
  ui['file-name'].textContent = displayName || prepared.name;
  setDirty(false);
  ui['rotation-x'].value = 0;
  ui['rotation-y'].value = loaded.orientation.rotationY;
  ui['rotation-z'].value = 0;
  markDevicePreviewStale();
  refreshParts();
  deletions = [];
  deleteDraft = null;
  undoStack.length = 0;
  redoStack.length = 0;
  syncUndoRedoButtons();
  ui['height-offset'].value = 0;
  preview.heightOffset = 0;
  treeQuery = '';
  expandedGroups = new Set();
  renderDeletePanel();
  resetBindings();
  ui['mode-web'].classList.add('active');
  ui['mode-device'].classList.remove('active');
  ui['mode-web-mobile'].classList.add('active');
  ui['mode-device-mobile'].classList.remove('active');
  ui['mode-device'].textContent = '车机质感';
  ui['mode-device-mobile'].textContent = '车机质感';
  ui['analysis-state'].textContent = editorState ? '项目已恢复' : '解析完成';
  ui['empty-state'].hidden = true;
  setControls(true);
  setActivePanel('model');
  updateSteps(3);
  ui['source-format-label'].textContent = prepared.fromProject
    ? `${prepared.formatLabel || 'GLB'} · 项目恢复`
    : prepared.sourceFormat === 'glb' ? 'GLB 2.0' : `${prepared.formatLabel} · 已统一为 GLB`;
  if (editorState) restoreSnapshot(editorState, { markDirty: false });
  validateStats(loaded.stats, loaded.orientation, prepared);
  setDirty(false);
  updateImportProgress({ progress: 1, label: editorState ? '项目恢复完成' : '模型导入完成' });
  if (!editorState && hiddenSubmeshes.size) {
    showMessage(`已自动剔除 ${hiddenSubmeshes.size} 个从不显示的子网格，可在「子网格显隐」里恢复`, 'info', { duration: 6000 });
  }
}

function beginFileLoad(displayName, label) {
  ui['file-name'].textContent = displayName;
  ui['analysis-state'].textContent = '解析中…';
  ui['model-file'].disabled = true;
  ui['project-file'].disabled = true;
  ui['open-project'].disabled = true;
  ui['inspector-open-project'].disabled = true;
  document.querySelector('.editor-shell').classList.add('is-importing');
  ui['empty-state'].hidden = true;
  updateImportProgress({ progress: 0.02, label });
  setStatuses([['warn', '…', '正在解析文件，请稍候']]);
}

function endFileLoad() {
  ui['model-file'].disabled = false;
  ui['project-file'].disabled = false;
  ui['open-project'].disabled = false;
  ui['inspector-open-project'].disabled = false;
  document.querySelector('.editor-shell').classList.remove('is-importing');
  finishImportProgress();
}

function handleLoadFailure(error, previousName, prefix) {
  if (current) {
    ui['file-name'].textContent = previousName;
    ui['analysis-state'].textContent = '当前项目未更改';
    setControls(true);
  } else {
    setDirty(false);
    ui['analysis-state'].textContent = '解析失败';
    setControls(false);
    updateSteps(0);
    ui['empty-state'].hidden = false;
  }
  setStatuses([['bad', '×', `${prefix}：${error.message || '文件结构无效'}`]]);
  showMessage(`${prefix}：${error.message || '文件结构无效'}`, 'error');
}

/**
 * 离开当前项目前的确认：给用户一个顺手保存的机会，而不是只警告"会丢失"。
 * 没有未保存修改时不打扰，直接放行。
 */
function confirmLeaveProject(action) {
  if (!current || !dirty) return Promise.resolve(true);
  ui['leave-dialog-message'].textContent = `${action}会关闭当前项目，而这里的修改还没有保存。`;
  ui['leave-dialog'].hidden = false;
  renderIcons();
  ui['leave-dialog-save'].focus();
  return new Promise((resolve) => {
    const finish = (result) => {
      ui['leave-dialog'].hidden = true;
      for (const [id, handler] of handlers) ui[id].removeEventListener('click', handler);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (event) => { if (event.key === 'Escape') finish(false); };
    const handlers = [
      ['leave-dialog-close', () => finish(false)],
      ['leave-dialog-cancel', () => finish(false)],
      ['leave-dialog-discard', () => finish(true)],
      ['leave-dialog-save', async () => finish(await saveProject())],
    ];
    for (const [id, handler] of handlers) ui[id].addEventListener('click', handler);
    document.addEventListener('keydown', onKey);
  });
}

function confirmReplaceCurrent() {
  return confirmLeaveProject('打开其他文件');
}

async function saveProject() {
  if (!current || !preview.model) return false;
  const buttons = [ui['save-project'], ui['mobile-save-project']];
  const labels = buttons.map((button) => button.innerHTML);
  let lastPercent = -1;
  buttons.forEach((button) => {
    button.disabled = true;
    button.classList.add('busy');
    button.innerHTML = '<span class="spinner"></span>';
  });
  ui['save-status'].classList.add('saving');
  ui['save-status'].textContent = '正在打包项目…';
  showMessage('正在打包项目文件…', 'info', { duration: 2500 });
  try {
    const result = await makeProjectFile({
      modelBytes: current.bytes,
      metadata: {
        displayName: ui['file-name'].textContent,
        modelName: current.sourceName || current.file.name,
        modelType: current.modelType || modelType || 'vehicle',
        sourceFormat: current.sourceFormat || 'glb',
        formatLabel: current.formatLabel || 'GLB',
        warnings: current.warnings || [],
      },
      editorState: captureSnapshot(),
    }, ({ progress, label }) => {
      const percent = Math.round(progress * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      buttons.forEach((button) => { button.title = `${label} ${percent}%`; });
      ui['save-status'].textContent = `${label} ${percent}%`;
    });
    const projectName = projectBaseName(ui['file-name'].textContent);
    downloadBytes(result.bytes, `${safeName(projectName)}.bydcarproj`);
    projectSaved = true;
    setDirty(false);
    showMessage(`项目已保存：${formatBytes(result.bytes.byteLength)}`, 'success');
    return true;
  } catch (error) {
    console.error(error);
    ui['save-status'].classList.remove('saving');
    ui['save-status'].classList.add('error');
    ui['save-status'].textContent = '项目保存失败';
    showMessage(`项目保存失败：${error.message || '未知错误'}`, 'error');
    return false;
  } finally {
    buttons.forEach((button, index) => {
      button.disabled = !current;
      button.classList.remove('busy');
      button.innerHTML = labels[index];
      button.title = index === 0 ? '保存项目 (Ctrl+S)' : '保存项目';
    });
    if (!dirty && projectSaved) ui['save-status'].classList.remove('saving', 'error');
    renderIcons();
  }
}

function normalizeProjectState(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('项目缺少有效的编辑进度');
  const transform = raw.transform;
  if (!validNumberArray(transform?.translation, 3)
    || !validNumberArray(transform?.rotation, 4)
    || !validNumberArray(transform?.scale, 3)) {
    throw new Error('项目中的模型变换数据无效');
  }
  let bindingsState = Array.isArray(raw.bindings) ? raw.bindings.filter((entry) => (
    Array.isArray(entry) && SLOT_BY_ID.has(entry[0]) && entry[1] && typeof entry[1] === 'object'
  )).map(([id, binding]) => [id, structuredClone(binding)]) : [];
  if (modelType === 'other') {
    const front = bindingsState.find(([id]) => id === 'CS_WF');
    const rear = bindingsState.find(([id]) => id === 'CS_WB');
    const forward = front || (rear && ['CS_WF', { ...rear[1], slotId: 'CS_WF' }]);
    bindingsState = bindingsState.filter(([id]) => id !== 'CS_WF' && id !== 'CS_WB');
    if (forward) bindingsState.push(forward);
    // 旧项目的「待机 + 停车后 n 秒触发」就是现在的久停：延迟大于 0 的整条搬到久停，行为和以前一致；
    // CS_Idle 从此叫「停车」、停车立即触发，留给用户重新绑一个站立动作
    const idle = bindingsState.find(([id]) => id === 'CS_Idle');
    if (idle && Number(idle[1].triggerDelaySeconds) > 0 && !bindingsState.some(([id]) => id === 'CS_Parked')) {
      bindingsState = bindingsState.filter(([id]) => id !== 'CS_Idle');
      // 旧待机的默认优先级 0 会和现在的停车同级，搬过去时换成久停的默认值；用户自己调过的保留
      const priority = Number(idle[1].priority) === 0 ? undefined : idle[1].priority;
      bindingsState.push(['CS_Parked', { ...idle[1], slotId: 'CS_Parked', priority: normalizeEventPriority('CS_Parked', priority) }]);
      if (raw.openSlot === 'CS_Idle') raw = { ...raw, openSlot: 'CS_Parked' };
    }
  }
  const knownSlots = new Set(bindingsState.map(([id]) => id));
  const requestedPanel = ['model', 'binding', 'check'].includes(raw.activePanel) ? raw.activePanel : 'model';
  const requestedOpenSlot = modelType === 'other' && raw.openSlot === 'CS_WB' ? 'CS_WF' : raw.openSlot;
  const openSlotValue = knownSlots.has(requestedOpenSlot) ? requestedOpenSlot : null;
  const activePanelValue = requestedPanel === 'binding' && !openSlotValue ? 'model' : requestedPanel;
  const requestedSelectionSlot = modelType === 'other' && raw.selectionEditingSlot === 'CS_WB'
    ? 'CS_WF'
    : raw.selectionEditingSlot;
  const selectionEditingValue = openSlotValue && requestedSelectionSlot === openSlotValue
    ? openSlotValue
    : null;
  const qualitySelected = ['smooth', 'balanced', 'high', 'original', 'custom'].includes(raw.quality?.selected)
    ? raw.quality.selected
    : 'original';
  return {
    bindings: bindingsState,
    deletions: Array.isArray(raw.deletions) ? structuredClone(raw.deletions) : [],
    hiddenSubmeshes: Array.isArray(raw.hiddenSubmeshes) ? raw.hiddenSubmeshes.filter(Number.isInteger) : [],
    rotation: validNumberArray(raw.rotation, 3) ? raw.rotation.map(Number) : [0, 0, 0],
    targetLength: finiteNumber(raw.targetLength, 5.2),
    heightOffset: finiteNumber(raw.heightOffset, 0),
    modelBrightness: normalizeModelBrightness(raw.modelBrightness),
    removeShadow: raw.removeShadow === true,
    transform: structuredClone(transform),
    activePanel: activePanelValue,
    openSlot: openSlotValue,
    regionMode: ['translate', 'scale'].includes(raw.regionMode) ? raw.regionMode : 'translate',
    selectionEditingSlot: selectionEditingValue,
    selectionTool: {
      mode: ['smart', 'brush'].includes(raw.selectionTool?.mode) ? raw.selectionTool.mode : 'smart',
      operation: ['add', 'subtract'].includes(raw.selectionTool?.operation) ? raw.selectionTool.operation : 'add',
      visibleOnly: raw.selectionTool?.visibleOnly !== false,
      radius: finiteNumber(raw.selectionTool?.radius, 28),
      angle: finiteNumber(raw.selectionTool?.angle, 38),
    },
    quality: {
      selected: qualitySelected,
      custom: {
        triangleTarget: finiteNumber(raw.quality?.custom?.triangleTarget, 300000),
        textureMaxSize: finiteNumber(raw.quality?.custom?.textureMaxSize, 4096),
      },
    },
  };
}

function validNumberArray(value, length) {
  return Array.isArray(value) && value.length === length && value.every((item) => Number.isFinite(Number(item)));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function projectBaseName(value) {
  return String(value || 'custom-model').replace(/(?:\.(?:glb|gltf|fbx|obj|zip|bydcarproj))+$/i, '') || 'custom-model';
}

function downloadBytes(bytes, fileName) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

function validateStats(stats, orientation, importInfo = null) {
  const results = [];
  if (importInfo?.fromProject) results.push(['good', '✓', '已恢复模型调整、删除区域、联动选区和导出质量']);
  if (stats.triangles > 300000) results.push(['warn', '!', `三角形较多（${stats.triangles.toLocaleString()}），原始档会完整保留，可按需要选择其他质量档位`]);
  else if (stats.triangles > 60000) results.push(['warn', '!', `三角形较多（${stats.triangles.toLocaleString()}），可按车机性能选择导出质量`]);
  else results.push(['good', '✓', `三角形数量适合车机（${stats.triangles.toLocaleString()}）`]);

  results.push(['good', '✓', `材质数量 ${stats.materials} 个（不限制）`]);

  if (stats.skinned && modelType === 'other') results.push(['good', '✓', '检测到骨骼蒙皮，其他模型模式会保留骨架与已绑定动画']);
  else if (stats.skinned) results.push(['warn', '!', '检测到骨骼蒙皮，车辆模式仍使用当前静态姿态']);
  if (stats.morphs) results.push(['warn', '!', '检测到 Morph，车机导出仍使用当前静态形状']);
  if (stats.animations && modelType === 'other') {
    if (bindableAnimations.length) results.push(['good', '✓', `检测到 ${stats.animations} 段模型动画，其中 ${bindableAnimations.length} 段可绑定到联动事件`]);
    else results.push(['warn', '!', `检测到 ${stats.animations} 段模型动画，但没有可用的 TRS 动画`]);
  } else if (stats.animations) {
    results.push(['warn', '!', `检测到 ${stats.animations} 段模型动画，车辆模式仍使用编辑器生成的标准联动动画`]);
  }
  if (modelType === 'other') {
    results.push(['good', '✓', '其他模型已保持导入时的原始朝向，可在预览中手动调整']);
  } else if (orientation?.detected && orientation.method === 'semantic') {
    results.push(['good', '✓', `已自动识别模型正面并对齐车头（Y ${orientation.rotationY}°，${orientation.reason}）`]);
  } else if (orientation?.detected) {
    results.push(['warn', '!', `已按车辆轮廓推测正面并对齐车头（Y ${orientation.rotationY}°），请在预览中确认`]);
  } else {
    results.push(['warn', '!', '未能从部件中可靠识别正面，已按常见模型约定默认左转 90°（Y 270°），可在预览中手动校正']);
  }
  if (importInfo?.sourceFormat && importInfo.sourceFormat !== 'glb') {
    results.push(['good', '✓', `${importInfo.formatLabel} 已转换为内嵌资源 GLB，后续编辑与导出使用统一几何`]);
  }
  for (const warning of importInfo?.warnings || []) results.push(['warn', '!', warning]);
  results.push(['good', '✓', '模型结构已完成解析']);
  setStatuses(results);
  ui.generate.disabled = false;
  ui['mobile-generate'].disabled = false;
  document.getElementById('mobile-generate-shortcut').disabled = false;
  ui.generate.title = '生成车模包';
}

function setStatuses(items) {
  ui['status-list'].innerHTML = items.map(([kind, icon, text]) => status(kind, icon, text)).join('');
}

function setControls(enabled) {
  for (const id of [
    'rotation-x', 'rotation-y', 'rotation-z', 'target-length', 'height-offset',
    'model-brightness', 'remove-shadow',
  ]) ui[id].disabled = !enabled;
  ui.generate.disabled = !enabled;
  ui['mobile-generate'].disabled = !enabled;
  document.getElementById('mobile-generate-shortcut').disabled = !enabled;
  ui['save-project'].disabled = !enabled;
  ui['mobile-save-project'].disabled = !enabled;
  for (const id of ['mode-web', 'mode-device', 'mode-web-mobile', 'mode-device-mobile']) ui[id].disabled = !enabled;
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
  modelBrightness = 1;
  renderModelBrightness();
  preview.setBrightness(modelBrightness);
  updateRotation();
  markDevicePreviewStale();
  refreshDevicePreviewForQuality();
  preview.view('perspective');
}

/* ---------- 联动配置 ---------- */

const bindings = new Map();
let bindableAnimations = [];
let parts = [];
let partGroups = [];
let openSlot = null;
let regionMode = 'translate';
let demoRun = null;
let pickingFor = null;
let selectionEditingSlot = null;
let selectionLast = emptySelection();
let selectionLastStrokeId = null;
let previewSelectionMode = 'smart';
let previewSelectionOperation = 'add';
let previewSelectionVisibleOnly = true;
let previewSelectionRadius = 28;
let previewSelectionAngle = 38;
let treeQuery = '';
let expandedGroups = new Set();
const partTreeScrollBySlot = new Map();
let pendingPartTreeReveal = null;

function sourceAnimationByIndex(index) {
  return bindableAnimations.find((animation) => animation.index === Number(index)) || null;
}

function actionUsesPivot(actionKind) {
  return actionKind === 'hinge' || actionKind === 'spin';
}

function sourceAnimationBindingValid(binding) {
  return Boolean(binding && Number.isInteger(binding.sourceAnimationIndex)
    && sourceAnimationByIndex(binding.sourceAnimationIndex));
}

function refreshBindingPreviewAfterExportChange(phase = 'on') {
  if (!preview.deviceMode) {
    playCurrentBinding(phase);
    return;
  }
  // 车机质感播放的是最终导出 GLB；配置变化后必须先重烘焙，
  // 否则当前模型里还不存在刚选择或刚修改的 BYD_EVT_* 动画。
  preview.stopBindingPreview();
  void setPreviewMode(true, { bindingPhase: phase });
}

/** 把变体列表写回绑定，同时把第 0 条同步到 sourceAnimation*，预览和旧车机都按它走。 */
function commitVariants(slot, variants) {
  const binding = bindings.get(slot.id);
  if (!binding || !variants.length) return;
  const head = variants[0];
  const animation = sourceAnimationByIndex(head.index);
  binding.variants = variants.map((item) => ({ ...item }));
  binding.sourceAnimationIndex = head.index;
  binding.sourceAnimationName = head.name;
  binding.sourceName = `模型动画：${head.name}`;
  if (animation) binding.nodeIndices = [...animation.nodeIndices];
  setDirty();
  markDevicePreviewStale();
  renderBindings();
  refreshBindingPreviewAfterExportChange();
}

function addVariantAnimation(slot, value) {
  const animation = sourceAnimationByIndex(value);
  const binding = bindings.get(slot.id);
  if (!animation || !binding) return;
  const variants = eventVariantsOf(binding);
  if (variants.some((item) => item.index === animation.index)) {
    showMessage('这个动画已经在列表里了', 'warning', { duration: 3000 });
    return;
  }
  if (variants.length >= MAX_EVENT_VARIANTS) {
    showMessage(`一个事件最多挂 ${MAX_EVENT_VARIANTS} 个动画`, 'warning', { duration: 3500 });
    return;
  }
  snapshot();
  // 新加的动画默认与现有的等概率
  const total = variants.reduce((sum, item) => sum + item.weight, 0);
  const weight = normalizeVariantWeight(Math.round(total / variants.length));
  commitVariants(slot, [...variants, { index: animation.index, name: animation.name, weight }]);
  playVariant(slot, animation.index);
}

function removeVariantAnimation(slot, index) {
  const binding = bindings.get(slot.id);
  if (!binding) return;
  const variants = eventVariantsOf(binding).filter((item) => item.index !== index);
  snapshot();
  if (!variants.length) {
    bindings.delete(slot.id);
    preview.stopBindingPreview();
    setDirty();
    markDevicePreviewStale();
    renderBindings();
    refreshBindingPreviewAfterExportChange();
    return;
  }
  commitVariants(slot, variants);
}

/** 改某条动画的转向后立即播它一遍，能直接看到转身效果。 */
function updateVariantYaw(slot, index, value) {
  const binding = bindings.get(slot.id);
  if (!binding) return;
  const variants = eventVariantsOf(binding);
  const target = variants.find((item) => item.index === index);
  const yaw = normalizeYawDegrees(value);
  if (!target || target.yaw === yaw) return;
  snapshot({ scope: 'variant-yaw', slotId: slot.id });
  target.yaw = yaw;
  commitVariants(slot, variants);
  playVariant(slot, index);
}

function updateVariantReroll(slot, index, value) {
  const binding = bindings.get(slot.id);
  if (!binding) return;
  const variants = eventVariantsOf(binding);
  const target = variants.find((item) => item.index === index);
  const cycles = normalizeRerollCycles(value);
  if (!target || target.rerollCycles === cycles) return;
  snapshot({ scope: 'variant-reroll', slotId: slot.id });
  target.rerollCycles = cycles;
  commitVariants(slot, variants);
}

function updateVariantWeights(slot) {
  const binding = bindings.get(slot.id);
  if (!binding) return;
  const variants = eventVariantsOf(binding);
  let changed = false;
  const next = variants.map((item) => {
    const input = document.getElementById(`variant-weight-${item.index}`);
    if (!input) return item;
    const weight = normalizeVariantWeight(input.value);
    if (weight !== item.weight) changed = true;
    return { ...item, weight };
  });
  if (!changed) return;
  snapshot({ scope: 'variant-weight', slotId: slot.id });
  commitVariants(slot, next);
}

function setSourceAnimationBinding(slot, value) {
  const animation = sourceAnimationByIndex(value);
  const existing = bindings.get(slot.id);
  if (!animation) {
    if (!existing) return;
    snapshot();
    bindings.delete(slot.id);
    preview.stopBindingPreview();
    setDirty();
    markDevicePreviewStale();
    renderBindings();
    refreshBindingPreviewAfterExportChange();
    return;
  }
  snapshot();
  bindings.set(slot.id, {
    slotId: slot.id,
    sourceAnimationIndex: animation.index,
    sourceAnimationName: animation.name,
    sourceName: `模型动画：${animation.name}`,
    nodeIndices: [...animation.nodeIndices],
    variants: [{ index: animation.index, name: animation.name, weight: 10 }],
    playback: normalizeOtherPlayback(slot, existing?.playback),
    priority: normalizeEventPriority(slot, existing?.priority),
    ...(slot.id === 'CS_Parked' ? {
      triggerDelaySeconds: normalizeIdleDelaySeconds(existing?.triggerDelaySeconds),
    } : {}),
  });
  setDirty();
  markDevicePreviewStale();
  renderBindings();
  refreshBindingPreviewAfterExportChange();
}

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

const MESSAGE_ICONS = {
  success: 'check-circle-2',
  warning: 'alert-triangle',
  error: 'alert-circle',
  info: 'info',
};
const MESSAGE_TITLES = {
  success: '操作成功',
  warning: '请检查',
  error: '操作失败',
  info: '提示',
};
const recentMessages = new Map();

function showMessage(message, type = 'info', { duration } = {}) {
  const text = String(message || '发生未知错误').trim();
  const kind = Object.hasOwn(MESSAGE_ICONS, type) ? type : 'info';
  const now = Date.now();
  const duplicateKey = `${kind}:${text}`;
  if (now - (recentMessages.get(duplicateKey) || 0) < 900) return null;
  recentMessages.set(duplicateKey, now);

  let stack = document.getElementById('message-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'message-stack';
    stack.className = 'message-stack';
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  while (stack.children.length >= 5) stack.firstElementChild?.remove();

  const element = document.createElement('div');
  element.className = `app-message ${kind}`;
  element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', MESSAGE_ICONS[kind]);
  icon.className = 'message-icon';
  const content = document.createElement('div');
  content.className = 'message-copy';
  const title = document.createElement('strong');
  title.textContent = MESSAGE_TITLES[kind];
  const copy = document.createElement('span');
  copy.textContent = text;
  content.append(title, copy);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'message-close';
  closeButton.title = '关闭';
  closeButton.innerHTML = '<i data-lucide="x"></i>';
  element.append(icon, content, closeButton);
  stack.appendChild(element);
  renderIcons();
  requestAnimationFrame(() => element.classList.add('show'));

  let timer = null;
  const close = () => {
    clearTimeout(timer);
    element.classList.remove('show');
    window.setTimeout(() => {
      element.remove();
      if (!stack.children.length) stack.remove();
    }, 180);
  };
  closeButton.addEventListener('click', close);
  const timeout = duration ?? (kind === 'error' ? 0 : kind === 'warning' ? 9000 : 5000);
  if (timeout > 0) timer = window.setTimeout(close, timeout);
  return { close };
}

window.addEventListener('error', (event) => {
  const message = event.error?.message || event.message;
  if (message) showMessage(`运行错误：${message}`, 'error');
});

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason?.message || event.reason;
  showMessage(`操作失败：${message || '未知 Promise 错误'}`, 'error');
});

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

const HISTORY_LIMIT = 80;
const undoStack = [];
const redoStack = [];

function captureSnapshot() {
  return {
    bindings: [...bindings.entries()].map(([id, binding]) => [id, structuredClone(binding)]),
    deletions: structuredClone(deletions),
    hiddenSubmeshes: [...hiddenSubmeshes],
    rotation: ['x', 'y', 'z'].map((axis) => Number(ui[`rotation-${axis}`].value) || 0),
    targetLength: Number(ui['target-length'].value) || 5.2,
    heightOffset: Number(ui['height-offset'].value) || 0,
    modelBrightness,
    removeShadow,
    transform: preview.getExportTransform(),
    activePanel,
    openSlot,
    regionMode,
    selectionEditingSlot,
    selectionTool: {
      mode: previewSelectionMode,
      operation: previewSelectionOperation,
      visibleOnly: previewSelectionVisibleOnly,
      radius: previewSelectionRadius,
      angle: previewSelectionAngle,
    },
    quality: {
      selected: selectedQuality,
      custom: structuredClone(customQuality),
    },
  };
}

function pushHistory(state, meta = {}) {
  if (!state) return;
  undoStack.push({ state, meta });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  syncUndoRedoButtons();
  setDirty();
  markDevicePreviewStale();
}

/** 在每个会改变配置的操作之前调用，把当前完整状态压栈。 */
function snapshot(meta = {}) {
  pushHistory(captureSnapshot(), meta);
}

function historyEntryMatchesSelection(entry, slotId = selectionEditingSlot) {
  return Boolean(
    slotId
    && entry?.meta?.scope === 'selection'
    && entry.meta.slotId === slotId,
  );
}

function syncUndoRedoButtons() {
  ui.undo.disabled = undoStack.length === 0;
  ui.redo.disabled = redoStack.length === 0;
  const localUndo = document.getElementById('selection-undo');
  const localRedo = document.getElementById('selection-redo');
  if (localUndo) localUndo.disabled = !historyEntryMatchesSelection(undoStack.at(-1), openSlot);
  if (localRedo) localRedo.disabled = !historyEntryMatchesSelection(redoStack.at(-1), openSlot);
  ui.undo.title = historyEntryMatchesSelection(undoStack.at(-1)) ? '撤销上一笔选面' : '撤销';
  ui.redo.title = historyEntryMatchesSelection(redoStack.at(-1)) ? '重做上一笔选面' : '重做';
}

/** 连续输入在聚焦期间只记录一次编辑前状态，避免每个字符都占一个撤销步骤。 */
function wireContinuousHistory(input, meta = {}) {
  if (!input || input.dataset.historyWired === 'true') return;
  input.dataset.historyWired = 'true';
  let baseline = null;
  let recorded = false;
  const begin = () => {
    if (!current || baseline) return;
    baseline = captureSnapshot();
    recorded = false;
  };
  const record = () => {
    if (!current || recorded) return;
    if (!baseline) baseline = captureSnapshot();
    pushHistory(baseline, meta);
    recorded = true;
  };
  const finish = () => {
    baseline = null;
    recorded = false;
  };
  input.addEventListener('focus', begin);
  input.addEventListener('pointerdown', begin);
  input.addEventListener('keydown', begin);
  input.addEventListener('beforeinput', begin);
  input.addEventListener('input', record);
  input.addEventListener('change', finish);
  input.addEventListener('blur', finish);
}

function restoreSnapshot(snap, { markDirty = true } = {}) {
  if (!snap) return;
  stopDemo();
  cancelDeleteDraft(true);
  closePreviewTools();
  bindings.clear();
  for (const [id, binding] of snap.bindings) bindings.set(id, binding);
  deletions = snap.deletions;
  hiddenSubmeshes = new Set(snap.hiddenSubmeshes || []);
  applyHiddenSubmeshes();
  ['x', 'y', 'z'].forEach((axis, i) => {
    ui[`rotation-${axis}`].value = snap.rotation[i];
    preview.rotation[axis] = snap.rotation[i];
  });
  ui['target-length'].value = snap.targetLength;
  preview.targetLength = snap.targetLength;
  ui['height-offset'].value = snap.heightOffset;
  preview.heightOffset = snap.heightOffset;
  modelBrightness = normalizeModelBrightness(snap.modelBrightness);
  renderModelBrightness();
  preview.setBrightness(modelBrightness);
  removeShadow = snap.removeShadow === true;
  ui['remove-shadow'].checked = removeShadow;
  preview.setRemoveShadow(removeShadow);
  if (snap.selectionTool) {
    previewSelectionMode = snap.selectionTool.mode || 'smart';
    previewSelectionOperation = snap.selectionTool.operation || 'add';
    previewSelectionVisibleOnly = snap.selectionTool.visibleOnly !== false;
    previewSelectionRadius = Number(snap.selectionTool.radius) || 28;
    previewSelectionAngle = Number(snap.selectionTool.angle) || 38;
  }
  // 直接还原快照时刻的模型矩阵——删除框/选区/旋转中心都是与它配套的世界坐标，
  // 不能经 normalize 重新推导（落地缩放会随删除后的几何变化而漂移）
  preview.setTransform(snap.transform);
  preview.setDeletions(deletions.map((item) => item.region));
  if (snap.quality) {
    selectedQuality = snap.quality.selected || 'original';
    customQuality.triangleTarget = snap.quality.custom?.triangleTarget ?? customQuality.triangleTarget;
    customQuality.textureMaxSize = snap.quality.custom?.textureMaxSize ?? customQuality.textureMaxSize;
    for (const id of ['quality-triangles', 'generate-quality-triangles']) ui[id].value = customQuality.triangleTarget;
    for (const id of ['quality-texture-size', 'generate-quality-texture-size']) ui[id].value = customQuality.textureMaxSize;
    renderQualityControls();
  }
  refreshParts();
  openSlot = snap.openSlot;
  regionMode = snap.regionMode || 'translate';
  const resumeFineSelection = Boolean(
    openSlot
    && snap.selectionEditingSlot === openSlot
    && bindings.get(openSlot)?.selection,
  );
  selectionEditingSlot = resumeFineSelection ? openSlot : null;
  renderDeletePanel();
  renderBindings();
  setActivePanel(snap.activePanel || (openSlot ? 'binding' : 'model'));
  if (activePanel === 'binding' && openSlot) {
    const slot = activeSlot(openSlot);
    const binding = bindings.get(openSlot);
    if (binding?.region) openRegionBox(slot);
    else if (binding?.selection && resumeFineSelection && !preview.selectionState) startFineSelection(slot, { preserveState: true });
    else if (binding) playCurrentBinding();
  }
  setDirty(markDirty);
  markDevicePreviewStale();
  syncUndoRedoButtons();
  refreshDevicePreviewForQuality();
}

function undo() {
  const entry = undoStack.pop();
  if (!entry) return;
  redoStack.push({ state: captureSnapshot(), meta: entry.meta });
  restoreSnapshot(entry.state);
  syncUndoRedoButtons();
}

function redo() {
  const entry = redoStack.pop();
  if (!entry) return;
  undoStack.push({ state: captureSnapshot(), meta: entry.meta });
  restoreSnapshot(entry.state);
  syncUndoRedoButtons();
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

/* ---------- 组合动画 ---------- */

let comboDraft = null;
let comboPlaying = null; // { index }：单段试播；{ sequence: true }：整段试播

function comboLoopTail() {
  return document.querySelector('input[name="combo-ending"]:checked')?.value === 'loop';
}

function comboBlendMs() {
  if (document.querySelector('input[name="combo-blend"]:checked')?.value !== 'smooth') return 0;
  return Math.min(1000, Math.max(10, Math.round(Number(ui['combo-blend'].value) || 150)));
}

function isCombinedAnimation(index) {
  return Boolean(preview.gltfJson?.animations?.[index]?.extras?.bydCombined);
}

function animationLabel(index) {
  return preview.gltfJson?.animations?.[index]?.name || `动画 ${index + 1}`;
}

function openComboDialog() {
  comboDraft = { segments: [] };
  comboPlaying = null;
  ui['combo-name'].value = '';
  ui['combo-blend'].value = '150';
  document.querySelector('input[name="combo-ending"][value="end"]').checked = true;
  document.querySelector('input[name="combo-blend"][value="cut"]').checked = true;
  ui['combo-blend-ms'].hidden = true;
  renderComboDialog();
  ui['combo-dialog'].hidden = false;
}

function closeComboDialog() {
  if (ui['combo-dialog'].hidden) return;
  stopComboPlayback();
  ui['combo-dialog'].hidden = true;
  comboDraft = null;
  playCurrentBinding();
}

/** 点到哪段就在视口里循环播哪段，看清楚再决定加不加。 */
function playComboClip(index) {
  comboPlaying = { index };
  preview.previewAnimationSequence([index], 0);
  renderComboDialog();
}

/** 试播/合成共用的展开顺序：每段按重复次数展开，最后一段若无限循环则只展开一次。 */
function comboEntries(segments, loopTail) {
  return segments.flatMap((segment, order) => Array.from(
    { length: loopTail && order === segments.length - 1 ? 1 : segment.repeat },
    () => segment.index,
  ));
}

function toggleComboSequence() {
  if (comboPlaying?.sequence) {
    stopComboPlayback();
    return;
  }
  if (!comboDraft?.segments.length) return;
  comboPlaying = { sequence: true };
  const loopTail = comboLoopTail();
  preview.previewAnimationSequence(comboEntries(comboDraft.segments, loopTail), comboBlendMs(), { loopLast: loopTail });
  renderComboDialog();
}

function stopComboPlayback() {
  comboPlaying = null;
  preview.stopBindingPreview();
  if (comboDraft) renderComboDialog();
}

function comboRow(index, { label = animationLabel(index), note = '', controls = '' } = {}) {
  const active = comboPlaying?.index === index;
  return `<div class="combo-segment${active ? ' active' : ''}" data-combo-play="${index}" title="${escapeHtml(label)}${note ? `：${escapeHtml(note)}` : ''}">
    <span>${escapeHtml(label)}${note ? `<em>${escapeHtml(note)}</em>` : ''}</span>${controls}
  </div>`;
}

/** 顺序下面的一句话说明：合成后会是什么样、多长。 */
function comboSummary(segments, loopTail, blendMs) {
  if (!segments.length) return '';
  const secondsOf = (index) => sourceAnimationByIndex(index)?.duration || 0;
  const gaps = Math.max(0, segments.reduce((sum, segment) => sum + segment.repeat, 0) - 1) * blendMs / 1000;
  if (loopTail) {
    const intro = segments.slice(0, -1).reduce((sum, segment) => sum + secondsOf(segment.index) * segment.repeat, 0) + gaps;
    const tail = segments[segments.length - 1];
    return segments.length === 1
      ? `合成后：${animationLabel(tail.index)} 一直循环`
      : `合成后：先播前奏约 ${intro.toFixed(1)} 秒，然后 ${animationLabel(tail.index)} 一直循环，直到车机换下一条动画`;
  }
  const total = segments.reduce((sum, segment) => sum + secondsOf(segment.index) * segment.repeat, 0) + gaps;
  return `合成后共约 ${total.toFixed(1)} 秒，播完就结束`;
}

function renderComboDialog() {
  const { segments } = comboDraft;
  const durationOf = (index) => {
    const item = sourceAnimationByIndex(index);
    return item?.duration ? `${item.duration.toFixed(2)} 秒` : '';
  };
  // 重绘列表时保住滚动位置，不然每点一下都跳回顶部
  const scrollTops = ['combo-library', 'combo-segments', 'combo-existing'].map((id) => [id, ui[id].scrollTop]);
  ui['combo-library'].innerHTML = bindableAnimations
    .filter((animation) => !isCombinedAnimation(animation.index))
    .map((animation) => comboRow(animation.index, {
      note: durationOf(animation.index),
      controls: `<button class="icon-btn" data-combo-add="${animation.index}" type="button" title="加入片段">＋</button>`,
    }))
    .join('');
  const loopTail = comboLoopTail();
  ui['combo-segments'].innerHTML = segments.length
    ? segments.map(({ index, repeat }, order) => {
      const infinite = loopTail && order === segments.length - 1;
      return comboRow(index, {
        label: `${order + 1}. ${animationLabel(index)}`,
        controls: `
        ${infinite
          ? '<span class="combo-repeat combo-repeat-infinite" title="最后一段一直循环">一直循环</span>'
          : `<span class="combo-repeat" title="这段连播几次">播 <input data-combo-repeat="${order}" type="number" min="1" max="20" value="${repeat}" /> 次</span>`}
        <button class="icon-btn" data-combo-move="${order}:-1" type="button" title="上移"${order === 0 ? ' disabled' : ''}>▲</button>
        <button class="icon-btn" data-combo-move="${order}:1" type="button" title="下移"${order === segments.length - 1 ? ' disabled' : ''}>▼</button>
        <button class="icon-btn" data-combo-remove="${order}" type="button" title="移除">✕</button>`,
      });
    }).join('')
    : '<p class="hint">还没有片段：从上面的列表里按 ＋ 加入。</p>';
  ui['combo-summary'].textContent = comboSummary(segments, loopTail, comboBlendMs());
  const combos = (preview.gltfJson?.animations || [])
    .map((animation, index) => ({ animation, index }))
    .filter(({ animation }) => animation.extras?.bydCombined);
  const describe = ({ segments: parts, blendMs, loopTail: tailLoops }) => normalizeComboSegments(parts)
    .map((segment, order, list) => `${animationLabel(segment.index)}${tailLoops && order === list.length - 1 ? '（一直循环）' : segment.repeat > 1 ? ` ×${segment.repeat}` : ''}`)
    .join(' → ') + (blendMs ? ` · 平滑过渡 ${blendMs} 毫秒` : '');
  ui['combo-existing'].innerHTML = combos.length
    ? combos.map(({ animation, index }) => comboRow(index, {
      label: animation.name,
      note: describe(animation.extras.bydCombined),
      controls: `<button class="icon-btn" data-combo-delete="${index}" type="button" title="删除这段组合动画">✕</button>`,
    })).join('')
    : '<p class="hint">当前模型还没有组合动画。</p>';
  for (const [id, top] of scrollTops) ui[id].scrollTop = top;
  ui['combo-status'].textContent = comboPlaying?.sequence
    ? `试播中：${segments.map(({ index }) => animationLabel(index)).join(' → ')}${loopTail ? '（最后一段一直循环）' : ''}`
    : comboPlaying ? `正在播放：${animationLabel(comboPlaying.index)}` : '点任意动画即可在视口里播放，模型可以随意旋转查看。';
  ui['combo-dialog-confirm'].disabled = segments.length < 2;
  ui['combo-dialog-preview'].disabled = !segments.length;
  ui['combo-dialog-preview'].querySelector('span').textContent = comboPlaying?.sequence ? '停止试播' : '试播整段';
  const dialog = ui['combo-dialog'];
  dialog.querySelectorAll('[data-combo-play]').forEach((row) => row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    playComboClip(Number(row.dataset.comboPlay));
  }));
  dialog.querySelectorAll('[data-combo-add]').forEach((button) => button.addEventListener('click', () => {
    segments.push({ index: Number(button.dataset.comboAdd), repeat: 1 });
    playComboClip(Number(button.dataset.comboAdd));
  }));
  dialog.querySelectorAll('[data-combo-repeat]').forEach((input) => {
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('change', () => {
      segments[Number(input.dataset.comboRepeat)].repeat = normalizeComboSegments([{ index: 0, repeat: input.value }])[0].repeat;
      renderComboDialog();
    });
  });
  dialog.querySelectorAll('[data-combo-move]').forEach((button) => button.addEventListener('click', () => {
    const [order, delta] = button.dataset.comboMove.split(':').map(Number);
    [segments[order], segments[order + delta]] = [segments[order + delta], segments[order]];
    renderComboDialog();
  }));
  dialog.querySelectorAll('[data-combo-remove]').forEach((button) => button.addEventListener('click', () => {
    segments.splice(Number(button.dataset.comboRemove), 1);
    renderComboDialog();
  }));
  dialog.querySelectorAll('[data-combo-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteCombinedAnimation(Number(button.dataset.comboDelete)));
  });
}

for (const id of ['combo-dialog-close', 'combo-dialog-cancel']) ui[id].addEventListener('click', closeComboDialog);
ui['combo-dialog'].addEventListener('keydown', (event) => { if (event.key === 'Escape') closeComboDialog(); });
ui['combo-dialog-confirm'].addEventListener('click', createCombinedAnimation);
ui['combo-dialog-preview'].addEventListener('click', toggleComboSequence);
document.querySelectorAll('input[name="combo-ending"], input[name="combo-blend"]').forEach((input) => {
  input.addEventListener('change', () => {
    ui['combo-blend-ms'].hidden = document.querySelector('input[name="combo-blend"]:checked')?.value !== 'smooth';
    if (comboDraft) renderComboDialog();
  });
});
ui['combo-blend'].addEventListener('change', () => { if (comboDraft) renderComboDialog(); });

async function createCombinedAnimation() {
  if (!current || !comboDraft || comboDraft.segments.length < 2) return;
  const existing = (preview.gltfJson?.animations || []).filter((animation) => animation.extras?.bydCombined).length;
  const name = ui['combo-name'].value.trim() || `组合动画 ${existing + 1}`;
  const blendMs = comboBlendMs();
  const loopTail = comboLoopTail();
  const segments = comboDraft.segments.map((segment) => ({ ...segment }));
  const slotId = openSlot;
  const nextIndex = preview.gltfJson.animations.length;
  closeComboDialog();
  if (!(await materializeAnimations(() => combineAnimations(current.bytes, { name, segments, blendMs, loopTail }), '正在生成组合动画'))) return;
  // 从哪个事件点开的就挂到哪个事件上，和在下拉里选一个动画的行为一致
  const slot = slotId && activeSlot(slotId);
  if (slot && sourceAnimationByIndex(nextIndex)) {
    if (sourceAnimationBindingValid(bindings.get(slot.id))) addVariantAnimation(slot, nextIndex);
    else setSourceAnimationBinding(slot, nextIndex);
  }
  showMessage(`组合动画「${name}」已生成`, 'success');
}

async function deleteCombinedAnimation(index) {
  if (!current) return;
  closeComboDialog();
  // 后面的动画下标会前移，已绑定的引用要跟着改；引用被删动画的绑定项直接去掉
  for (const [slotId, binding] of [...bindings.entries()]) {
    const variants = eventVariantsOf(binding)
      .filter((item) => item.index !== index)
      .map((item) => ({ ...item, index: item.index > index ? item.index - 1 : item.index }));
    if (!variants.length) {
      bindings.delete(slotId);
      continue;
    }
    binding.variants = variants;
    binding.sourceAnimationIndex = variants[0].index;
    binding.sourceAnimationName = variants[0].name;
  }
  await materializeAnimations(() => removeAnimation(current.bytes, index), '正在删除组合动画');
}

/** 动画列表变了（新增/删除组合动画）就把模型重新装载一遍：预览、可绑定列表、导出字节都以新模型为准。 */
async function materializeAnimations(build, label) {
  const editorState = captureSnapshot();
  const displayName = ui['file-name'].textContent;
  const wasSaved = projectSaved;
  beginFileLoad(displayName, label);
  try {
    const bytes = build();
    await activatePreparedModel({ ...current, name: current.sourceName || current.file.name, bytes }, {
      displayName,
      sourceFile: current.sourceFile,
      editorState,
      previewProgressStart: 0.1,
      previewProgressScale: 0.85,
    });
    ui['analysis-state'].textContent = '解析完成';
    projectSaved = wasSaved;
    setDirty(true);
    return true;
  } catch (error) {
    console.error(error);
    handleLoadFailure(error, displayName, '更新动画失败');
    return false;
  } finally {
    endFileLoad();
  }
}

/* ---------- 删除多余部分 ---------- */

let deletions = [];
let submeshes = [];
let hiddenSubmeshes = new Set();

function applyHiddenSubmeshes() {
  const known = new Set(submeshes.map((item) => item.materialIndex));
  hiddenSubmeshes = new Set([...hiddenSubmeshes].filter((index) => known.has(index)));
  preview.setHiddenMaterials([...hiddenSubmeshes]);
  renderSubmeshPanel();
}

function renderSubmeshPanel() {
  ui['submesh-section'].hidden = submeshes.length < 2;
  ui['submesh-summary'].textContent = hiddenSubmeshes.size
    ? `已隐藏 ${hiddenSubmeshes.size} / ${submeshes.length}`
    : `共 ${submeshes.length} 个`;
  ui['submesh-list'].innerHTML = submeshes.map((item) => {
    const hidden = hiddenSubmeshes.has(item.materialIndex);
    const note = item.defaultVisible ? '' : (item.animated ? '默认隐藏 · 动画中显示' : '默认隐藏 · 没有动画会显示');
    return `
      <label class="submesh-row${hidden ? ' hidden' : ''}" data-submesh-row="${item.materialIndex}">
        <input type="checkbox" data-submesh="${item.materialIndex}"${hidden ? '' : ' checked'} />
        <span>${escapeHtml(item.name)}${note ? `<em>${note}</em>` : ''}</span><small>${item.triangles.toLocaleString()} 面</small>
      </label>`;
  }).join('');
  ui['submesh-list'].querySelectorAll('[data-submesh-row]').forEach((row) => {
    const materialIndex = Number(row.dataset.submeshRow);
    row.querySelector('input').addEventListener('change', (event) => {
      snapshot({ scope: 'submesh' });
      if (event.target.checked) hiddenSubmeshes.delete(materialIndex);
      else hiddenSubmeshes.add(materialIndex);
      applyHiddenSubmeshes();
    });
    row.addEventListener('mouseenter', () => preview.highlightSubmesh(materialIndex));
    row.addEventListener('mouseleave', () => preview.clearHighlight());
  });
}

ui['submesh-show-all'].addEventListener('click', () => {
  if (!hiddenSubmeshes.size) return;
  snapshot({ scope: 'submesh' });
  hiddenSubmeshes.clear();
  applyHiddenSubmeshes();
});
ui['submesh-recommend'].addEventListener('click', () => {
  snapshot({ scope: 'submesh' });
  hiddenSubmeshes = recommendedHiddenSubmeshes(submeshes);
  applyHiddenSubmeshes();
});
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
  const slot = activeSlot(openSlot);
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
      removeShadow,
    };
  },
  preview,
  notify: showMessage,
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
  if (modelType === 'other') return structuredClone(region);
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
    if (modelType === 'other') return sourceAnimationBindingValid(binding);
    if (!binding.selection) return true;
    return selectionTriangleCount(binding.selection) > 0;
  }).map((binding) => {
    const copy = structuredClone(binding);
    if (!copy.region) return copy;
    const slot = activeSlot(copy.slotId);
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
    showMessage('精细选面暂不支持一键镜像，请在当前模型上手动补选对应区域。', 'warning');
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
      : defaultParams(slot, measured.bounds || region, { modelType }).pivot,
    pivotCustom: Boolean(source.pivotCustom),
    axis,
    angle,
    duration: source.duration ?? 0.8,
    reverse: Boolean(source.reverse),
    color: source.color || slot.color,
    ...lampParamsOf(source),
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
  Object.assign(binding, lampParamsOf(source));
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
    if (modelType === 'other' && !sourceAnimationBindingValid(binding)) continue;
    const slot = activeSlot(slotId);
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
    const count = bindingsForOutput().length;
    ui['binding-summary'].textContent = count ? `已配置 ${count} 项` : '未配置';
  }
}

function stopDemo() {
  if (!demoRun) return;
  demoRun.cancelled = true;
  demoRun = null;
  preview.stopBindingPreview();
  setDemoButton(false);
  const count = bindingsForOutput().length;
  ui['binding-summary'].textContent = count ? `已配置 ${count} 项` : '未配置';
}

/** 被其他槽位（非框选）占用的叶子 → 槽位名，占用的部位不能重复绑定 */
function claimedByOthers(slot) {
  const claimed = new Map();
  for (const [id, other] of bindings) {
    if (id === slot.id || other.region) continue;
    const label = activeSlot(id)?.label || id;
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
  const defaults = defaultParams(slot, bounds, { modelType });
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
    actionKind: slot.kind,
    scaleAmount: previous?.scaleAmount ?? 0.25,
    scaleTarget: previous?.scaleTarget ?? 0.01,
    ...lampParamsOf(previous),
  });
  renderBindings();
  playCurrentBinding();
}

/** 换绑定来源时沿用已调好的灯光质感参数 */
function lampParamsOf(source) {
  const params = {};
  if (source?.glow) params.glow = structuredClone(source.glow);
  if (source?.beam) params.beam = structuredClone(source.beam);
  return params;
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
  const slot = activeSlot(openSlot);
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
    const sideText = modelType === 'vehicle' && LATERAL_SLOT_SIDE[slot.id]
      ? `并限制在车身${LATERAL_SLOT_SIDE[slot.id] === 'left' ? '左' : '右'}半边`
      : '';
    showMessage(`「${group?.name || all[0].name}」已整体绑给「${owner}」。已自动切换为框选${sideText}，请确认蓝框只套住本槽位区域。`, 'warning');
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

function playbackModeLabel(mode) {
  return {
    once: '打开时播放一次后复位',
    hold: '打开时播放一次并保持尾帧',
    loop: '打开时循环播放',
    pingpong: '打开时往返循环',
  }[mode] || '打开时播放一次后复位';
}

function playbackEndLabel(endMode) {
  return {
    reverse: '关闭时反向恢复',
    reset: '关闭时立即复位',
    hold: '关闭时立即保持尾帧',
    finish: '关闭时播完本轮并保持尾帧',
  }[endMode] || '关闭时立即复位';
}

// 灯光/刹车/转向这类事件只要信号还亮着就一直激活，保持尾帧会一直占住播放槽，
// 导致待机和行驶动作再也轮不上（这一点调优先级救不回来），所以单独提示。
function playbackOccupyNotice(slot, playback) {
  if (!isSustainedEvent(slot)) return '';
  const holdsForever = playback.mode === 'hold' || ['hold', 'finish'].includes(playback.endMode);
  if (!holdsForever) return '';
  return `<div class="playback-behavior warning" role="status">
    <div class="playback-behavior-copy">
      <strong>这个事件会一直占住动作</strong>
      <span>${escapeHtml(slot.label)}只要还亮着就持续激活，保持尾帧会让车模一直定格，停车和行驶动作都播不了。建议改成“播放一次后复位”。</span>
    </div>
    <button class="btn small" id="bind-playback-use-once" type="button"><i data-lucide="corner-down-right"></i>改为播放一次后复位</button>
  </div>`;
}

function playbackBehaviorNotice(playback) {
  const opening = playbackModeLabel(playback.mode);
  const closing = playbackEndLabel(playback.endMode);
  const needsHoldHint = playback.mode !== 'hold' && ['hold', 'finish'].includes(playback.endMode);
  if (!needsHoldHint) {
    return `<div class="playback-behavior"><span>当前效果：${opening}；${closing}</span></div>`;
  }
  return `<div class="playback-behavior warning" role="status">
    <div class="playback-behavior-copy">
      <strong>当前打开时不会停在尾帧</strong>
      <span>${opening}；只有关闭事件后才会执行“${closing}”。</span>
    </div>
    <button class="btn small" id="bind-playback-use-hold" type="button"><i data-lucide="corner-down-right"></i>改为打开后播放一次并保持</button>
  </div>`;
}

// 动画列表里当前点开预览的那一条；null 表示跟随代表动作
let selectedVariantIndex = null;

/** 单独预览某一条动画，方便挨个看完再决定删哪个。 */
function playVariant(slot, variantIndex) {
  const binding = bindings.get(slot.id);
  if (!binding || !Number.isInteger(variantIndex)) return;
  selectedVariantIndex = variantIndex;
  ui['binding-editor-host'].querySelectorAll('[data-variant-play]').forEach((row) => {
    row.classList.toggle('active', Number(row.dataset.variantPlay) === variantIndex);
  });
  const animation = sourceAnimationByIndex(variantIndex);
  preview.previewBinding(slot, {
    ...binding,
    sourceAnimationIndex: variantIndex,
    sourceAnimationName: animation?.name || binding.sourceAnimationName,
    nodeIndices: animation ? [...animation.nodeIndices] : binding.nodeIndices,
  }, 'on');
}

/** 事件下挂的动画列表：多于一条时按概率随机播，单条时保持原来的极简样子。 */
function variantListHtml(slot, binding) {
  const variants = eventVariantsOf(binding);
  if (variants.length <= 1) {
    const only = variants[0];
    return `<div class="source-animation-bound"><span>已绑定动画</span><strong title="${escapeHtml(only?.name || '')}">${escapeHtml(only?.name || '')}</strong>
      ${only ? `<div class="variant-controls"><span class="variant-field" title="触发这条动画时模型相对初始朝向原地转到的角度：正数向左、负数向右、180 转身；进入时平滑转过去，退出时转回初始朝向"><span>触发时转向</span><input id="variant-yaw-${only.index}" type="number" min="-180" max="180" step="15" value="${only.yaw}" aria-label="${escapeHtml(only.name)} 的转向角度" /><small>°</small></span></div>` : ''}
    </div>`;
  }
  const chances = variantChances(variants);
  const active = variants.some((item) => item.index === selectedVariantIndex)
    ? selectedVariantIndex
    : variants[0].index;
  const rows = variants.map((variant, index) => `
    <div class="variant-row${variant.index === active ? ' active' : ''}" data-variant-play="${variant.index}" role="button" tabindex="0" title="点击播放这个动作">
      <div class="variant-name">
        <span title="${escapeHtml(variant.name)}">${escapeHtml(variant.name)}</span>
        ${index === 0 ? '<em class="variant-lead" title="代表动作：事件之间的切换过渡按它预烘">代表</em>' : ''}
      </div>
      <button class="btn small variant-remove" type="button" data-variant-remove="${variant.index}" aria-label="移除 ${escapeHtml(variant.name)}"><i data-lucide="x"></i></button>
      <div class="variant-controls">
        <span class="variant-field" title="抽中这条动画的相对权重，右侧是换算后的概率"><span>权重</span><input id="variant-weight-${variant.index}" type="number" min="1" max="100" step="1" value="${variant.weight}" aria-label="${escapeHtml(variant.name)} 的权重" /><small>${chances[index]}%</small></span>
        <span class="variant-field" title="触发这条动画时模型相对初始朝向原地转到的角度：正数向左、负数向右、180 转身；随机换到另一条动画时只补两者的角度差，角度相同就不转"><span>触发时转向</span><input id="variant-yaw-${variant.index}" type="number" min="-180" max="180" step="15" value="${variant.yaw}" aria-label="${escapeHtml(variant.name)} 的转向角度" /><small>°</small></span>
        <span class="variant-field" title="循环播放时，这条动画至少连着播这么多轮才重新抽；抽到自己会继续循环不打断"><span>至少播</span><input id="variant-reroll-${variant.index}" type="number" min="1" max="99" step="1" value="${variant.rerollCycles}" aria-label="${escapeHtml(variant.name)} 至少循环几轮再换" /><small>轮再换</small></span>
      </div>
    </div>`).join('');
  return `<section class="variant-list" aria-label="事件动画列表">
    <div class="variant-title"><i data-lucide="dices"></i><strong>随机动作（${variants.length}）</strong><small>点击可单独预览</small></div>
    ${rows}
  </section>`;
}

function otherBindingEditor(slot, binding) {
  const selected = sourceAnimationBindingValid(binding) ? binding.sourceAnimationIndex : '';
  const playback = normalizeOtherPlayback(slot, binding?.playback);
  const sourceAnimation = sourceAnimationByIndex(selected);
  const effectiveDuration = playbackDurationOf(sourceAnimation?.duration, playback);
  const idleDelay = normalizeIdleDelaySeconds(binding?.triggerDelaySeconds);
  const priority = normalizeEventPriority(slot, binding?.priority);
  const bound0 = sourceAnimationBindingValid(binding);
  let animationControl;
  if (bindableAnimations.length === 0) {
    animationControl = `
      <div class="source-animation-empty">
        <i data-lucide="film"></i>
        <strong>没有可绑定的动画</strong>
        <span>当前模型没有可用的 TRS 动画；纯 Morph（形态键）动画车机无法播放。</span>
      </div>`;
  } else {
    animationControl = `
      <div class="field source-animation-field">
        <label for="bind-source-animation">模型自带动画</label>
        <select id="bind-source-animation">
          <option value="">${bound0 ? '再挂一个动画（随机播放）' : '选择一个动画'}</option>
          ${bindableAnimations.map((animation) => `
            <option value="${animation.index}"${!bound0 && animation.index === selected ? ' selected' : ''}>${escapeHtml(animation.name)}${isCombinedAnimation(animation.index) ? ' · 组合' : ''}${animation.duration ? ` · ${animation.duration.toFixed(2)} 秒` : ''}</option>`).join('')}
        </select>
        <small>${bound0 ? '同一个事件可以挂多个动画，车机每次触发按概率随机挑一个。' : '选择后立即绑定并在网页质感中预览。'}</small>
        <button class="btn small" id="bind-combine" type="button" title="把几段动画首尾相接合成一段新动画"><i data-lucide="film"></i>组合动画…</button>
      </div>`;
  }
  const bound = sourceAnimationBindingValid(binding)
    ? `${variantListHtml(slot, binding)}
       <section class="other-playback-config" aria-label="播放设置">
         <div class="other-playback-title"><i data-lucide="settings-2"></i><strong>播放设置</strong></div>
         <div class="other-playback-grid">
           ${slot.id === 'CS_Parked' ? `<div class="field" title="车停下后先播停车动作，静止满这么多秒才触发久停；最少 ${PARKED_DELAY_MIN_SECONDS} 秒">
             <label for="bind-trigger-delay">停车多久后触发</label>
             <div class="input-suffix"><input id="bind-trigger-delay" type="number" min="${PARKED_DELAY_MIN_SECONDS}" max="600" step="1" value="${idleDelay}" /><span>秒</span></div>
           </div>` : ''}
            <div class="field">
              <label for="bind-playback-mode">打开时播放方式</label>
              <select id="bind-playback-mode">
                <option value="once"${playback.mode === 'once' ? ' selected' : ''}>播放一次后复位</option>
                <option value="hold"${playback.mode === 'hold' ? ' selected' : ''}>播放一次并保持尾帧</option>
                <option value="loop"${playback.mode === 'loop' ? ' selected' : ''}>循环播放</option>
                <option value="pingpong"${playback.mode === 'pingpong' ? ' selected' : ''}>往返循环</option>
              </select>
            </div>
           <div class="field">
             <label for="bind-playback-direction">播放方向</label>
             <select id="bind-playback-direction">
               <option value="forward"${playback.direction === 'forward' ? ' selected' : ''}>正放</option>
               <option value="reverse"${playback.direction === 'reverse' ? ' selected' : ''}>倒放</option>
             </select>
            </div>
            <div class="field playback-end-field">
              <label for="bind-playback-end">关闭时处理</label>
              <select id="bind-playback-end">
                <option value="reverse"${playback.endMode === 'reverse' ? ' selected' : ''}>反向恢复</option>
                <option value="reset"${playback.endMode === 'reset' ? ' selected' : ''}>立即复位</option>
                <option value="hold"${playback.endMode === 'hold' ? ' selected' : ''}>立即保持尾帧</option>
                <option value="finish"${playback.endMode === 'finish' ? ' selected' : ''}>播完本轮并保持尾帧</option>
              </select>
            </div>
          </div>
          <div id="playback-behavior-host">${playbackOccupyNotice(slot, playback)}${playbackBehaviorNotice(playback)}</div>
          <details class="playback-advanced" open>
            <summary><span>高级设置</span><small id="playback-duration">实际时长 ${effectiveDuration.toFixed(2)} 秒</small></summary>
            <div class="playback-advanced-grid">
              <div class="field">
                <label for="bind-event-priority">同时触发优先级</label>
                <select id="bind-event-priority">
                  ${EVENT_PRIORITY_LEVELS.map((level) => `
                    <option value="${level.value}"${level.value === priority ? ' selected' : ''}>${level.label}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label for="bind-playback-speed">播放速度</label>
                <input id="bind-playback-speed" type="number" min="0.1" max="4" step="0.05" value="${playback.speed}" />
              </div>
              <div class="field">
                <label for="bind-transition-duration">进入/切换过渡</label>
                <div class="input-suffix"><input id="bind-transition-duration" type="number" min="0" max="1000" step="20" value="${playback.transitionMs}" /><span>毫秒</span></div>
              </div>
              <div class="field">
                <label for="bind-playback-start">动作开始</label>
                <div class="input-suffix"><input id="bind-playback-start" type="number" min="0" max="98" step="1" value="${Math.round(playback.range.start * 100)}" /><span>%</span></div>
              </div>
             <div class="field">
               <label for="bind-playback-end-range">动作结束</label>
               <div class="input-suffix"><input id="bind-playback-end-range" type="number" min="1" max="100" step="1" value="${Math.round(playback.range.end * 100)}" /><span>%</span></div>
             </div>
           </div>
           <small class="playback-priority-hint">多个事件同时触发时，动作没用到同一根骨骼就会同时播放；抢同一根骨骼时由优先级高的接管，同级则后触发的接管。</small>
         </details>
       </section>
       <div class="quick-row other-preview-actions">
         <button class="btn small" id="bind-preview-source"><i data-lucide="play"></i>预览触发</button>
         <button class="btn small" id="bind-preview-end"><i data-lucide="rotate-ccw"></i>预览结束</button>
         <button class="btn small" id="bind-remove">移除绑定</button>
       </div>`
    : '';
  return `<div class="binding-editor other-binding-editor">
    <section class="event-action-card">
      <div class="event-action-copy">
        <span>车机事件</span>
        <strong>${slot.label}</strong>
        <small>${slot.trigger || '对应车辆状态变化时触发'}</small>
      </div>
      ${animationControl}
    </section>
    ${bound}
  </div>`;
}

function bindingEditor(slot) {
  const binding = bindings.get(slot.id);
  const isSelection = Boolean(binding?.selection) || selectionEditingSlot === slot.id;
  const isRegion = Boolean(binding?.region);
  if (modelType === 'other') return otherBindingEditor(slot, binding);
  const actionKind = slot.kind;
  const rows = [];
  rows.push(`
    <div class="source-tabs" role="tablist" aria-label="绑定来源">
      <button type="button" class="btn small${!isSelection && !isRegion ? ' primary' : ''}" data-source-tab="parts">整部件</button>
      <button type="button" class="btn small${isSelection ? ' primary' : ''}" data-source-tab="selection">精细选面</button>
      <button type="button" class="btn small${isRegion ? ' primary' : ''}" data-source-tab="region">旧框选</button>
    </div>`);

  // 对侧已配置时提供一键镜像（框选与选部件两种来源都支持）
  const mirrorFromId = MIRROR_PAIRS[slot.id];
  const mirrorFrom = mirrorFromId ? bindings.get(mirrorFromId) : null;
  if (modelType === 'vehicle' && mirrorFrom) {
    const mirrorSelectionDisabled = Boolean(mirrorFrom.selection);
    rows.push(`
      <div class="quick-row" style="margin-top:0">
        <button type="button" class="btn small" id="bind-mirror"${mirrorSelectionDisabled ? ' disabled title="精细选面暂不支持自动镜像，请在模型上手动补选"' : ''}><i data-lucide="arrow-left-right"></i>${mirrorSelectionDisabled ? '精细选面请手动补选' : `从「${activeSlot(mirrorFromId).label}」镜像过来`}</button>
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
      rows.push(`<p class="hint" style="margin:8px 0 0">${modelType === 'other'
        ? '可以勾选任意数量的模型部件，也可以点“在模型上点选”后直接点击 3D 模型。一个事件可以同时驱动多个部位。'
        : '车门这类多块的部件直接勾整组（内饰会跟着动）；也可以点“在模型上点选”后直接点击 3D 模型。点到已被其他联动占用的部件（比如同一盏灯）会自动转为框选，从它上面切一块出来。'}</p>`);
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
          <button type="button" class="btn small" id="selection-undo"${historyEntryMatchesSelection(undoStack.at(-1), slot.id) ? '' : ' disabled'}>撤销选区</button>
          <button type="button" class="btn small" id="selection-redo"${historyEntryMatchesSelection(redoStack.at(-1), slot.id) ? '' : ' disabled'}>重做选区</button>
          <button type="button" class="btn small" id="selection-clear"${stats.triangles ? '' : ' disabled'}>清空选区</button>
          <button type="button" class="btn small primary" id="selection-done">完成选择</button>
        </div>
        <p class="hint">${modelType === 'other'
          ? '智能点选会沿共享边扩展到相邻曲面；画笔可以旋转模型后继续补选其他需要联动的区域。'
          : '智能点选会沿共享边扩展到相邻曲面；画笔可以旋转模型后继续补选另一侧。选中左右两个轮子时，它们会加入同一个槽位。'}</p>
      </div>`);
  }

  if (binding.region) {
    const pivotButton = actionUsesPivot(actionKind)
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

  if (actionUsesPivot(actionKind)) {
    const pivot = binding?.pivot || [0, 0, 0];
    rows.push(`
      <div class="field-grid">
        ${bindNumber('旋转中心 X', 'bind-pivot-x', pivot[0])}
        ${bindNumber('旋转中心 Y', 'bind-pivot-y', pivot[1])}
        ${bindNumber('旋转中心 Z', 'bind-pivot-z', pivot[2])}
      </div>
      <div class="quick-row">
        ${binding?.selection && actionKind === 'spin' ? '<button class="btn small" id="pivot-refit">重新自动拟合</button>' : ''}
        <button class="btn small" data-pivot="center">取中心</button>
        ${modelType === 'vehicle' ? '<button class="btn small" data-pivot="front">取车头侧</button><button class="btn small" data-pivot="rear">取车尾侧</button>' : ''}
      </div>
      <p class="hint" style="margin:6px 0 9px">预览里的橙色小球就是旋转中心，虚线是旋转轴，${
        binding?.region ? '切到上方“拖中心点”后可直接拖动小球' : '可直接拖动小球调整'}。</p>`);
  }
  if (actionKind === 'hinge' || actionKind === 'swing') {
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
        ${bindNumber(actionKind === 'swing' ? '摆动幅度°' : '开启角度°', 'bind-angle', binding?.angle ?? slot.angle ?? 30)}
        ${bindNumber(actionKind === 'swing' ? '循环用时 秒' : '开合用时 秒', 'bind-duration', binding?.duration ?? 0.8, 0.1)}
      </div>`);
  }
  if (actionKind === 'spin') {
    const axis = binding?.axis || slot.axis;
    rows.push(`
      <div class="field">
        <label for="bind-axis">旋转轴</label>
        <select id="bind-axis">
          <option value="z"${axis === 'z' ? ' selected' : ''}>Z 轴${modelType === 'vehicle' ? '（车轮向前滚动）' : ''}</option>
          <option value="x"${axis === 'x' ? ' selected' : ''}>X 轴${modelType === 'vehicle' ? '（左右侧翻）' : ''}</option>
          <option value="y"${axis === 'y' ? ' selected' : ''}>Y 轴${modelType === 'vehicle' ? '（水平打转）' : ''}</option>
        </select>
      </div>
      ${bindNumber('转一圈用时（秒）', 'bind-duration', binding?.duration ?? 0.8, 0.1)}
      <label class="check-row"><input type="checkbox" id="bind-reverse"${binding?.reverse ? ' checked' : ''} />反向转动</label>
      <p class="hint" style="margin:0 0 9px">${modelType === 'other'
        ? '旋转中心决定部位围绕哪里转动。默认取所选部位中心，也可以拖动橙色中心点微调。'
        : '车机只有前、后两个车轮插槽，左右轮共用同一段动画同向转动。框选时把左右两个轮子一起框住，并把旋转中心放到轮轴上，轮子就会原地自转。'}</p>`);
  }
  if (actionKind === 'pulse') {
    rows.push(`
      <div class="field-grid two-cols">
        ${bindNumber('缩放幅度', 'bind-scale-amount', binding?.scaleAmount ?? 0.25, 0.05)}
        ${bindNumber('循环用时 秒', 'bind-duration', binding?.duration ?? 0.8, 0.1)}
      </div>`);
  }
  if (actionKind === 'scale') {
    rows.push(`
      <div class="field-grid two-cols">
        ${bindNumber('打开时缩放到', 'bind-scale-target', binding?.scaleTarget ?? 0.01, 0.05)}
        ${bindNumber('开合用时 秒', 'bind-duration', binding?.duration ?? 0.8, 0.1)}
      </div>`);
  }
  if (isLampSlot(slot)) {
    rows.push(`
      <div class="field">
        <label for="bind-color">点亮颜色</label>
        <input id="bind-color" type="color" value="${binding?.color || slot.color}" />
      </div>`);
    if (binding) rows.push(lampEditorHtml(slot, binding));
  }
  rows.push(`
    <div class="quick-row">
      <button class="btn small" id="bind-remove">移除绑定</button>
    </div>`);
  return `<div class="binding-editor">${rows.join('')}</div>`;
}

function currentCarSize() {
  const bounds = preview.wholeBounds();
  if (!bounds) return { length: Number(ui['target-length'].value) || 5.2, width: 1.9 };
  return { length: bounds.max[0] - bounds.min[0], width: bounds.max[2] - bounds.min[2] };
}

function currentCarLength() {
  return currentCarSize().length;
}

function percentRange(id, label, value, [min, max], step = 5, attrs = '') {
  const percent = Math.round(value * 100);
  return `<label class="range-field"${attrs}>${label} <output id="${id}-output">${percent}%</output><input id="${id}" type="range" min="${Math.round(min * 100)}" max="${Math.round(max * 100)}" step="${step}" value="${percent}" /></label>`;
}

function unitRange(id, label, value, [min, max], step, output, attrs = '') {
  return `<label class="range-field"${attrs}>${label} <output id="${id}-output">${output}</output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
}

function selectField(id, label, options, value) {
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}">${options.map((option) => (
    `<option value="${option.value}"${option.value === value ? ' selected' : ''}>${option.label}</option>`
  )).join('')}</select></div>`;
}

const signedMeters = (value) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)} m`;

const BEAM_LABELS = {
  length: (beam, car) => `${beam.length.toFixed(1)} 倍车长 ≈ ${(beam.length * car.length).toFixed(1)} m`,
  width: (beam, car) => `${beam.width.toFixed(2)} 倍车宽 ≈ ${(beam.width * car.width).toFixed(2)} m`,
  offset: (beam, car) => `${signedMeters(beam.offset * car.length)}`,
  side: (beam, car) => `${beam.side === 0 ? '居中' : `${beam.side > 0 ? '偏左' : '偏右'} ${Math.abs(beam.side * car.width).toFixed(2)} m`}`,
  height: (beam) => `${(beam.height * 100).toFixed(1)} cm`,
  spacing: (beam, car) => `${beam.lobeSpacing.toFixed(2)} 倍车宽 ≈ ${(beam.lobeSpacing * car.width).toFixed(2)} m`,
};

/** 灯光质感：叠加层发光参数 + （近光/远光/雾灯/刹车/倒车）路面光束参数 */
function lampEditorHtml(slot, binding) {
  const glow = normalizeLampGlow(binding.glow);
  const beam = normalizeLampBeam(slot, binding.beam);
  const rows = [`
    <div class="lamp-section">
      <div class="tool-heading"><strong>发光质感</strong><span>叠加在灯罩表面的点亮贴图</span></div>
      <div class="range-fields">
        ${percentRange('lamp-glow-intensity', '亮度', glow.intensity, LAMP_GLOW_LIMITS.intensity)}
        ${percentRange('lamp-glow-core', '热白中心', glow.core, LAMP_GLOW_LIMITS.core)}
        ${percentRange('lamp-glow-detail', '保留灯罩纹理', glow.detail, LAMP_GLOW_LIMITS.detail)}
        ${percentRange('lamp-glow-softness', '边缘柔化', glow.softness, LAMP_GLOW_LIMITS.softness)}
      </div>
      <p class="hint">灭灯时叠加层完全透明、车身保持原样；亮灯时按原灯罩贴图提亮染色，热白中心越高越像真实点亮的透镜。</p>
    </div>`];
  if (beam) {
    const car = currentCarSize();
    const L = LAMP_BEAM_LIMITS;
    rows.push(`
    <div class="lamp-section">
      <div class="tool-heading"><strong>路面光束</strong><span>${beam.direction === 'rear' ? '投射在车尾地面' : '投射在车头前方地面'}</span></div>
      <label class="check-row"><input type="checkbox" id="lamp-beam-enabled"${beam.enabled ? ' checked' : ''} />投射路面光束</label>
      <div id="lamp-beam-fields"${beam.enabled ? '' : ' hidden'}>
        <div class="field-grid two-cols" style="margin-top:4px">
          ${selectField('lamp-beam-shape', '形状', BEAM_SHAPES, beam.shape)}
          ${selectField('lamp-beam-lobe-mode', '光斑分布', BEAM_LOBE_MODES, beam.lobeMode)}
        </div>
        <div class="range-fields">
          ${unitRange('lamp-beam-spacing', '光斑间距', beam.lobeSpacing, L.lobeSpacing, 0.02, BEAM_LABELS.spacing(beam, car), beam.lobeMode === 'double' ? '' : ' hidden')}
          ${percentRange('lamp-beam-lobe-width', '光斑宽度', beam.lobeWidth, L.lobeWidth)}
          ${unitRange('lamp-beam-length', '光束长度', beam.length, L.length, 0.1, BEAM_LABELS.length(beam, car))}
          ${unitRange('lamp-beam-width', '光束宽度', beam.width, L.width, 0.05, BEAM_LABELS.width(beam, car))}
          ${unitRange('lamp-beam-offset', '起点前后', beam.offset, L.offset, 0.01, BEAM_LABELS.offset(beam, car))}
          ${unitRange('lamp-beam-side', '左右偏移', beam.side, L.side, 0.01, BEAM_LABELS.side(beam, car))}
          ${unitRange('lamp-beam-height', '离地高度', beam.height, L.height, 0.005, BEAM_LABELS.height(beam))}
          ${percentRange('lamp-beam-intensity', '强度', beam.intensity, L.intensity)}
          ${percentRange('lamp-beam-spread', '横向扩散', beam.spread, L.spread)}
          ${percentRange('lamp-beam-falloff', '沿路衰减', beam.falloff, L.falloff)}
          ${percentRange('lamp-beam-haze', '雾感', beam.haze, L.haze)}
        </div>
        <label class="check-row"><input type="checkbox" id="lamp-beam-follow"${beam.color ? '' : ' checked'} />光束颜色跟随点亮颜色</label>
        <div class="field" id="lamp-beam-color-field"${beam.color ? '' : ' hidden'}>
          <label for="lamp-beam-color">光束颜色</label>
          <input id="lamp-beam-color" type="color" value="${beam.color || binding.color || slot.color}" />
        </div>
      </div>
      <p class="hint">“按灯罩自动”会依据绑定灯罩的左右分布生成光斑：左右各一盏就是两道，单盏中置就是一道。长度、宽度、偏移按车身尺寸等比缩放，任何车型都适用；“沿路衰减”越低照得越远，“横向扩散”越高越散。</p>
    </div>`);
  }
  return rows.join('');
}

const LAMP_INPUT_IDS = [
  'lamp-glow-intensity', 'lamp-glow-core', 'lamp-glow-detail', 'lamp-glow-softness',
  'lamp-beam-enabled', 'lamp-beam-shape', 'lamp-beam-lobe-mode', 'lamp-beam-spacing', 'lamp-beam-lobe-width',
  'lamp-beam-length', 'lamp-beam-width', 'lamp-beam-offset', 'lamp-beam-side', 'lamp-beam-height',
  'lamp-beam-intensity', 'lamp-beam-spread', 'lamp-beam-falloff', 'lamp-beam-haze',
  'lamp-beam-follow', 'lamp-beam-color',
];

function syncLampOutputs(slot, binding) {
  const glow = normalizeLampGlow(binding.glow);
  for (const [id, value] of [
    ['lamp-glow-intensity', glow.intensity], ['lamp-glow-core', glow.core],
    ['lamp-glow-detail', glow.detail], ['lamp-glow-softness', glow.softness],
  ]) {
    const output = document.getElementById(`${id}-output`);
    if (output) output.textContent = `${Math.round(value * 100)}%`;
  }
  const beam = normalizeLampBeam(slot, binding.beam);
  if (!beam) return;
  const car = currentCarSize();
  const fields = document.getElementById('lamp-beam-fields');
  if (fields) fields.hidden = !beam.enabled;
  const spacing = document.getElementById('lamp-beam-spacing')?.closest('.range-field');
  if (spacing) spacing.hidden = beam.lobeMode !== 'double';
  const colorField = document.getElementById('lamp-beam-color-field');
  if (colorField) colorField.hidden = !beam.color;
  const setText = (id, text) => {
    const output = document.getElementById(id);
    if (output) output.textContent = text;
  };
  setText('lamp-beam-length-output', BEAM_LABELS.length(beam, car));
  setText('lamp-beam-width-output', BEAM_LABELS.width(beam, car));
  setText('lamp-beam-offset-output', BEAM_LABELS.offset(beam, car));
  setText('lamp-beam-side-output', BEAM_LABELS.side(beam, car));
  setText('lamp-beam-height-output', BEAM_LABELS.height(beam));
  setText('lamp-beam-spacing-output', BEAM_LABELS.spacing(beam, car));
  for (const key of ['lobeWidth', 'intensity', 'spread', 'falloff', 'haze']) {
    const id = key === 'lobeWidth' ? 'lamp-beam-lobe-width' : `lamp-beam-${key}`;
    setText(`${id}-output`, `${Math.round(beam[key] * 100)}%`);
  }
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
  for (const [group, slots] of activeSlotGroups()) {
    const ordered = [...slots].sort((a, b) => Number(bindings.has(b.id)) - Number(bindings.has(a.id)));
    const items = ordered.map((slot) => {
      const binding = bindings.get(slot.id);
      const open = openSlot === slot.id;
      const selectionCount = binding?.selection ? selectionTriangleCount(binding.selection) : 0;
      const needsConfirm = Boolean(binding && (
        (modelType === 'other' && !sourceAnimationBindingValid(binding))
        || (binding.selection && selectionCount === 0)
      ));
      const state = !binding ? '未绑定' : needsConfirm ? '需确认' : '已绑定';
      return `
        <div class="binding-item${binding && !needsConfirm ? ' bound' : ''}${open ? ' open' : ''}">
          <button class="binding-head" data-slot="${slot.id}"${ready ? '' : ' disabled'}>
            <span class="binding-name"><span class="slot-dot ${binding && !needsConfirm ? 'bound' : ''}"></span>${slot.label}</span>
            <span class="binding-state ${state === '需确认' ? 'needs-confirm' : ''}">${state}</span>
          </button>
        </div>`;
    }).join('');
    html.push(`<div class="binding-group"><h3>${group}</h3>${items}</div>`);
  }
  ui['binding-groups'].innerHTML = html.join('');
  const readyBindingCount = bindingsForOutput().length;
  ui['binding-summary'].textContent = readyBindingCount ? `已配置 ${readyBindingCount} 项` : '未配置';
  ui['demo-all'].disabled = !current || readyBindingCount === 0;
  ui['binding-back'].hidden = !openSlot;
  document.querySelector('.binding-inspector-title').classList.toggle('has-back', Boolean(openSlot));
  if (demoRun) setDemoButton(true);
  else setDemoButton(false);
  if (openSlot) {
    const slot = activeSlot(openSlot);
    ui['binding-editor-title'].textContent = slot?.label || '联动编辑';
    ui['binding-editor-host'].innerHTML = slot ? bindingEditor(slot) : '';
  } else {
    ui['binding-editor-title'].textContent = '选择一个联动槽位';
    const picker = [...activeSlotGroups()].flatMap(([, slots]) => slots).map((slot) => `
      <button class="btn small" data-mobile-slot="${slot.id}">${slot.label}${bindings.has(slot.id) ? ' · 已绑定' : ''}</button>`).join('');
    const emptyCopy = modelType === 'other'
      ? '先选择一个车机事件，再绑定模型自带动画'
      : '从左侧选择灯光、车轮或开合槽位';
    ui['binding-editor-host'].innerHTML = `<div class="inspector-placeholder"><i data-lucide="mouse-pointer-2"></i><span>${emptyCopy}</span></div><div class="mobile-slot-picker">${picker}</div>`;
  }
  renderIcons();
  wireBindingEditor();
  if (openSlot) restorePartTreeScroll(activeSlot(openSlot));
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

function wirePlaybackHoldFix(slot) {
  document.getElementById('bind-playback-use-hold')?.addEventListener('click', () => {
    const mode = document.getElementById('bind-playback-mode');
    if (!mode) return;
    mode.value = 'hold';
    updateOtherPlaybackBinding(slot);
    renderBindings();
    showMessage('已改为打开后播放一次并保持尾帧', 'success', { duration: 3500 });
  });
  document.getElementById('bind-playback-use-once')?.addEventListener('click', () => {
    const mode = document.getElementById('bind-playback-mode');
    const end = document.getElementById('bind-playback-end');
    if (!mode) return;
    mode.value = 'once';
    if (end) end.value = 'reset';
    updateOtherPlaybackBinding(slot);
    renderBindings();
    showMessage('已改为播放一次后复位，不再占住动作', 'success', { duration: 3500 });
  });
}

function wireBindingEditor() {
  ui['binding-editor-host'].querySelectorAll('[data-mobile-slot]').forEach((button) => {
    button.addEventListener('click', () => toggleSlot(button.dataset.mobileSlot));
  });
  ui['binding-groups'].querySelectorAll('[data-slot]').forEach((button) => {
    button.addEventListener('click', () => toggleSlot(button.dataset.slot));
  });
  if (!openSlot) return;
  const slot = activeSlot(openSlot);
  if (modelType === 'other') {
    document.getElementById('bind-source-animation')?.addEventListener('change', (event) => {
      const value = event.target.value;
      // 已经绑过就是往列表里再加一个随机动作，没绑过才是首次绑定
      if (value && sourceAnimationBindingValid(bindings.get(slot.id))) {
        addVariantAnimation(slot, value);
        return;
      }
      setSourceAnimationBinding(slot, value);
    });
    document.getElementById('bind-combine')?.addEventListener('click', openComboDialog);
    ui['binding-editor-host'].querySelectorAll('[data-variant-remove]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        removeVariantAnimation(slot, Number(button.dataset.variantRemove));
      });
    });
    ui['binding-editor-host'].querySelectorAll('[data-variant-play]').forEach((row) => {
      const play = (event) => {
        // 改概率和点删除都在行内，别顺手把预览也触发了
        if (event.target.closest('input, button')) return;
        playVariant(slot, Number(row.dataset.variantPlay));
      };
      row.addEventListener('click', play);
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        play(event);
      });
    });
    for (const variant of eventVariantsOf(bindings.get(slot.id))) {
      const input = document.getElementById(`variant-weight-${variant.index}`);
      if (input) {
        wireContinuousHistory(input, { scope: 'variant-weight', slotId: slot.id });
        input.addEventListener('change', () => updateVariantWeights(slot));
      }
      const yawInput = document.getElementById(`variant-yaw-${variant.index}`);
      yawInput?.addEventListener('click', (event) => event.stopPropagation());
      yawInput?.addEventListener('change', () => updateVariantYaw(slot, variant.index, yawInput.value));
      const rerollInput = document.getElementById(`variant-reroll-${variant.index}`);
      rerollInput?.addEventListener('click', (event) => event.stopPropagation());
      rerollInput?.addEventListener('change', () => updateVariantReroll(slot, variant.index, rerollInput.value));
    }
    for (const id of [
      'bind-playback-mode', 'bind-playback-direction', 'bind-playback-end',
      'bind-playback-speed', 'bind-transition-duration', 'bind-playback-start',
      'bind-playback-end-range', 'bind-trigger-delay', 'bind-event-priority',
    ]) {
      document.getElementById(id)?.addEventListener('change', () => updateOtherPlaybackBinding(slot));
    }
    wirePlaybackHoldFix(slot);
    document.getElementById('bind-preview-source')?.addEventListener('click', () => playCurrentBinding('on'));
    document.getElementById('bind-preview-end')?.addEventListener('click', () => playCurrentBinding('off'));
    document.getElementById('bind-remove')?.addEventListener('click', () => {
      snapshot();
      bindings.delete(slot.id);
      preview.stopBindingPreview();
      setDirty();
      markDevicePreviewStale();
      renderBindings();
      refreshBindingPreviewAfterExportChange();
    });
    return;
  }
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
  for (const id of ['bind-pivot-x', 'bind-pivot-y', 'bind-pivot-z', 'bind-angle', 'bind-axis', 'bind-color', 'bind-duration', 'bind-reverse', 'bind-scale-amount', 'bind-scale-target', ...LAMP_INPUT_IDS]) {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', () => updateBindingFromInputs(slot));
      wireContinuousHistory(input, { scope: 'binding-input', slotId: slot.id, field: id });
    }
  }
  if (isLampSlot(slot)) {
    // 点亮图集是导出管线烘出来的：车机质感下拖完滑杆再重烘一次，网页质感则即时重画
    for (const id of ['bind-color', ...LAMP_INPUT_IDS]) {
      document.getElementById(id)?.addEventListener('change', () => {
        if (preview.deviceMode) refreshBindingPreviewAfterExportChange('on');
      });
    }
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
  // 换事件了，动画列表的预览选中跟着回到代表动作
  if (openSlot !== slotId) selectedVariantIndex = null;
  const closing = openSlot === slotId;
  const previousBinding = openSlot ? bindings.get(openSlot) : null;
  const nextBinding = closing ? null : bindings.get(slotId);
  const preserveBindingPreview = modelType === 'other'
    && !closing
    && openSlot !== null
    && openSlot !== slotId
    && sourceAnimationBindingValid(previousBinding)
    && sourceAnimationBindingValid(nextBinding);
  stopFineSelection();
  openSlot = closing ? null : slotId;
  regionMode = 'translate';
  closePreviewTools({ preserveBindingPreview });
  renderBindings();
  if (closing) return;
  setActivePanel('binding');
  const slot = activeSlot(slotId);
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
    createRegionBinding(slot, suggestRegion(slot, modelBounds, { modelType }));
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
  const defaults = defaultParams(slot, bounds, { modelType });
  const actionKind = slot.kind;
  const next = {
    ...(previous ? structuredClone(previous) : {}),
    slotId: slot.id,
    whole: false,
    selection: structuredClone(selection),
    nodeIndices: [...new Set((selection.groups || []).map((group) => group.nodeIndex))],
    sourceName: stats.triangles ? `精细选面（${stats.triangles.toLocaleString()} 面）` : '精细选面（未完成）',
    bounds,
    geomBounds: bounds,
    pivot: previous?.pivotCustom ? previous.pivot : (actionKind === 'spin' ? (stats.pivot || defaults.pivot) : defaults.pivot),
    pivotCustom: Boolean(previous?.pivotCustom),
    axis: previous?.axis || defaults.axis,
    angle: previous?.angle ?? defaults.angle,
    duration: previous?.duration ?? 0.8,
    reverse: Boolean(previous?.reverse),
    color: previous?.color || defaults.color,
    actionKind,
    scaleAmount: previous?.scaleAmount ?? 0.25,
    scaleTarget: previous?.scaleTarget ?? 0.01,
  };
  delete next.region;
  bindings.set(slot.id, next);
  selectionEditingSlot = slot.id;
  selectionLast = structuredClone(next.selection);
  selectionLastStrokeId = null;
  renderBindings();
  startFineSelection(slot, { preserveState: true });
}

function updateSelectionBinding(slot, selection, stats, change = {}) {
  const binding = bindings.get(slot.id);
  if (!binding) return;
  const nextSelection = structuredClone(selection || emptySelection());
  const previous = selectionLast || emptySelection();
  if (JSON.stringify(previous) !== JSON.stringify(nextSelection)) {
    const strokeId = change.strokeId ?? null;
    if (strokeId === null || strokeId !== selectionLastStrokeId) {
      const state = captureSnapshot();
      const previousBinding = state.bindings.find(([id]) => id === slot.id)?.[1];
      if (previousBinding) previousBinding.selection = structuredClone(previous);
      state.selectionEditingSlot = slot.id;
      pushHistory(state, { scope: 'selection', slotId: slot.id, strokeId });
    }
    selectionLastStrokeId = strokeId;
  }
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
    if (selectionEditingSlot !== slot.id) syncPivotTools(slot, binding);
  }
  binding.sourceName = stats?.triangles ? `精细选面（${stats.triangles.toLocaleString()} 面）` : '精细选面（未完成）';
  markDevicePreviewStale();
  setDirty();
  updateWorkspaceSelection(stats);
  updateBindingRow(slot, binding);
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
  syncUndoRedoButtons();
  const binding = openSlot ? bindings.get(openSlot) : null;
  if (binding) updateBindingRow(activeSlot(openSlot), binding);
}

function startFineSelection(slot, { preserveState = false } = {}) {
  const binding = bindings.get(slot?.id);
  if (!slot || !binding?.selection || preview.deviceMode) return;
  const continuingSameSession = selectionEditingSlot === slot.id && Boolean(preview.selectionState);
  // 编辑选区必须始终命中原始网格；动画预览会隐藏原件并换成临时切分网格。
  preview.stopBindingPreview();
  preview.clearHighlight();
  preview.hideRegionBox();
  preview.hidePivotMarker();
  selectionEditingSlot = slot.id;
  if (!preserveState || !continuingSameSession) {
    selectionLast = structuredClone(binding.selection);
    selectionLastStrokeId = null;
  }
  preview.setTriangleSelection(true, binding.selection, {
    mode: previewSelectionMode,
    operation: previewSelectionOperation,
    brushRadius: previewSelectionRadius,
    angle: previewSelectionAngle,
    visibleOnly: previewSelectionVisibleOnly,
    onChange: (selection, stats, change) => updateSelectionBinding(slot, selection, stats, change),
    onStatus: ({ state, stats }) => {
      ui['workspace-index'].textContent = state === 'building' ? '正在构建 BVH 索引…' : 'BVH 索引就绪';
      updateSelectionSummary(stats);
    },
  });
  ui['workspace-mode'].textContent = '精细选面';
  const stats = preview.selectionStats(binding.selection);
  updateSelectionSummary(stats);
  updateWorkspaceSelection(stats);
  syncUndoRedoButtons();
}

function stopFineSelection() {
  if (!selectionEditingSlot && !preview.selectionState) return;
  selectionEditingSlot = null;
  selectionLast = emptySelection();
  selectionLastStrokeId = null;
  preview.setTriangleSelection(false);
  ui['workspace-index'].textContent = '精细索引未启用';
  ui['workspace-mode'].textContent = openSlot ? '联动预览' : '浏览模式';
  syncUndoRedoButtons();
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
  document.getElementById('selection-undo')?.addEventListener('click', undo);
  document.getElementById('selection-redo')?.addEventListener('click', redo);
  document.getElementById('selection-clear')?.addEventListener('click', () => {
    const binding = bindings.get(slot.id);
    if (!binding) return;
    snapshot({ scope: 'selection', slotId: slot.id, action: 'clear' });
    const next = emptySelection();
    selectionLast = structuredClone(next);
    selectionLastStrokeId = null;
    binding.selection = next;
    binding.nodeIndices = [];
    binding.sourceName = '精细选面（未完成）';
    preview.setTriangleSelection(true, next, { mode: previewSelectionMode, operation: previewSelectionOperation, brushRadius: previewSelectionRadius, angle: previewSelectionAngle, visibleOnly: previewSelectionVisibleOnly, onChange: (selection, stats, change) => updateSelectionBinding(slot, selection, stats, change), onStatus: ({ state, stats }) => { ui['workspace-index'].textContent = state === 'building' ? '正在构建 BVH 索引…' : 'BVH 索引就绪'; updateSelectionSummary(stats); } });
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
    pivot: previous?.pivotCustom ? previous.pivot : defaultParams(slot, measured.bounds || constrainedRegion, { modelType }).pivot,
    pivotCustom: Boolean(previous?.pivotCustom),
    axis: previous?.axis || slot.axis,
    angle: previous?.angle ?? slot.angle,
    duration: previous?.duration ?? 0.8,
    reverse: Boolean(previous?.reverse),
    color: previous?.color || slot.color,
    actionKind: slot.kind,
    scaleAmount: previous?.scaleAmount ?? 0.25,
    scaleTarget: previous?.scaleTarget ?? 0.01,
    ...lampParamsOf(previous),
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
      binding.pivot = defaultParams(slot, binding.geomBounds || region, { modelType }).pivot;
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
  if (!slot || !binding || !actionUsesPivot(slot.kind)) {
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

function closePreviewTools({ preserveBindingPreview = false } = {}) {
  stopFineSelection();
  stopPicking();
  if (!preserveBindingPreview) preview.stopBindingPreview();
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
  const scaleAmount = document.getElementById('bind-scale-amount');
  if (scaleAmount) binding.scaleAmount = Math.min(0.9, Math.max(0.05, Number(scaleAmount.value) || 0.25));
  const scaleTarget = document.getElementById('bind-scale-target');
  if (scaleTarget) binding.scaleTarget = Math.min(3, Math.max(0.01, Number(scaleTarget.value) || 0.01));
  if (isLampSlot(slot)) {
    const valueOf = (id) => document.getElementById(id)?.value;
    if (document.getElementById('lamp-glow-intensity')) {
      binding.glow = normalizeLampGlow({
        intensity: Number(valueOf('lamp-glow-intensity')) / 100,
        core: Number(valueOf('lamp-glow-core')) / 100,
        detail: Number(valueOf('lamp-glow-detail')) / 100,
        softness: Number(valueOf('lamp-glow-softness')) / 100,
      });
    }
    const beamEnabled = document.getElementById('lamp-beam-enabled');
    if (beamEnabled) {
      binding.beam = normalizeLampBeam(slot, {
        enabled: beamEnabled.checked,
        shape: valueOf('lamp-beam-shape'),
        lobeMode: valueOf('lamp-beam-lobe-mode'),
        lobeSpacing: Number(valueOf('lamp-beam-spacing')),
        lobeWidth: Number(valueOf('lamp-beam-lobe-width')) / 100,
        length: Number(valueOf('lamp-beam-length')),
        width: Number(valueOf('lamp-beam-width')),
        offset: Number(valueOf('lamp-beam-offset')),
        side: Number(valueOf('lamp-beam-side')),
        height: Number(valueOf('lamp-beam-height')),
        intensity: Number(valueOf('lamp-beam-intensity')) / 100,
        spread: Number(valueOf('lamp-beam-spread')) / 100,
        falloff: Number(valueOf('lamp-beam-falloff')) / 100,
        haze: Number(valueOf('lamp-beam-haze')) / 100,
        color: document.getElementById('lamp-beam-follow')?.checked ? null : valueOf('lamp-beam-color'),
      });
    }
    syncLampOutputs(slot, binding);
  }
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

function updateOtherPlaybackBinding(slot) {
  const binding = bindings.get(slot.id);
  if (!binding) return;
  snapshot({ scope: 'binding-playback', slotId: slot.id });
  binding.playback = normalizeOtherPlayback(slot, {
    version: 3,
    mode: document.getElementById('bind-playback-mode')?.value,
    direction: document.getElementById('bind-playback-direction')?.value,
    endMode: document.getElementById('bind-playback-end')?.value,
    speed: document.getElementById('bind-playback-speed')?.value,
    transitionMs: document.getElementById('bind-transition-duration')?.value,
    range: {
      start: (Number(document.getElementById('bind-playback-start')?.value) || 0) / 100,
      end: (Number(document.getElementById('bind-playback-end-range')?.value) || 100) / 100,
    },
  });
  binding.priority = normalizeEventPriority(slot, document.getElementById('bind-event-priority')?.value);
  const delayInput = document.getElementById('bind-trigger-delay');
  if (delayInput) {
    binding.triggerDelaySeconds = normalizeIdleDelaySeconds(delayInput.value);
    delayInput.value = binding.triggerDelaySeconds;
  }
  setDirty();
  markDevicePreviewStale();
  document.getElementById('bind-playback-speed').value = binding.playback.speed;
  document.getElementById('bind-transition-duration').value = binding.playback.transitionMs;
  document.getElementById('bind-playback-start').value = Math.round(binding.playback.range.start * 100);
  document.getElementById('bind-playback-end-range').value = Math.round(binding.playback.range.end * 100);
  const animation = sourceAnimationByIndex(binding.sourceAnimationIndex);
  const duration = playbackDurationOf(animation?.duration, binding.playback);
  const durationLabel = document.getElementById('playback-duration');
  if (durationLabel) durationLabel.textContent = `实际时长 ${duration.toFixed(2)} 秒`;
  const behaviorHost = document.getElementById('playback-behavior-host');
  if (behaviorHost) {
    behaviorHost.innerHTML = playbackOccupyNotice(slot, binding.playback)
      + playbackBehaviorNotice(binding.playback);
    renderIcons();
    wirePlaybackHoldFix(slot);
  }
  refreshBindingPreviewAfterExportChange('on');
}

function playCurrentBinding(phase = 'on') {
  if (!openSlot) return;
  const slot = activeSlot(openSlot);
  const binding = bindings.get(openSlot);
  if (!slot || !binding) return;
  if (modelType === 'other' && !sourceAnimationBindingValid(binding)) return;
  if (selectionEditingSlot === openSlot) {
    preview.stopBindingPreview();
    return;
  }
  // 框选时已经有选区盒了，再叠一个高亮框只会互相干扰
  if (!binding.region && !binding.selection) preview.highlightPart(binding.nodeIndices);
  preview.previewBinding(slot, binding, phase);
}

async function generatePackage() {
  if (!current || !preview.model) return;
  const buttons = [ui.generate, ui['mobile-generate'], document.getElementById('mobile-generate-shortcut')];
  const labels = buttons.map((button) => button?.innerHTML || '');
  buttons.forEach((button) => { if (button) { button.disabled = true; button.classList.add('busy'); } });
  ui.generate.innerHTML = '<span class="spinner"></span><span>生成中…</span>';
  ui['mobile-generate'].innerHTML = '<span class="spinner"></span>生成中…';
  const quality = exportQuality();
  setStatuses([['warn', '…', `正在按“${quality.label}”质量生成车模包`]]);
  updateImportProgress({ progress: 0, label: '正在准备导出' });
  try {
    const result = await makeBydCar({
      sourceBytes: current.bytes,
      sourceName: current.sourceName || current.file.name,
      modelType,
      transform: preview.getExportTransform(),
      stats: current.stats,
      bindings: bindingsForOutput(),
      deletions: deletions.map((item) => item.region),
      quality,
      removeShadow,
      brightness: modelBrightness,
      hiddenMaterials: [...hiddenSubmeshes],
      onProgress: updateImportProgress,
    });
    const blob = new Blob([result.bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName(result.manifest.name)}.bydcar`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    updateSteps(4);
    setStatuses([
      ['good', '✓', `车模包已生成：${formatBytes(result.bytes.byteLength)}`],
      ['good', '✓', `导出质量：${quality.label}`],
      ['good', '✓', `模型亮度：${Math.round(modelBrightness * 100)}%`],
      ['good', '✓', `几何：${current.stats.triangles.toLocaleString()} → ${result.manifest.model.outputStats.triangles.toLocaleString()} 三角形${current.stats.triangles === result.manifest.model.outputStats.triangles ? '（未减面）' : ''}`],
      ['good', '✓', 'CarSelf.dat 和 GLB 均已写入 SHA-256 校验值'],
      ...(result.sizeWarning ? [['bad', '!', result.sizeWarning]] : []),
      ['warn', '!', '导入地图后需要重启地图进程才能生效'],
    ]);
    if (result.sizeWarning) {
      showMessage(result.sizeWarning, 'warning', { duration: 9000 });
    } else {
      showMessage(`车模包已生成：${formatBytes(result.bytes.byteLength)}`, 'success');
    }
  } catch (error) {
    console.error(error);
    setStatuses([['bad', '×', `生成失败：${error.message || '未知错误'}`]]);
    showMessage(`生成失败：${error.message || '未知错误'}`, 'error');
  } finally {
    finishImportProgress();
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
