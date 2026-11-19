'use strict';
/* 提示词生成器界面 */
// 嵌入模式标记：iframe src 带 ?embed=1 时，只做提示词构建并回传宿主，不出图
window.__CPS_EMBED__ = /[?&]embed=1/.test(location.search);
var DATA = {}, STATE = null, LOCKS = {}, CURTAB = 'character', POSES = {}, LASTBUILD = null;

var TABS = [
  { id: 'character', ic: '\u25CF', name: '人物' },
  { id: 'clothing',  ic: '\u25C8', name: '服装' },
  { id: 'pose',      ic: '\u25D0', name: '动作' },
  { id: 'scene',     ic: '\u25A3', name: '场景' },
  { id: 'feature',   ic: '\u2726', name: '特征' },
  { id: 'style',     ic: '\u25D1', name: '画风' },
  { id: 'output',    ic: '\u2699', name: '输出' }
];

var BROWSER = !window.cps;
var API = window.cps || {
  readJSON: function (rel) { return fetch('/' + rel).then(function (r) { return r.json(); }).then(function (d) { return { ok: true, data: d }; }).catch(function () { return { ok: false }; }); },
  writeJSON: function (rel, obj) { return fetch('/__save', { method: 'POST', body: JSON.stringify({ path: rel, data: obj }) }).then(function () { return { ok: true }; }).catch(function () { return { ok: false }; }); },
  comfy: function (o) {
    return fetch('/proxy' + o.path, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : null })
      .then(function (r) {
        if (o.json === false) return r.arrayBuffer().then(function (ab) {
          var b = ''; var arr = new Uint8Array(ab);
          for (var i = 0; i < arr.length; i++) b += String.fromCharCode(arr[i]);
          return { ok: r.ok, status: r.status, base64: btoa(b), type: r.headers.get('content-type') || 'image/png' };
        });
        return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
      }).catch(function (e) { return { ok: false, error: e.message }; });
  },
  ping: function () { return fetch('/proxy/system_stats').then(function (r) { return { ok: r.ok, port: 8188 }; }).catch(function () { return { ok: false }; }); },
  launch: function () { return fetch('/__launch').then(function () { return { ok: true }; }).catch(function () { return { ok: false }; }); },
  kill: function () { return fetch('/__kill').then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: e.message }; }); },
  saveImage: function () { return Promise.resolve({ ok: false }); },
  openFolder: function () { return Promise.resolve({ ok: false, error: '浏览器模式打不开本地目录，用 Electron 版' }); },
  // 训练：只有桌面版有完整能力，浏览器模式给同形状的失败返回，界面不会崩
  trainScan: function () { return Promise.resolve({ ok: false, error: '训练只在桌面版可用' }); },
  trainEnv: function () { return Promise.resolve({ ok: false }); },
  trainCkpts: function () { return Promise.resolve({ ok: false }); },
  trainCaption: function () { return Promise.resolve({ ok: false, error: '训练只在桌面版可用' }); },
  trainStatus: function () { return Promise.resolve({ ok: false }); },
  trainPrepare: function () { return Promise.resolve({ ok: false, error: '训练只在桌面版可用' }); },
  trainStart: function () { return Promise.resolve({ ok: false, error: '训练只在桌面版可用' }); },
  trainStop: function () { return Promise.resolve({ ok: false, error: '训练只在桌面版可用' }); },
  trainLog: function () { return Promise.resolve({ ok: false }); },
  trainSets: function () { return Promise.resolve({ ok: false, items: [] }); },
  loraRemove: function () { return Promise.resolve({ ok: false, error: '浏览器模式不支持' }); },
  loraExport: function () { return Promise.resolve({ ok: false, error: '浏览器模式不支持' }); },
  loraRename: function () { return Promise.resolve({ ok: false, error: '浏览器模式不支持' }); },
  // 生图模型管理：桌面版可用，浏览器模式给同形状的失败返回，界面不会崩
  modelsScan: function () { return Promise.resolve({ ok: false, error: '模型管理只在桌面版可用', files: [] }); },
  modelsSave: function () { return Promise.resolve({ ok: false, error: '模型管理只在桌面版可用' }); },
  modelsRemove: function () { return Promise.resolve({ ok: false, error: '模型管理只在桌面版可用' }); }
};

function $(s) { return document.querySelector(s); }
function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function status(msg, kind) { $('#statusText').textContent = msg; }

function CTX() {
  return { models: DATA.models, characters: DATA.characters, clothing: DATA.clothing,
    scenes: DATA.scenes, features: DATA.features, styles: DATA.styles,
    poses: POSES, negatives: DATA.negatives, lora: DATA.lora };
}

/* ---------- tooltip ---------- */
var tipEl = null;
// 界面缩放因子（body zoom）。fixed 定位要把视觉坐标换算回 CSS 坐标，否则会二次放大。
function zoomFactor() {
  var z = 1;
  try { z = parseFloat(getComputedStyle(document.body).zoom) || 1; } catch (e) {}
  return z || 1;
}
function bindTip(el, text) {
  if (!text) return;
  el.addEventListener('mouseenter', function (e) {
    if (!tipEl) tipEl = $('#tip');
    tipEl.innerHTML = text.replace(/\n/g, '<br>');
    tipEl.classList.remove('hidden');
    var z = zoomFactor();
    var r = el.getBoundingClientRect();
    var w = 330 * z;                                  // 视觉宽度
    var x = Math.min(r.left, window.innerWidth - w - 16 * z);
    var y = r.bottom + 6 * z;
    if (y + tipEl.offsetHeight * z > window.innerHeight) y = r.top - tipEl.offsetHeight * z - 6 * z;
    tipEl.style.left = Math.max(8, x / z) + 'px';
    tipEl.style.top = Math.max(8, y / z) + 'px';
  });
  el.addEventListener('mouseleave', function () { if (tipEl) tipEl.classList.add('hidden'); });
}

/* ---------- 数据加载 ---------- */
/* ---------- 图片灯箱（点图放大 / 滚轮缩放 / 拖动平移） ---------- */
var LB = { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0 };

function lbApply() {
  var img = $('#lightboxImg');
  if (!img) return;
  img.style.transform = 'translate(' + LB.x + 'px,' + LB.y + 'px) scale(' + LB.scale + ')';
}
function openLightbox(src) {
  var lb = $('#lightbox'), img = $('#lightboxImg');
  if (!lb || !img || !src) return;
  img.src = src;
  LB.scale = 1; LB.x = 0; LB.y = 0; lbApply();
  lb.classList.remove('hidden');
}
function closeLightbox() {
  var lb = $('#lightbox');
  if (lb) lb.classList.add('hidden');
  LB.scale = 1; LB.x = 0; LB.y = 0; lbApply();
}
function bindLightbox() {
  var lb = $('#lightbox'), img = $('#lightboxImg');
  if (!lb || !img) return;
  // 捕获阶段拦：先放大，不再触发图库回填那类父级点击
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG') return;
    // 图库弹层里点标题就是「回填参数」（弹层自己也这么写），不能在半路被放大镜截走
    if (t.closest('#modalGallery')) return;
    if (t.closest('#result') || t.closest('.gal-item')) {
      e.stopPropagation(); e.preventDefault();
      openLightbox(t.src);
    }
  }, true);
  lb.addEventListener('click', function (e) {
    if (e.target.id !== 'lightboxImg') closeLightbox();
  });
  lb.addEventListener('wheel', function (e) {
    e.preventDefault();
    var next = Math.min(8, Math.max(1, LB.scale * (e.deltaY < 0 ? 1.15 : 0.87)));
    LB.scale = next;
    if (next <= 1) { LB.x = 0; LB.y = 0; }
    lbApply();
  }, { passive: false });
  img.addEventListener('mousedown', function (e) {
    if (LB.scale <= 1) return;
    LB.dragging = true; LB.sx = e.clientX; LB.sy = e.clientY; LB.ox = LB.x; LB.oy = LB.y;
    img.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!LB.dragging) return;
    LB.x = LB.ox + (e.clientX - LB.sx);
    LB.y = LB.oy + (e.clientY - LB.sy);
    lbApply();
  });
  window.addEventListener('mouseup', function () {
    if (!LB.dragging) return;
    LB.dragging = false;
    img.classList.remove('dragging');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeLightbox();
  });
  // 双击灯箱里的图：在 1x 与 2x 之间切换
  img.addEventListener('dblclick', function (e) {
    e.stopPropagation();
    LB.scale = LB.scale > 1 ? 1 : 2;
    LB.x = 0; LB.y = 0; lbApply();
  });
}

/* ---------- 出图进度（ComfyUI WebSocket） ---------- */
var COMFLY_PORT = 8188;
var CWS = null, CWS_OK = false, PROG = { pid: null, on: false, t0: 0, shot: 0, total: 1, lastVal: 0, lastMax: 0, timer: null };
var NODE_CN = {
  '3': '采样中', '4': '加载模型权重', '5': '准备画布', '6': '编码正向提示词', '7': '编码负向提示词',
  '8': 'VAE 解码', '9': '保存图片', '20': '加载 ControlNet', '21': '读取控制图',
  '22': '应用 ControlNet', '23': '提取控制图（预处理）', '10': '加载 LoRA', '11': '加载 LoRA', '12': '加载 LoRA'
};

function progShow(total) {
  PROG.on = true; PROG.pid = null; PROG.t0 = Date.now(); PROG.shot = 1; PROG.total = total || 1;
  PROG.lastVal = 0; PROG.lastMax = 0;
  var w = $('#progWrap'); if (!w) return;
  w.classList.remove('hidden');
  $('#progFill').className = 'prog-fill indet';
  $('#progFill').style.width = '';
  $('#progLabel').textContent = '提交中…';
  $('#progPct').textContent = '';
  $('#progStage').textContent = COMFLY ? '已连接 8188' : '连接 ComfyUI…';
  $('#progEta').textContent = '';
  if (PROG.timer) clearInterval(PROG.timer);
  PROG.timer = setInterval(progTick, 1000);
}
function progHide() {
  var w = $('#progWrap'); if (w) w.classList.add('hidden');
  PROG.on = false;
  if (PROG.timer) { clearInterval(PROG.timer); PROG.timer = null; }
}
function progTick() {
  if (!PROG.on) return;
  var sec = Math.round((Date.now() - PROG.t0) / 1000);
  var eta = $('#progEta');
  if (eta && sec > 2 && PROG.lastVal > 0 && PROG.lastMax > 0) {
    var per = (Date.now() - PROG.t0) / PROG.lastVal;
    var left = Math.max(0, Math.round(per * (PROG.lastMax - PROG.lastVal) / 1000));
    eta.textContent = '已用 ' + sec + 's · 剩余约 ' + left + 's';
  } else if (eta) {
    eta.textContent = sec > 0 ? '已用 ' + sec + 's' : '';
  }
}
function progSet(pct, label, stage, cls) {
  if (!PROG.on) return;
  var fill = $('#progFill'); if (!fill) return;
  if (pct == null) {
    fill.classList.add('indet');
  } else {
    fill.classList.remove('indet');
    fill.style.width = pct + '%';
  }
  if (cls) fill.className = 'prog-fill' + (cls === 'done' ? ' done' : cls === 'err' ? ' err' : '');
  if (label != null) $('#progLabel').textContent = label;
  if (pct != null) $('#progPct').textContent = pct + '%';
  if (stage != null) $('#progStage').textContent = stage;
}

function initComfyWS() {
  if (CWS || typeof WebSocket === 'undefined') return;
  // 浏览器模式走 server.js 的 :7811/ws，Electron 模式走主进程的 :7812/ws（两者都会改写 Origin）
  var wsPort = window.cps ? 7812 : (location.port || 7811);
  var url = 'ws://127.0.0.1:' + wsPort + '/ws?clientId=cps_' + Math.random().toString(36).slice(2, 10);
  var sock;
  try { sock = new WebSocket(url); } catch (e) { CWS = null; return; }
  CWS = sock;
  sock.onopen = function () { CWS_OK = true; };
  sock.onclose = function () {
    CWS_OK = false;
    if (CWS === sock) { CWS = null; setTimeout(initComfyWS, 4000); }
  };
  sock.onerror = function () { CWS_OK = false; };
  sock.onmessage = function (ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || !m.type || !PROG.on) return;
    if (PROG.pid && m.data && m.data.prompt_id && m.data.prompt_id !== PROG.pid) return;
    if (m.type === 'execution_start') {
      PROG.t0 = Date.now();
      progSet(null, '开始执行…', '排队完成，正在跑工作流');
    } else if (m.type === 'execution_cached') {
      progSet(null, '部分节点命中缓存', '');
    } else if (m.type === 'progress') {
      var v = m.data.value, mx = m.data.max;
      PROG.lastVal = v; PROG.lastMax = mx;
      var pct = mx ? Math.round(v / mx * 100) : 0;
      progSet(pct, '采样 ' + v + ' / ' + mx + ' 步', 'KSampler', null);
    } else if (m.type === 'executing') {
      var n = m.data && m.data.node;
      if (n == null) {
        progSet(100, '本张完成', '收尾', 'done');
      } else {
        progSet(null, '处理中…', (NODE_CN[String(n)] || ('节点 ' + n)) );
      }
    } else if (m.type === 'execution_error') {
      progSet(100, '执行出错', (m.data && m.data.exception_message || '看 ComfyUI 日志').slice(0, 80), 'err');
    }
  };
}

/* ---------- 界面缩放（字体与控件整体放大） ---------- */
var ZOOM_KEY = 'cps_ui_zoom';
function zoomNow() {
  var z = getComputedStyle(document.body).zoom;
  return Math.round((parseFloat(z) || 1) * 100);
}
function adaptTopbar() {
  var z = parseFloat(getComputedStyle(document.body).zoom) || 1;
  var eff = window.innerWidth / z;          // 缩放后的有效逻辑宽度
  document.body.classList.toggle('top-compact', eff < 1180);
  document.body.classList.toggle('top-tight', eff < 980);
}
function applyZoom(z, save) {
  z = Math.min(1.8, Math.max(0.8, Math.round(z * 100) / 100));
  document.body.style.setProperty('--ui-zoom', String(z));
  var v = $('#zoomVal'); if (v) v.textContent = Math.round(z * 100) + '%';
  if (save) { try { localStorage.setItem(ZOOM_KEY, String(z)); } catch (e) {} status('界面缩放 ' + Math.round(z * 100) + '%'); }
  adaptTopbar();
}
function initZoom() {
  var saved = 0;
  try { saved = parseFloat(localStorage.getItem(ZOOM_KEY) || '0'); } catch (e) {}
  if (saved) applyZoom(saved, false);
  else {
    // 默认 125%：窗口默认 1330 宽会命中 max-width:1360 的媒体查询（110%），这里显式覆盖
    applyZoom(1.25, false);
  }
  var zo = $('#zoomOut'), zi = $('#zoomIn');
  if (zo) zo.onclick = function () { applyZoom(zoomNow() / 100 - 0.1, true); };
  if (zi) zi.onclick = function () { applyZoom(zoomNow() / 100 + 0.1, true); };
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(zoomNow() / 100 + 0.1, true); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); applyZoom(zoomNow() / 100 - 0.1, true); }
    else if (e.key === '0') { e.preventDefault(); try { localStorage.removeItem(ZOOM_KEY); } catch (x) {} document.body.style.removeProperty('--ui-zoom'); var v = $('#zoomVal'); if (v) v.textContent = zoomNow() + '%'; adaptTopbar(); }
  });
  // 窗口变大/变小时同步显示实际值（媒体查询会改 --ui-zoom）
  window.addEventListener('resize', function () { var v = $('#zoomVal'); if (v) v.textContent = zoomNow() + '%'; adaptTopbar(); });
  adaptTopbar();
}

/* ---------- 滑条填充（条形滑块左边的已选部分） ---------- */
function setFill(inp) {
  if (!inp || inp.type !== 'range') return;
  var min = +inp.min || 0, max = +inp.max || 100, v = +inp.value;
  var p = max > min ? (v - min) / (max - min) * 100 : 0;
  inp.style.setProperty('--p', Math.max(0, Math.min(100, p)).toFixed(1) + '%');
}
function syncFills() {
  Array.prototype.forEach.call(document.querySelectorAll('input[type=range]'), setFill);
}

/* ---------- 提示词 / 参数块折叠（腾出空间给预览） ---------- */
var FOLD_KEY = 'cps_fold';
function initFold() {
  var st = null;
  try { st = JSON.parse(localStorage.getItem(FOLD_KEY) || 'null'); } catch (e) {}
  if (!st) st = { pos: true, neg: true, params: true };   // 首次打开：提示词默认收起，参数保持展开
  [['pos', '#pvPos'], ['neg', '#pvNeg'], ['params', '#pvParams']].forEach(function (p) {
    var box = $(p[1]); if (!box) return;
    var head = box.querySelector('.pv-head');
    if (!head) return;
    if (st[p[0]]) box.classList.add('collapsed');
    head.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'BUTTON') return;
      box.classList.toggle('collapsed');
      st[p[0]] = box.classList.contains('collapsed');
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(st)); } catch (x) {}
    });
  });
  // 双击标题栏：三块一起收起 / 一起展开
  var posHead = $('#pvPos') && $('#pvPos').querySelector('.pv-head');
  if (posHead) {
    posHead.addEventListener('dblclick', function () {
      var allCollapsed = ['#pvPos', '#pvNeg', '#pvParams'].every(function (q) {
        var b = $(q); return b && b.classList.contains('collapsed');
      });
      ['#pvPos', '#pvNeg', '#pvParams'].forEach(function (q) {
        var b = $(q); if (!b) return;
        b.classList.toggle('collapsed', !allCollapsed);
      });
      st = { pos: !allCollapsed, neg: !allCollapsed, params: !allCollapsed };
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(st)); } catch (x) {}
      status(allCollapsed ? '已展开提示词面板' : '已收起提示词面板');
    });
  }
}

/* ---------- 无边框窗口：自绘最小化/最大化/关闭 ---------- */

/* 窗口按钮：独立绑定，boot 里调一次 + 延迟再兜一次，避免被前面的异常跳过 */
function bindWinCtl() {
  if (!window.cps || !window.cps.win) return false;
  var mn = document.getElementById('winMin');
  var mx = document.getElementById('winMax');
  var cl = document.getElementById('winClose');
  if (!mn || !mx || !cl) return false;
  mn.onclick = function () { window.cps.win.min(); };
  mx.onclick = function () { window.cps.win.max(); };
  cl.onclick = function () { window.cps.win.close(); };
  try {
    mx.innerHTML = '&#x25A2;';
    window.cps.win.isMax().then(function (v) {
      mx.innerHTML = v ? '&#x2750;' : '&#x25A2;';
      mx.title = v ? '还原' : '最大化';
    });
    window.cps.win.onMaxChange(function (v) {
      mx.innerHTML = v ? '&#x2750;' : '&#x25A2;';
      mx.title = v ? '还原' : '最大化';
    });
  } catch (e) {}
  return true;
}

function initWinCtl() {
  var isEl = !!window.cps;
  document.body.classList.toggle('is-electron', isEl);
  var mn = $('#winMin'), mx = $('#winMax'), cl = $('#winClose');
  if (!isEl || !window.cps.win) return;
  if (mn) mn.onclick = function () { window.cps.win.min(); };
  if (mx) mx.onclick = function () { window.cps.win.max(); };
  if (cl) cl.onclick = function () { window.cps.win.close(); };
  try {
    window.cps.win.onMaxChange(function (v) {
      if (!mx) return;
      mx.innerHTML = v ? '&#x2750;' : '&#x25A2;';
      mx.title = v ? '还原' : '最大化';
    });
    window.cps.win.isMax().then(function (v) {
      if (!mx) return;
      mx.innerHTML = v ? '&#x2750;' : '&#x25A2;';
      mx.title = v ? '还原' : '最大化';
    });
  } catch (e) {}
  // 双击顶栏空白处切换最大化/还原
  var tb = $('#topbar');
  if (tb) {
    tb.addEventListener('dblclick', function (e) {
      if (e.target.closest('button,input,.model-switch,.token-wrap,.zoom-ctl,.win-ctl,.brand')) return;
      window.cps.win.max();
    });
  }
}

/* ---------- 通用选项选择弹层（多选项字段用，像姿势库一样） ---------- */
var PICK = { mod: null, field: null };

function openPicker(mod, field) {
  PICK.mod = mod; PICK.field = field;
  var m = $('#modalPicker');
  $('#pickTitle').innerHTML = '选择 · ' + field.label + '<em id="pickSub" class="sub">' +
    (field.type === 'multi' ? '可多选' : '单选，再点一次取消') + '</em>';
  $('#pickSearch').value = '';
  m.classList.remove('hidden');
  renderPickList('');
  // 每次打开都重新绑一次：boot 时的那次绑定可能因为前面某处异常被跳过
  var dn2 = $('#pickDone');
  if (dn2) dn2.onclick = function (e) {
    if (e) e.stopPropagation();
    closePicker(); renderPanel(); rebuild();
  };
  var cl2 = $('#pickClear');
  if (cl2) cl2.onclick = function (e) {
    if (e) e.stopPropagation();
    if (!PICK.field) return;
    STATE[PICK.mod][PICK.field.id] = PICK.field.type === 'multi' ? [] : null;
    renderPickList(''); renderPanel(); rebuild();
    status('已清空「' + PICK.field.label + '」');
  };
  var sr = $('#pickSearch');
  if (sr) sr.oninput = function () { renderPickList(this.value); };
  var md = $('#modalPicker');
  if (md) md.onclick = function (e) { if (e.target === md) closePicker(); };
  setTimeout(function () { var q = $('#pickSearch'); if (q) q.focus(); }, 30);
}
function closePicker() { $('#modalPicker').classList.add('hidden'); PICK.mod = null; PICK.field = null; }

function renderPickList(q) {
  var f = PICK.field, mod = PICK.mod;
  if (!f) return;
  var box = $('#pickList'); box.innerHTML = '';
  var cur = STATE[mod][f.id];
  var curArr = Array.isArray(cur) ? cur : (cur ? [cur] : []);
  var multi = f.type === 'multi';
  var qq = (q || '').trim().toLowerCase();
  var shown = 0;
  // 合并进来的字段（眼型→瞳色/瞳孔特效，妆容→妆浓程度）：同一弹框里依次给一段
  var mlist = f.mergeFields || (f.mergeField ? [f.mergeField] : []);
  if (!qq) mlist.forEach(function (mid) {
    var mf = (DATA[dataModKey(mod)] && DATA[dataModKey(mod)].fields || []).find(function (x) { return x.id === mid; });
    if (!mf) return;
    var hd = el('div', 'pick-sec pick-sec-top', (mf.type === 'slider' ? (mf.label + '（拖动调整）') : (mf.type === 'multi' ? (mf.label + '（可多选）') : (mf.label + '（单选，点一下再点一次取消）'))));
    hd.style.gridColumn = '1/-1';
    box.appendChild(hd);

    if (mf.type === 'slider') {
      var sw = el('div', 'pick-slider');
      sw.style.gridColumn = '1/-1';
      var cur0 = STATE[mod][mf.id];
      var v0 = (cur0 == null || isNaN(+cur0)) ? Math.round(((mf.min != null ? mf.min : 0) + (mf.max != null ? mf.max : 100)) / 2) : +cur0;
      var rng = document.createElement('input');
      rng.type = 'range';
      rng.min = String(mf.min != null ? mf.min : 0);
      rng.max = String(mf.max != null ? mf.max : 100);
      rng.step = '1';
      rng.value = String(v0);
      rng.className = 'pick-range';
      var num = el('b', 'pick-range-v', STATE[mod][mf.id] == null ? '默认' : String(v0));
      rng.oninput = function () {
        STATE[mod][mf.id] = +this.value;
        num.textContent = String(this.value);
        rebuild();
      };
      rng.onchange = function () { renderPanel(); };
      var clr = el('span', 'chip', '清空');
      clr.onclick = function () {
        STATE[mod][mf.id] = null;
        num.textContent = '默认';
        rng.value = String(v0);
        rebuild(); renderPickList($('#pickSearch').value); renderPanel();
      };
      sw.appendChild(rng); sw.appendChild(num); sw.appendChild(clr);
      box.appendChild(sw);
    } else {
      var cw = el('div', 'chips');
      cw.style.gridColumn = '1/-1';
      (mf.options || []).forEach(function (o) {
        var on = Array.isArray(STATE[mod][mf.id]) ? STATE[mod][mf.id].indexOf(o.v) >= 0 : STATE[mod][mf.id] === o.v;
        var c = el('span', 'chip pick-color' + (on ? ' on' : ''), o.cn);
        if (o.hex) {
          var dot = el('i');
          dot.style.cssText = 'display:inline-block;width:22px;height:22px;border-radius:5px;margin-right:8px;vertical-align:-6px;border:1px solid rgba(255,255,255,.28);background:' + o.hex;
          c.insertBefore(dot, c.firstChild);
          c.title = o.v;
        }
        c.onclick = function () {
          if (mf.type === 'multi') {
            var arr = Array.isArray(STATE[mod][mf.id]) ? STATE[mod][mf.id].slice() : [];
            var i2 = arr.indexOf(o.v);
            if (i2 >= 0) arr.splice(i2, 1); else arr.push(o.v);
            STATE[mod][mf.id] = arr;
          } else {
            STATE[mod][mf.id] = (STATE[mod][mf.id] === o.v) ? null : o.v;
          }
          touch(mod);
          renderPickList($('#pickSearch').value);
          renderPanel(); rebuild();
        };
        cw.appendChild(c);
      });
      box.appendChild(cw);
    }
  });
  favSortOptions(mod, f.id, f.options).forEach(function (o) {
    if (qq && (o.cn + ' ' + o.v).toLowerCase().indexOf(qq) < 0) return;
    shown++;
    var on = curArr.indexOf(o.v) >= 0;
    var fav0 = isFav(mod, f.id, o.v);
    var it = el('div', 'pick-item' + (on ? ' on' : '') + (o.v === 'none' ? ' pick-none' : '') + (fav0 ? ' fav' : ''));
    it.innerHTML = (fav0 ? '<span class="pi-star">★</span>' : '') +
      '<span class="pi-cn">' + o.cn + '</span>' + (f.hideTag ? '' : '<span class="pi-v">' + o.v + '</span>');
    attachFav(it, mod, f.id, o.v, o.cn, function () { renderPickList($('#pickSearch').value); });
    it.onclick = function () {
      if (multi) {
        var arr = Array.isArray(STATE[mod][f.id]) ? STATE[mod][f.id].slice() : [];
        var i = arr.indexOf(o.v);
        if (i >= 0) arr.splice(i, 1); else arr.push(o.v);
        // 「无 / none」和其它项互斥
        if (o.v === 'none' && arr.length > 1) arr = ['none'];
        if (o.v !== 'none') arr = arr.filter(function (x) { return x !== 'none'; });
        STATE[mod][f.id] = arr;
        touch(mod);
      } else {
        var c0 = STATE[mod][f.id];
        STATE[mod][f.id] = (c0 === o.v) ? (f.optional ? null : (f.default !== undefined ? f.default : null)) : o.v;
        touch(mod);
      }
      if (mod === 'feature' && f.id === 'crowd') STATE._crdAuto = false;
      renderPickList($('#pickSearch').value);
      renderPanel(); rebuild();
      if (!multi) closePicker();
    };
    box.appendChild(it);
  });
  if (!shown) {
    var empty = el('div', 'hint', '没有匹配的选项');
    empty.style.gridColumn = '1/-1';
    empty.style.padding = '16px 4px';
    box.appendChild(empty);
  }
  var hint = $('#pickHint');
  if (hint) {
    hint.textContent = multi
      ? ('已选 ' + curArr.length + ' 项 / 共 ' + (f.options || []).length + ' 项')
      : ('当前：' + (curArr.length ? ((f.options || []).find(function (o) { return o.v === curArr[0]; }) || {}).cn || curArr[0] : '未选'));
  }
}

// STATE 用单数模块名（character），DATA 用复数（characters）
function dataModKey(mod) {
  return mod === 'character' ? 'characters' : (mod === 'scene' ? 'scenes' : (mod === 'feature' ? 'features' : (mod === 'style' ? 'styles' : mod)));
}
function buildPickRow(f, arr, mod) {
  var row = el('div', 'pick-row');
  var btn = el('button', 'btn pick-btn', '选择');
  btn.title = '打开选项面板（共 ' + (f.options || []).length + ' 项）';
  btn.onclick = function () { openPicker(mod, f); };
  row.appendChild(btn);                      // 选择按钮放左边，更顺手也更显眼
  var txt = arr && arr.length
    ? arr.map(function (v) { var o = (f.options || []).find(function (x) { return x.v === v; }); return o ? o.cn : v; }).join('、')
    : '未选择';
  // 合并字段（瞳色 / 瞳孔特效 / 妆浓程度）也显示在摘要里
  var mlist2 = f.mergeFields || (f.mergeField ? [f.mergeField] : []);
  mlist2.forEach(function (mid) {
    var mc = (DATA[dataModKey(mod)] && DATA[dataModKey(mod)].fields || []).find(function (x) { return x.id === mid; });
    if (!mc) return;
    var mcv = STATE[mod][mc.id];
    if (Array.isArray(mcv)) {
      if (!mcv.length) return;
      var cns = mcv.map(function (v) { var o = (mc.options || []).find(function (x) { return x.v === v; }); return o ? o.cn : v; });
      txt = (txt && txt !== '未选择' ? txt + '　·　' : '') + mc.label + '：' + cns.join('、');
      return;
    }
    if (mcv == null || mcv === '') return;
    var label;
    if (mc.type === 'slider') label = mc.label + ' ' + mcv;
    else {
      var mco = (mc.options || []).find(function (x) { return x.v === mcv; });
      label = mc.label + '：' + (mco ? mco.cn : mcv);
    }
    txt = (txt && txt !== '未选择' ? txt + '　·　' : '') + label;
  });
  var sum = el('span', 'pr-sum' + (arr && arr.length ? '' : ' empty'), txt);
  row.appendChild(sum);
  return row;
}

function bindPicker() {
  var q = $('#pickSearch');
  if (q) q.addEventListener('input', function () { renderPickList(q.value); });
  var cl = $('#pickClear');
  if (cl) cl.onclick = function () {
    if (!PICK.field) return;
    STATE[PICK.mod][PICK.field.id] = PICK.field.type === 'multi' ? [] : null;
    renderPickList(''); renderPanel(); rebuild(); status('已清空「' + PICK.field.label + '」');
  };
  var dn = $('#pickDone');
  if (dn) dn.onclick = function () { closePicker(); renderPanel(); rebuild(); };
  var m = $('#modalPicker');
  if (m) m.addEventListener('click', function (e) { if (e.target.id === 'modalPicker') closePicker(); });
}

/* ---------- ComfyUI 服务：启动 / 退出 ---------- */
async function comfyStart(btn) {
  var t0 = Date.now();
  if (btn) { btn.disabled = true; btn.textContent = '启动中'; }
  status('正在拉起 ComfyUI 服务…');
  progShow(1);
  progSet(null, '启动 ComfyUI…', '加载中（首次约 40–60 秒）');
  var r = await API.launch();
  if (!r || !r.ok) {
    status('启动失败：' + ((r && r.error) || '未知'));
    progSet(100, '启动失败', (r && r.error) || '未知', 'err');
    setTimeout(progHide, 4000);
    if (btn) { btn.disabled = false; btn.textContent = '启动'; }
    return false;
  }
  var ok = false;
  for (var i = 0; i < 30; i++) {
    await new Promise(function (res) { setTimeout(res, 3000); });
    var sec = Math.round((Date.now() - t0) / 1000);
    progSet(null, 'ComfyUI 启动中 ' + sec + 's', '等待 8188 响应…');
    var p = await API.ping();
    if (p && p.ok) { ok = true; break; }
  }
  if (btn) { btn.disabled = false; btn.textContent = '启动'; }
  if (ok) {
    await pingComfy();
    progSet(100, 'ComfyUI 已就绪', '', 'done');
    setTimeout(progHide, 1500);
    status('ComfyUI 已就绪，可以出图');
    return true;
  }
  progSet(100, '超时未就绪', '看 _tmp/comfyui.log', 'err');
  setTimeout(progHide, 5000);
  status('等了 90 秒仍未就绪，看 _tmp\\comfyui.log');
  return false;
}

async function comfyStop(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '退出中'; }
  var r = await API.kill();
  if (btn) { btn.disabled = false; btn.textContent = '退出'; }
  COMFLY = false;
  var st = $('#comfyStatus');
  if (st) { st.textContent = '未连接'; st.className = 'status err'; }
  if (r && r.ok) {
    var n = (r.killed || []).length;
    status(n ? ('已关闭 ComfyUI（终止 ' + n + ' 个进程）') : '当前没有在跑的 ComfyUI');
  } else {
    status('关闭失败：' + ((r && r.error) || '未知'));
  }
}

/* ---------- 左右可拖拽分割条（设定区 / 预览区） ---------- */
var PVW_KEY = 'cps_pv_width';
function initSplitter() {
  var sp = $('#splitter'), pv = $('#preview');
  if (!sp || !pv) return;
  var saved = parseInt(localStorage.getItem(PVW_KEY) || '0', 10);
  if (saved > 240) {
    pv.style.width = saved + 'px';
  } else {
    // 默认预览区 = 窗口宽度的 41.7%（实测用户习惯的比例）
    var zz = parseFloat(getComputedStyle(document.body).zoom) || 1;
    var base = (window.innerWidth / zz) * 0.417;
    pv.style.width = Math.round(base) + 'px';
    window.addEventListener('resize', function () {
      if (localStorage.getItem(PVW_KEY)) return;   // 用户拖过就不再自动改
      var z2 = parseFloat(getComputedStyle(document.body).zoom) || 1;
      pv.style.width = Math.round((window.innerWidth / z2) * 0.417) + 'px';
    });
  }

  var drag = false, startX = 0, startW = 0, z = 1;
  sp.addEventListener('mousedown', function (e) {
    drag = true;
    startX = e.clientX;
    startW = pv.getBoundingClientRect().width;      // 视觉像素
    z = parseFloat(getComputedStyle(document.body).zoom) || 1;
    sp.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var dx = (startX - e.clientX) / z;              // 向左拖 = 预览变宽
    var w = startW / z + dx;
    var maxW = (window.innerWidth / z) - 460;       // 左边至少留 460
    w = Math.max(300, Math.min(maxW, w));
    pv.style.width = Math.round(w) + 'px';
  });
  window.addEventListener('mouseup', function () {
    if (!drag) return;
    drag = false;
    sp.classList.remove('dragging');
    document.body.style.cursor = '';
    try { localStorage.setItem(PVW_KEY, String(parseInt(pv.style.width, 10) || 0)); } catch (e) {}
  });
  // 双击分割条恢复默认宽度
  sp.addEventListener('dblclick', function () {
    pv.style.width = '';
    try { localStorage.removeItem(PVW_KEY); } catch (e) {}
    status('预览宽度已恢复默认');
  });
}

/* ---------- 一键收起提示词/参数三块 ---------- */
var HIDEP_KEY = 'cps_hide_prompts';
function initHidePrompts() {
  var btn = $('#btnHidePrompts');
  function apply(hide) {
    document.body.classList.toggle('hide-prompts', !!hide);
    if (btn) btn.textContent = hide ? '显示提示词' : '收起提示词';
    try { localStorage.setItem(HIDEP_KEY, hide ? '1' : '0'); } catch (e) {}
  }
  var on = true;   // 默认收起提示词三块，出图区占满（与用户截图一致）
  try { var v = localStorage.getItem(HIDEP_KEY); if (v !== null) on = v === '1'; } catch (e) {}
  apply(on);
  if (btn) btn.onclick = function () {
    var now = !document.body.classList.contains('hide-prompts');
    apply(now);
    status(now ? '已收起提示词面板，图区已放大' : '已显示提示词面板');
  };
}

/* ---------- 生图模型：模板 / 列表 / 添加 / 删除 ---------- */
var MODEL_TEMPLATES = {
  anime_sdxl: {
    arch: 'sdxl', kind: 'anime', supportsArtist: true, loraRule: 'IL', tokenBudget: 200, forceNegGroups: [],
    prefix: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres',
    negativeBase: 'bad quality, worst quality, low quality, lowres, bad anatomy, bad hands, extra digits, fewer digits, missing fingers, extra limbs, fused fingers, mutated hands, poorly drawn face, poorly drawn hands, deformed, disfigured, blurry, jpeg artifacts, watermark, signature, username, text, error, censored',
    sampler: { steps: 30, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal', width: 896, height: 1344 }
  },
  realistic_sdxl: {
    arch: 'sdxl', kind: 'realistic', supportsArtist: false, loraRule: '!IL', tokenBudget: 200, forceNegGroups: [],
    prefix: 'masterpiece, best quality, ultra detailed, photorealistic',
    negativeBase: 'worst quality, low quality, lowres, bad anatomy, bad hands, extra digits, fewer digits, missing fingers, extra limbs, fused fingers, mutated hands, deformed, disfigured, blurry, jpeg artifacts, watermark, signature, text, censored, cartoon, anime, 3d render, cgi, doll, mannequin',
    sampler: { steps: 28, cfg: 5.5, sampler: 'dpmpp_2m', scheduler: 'karras', width: 832, height: 1216 }
  },
  anime_sd15: {
    arch: 'sd15', kind: 'anime', supportsArtist: true, loraRule: '!IL', tokenBudget: 150, forceNegGroups: [],
    prefix: 'masterpiece, best quality, very aesthetic',
    negativeBase: 'worst quality, low quality, lowres, bad anatomy, bad hands, extra digits, fewer digits, missing fingers, extra limbs, fused fingers, mutated hands, deformed, blurry, jpeg artifacts, watermark, signature, text, censored',
    sampler: { steps: 28, cfg: 7, sampler: 'euler_ancestral', scheduler: 'normal', width: 512, height: 768 }
  },
  realistic_sd15: {
    arch: 'sd15', kind: 'realistic', supportsArtist: false, loraRule: '!IL', tokenBudget: 150, forceNegGroups: [],
    prefix: 'masterpiece, best quality, ultra detailed, photorealistic',
    negativeBase: 'worst quality, low quality, lowres, bad anatomy, bad hands, extra digits, fewer digits, missing fingers, extra limbs, fused fingers, deformed, blurry, jpeg artifacts, watermark, signature, text, censored, cartoon, anime, 3d render, cgi, doll',
    sampler: { steps: 25, cfg: 6, sampler: 'euler_ancestral', scheduler: 'normal', width: 512, height: 768 }
  }
};

function modelKindCn(m) {
  if (!m) return '';
  var k = m.kind === 'realistic' ? '写实' : (m.kind === 'anime' ? '动漫' : '其他');
  return k + ' · ' + (m.arch === 'sd15' ? 'SD1.5' : 'SDXL');
}

function setModelTo(id) {
  var m = modelById(id);
  if (!m || STATE.model === m.id) return;
  Object.keys(STATE.loras || {}).forEach(function (f) { if (ilLoraBlocked(m, f)) delete STATE.loras[f]; });
  STATE.model = m.id;
  if (!m.supportsArtist) STATE.style.artists = [];
  // 写实度跟着模型走，避免「写实度与模型方向冲突」这种要用户自己理解的提示
  if (STATE.style && STATE.style.realism != null) STATE.style.realism = (m.kind === 'realistic') ? 85 : 35;
  renderModels(); renderSettingsModels(); renderPanel(); rebuild();
  status('已切换到「' + m.name + '」');
}

function renderSettingsModels() {
  // 占位模型（还没加底模时的兜底）只用于界面不崩，不进「生图模型」列表
  DATA.models.models = (DATA.models.models || []).filter(function (m) { return m.id !== '_none'; });
  var box = $('#setModelList');
  if (!box) return;
  var models = (DATA.models && DATA.models.models) || [];
  box.innerHTML = '';
  if (!models.length) { box.innerHTML = '<div class="set-hint">还没有模型</div>'; return; }
  models.forEach(function (m) {
    var row = el('div', 'model-row' + (STATE.model === m.id ? ' on' : ''));
    var info = el('div', 'model-info');
    info.innerHTML = '<b>' + m.name + '</b>' +
      '<span class="model-meta">' + modelKindCn(m) + ' · ' + (m.tokenBudget || 200) + ' token · ' +
      (m.sampler ? (m.sampler.steps + ' 步 / CFG ' + m.sampler.cfg) : '') + '</span>' +
      '<span class="model-file">' + (m.file || '') + '</span>';
    row.appendChild(info);
    var btns = el('div', 'model-btns');
    if (STATE.model === m.id) {
      btns.appendChild(el('span', 'model-cur', '当前'));
    } else {
      var b = el('button', 'btn mini-btn', '用这个');
      b.onclick = function () { setModelTo(m.id); };
      btns.appendChild(b);
    }
    if (models.length > 1) {
      var d = el('button', 'btn mini-btn danger', '删除');
      d.onclick = function () { removeModel(m); };
      btns.appendChild(d);
    }
    row.appendChild(btns);
    box.appendChild(row);
  });
}

function removeModel(m) {
  showGuide('从列表里删掉这个模型？',
    '<p><b>' + m.name + '</b></p>' +
    '<p class="gd-dim">只删这里的记录，<b>模型文件不会被删</b>（还在 ComfyUI 的 checkpoints 目录）。' +
    '想再用可以重新「添加模型」。</p>',
    '删除', function () {
      API.modelsRemove(m.id).then(function (r) {
        if (!r || !r.ok) { status('删除失败：' + ((r && r.error) || '未知原因')); return; }
        API.readJSON('data/models.json').then(function (rr) {
          if (rr && rr.ok) DATA.models = rr.data;
          if (!modelById(STATE.model)) STATE.model = (DATA.models.models[0] || {}).id;
          renderModels(); renderSettingsModels(); renderPanel(); rebuild();
          status('已移除模型「' + m.name + '」');
        });
      });
    }, '取消');
}

async function openAddModel() {
  var box = $('#modalModel');
  if (!box) return;
  box.classList.remove('hidden');
  var msg = $('#mmMsg'); if (msg) msg.textContent = '扫描中…';
  var sel = $('#mmFile'); sel.innerHTML = '';
  var r = await API.modelsScan();
  if (!r || !r.ok) {
    sel.innerHTML = '<option value="">（读取失败）</option>';
    if (msg) msg.textContent = (r && r.error) || '读取失败';
    return;
  }
  var files = (r.files || []).filter(function (f) { return !f.added; });
  if (!files.length) {
    sel.innerHTML = '<option value="">（没有可添加的模型）</option>';
    if (msg) msg.textContent = '没找到可添加的模型。把 .safetensors 放进：' + r.dir;
    return;
  }
  files.forEach(function (f) {
    var o = el('option');
    o.value = f.file;
    o.textContent = f.file + '（' + (f.size / 1073741824).toFixed(1) + ' GB）';
    sel.appendChild(o);
  });
  if (msg) msg.textContent = '';
  $('#mmName').value = files[0].file.replace(/\.(safetensors|ckpt)$/i, '');
}

async function saveNewModel() {
  var file = $('#mmFile').value;
  var msg = $('#mmMsg');
  if (!file) { if (msg) msg.textContent = '先选一个模型文件'; return; }
  var tpl = MODEL_TEMPLATES[$('#mmKind').value] || MODEL_TEMPLATES.anime_sdxl;
  var name = ($('#mmName').value || '').trim() || file;
  var slug = file.replace(/\.(safetensors|ckpt)$/i, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 32);
  var payload = Object.assign({}, tpl, {
    id: 'm_' + (slug || 'model') + '_' + Date.now().toString(36).slice(-4),
    file: file,
    name: name,
    note: '自定义添加（' + modelKindCn(tpl) + '）'
  });
  if (msg) msg.textContent = '保存中…';
  var r = await API.modelsSave(payload);
  if (!r || !r.ok) { if (msg) msg.textContent = '失败：' + ((r && r.error) || '未知'); return; }
  var rr = await API.readJSON('data/models.json');
  if (rr && rr.ok) DATA.models = rr.data;
  $('#modalModel').classList.add('hidden');
  renderModels(); renderSettingsModels(); renderPanel(); rebuild();
  status('已添加模型「' + name + '」');
}

/* ---------- 设置弹窗 ---------- */
var _setFirstRun = false;

/* 齿轮上的气泡提醒：有哪些还没设置好（不影响使用，但会一直提示） */
async function checkSetupBadge() {
  var gear = $('#btnSettings');
  if (!gear) return [];
  var r = null;
  try { r = await API.setupCheck(); } catch (e) { r = null; }
  var issues = (r && r.ok && r.issues) ? r.issues : [];
  var old = gear.querySelector('.gear-dot');
  if (old) old.remove();
  var oldTip = document.querySelector('#gearTip');
  if (oldTip) oldTip.remove();
  if (!issues.length) { gear.title = '路径、默认模型、默认分辨率'; return []; }

  var dot = document.createElement('i');
  dot.className = 'gear-dot';
  gear.appendChild(dot);
  gear.title = issues.map(function (x) { return x.t; }).join(' / ');

  var tip = document.createElement('div');
  tip.id = 'gearTip';
  tip.className = 'gear-tip';
  tip.innerHTML = '<b>还有 ' + issues.length + ' 项没设置</b>' +
    '<ul>' + issues.map(function (x) { return '<li>' + x.t + '</li>'; }).join('') + '</ul>' +
    '<span class="gt-go">点这里去设置 →</span>';
  tip.onclick = function () { tip.remove(); openSettings(false); };
  document.body.appendChild(tip);

  var place = function () {
    var b = gear.getBoundingClientRect();
    var z = (function () {
      var v = parseFloat(getComputedStyle(document.body).zoom || '1');
      return isNaN(v) || !v ? 1 : v;
    })();
    tip.style.left = Math.round(b.left / z - 150) + 'px';
    tip.style.top = Math.round(b.bottom / z + 8) + 'px';
  };
  place();
  // 点别处收起
  setTimeout(function () {
    document.addEventListener('click', function h(e) {
      if (!tip.contains(e.target) && e.target !== gear && !gear.contains(e.target)) {
        tip.remove();
        document.removeEventListener('click', h);
      }
    });
  }, 50);
  return issues;
}

/* 每次启动：问一次要不要拉起 ComfyUI 服务 */
async function askStartComfy() {
  var ok = false;
  try { ok = await pingComfy(); } catch (e) { ok = false; }
  if (ok) return;                       // 已经在跑，不打扰
  showGuide('ComfyUI 服务没在运行',
    '<p>出图需要 ComfyUI 在后台跑着。要现在启动吗？</p>' +
    '<p class="gd-dim">启动后约 40–60 秒准备就绪（显存占用取决于你的模型）。' +
    '选「稍后」也可以，右下角「启动服务」随时能点。</p>',
    '启动服务', function () { startComfy(); }, '稍后', null);
}

async function startComfy() {
  var st = $('#comfyStatus');
  if (st) { st.textContent = '启动中…'; st.className = 'status busy'; }
  status('正在启动 ComfyUI 服务（约 40–60 秒）…');
  var r = await API.launch();
  if (r && r.ok) {
    if (r.already) status('ComfyUI 已经在运行');
    else status('已发起启动，稍等 40–60 秒后点「检测」或直接出图');
  } else {
    status('启动失败：' + ((r && r.error) || '未知原因'));
    if (st) { st.textContent = '未连接'; st.className = 'status err'; }
  }
}

async function openSettings(firstRun) {
  var box = $('#modalSettings');
  if (!box) return;
  _setFirstRun = !!firstRun;
  box.classList.remove('hidden');
  var fr = $('#setFirstRun');
  if (fr) fr.classList.toggle('hidden', !_setFirstRun);
  var msg = $('#setMsg'); if (msg) msg.textContent = '读取中…';
  try {
    var r = await API.configGet();
    if (!r || !r.ok) { if (msg) msg.textContent = '读取配置失败'; return; }
    var c = r.config || {};
    $('#setComfyBase').value = c.comfyBase || '';
    $('#setComfyPy').value = c.comfyPy || '';
    $('#setOutDir').value = c.outDir || '';
    renderSettingsModels();
    $('#setRes').value = c.res || '832x1216';
    if (msg) msg.textContent = '';
    // 首次使用 / 路径为空：直接先跑一次自动搜索，省得用户自己找
    var needAuto = _setFirstRun || !c.comfyBase || !c.comfyPy;
    if (needAuto && typeof autoDetectSetup === 'function') {
      setTimeout(function () { autoDetectSetup(true); }, 60);
    }
  } catch (e) { if (msg) msg.textContent = '读取失败：' + e.message; }
}

/* 自动搜索：ComfyUI 根目录 / Python / 输出目录 / 底模 → 回填并登记模型 */
async function autoDetectSetup(silent) {
  var msgEl = $('#setAutoMsg');
  var say = function (t) { if (msgEl) msgEl.textContent = t; };
  say('正在扫描磁盘，请稍等…');
  var r = null;
  try { r = await API.setupDetect(); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { say('搜索失败：' + ((r && r.error) || '未知原因')); return; }

  if (!r.comfyBase) {
    say('没找到 ComfyUI 目录，请手动填「根目录」（里面要有 main.py）');
    if (r.outDir && $('#setOutDir') && !$('#setOutDir').value) $('#setOutDir').value = r.outDir;
    return;
  }
  $('#setComfyBase').value = r.comfyBase;
  if (r.comfyPy) $('#setComfyPy').value = r.comfyPy;
  if ($('#setOutDir') && !$('#setOutDir').value.trim()) $('#setOutDir').value = r.outDir || '';

  // 底模：把 checkpoints 里还没登记的自动加进来
  var added = [];
  var ck = r.checkpoints || [];
  if (ck.length) {
    var known = {};
    (DATA.models.models || []).forEach(function (m) { known[String(m.file || '').toLowerCase()] = 1; });
    for (var i = 0; i < ck.length && i < 8; i++) {
      var f = ck[i].file;
      if (known[f.toLowerCase()]) continue;
      var low = f.toLowerCase();
      var isPony = /pony/.test(low);
      var isAnime = /(illustrious|noob|_il\b|anime|wai|hentai|animagine|nova)/.test(low);
      var kind = isPony ? 'realistic' : (isAnime ? 'anime' : (/real|photo|cyber/i.test(low) ? 'realistic' : 'anime'));
      var mm = {
        id: 'auto_' + low.replace(/[^a-z0-9]+/g, '_').slice(0, 28),
        name: (kind === 'anime' ? '动漫 · ' : '写实 · ') + f.replace(/\.(safetensors|ckpt)$/i, ''),
        file: f,
        arch: 'sdxl',
        kind: kind,
        prefix: isPony ? 'score_9, score_8_up, score_7_up, source_pony'
                       : 'masterpiece, best quality, amazing quality, very aesthetic, absurdres',
        negativeBase: 'bad quality, worst quality, low quality, lowres, bad anatomy, bad hands, extra digits, fewer digits, missing fingers, extra limbs, fused fingers, mutated hands, poorly drawn face, deformed, blurry, jpeg artifacts, watermark, signature, text, censored',
        sampler: { steps: isPony ? 28 : 30, cfg: isPony ? 5.5 : 5, sampler: 'euler_ancestral', scheduler: isPony ? 'karras' : 'normal', width: 832, height: 1216 },
        supportsArtist: !isPony,
        loraRule: isPony ? '!IL' : (isAnime ? 'IL' : ''),
        tokenBudget: 200,
        forceNegGroups: [],
        note: isPony ? 'Pony 系：必须带 score_9 前缀' : (isAnime ? 'Illustrious 系：吃 danbooru tag' : '自动识别，按需微调'),
      };
      try {
        var sr = await API.modelsSave(mm);
        if (sr && sr.ok) { (DATA.models.models = DATA.models.models || []).push(sr.model); added.push(mm.name); }
      } catch (e) {}
    }
  }
  renderSettingsModels();

  var parts = ['已找到：' + r.comfyBase];
  if (!r.comfyPy) parts.push('（没找到 Python，请手动填）');
  if (added.length) parts.push('已登记 ' + added.length + ' 个底模');
  else if (!ck.length) parts.push('（checkpoints 里没有底模，请确认模型已放好）');
  say(parts.join(' · '));
  if (!silent) status('自动搜索完成');
}

function closeSettings() {
  var box = $('#modalSettings');
  if (box) box.classList.add('hidden');
}

async function saveSettings() {
  var msg = $('#setMsg');
  var patch = {
    comfyBase: $('#setComfyBase').value.trim(),
    comfyPy: $('#setComfyPy').value.trim(),
    outDir: $('#setOutDir').value.trim(),
    model: STATE.model || '',
    res: $('#setRes').value,
    installed: true,
  };
  if (msg) msg.textContent = '保存中…';
  var r = await API.configSave(patch);
  if (!r || !r.ok) { if (msg) msg.textContent = '保存失败：' + ((r && r.error) || '未知'); return; }
  if (patch.model) {
    var _mm = (DATA.models.models || []).find(function (m) { return m.id === patch.model || m.file === patch.model; });
    STATE.model = _mm ? _mm.id : patch.model;
  }
  if (patch.res) {
    var p = patch.res.split('x');
    STATE.overrideW = parseInt(p[0], 10);
    STATE.overrideH = parseInt(p[1], 10);
  }
  rebuild();
  if (msg) msg.textContent = r.needRestart ? '已保存 · ComfyUI 路径变了，请「退出服务 → 启动服务」' : '已保存';
  try { checkSetupBadge(); } catch (e) {}
  status(r.needRestart ? '设置已保存，ComfyUI 需要重启服务' : '设置已保存');
  setTimeout(closeSettings, r.needRestart ? 2200 : 900);
}

async function boot() {
  // 一开始就标记 Electron 环境：窗口按钮的显示完全靠这个类，晚一步就会被 CSS 藏掉
  try { document.body.classList.toggle('is-electron', !!window.cps); } catch (e) {}
  try { bindWinCtl(); } catch (e) {}
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('tab')) CURTAB = q.get('tab');
  } catch (e) {}
  var files = ['models', 'characters', 'clothing', 'poses-light', 'poses-mid', 'poses-service', 'scenes', 'features', 'styles', 'lora', 'negatives', 'recipes'];
  for (var i = 0; i < files.length; i++) {
    var r = await API.readJSON('data/' + files[i] + '.json');
    var key = files[i].replace('poses-', 'pose_');
    DATA[key] = r.data || r;
  }
  // 内置一个中性模型占位：提供 prefix/负面/token 预算/采样参数，界面上不显示模型切换
  if (!DATA.models || !Array.isArray(DATA.models.models) || !DATA.models.models.length) {
    DATA.models = { version: 1, models: [{
      id: '_none', name: '默认', file: '',
      arch: 'sdxl', kind: 'anime', prefix: '', negativeBase: '',
      sampler: { steps: 28, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal', width: 832, height: 1216 },
      supportsArtist: false, loraRule: '', tokenBudget: 200, forceNegGroups: [],
      note: ''
    }] };
  }
  // 只挂真正加载到的姿势库（开源版可能只有 SFW，缺 mid/service 时不能留空壳）
  POSES = {};
  [['light', 'pose_light'], ['mid', 'pose_mid'], ['service', 'pose_service']].forEach(function (pair) {
    var d = DATA[pair[1]];
    if (d && Array.isArray(d.poses) && d.poses.length) POSES[pair[0]] = d;
  });
  // 人数标记：SFW 里 cp 组＝双人；NSFW 里有男性出场（male）＝双人，束缚类纯女方＝单人
  Object.keys(POSES).forEach(function (t) {
    (POSES[t].poses || []).forEach(function (ps) {
      ps._multi = (ps.group === 'mp');
      ps._duo = !ps._multi && ((t === 'light') ? (ps.group === 'cp') : (ps.male === true));
    });
  });
  STATE = CPS.defaultState({
    models: DATA.models, characters: DATA.characters, clothing: DATA.clothing, scenes: DATA.scenes,
    features: DATA.features, styles: DATA.styles, poses: POSES
  });
  STATE.pose.crowdTab = 'solo';
  // 隐私考虑：启动一律用默认设定，不恢复上次状态（避免 NSFW 内容被别人看到）
  try { localStorage.removeItem('cps_state'); localStorage.removeItem('cps_seed'); } catch (e) {}
  renderModels(); renderTabs(); renderPanel(); rebuild();
  try { initHidePrompts(); } catch (e) { console.warn('hidePrompts 早期初始化失败', e); }
  initSeedUI();
  await loadGallery(); renderHistory();
  // 首次使用引导：只在没点过「知道了」时出现
  if (!localStorage.getItem('cps_onboard_ok') && $('#onboard')) {
    $('#onboard').classList.remove('hidden');
    $('#btnOnboardOk').onclick = function () {
      localStorage.setItem('cps_onboard_ok', '1');
      $('#onboard').classList.add('hidden');
    };
  }
  // 不恢复上次设定（隐私考虑），这里原本有一句 if (restored) ... 已随功能一起移除
  // ===== 嵌入模式：跳过 ComfyUI 设置弹窗 / 服务探测 / 定时重连 =====
  if (!window.__CPS_EMBED__) {
  // 首次使用：配置里没有 installed 标记，或 ComfyUI 路径无效 → 固定打开设置页并自动搜索
  try {
    var _cf = await API.configGet();
    var _c = (_cf && _cf.config) || {};
    var _needSetup = !_c.installed;   // 只在真正的首次（没保存过设置）时弹设置页
    if (_needSetup) {
      // 首次：固定进设置页，自动搜索填好
      setTimeout(function () { openSettings(true); checkSetupBadge(); }, 400);
    } else {
      // 之后不弹设置页，只在齿轮上给气泡提醒；并问一次要不要起服务
      setTimeout(function () {
        checkSetupBadge().then(function (issues) {
          if (!issues.length) setTimeout(askStartComfy, 600);
          else status('提示：还有 ' + issues.length + ' 项没设置（点右上 ⚙ 查看）');
        });
      }, 700);
    }
  } catch (e) {}

  // 应用设置里的默认模型 / 分辨率（必须在 STATE 建好之后，且 await 到配置返回）
  try {
    var _cfg = await API.configGet();
    if (_cfg && _cfg.ok && _cfg.config) {
      var _c = _cfg.config;
      if (_c.res) {
        var _p = String(_c.res).split('x');
        if (_p.length === 2) {
          STATE.overrideW = parseInt(_p[0], 10);
          STATE.overrideH = parseInt(_p[1], 10);
        }
      }
      if (_c.model) {
        var _m = (DATA.models.models || []).find(function (m) { return m.id === _c.model || m.file === _c.model; });
        if (_m) { STATE.model = _m.id; renderModels(); }   // 统一存 id，别存文件名
      }
      rebuild();
    }
  } catch (e) {}
  pingComfy();

  // 自动重连：没连上时每 12 秒探测一次，连上就更新状态并停止提示
  setInterval(async function () {
    if (COMFLY) return;
    var r = await API.ping();
    if (r && r.ok) {
      COMFLY = true;
      var st = $('#comfyStatus');
      if (st) { st.textContent = '已连接 :' + (r.port || 8188); st.className = 'status ok'; }
      status('ComfyUI 已就绪，可以出图');
    }
  }, 12000);
  } // ===== /嵌入模式跳过 ComfyUI 探测 =====

  // 外部指定配方入口已移除（配方已迁移到主程序「提示词库」页面）
  try {
    var mq = new URLSearchParams(location.search).get('modal');
    if (mq === 'pose') { CURTAB = 'pose'; renderTabs(); renderPanel(); openPose(new URLSearchParams(location.search).get('tier') || 'service'); }
    else if (mq === 'gallery') { openGallery(); }
    if (new URLSearchParams(location.search).get('auto') === '1') {
      setTimeout(function () { generate(); }, 1500);
    }
  } catch (e) {}
  // 这几个是关键 UI 绑定，任何一个抛错都不许拖累后面（之前 initHidePrompts 就是这么被跳过的）
  function safeInit(name, fn) { try { fn(); } catch (e) { console.warn('初始化失败: ' + name, e); } }
  safeInit('hidePrompts', initHidePrompts);
  safeInit('lightbox', bindLightbox);
  safeInit('picker', bindPicker);
  safeInit('splitter', initSplitter);
  var bu = $('#btnComfyUp'), bd = $('#btnComfyDown');
  if (bu) bu.onclick = function () { comfyStart(bu); };
  if (bd) bd.onclick = function () { comfyStop(bd); };
  safeInit('fold', initFold);
  safeInit('winCtl', initWinCtl);
  document.addEventListener('input', function (e) { if (e.target && e.target.type === 'range') setFill(e.target); }, true);
  document.addEventListener('change', function (e) { if (e.target && e.target.type === 'range') setFill(e.target); }, true);
  initZoom();
  if (!window.__CPS_EMBED__) initComfyWS();
  try { bindWinCtl(); } catch (e) {}
  setTimeout(function () { try { bindWinCtl(); } catch (e) {} }, 800);   // 三保险：万一前面某步把绑定覆盖了
  status('');
}

/* 模型与 LoRA 的兼容判定：完全由 models.json 驱动，不再写死 'pony' 这个 id。
   loraRule = '!IL' 的模型（写实系）排斥 _IL 后缀的 LoRA；'IL' / 'any' 不排斥。 */
function modelById(id) {
  var arr = (DATA.models && DATA.models.models) || [];
  return arr.find(function (m) { return m.id === id || m.file === id; }) || arr[0] || null;
}
function ilLoraBlocked(m, file) {
  if (!m || m.loraRule !== '!IL') return false;
  var items = (DATA.lora && DATA.lora.items) || [];
  var it = items.find(function (x) { return x.file === file; });
  var base = it ? it.base : (String(file).indexOf('_IL') > 0 ? 'IL' : 'any');
  return base === 'IL';
}

function setModel(m) {
  if (!m || STATE.model === m.id) return;
  var lost = [];
  if (!m.supportsArtist && (STATE.style.artists || []).length) lost.push('画图风格');
  Object.keys(STATE.loras || {}).forEach(function (f) { if (ilLoraBlocked(m, f)) lost.push('LoRA ' + f); });
  STATE.model = m.id;
  STATE.style.artists = [];
  // 写实度跟着模型走，避免「写实度和模型方向冲突」这种要用户自己理解的提示
  if (STATE.style && STATE.style.realism != null) STATE.style.realism = (m.kind === 'realistic') ? 85 : 35;
  Object.keys(STATE.loras).forEach(function (f) { if (ilLoraBlocked(m, f)) delete STATE.loras[f]; });
  renderModels(); renderPanel(); rebuild();
  status('已换模型：' + m.name + (lost.length ? '（自动关掉了：' + lost.join('、') + '）' : ''));
}

// 标题栏只显示「当前在用的模型」一个按钮，点开就是换模型
function renderModels() {
  var box = $('#modelSwitch');
  if (!box) return;
  box.innerHTML = '';
  var ms = DATA.models.models || [];
  var cur = ms.find(function (m) { return m.id === STATE.model; }) || ms[0];
  if (!cur) return;

  var btn = el('button', 'model-cur');
  btn.innerHTML = '<span class="mc-dot"></span><span class="mc-n">' + cur.name + '</span>' +
    '<span class="mc-car">▾</span>';
  bindTip(btn, '<b>当前模型：' + cur.name + '</b>\n' + (cur.note || '') +
    '\n采样：' + cur.sampler.steps + ' 步 / cfg ' + cur.sampler.cfg + '\n\n点一下换模型');
  btn.onclick = function (ev) {
    ev.stopPropagation();
    var old = document.getElementById('modelMenu');
    if (old) { old.remove(); return; }
    var menu = document.createElement('div');
    menu.className = 'model-menu';
    menu.id = 'modelMenu';
    ms.forEach(function (m) {
      var it = document.createElement('div');
      it.className = 'model-item' + (m.id === STATE.model ? ' on' : '');
      it.innerHTML = '<div class="mi-n">' + m.name + (m.id === STATE.model ? '　<b>使用中</b>' : '') +
        '</div><div class="mi-note">' + (m.note || '') + '</div>';
      it.onclick = function (ev2) {
        ev2.stopPropagation();
        menu.remove();
        setModel(m);
      };
      menu.appendChild(it);
    });
    var zz = zoomFactor();
    var r = btn.getBoundingClientRect();
    menu.style.left = Math.round(r.left / zz) + 'px';
    menu.style.top = Math.round((r.bottom + 6 * zz) / zz) + 'px';
    document.body.appendChild(menu);
    var closeFn = function (ev3) {
      var m2 = document.getElementById('modelMenu');
      if (m2 && !m2.contains(ev3.target)) { m2.remove(); document.removeEventListener('mousedown', closeFn); }
    };
    setTimeout(function () { document.addEventListener('mousedown', closeFn); }, 30);
  };
  box.appendChild(btn);
}

function renderTabs() {
  var n = $('#tabs'); n.innerHTML = '';
  TABS.forEach(function (t) {
    var d = el('div', 'tab' + (CURTAB === t.id ? ' on' : ''));
    d.innerHTML = '<span class="ic">' + t.ic + '</span>' + t.name;
    d.onclick = function () {
      CURTAB = t.id;
      // 切页签时清掉本页的折叠记录 → 进来必定展开第一组，不会看到一片空白
      try {
        if (STATE && STATE._collapsed) {
          Object.keys(STATE._collapsed).forEach(function (k) {
            if (k.indexOf(t.id + '.') === 0) delete STATE._collapsed[k];
          });
        }
      } catch (e) {}
      renderTabs(); renderPanel(); $('#search').value = '';
    };
    n.appendChild(d);
  });
}

/* ---------- 字段渲染 ---------- */
function currentFields() {
  if (CURTAB === 'character') return { mod: 'character', fields: DATA.characters.fields.filter(function (f) { return !f.uiIn; }), groups: DATA.characters.groups, title: '人物设定' };
  if (CURTAB === 'clothing') return { mod: 'clothing', fields: DATA.clothing.fields, groups: DATA.clothing.groups, title: '服装设定' };
  if (CURTAB === 'scene') return { mod: 'scene', fields: DATA.scenes.fields.filter(function (f) { return f.uiIn !== 'pose'; }), groups: DATA.scenes.groups, title: '场景设定' };
  if (CURTAB === 'feature') return { mod: 'feature', fields: DATA.features.fields.filter(function (f) { return f.uiIn !== 'pose'; }), groups: DATA.features.groups, title: '特征设定' };
  if (CURTAB === 'style') return { mod: 'style', fields: DATA.styles.fields, groups: DATA.styles.groups, title: '画风设定' };
  return null;
}

/* 顶部「锁定」按钮的选中态：任有字段被锁 → 蓝色底/白字/白图标 */
function syncLockBtn() {
  var b = $('#btnLock'); if (!b) return;
  var any = Object.keys(LOCKS).some(function (k) { return LOCKS[k]; });
  b.classList.toggle('on', any);
  b.innerHTML = any ? '✓ 已锁定' : '⌾ 锁定';
}

function renderPanel() {
  var box = $('#fields'); box.innerHTML = '';
  var t = TABS.find(function (x) { return x.id === CURTAB; });
  $('#panelTitle').textContent = t ? t.name + '设定' : '';
  $('#btnPanelReset').style.display = (CURTAB === 'output') ? 'none' : '';
  $('#search').style.display = (CURTAB === 'output') ? 'none' : '';
  syncLockBtn();

  if (CURTAB === 'pose') return renderPoseInline();
  if (CURTAB === 'output') return renderOutputInline();

  var cfg = currentFields(); if (!cfg) return;
  $('#panelTitle').textContent = cfg.title;

  var rules = CPS.build(STATE, CTX()).rules;
  var renderField = function (f) {
    var dis = rules.disabled.has(f.id) && f.id !== 'coverage';
    var card = el('div', 'field' + (f.type === 'slider' ? ' f-slider' : '') + (dis ? ' disabled' : '') + (LOCKS[cfg.mod + '.' + f.id] ? ' locked' : ''));
    card.dataset.search = (f.label + ' ' + (f.options || []).map(function (o) { return o.cn + ' ' + o.v; }).join(' ')).toLowerCase();

    var head = el('div', 'field-head');
    var offKey = cfg.mod + '.' + f.id;
    if (!STATE._off) STATE._off = {};
    var isOffNow = !!STATE._off[offKey];
    var pwr = el('span', 'sw-power' + (isOffNow ? ' off' : ''), isOffNow ? '○' : '●');
    pwr.title = isOffNow ? '已停用：值保留但不写进提示词（点一下启用）' : '启用中（点一下停用，值会保留）';
    pwr.onclick = function (e) {
      e.stopPropagation();
      STATE._off[offKey] = !STATE._off[offKey];
      if (!STATE._off[offKey]) delete STATE._off[offKey];
      renderPanel(); rebuild();
      status(STATE._off[offKey] ? '「' + f.label + '」已停用（值保留）' : '「' + f.label + '」已启用');
    };
    head.appendChild(pwr);
    var isCov = (cfg.mod === 'clothing' && f.id === 'coverage');
    var isCrd = (cfg.mod === 'feature' && f.id === 'crowd');
    var autoFlag = isCov ? (STATE._covAuto !== false) : (STATE._crdAuto !== false);
    var labTxt = (isCov || isCrd) ? (f.label + (autoFlag ? '（自动）' : '（手动）')) : f.label;
    var nameEl = el('span', 'name', labTxt);
    if (isCov || isCrd) nameEl.classList.add(autoFlag ? 'cov-auto' : 'cov-manual');
    head.appendChild(nameEl);
    if (isCrd && STATE._crdAuto === false) {
      var crdBtn = el('span', 'lockbtn cov-reset', '⟳');
      crdBtn.title = '恢复自动：跟着当前动作/姿势走';
      crdBtn.onclick = function () {
        STATE._crdAuto = true;
        syncCrowd(); renderPanel(); rebuild();
        status('画面人数已恢复自动跟随动作');
      };
      head.appendChild(crdBtn);
    }
    if (isCov && STATE._covAuto === false) {
      var covBtn = el('span', 'lockbtn cov-reset', '⟳');
      covBtn.title = '恢复自动：让覆盖度跟着上衣/下装/内衣走';
      covBtn.onclick = function () {
        STATE._covAuto = true;
        syncCoverage(); renderPanel(); rebuild();
        status('');
      };
      head.appendChild(covBtn);
    }
    var qi = el('span', 'qi', '!');
    bindTip(qi, '<b>' + f.label + '</b>\n' + (f.hint || '无说明') + (dis ? '\n\n⚠ 当前被互斥规则禁用' : ''));
    head.appendChild(qi);
    var lk = el('span', 'lockbtn', LOCKS[cfg.mod + '.' + f.id] ? '🔒' : '🔓');
    lk.title = '锁定/解锁：锁定后随机与重置都不会动它';
    lk.onclick = function () {
      var k = cfg.mod + '.' + f.id;
      LOCKS[k] = !LOCKS[k];
      card.classList.toggle('locked');
      lk.textContent = LOCKS[k] ? '🔒' : '🔓';
      syncLockBtn();
    };
    head.appendChild(lk);

    // 移除：把这个字段的词从提示词里摘掉并回归默认
    var rst = el('span', 'lockbtn rst', '⟲');
    rst.title = '回到默认：这一项完全不写进提示词';
    rst.onclick = function () {
      STATE[cfg.mod][f.id] = f.type === 'multi' ? [] : null;
      renderPanel(); rebuild(); status('「' + f.label + '」已清空，不写进提示词');
    };
    head.appendChild(rst);

    var isOff = STATE[cfg.mod][f.id] == null;
    if (isOff && f.type !== 'color') card.classList.add('off');
    if (isOffNow) card.classList.add('pwroff');
    if (f.type === 'slider') head.appendChild(el('span', 'val' + (isOff ? ' val-def' : ''), isOff ? '默认' : String(STATE[cfg.mod][f.id])));
    card.appendChild(head);

    // 「画面人数」选项少且常用，不走弹层，直接铺成单排按钮
    if (f.id === 'crowd') {
      var cwRow = el('div', 'chips crowd-chips');
      var curV = STATE[cfg.mod][f.id];
      favSortOptions(cfg.mod, f.id, f.options).forEach(function (o) {
        var onC = curV === o.v;
        var cC = el('span', 'chip' + (onC ? ' on' : '') + (isFav(cfg.mod, f.id, o.v) ? ' fav' : ''),
          (isFav(cfg.mod, f.id, o.v) ? '★ ' : '') + o.cn);
        attachFav(cC, cfg.mod, f.id, o.v, o.cn, function () { renderPanel(); });
        cC.onclick = function () {
          STATE[cfg.mod][f.id] = (STATE[cfg.mod][f.id] === o.v) ? null : o.v;
          // 画面人数：手动选了就转「手动」，清空则回到自动跟随动作
          if (f.id === 'crowd') STATE._crdAuto = (STATE[cfg.mod][f.id] == null);
          renderPanel(); rebuild();
        };
        cwRow.appendChild(cC);
      });
      card.appendChild(cwRow);
      if (isOffNow) card.classList.add('pwroff');
      box.appendChild(card);
      return;
    }

    if (f.type === 'slider') {
      var sl = buildSlider(f, isOff ? f.default : STATE[cfg.mod][f.id], function (v) {
        STATE[cfg.mod][f.id] = v;
        if (cfg.mod === 'clothing' && f.id === 'coverage') {
          if (STATE._covAuto !== false) { STATE._covAuto = false; }
        }
        touch(cfg.mod); rebuild();
      }, card);
      card.appendChild(sl);
      var seg = el('div', 'seg');
      (f.map || []).forEach(function (m) {
        var s = el('span', '', '');
        s.title = (m.tags && m.tags.length ? m.tags.join(', ') : '无词') + '  (' + m.from + '–' + m.to + ')';
        s.dataset.from = m.from; s.dataset.to = m.to;
        seg.appendChild(s);
      });
      sl.appendChild(seg);
      card._seg = seg;
    } else if (f.type === 'color') {
      // 服装颜色跟随宿主部位：宿主没选 / 被互斥禁用 时整行变灰并提示
      var hostBlocked = false, hostText = '';
      if (f.forField) {
        var hv = STATE.clothing[f.forField];
        var hArr = Array.isArray(hv) ? hv : (hv ? [hv] : []);
        hostBlocked = rules.disabled.has(f.forField) || rules.cleared.has('clothing.' + f.forField)
          || hArr.length === 0 || hArr[0] === 'none' || hArr[0] === 'barefoot' || /^no /.test(hArr[0] || '');
        hostText = hostBlocked ? '（先选一件「' + (DATA.clothing.fields.find(function (x) { return x.id === f.forField; }) || {}).label + '」）' : '';
        if (hostBlocked) card.classList.add('off');
      }
      var wrap = el('div', 'chips');
      f.options.forEach(function (o) {
        var c = el('div', 'color-chip' + (STATE[cfg.mod][f.id] === o.v ? ' on' : ''));
        c.style.background = o.hex;
        c.title = (STATE[cfg.mod][f.id] === o.v ? '再点一下移除颜色 → ' : '选 ') + o.cn + '（' + o.v + '）';
        c.onclick = function () {
          STATE[cfg.mod][f.id] = (STATE[cfg.mod][f.id] === o.v ? null : o.v);
          touch(cfg.mod); renderPanel(); rebuild();
        };
        wrap.appendChild(c);
      });
      card.appendChild(wrap);
      var curCol = f.options.find(function (o) { return o.v === STATE[cfg.mod][f.id]; });
      var cnm = el('div', '', hostBlocked ? '' : (curCol ? '当前：' + curCol.cn + '（' + curCol.v + '）' : '未选颜色（不影响出图，选了才会输出）'));
      cnm.style.cssText = 'font-size:10px;color:#5c606b;margin-top:6px';
      if (!hostBlocked) card.appendChild(cnm);
      if (hostBlocked) {
        var hint = el('div', '', hostText);
        hint.style.cssText = 'font-size:10px;color:#5c606b;margin-top:6px';
        card.appendChild(hint);
      }
    } else if (f.type === 'multi' && (f.options || []).length > 6) {
      var curArrM = Array.isArray(STATE[cfg.mod][f.id]) ? STATE[cfg.mod][f.id] : [];
      card.appendChild(buildPickRow(f, curArrM, cfg.mod));
    } else if (f.type === 'multi') {
      var wrap2 = el('div', 'chips');
      favSortOptions(cfg.mod, f.id, f.options).forEach(function (o) {
        var cur = STATE[cfg.mod][f.id] || [];
        var on = cur.indexOf(o.v) >= 0;
        var fav1 = isFav(cfg.mod, f.id, o.v);
        var c = el('span', 'chip' + (on ? ' on' : '') + (fav1 ? ' fav' : ''));
        c.innerHTML = (fav1 ? '<b class="favstar">★</b>' : '') + o.cn +
          (f.hideTag ? '' : '<span class="tg">' + o.v + '</span>');
        c.title = on ? '再点一下移除这一项' : '点一下加入提示词';
        attachFav(c, cfg.mod, f.id, o.v, o.cn, function () { renderPanel(); });
        c.onclick = function () {
          var arr = STATE[cfg.mod][f.id] || [];
          var i = arr.indexOf(o.v); if (i >= 0) arr.splice(i, 1); else arr.push(o.v);
          touch(cfg.mod); renderPanel(); rebuild();
        };
        wrap2.appendChild(c);
      });
      card.appendChild(wrap2);
    } else if (f.type === 'select' && (f.options || []).length > 6) {
      var curV = STATE[cfg.mod][f.id];
      card.appendChild(buildPickRow(f, curV ? [curV] : [], cfg.mod));
    } else if (f.type === 'select') {
      var wrap3 = el('div', 'chips');
      favSortOptions(cfg.mod, f.id, f.options).forEach(function (o) {
        var fav2 = isFav(cfg.mod, f.id, o.v);
        var c = el('span', 'chip' + (STATE[cfg.mod][f.id] === o.v ? ' on' : '') + (fav2 ? ' fav' : ''));
        c.innerHTML = (fav2 ? '<b class="favstar">★</b>' : '') + o.cn +
          (f.hideTag ? '' : '<span class="tg">' + o.v + '</span>');
        c.title = '点一下选中，再点一下移除（回归默认）';
        attachFav(c, cfg.mod, f.id, o.v, o.cn, function () { renderPanel(); });
        c.onclick = function () {
          if (STATE[cfg.mod][f.id] === o.v) {
            STATE[cfg.mod][f.id] = f.optional ? null : (f.default !== undefined ? f.default : null);
            status('已移除「' + f.label + ' → ' + o.cn + '」');
          } else {
            STATE[cfg.mod][f.id] = o.v;
          }
          if (cfg.mod === 'feature' && f.id === 'crowd') STATE._crdAuto = false;
          touch(cfg.mod); renderPanel(); rebuild();
        };
        wrap3.appendChild(c);
      });
      card.appendChild(wrap3);
    }
    box.appendChild(card);
    };
  // 按 group 分节渲染
  var gs = cfg.groups || [];
  if (!gs.length) { gs = [{ id: null, name: '' }]; }
  var kwNow = (($('#search') || {}).value || '').toLowerCase().trim();
  var gIdx = 0;
  gs.forEach(function (g) {
    var list = g.id ? cfg.fields.filter(function (x) { return x.group === g.id; }) : cfg.fields;
    if (!list.length) return;
    if (g.name) {
      var gkey = cfg.mod + '.' + g.id;
      // 搜索时强制展开，否则搜不到被折叠的内容
      // 默认全部收起：只有用户手动展开过（显式 false）才展开
      // 默认收起；但本页没有任何「已展开」记录时，第一组自动展开，
      // 否则切页签后只看到一排分组标题，像是「东西都没了」。
      var modHasState = STATE._collapsed && Object.keys(STATE._collapsed).some(function (k) {
        return k.indexOf(cfg.mod + '.') === 0;
      });
      var expandedExplicit = STATE._collapsed && STATE._collapsed[gkey] === false;
      var collapsed = !kwNow && !expandedExplicit && !(!modHasState && gIdx === 0);
      var gHead = el('div', 'field-group-h' + (collapsed ? ' col' : ''));
      // 大分组换个颜色，一眼分得清是哪一块（按组顺序轮换色相）
      gHead.style.setProperty('--gc', GC_COLORS[(gIdx++) % GC_COLORS.length]);
      gHead.innerHTML = '<span class="fg-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
        '<span class="fg-name">' + g.name + '</span>' +
        (g.note ? '<span class="fg-note">' + g.note + '</span>' : '') +
        '<span class="fg-n">' + list.length + '</span>';
      gHead.title = collapsed ? '点开「' + g.name + '」' : '收起「' + g.name + '」';
      gHead.onclick = function () {
        if (!STATE._collapsed) STATE._collapsed = {};
        var willExpand = collapsed;      // collapsed=true 表示当前是收起状态
        if (willExpand) {
          // 点开一个就收起同页其他分组，页面不会再越拉越长
          (cfg.groups || []).forEach(function (gg) {
            if (gg.id && gg.id !== g.id) STATE._collapsed[cfg.mod + '.' + gg.id] = true;
          });
        }
        STATE._collapsed[gkey] = willExpand ? false : true;
        renderPanel();
        queueSaveState();
      };
      box.appendChild(gHead);
      if (collapsed) return;
    }
    list.forEach(renderField);
  });

  syncSegs();
  syncFills();
}

function markSeg() {}
function syncSegs() {
  $$('.field').forEach(function (card) {
    if (!card._seg) return;
    var valEl = card.querySelector('.val'); if (!valEl) return;
    var v = parseInt(valEl.textContent, 10);
    if (isNaN(v)) return;
    Array.prototype.forEach.call(card._seg.children, function (s) {
      var f = +s.dataset.from, t = +s.dataset.to;
      s.classList.toggle('cur', v >= f && v <= t);
    });
  });
}

function buildSlider(f, val, onChange, card) {
  // 保护：非数字值（比如人物卡里存成 "teen"）会让滑条显示 NaN，这里回退到默认
  if (val == null || val === '' || isNaN(+val)) {
    val = (f.default != null && !isNaN(+f.default)) ? +f.default : Math.round((f.min + f.max) / 2);
  } else {
    val = +val;
  }
  var row = el('div', 'fs-ctl');
  var inp = document.createElement('input');
  inp.type = 'range'; inp.min = f.min; inp.max = f.max; inp.value = val;
  inp.title = '双击恢复默认值 ' + f.default;
  if (f.danger && ((val >= f.danger[0][0] && val <= f.danger[0][1]) || (val >= f.danger[1][0] && val <= f.danger[1][1]))) inp.classList.add('danger');
  setFill(inp);

  var raf = null;
  inp.addEventListener('input', function () {
    var v = +inp.value;
    // 轻量即时反馈：只动当前这一张卡
    if (card) {
      var ve = card.querySelector('.val');
      if (ve) ve.textContent = v;
      updateSeg(card, v);
      if (card.classList.contains('off')) card.classList.remove('off');
    }
    if (f.danger) {
      var bad = (v >= f.danger[0][0] && v <= f.danger[0][1]) || (v >= f.danger[1][0] && v <= f.danger[1][1]);
      inp.classList.toggle('danger', bad);
    }
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () { raf = null; onChange(v); });
    // 兜底：rAF 被浏览器节流时（窗口隐藏/最小化）50ms 后照常提交，避免拖完预览不动
    setTimeout(function () { if (raf) { cancelAnimationFrame(raf); raf = null; onChange(v); } }, 50);
  });
  inp.addEventListener('dblclick', function () { inp.value = f.default; setFill(inp); onChange(f.default); });
  row.appendChild(inp);
  return row;
}

function touch(mod) { STATE._lastTouched = mod; }

/* ---------- 重建 ---------- */
var _lastPos = null, _lastNeg = null, _lastParams = '', _lastWarn = '';
var _rbQueued = false;

// 节流入口：同一帧内多次调用只算一次
function rebuild() {
  if (_rbQueued) return;
  _rbQueued = true;
  requestAnimationFrame(function () { _rbQueued = false; doRebuild(); });
  // 双保险：窗口最小化/隐藏时浏览器会暂停 rAF，这里兜一次，避免预览与 token 停在旧值
  setTimeout(function () { if (_rbQueued) { _rbQueued = false; doRebuild(); } }, 60);
}

var _lastRuleSig = '';

/* ---------- 覆盖度随服装自动联动 ---------- */
// 无衣着→5(no-clothing)／只有内衣→24／只有一半→45(partially undressed)／上下装齐→90(正常)
function calcCoverage() {
  var c = STATE.clothing || {};
  var arr = function (k) { return c[k] || []; };
  var has = function (k) { return arr(k).filter(function (x) { return x !== 'none'; }).length > 0; };
  // 四个部位一个都没碰过（都是空数组）→ 不输出任何覆盖度词
  var untouched = ['top', 'bottom', 'underTop', 'underBottom'].every(function (k) { return arr(k).length === 0; });
  if (untouched) return null;
  var top = has('top'), bottom = has('bottom');
  var uT = has('underTop'), uB = has('underBottom');
  if (!top && !bottom && !uT && !uB) return 5;   // 明确都选了「无」= 全身裸
  if (!top && !bottom) return 24;
  if (top && bottom) {
    // 长裙 / 旗袍 / 大衣这类覆盖更多的，给高一点
    var longish = (c.bottom || []).some(function (x) { return /long|dress|china/i.test(x); });
    return longish ? 96 : 90;
  }
  return 45;
}

// 画面人数：由当前姿势决定（单人姿势＝只有女方，带 1boy 的＝1女1男）
function calcCrowd() {
  var tier = STATE.pose && STATE.pose.tier;
  var td = POSES && POSES[tier];
  var pose = td && td.poses.find(function (p) { return p.id === STATE.pose.id; });
  if (!pose) return null;
  if (pose.crowd) return pose.crowd;           // 多人库/已标注的姿势直接用
  if (pose._duo === false) return '1girl';
  var t = (pose.tags || []).join(' ').toLowerCase();
  if (/multiple girls|crowd/.test(t)) return 'multiple girls, multiple boys';
  var bm = /(\d+)boys/.exec(t);
  var gm = /(\d+)girls/.exec(t);
  var nB = bm ? +bm[1] : (/(^|[^\d])1boy/.test(t) ? 1 : 0);
  var nG = gm ? +gm[1] : (/(^|[^\d])(1girl|solo)/.test(t) ? 1 : 1);
  if (nB === 0) return '1girl';
  if (nB >= 3) return '1girl, 2boys';
  if (nG >= 3) return '3girls, 1boy';
  if (nG === 2) return '2girls, 1boy';
  if (nB === 2) return '1girl, 2boys';
  return '1girl, 1boy';
}
function syncCrowd() {
  if (!STATE.feature) return;
  if (STATE._crdAuto === false) return;   // 用户手动选过，不再跟随
  var v = calcCrowd();
  if (v && STATE.feature.crowd !== v) STATE.feature.crowd = v;
}

function syncCoverage() {
  if (!STATE.clothing) return;
  if (STATE._covAuto === false) return;   // 用户手动调过，不再自动改
  var v = calcCoverage();
  if (STATE.clothing.coverage !== v) STATE.clothing.coverage = v;
}

function doRebuild() {
  syncCoverage();
  syncCrowd();
  var b = CPS.build(STATE, CTX());
  LASTBUILD = b;
  queueSaveState();
  // 互斥规则命中 → 只在不打扰的地方说一句，让用户知道「我选的为什么没生效」
  try {
    var hits = (b.rules && b.rules.hits) || [];
    var dis = (b.rules && b.rules.disabled) ? Array.from(b.rules.disabled) : [];
    var sig = hits.map(function (h) { return h.id; }).join(',') + '|' + dis.join(',');
    if (sig !== _lastRuleSig) {
      _lastRuleSig = sig;
      if (hits.length) {
        var who = hits.map(function (h) { return h.label || h.id; }).join('、');
        var NAME_CN = { top: '上装', underTop: '内搭', bottom: '下装', underBottom: '内裤',
                        headwear: '头饰', legwear: '腿部', shoes: '鞋', outerwear: '外套',
                        accessory: '配饰', coverage: '覆盖度' };
        var cn = dis.slice(0, 4).map(function (k) { return NAME_CN[k] || k; });
        var what = cn.length ? '，已自动收起 ' + cn.join('、') : '';
        /* 技术性互斥提示不展示（只留需决策的信息） */
      }
    }
  } catch (e) {}

  if (b.positive !== _lastPos) { $('#posText').value = b.positive; _lastPos = b.positive; }
  if (b.negative !== _lastNeg) { $('#negText').value = b.negative; _lastNeg = b.negative; }

  var pct = Math.min(100, Math.round(b.tokens / b.budget * 100));
  var fill = $('#tokenFill');
  fill.style.width = pct + '%';
  var tc = b.tokens > 200 ? 'var(--err)' : (b.tokens > 120 ? 'var(--warn)' : 'var(--ok)');
  fill.style.background = tc;
  var num = $('#tokenNum');
  num.textContent = b.tokens + '/' + b.budget;
  num.style.color = b.tokens > 200 ? 'var(--err)' : (b.tokens > 120 ? 'var(--warn)' : 'var(--txt2)');

  var wb = $('#warnbar');
  var wt = b.warnings.length ? '⚠ ' + b.warnings.join('　｜　') : '';
  if (wt !== _lastWarn) {
    if (wt) { wb.classList.remove('hidden'); wb.textContent = wt; } else wb.classList.add('hidden');
    _lastWarn = wt;
  }

  var p = b.param;
  var ph = '<div>尺寸 <b>' + p.width + '×' + p.height + '</b></div>' +
    '<div>步数 <b>' + p.steps + '</b></div><div>CFG <b>' + p.cfg + '</b></div>' +
    '<div>采样 <b>' + p.sampler + '</b></div><div>调度 <b>' + p.scheduler + '</b></div>' +
    '<div style="grid-column:1/-1">丢弃 <b>' + b.dropped.length + '</b> 条 · 已用 <b>' + b.sources.length + '</b> 条</div>';
  if (ph !== _lastParams) { $('#params').innerHTML = ph; _lastParams = ph; }
}

function updateSeg(card, v) {
  var seg = card._seg;
  if (!seg) return;
  for (var i = 0; i < seg.children.length; i++) {
    var s = seg.children[i];
    var a = +s.dataset.from, z = +s.dataset.to;
    s.classList.toggle('cur', v >= a && v <= z);
  }
}
/* ---------- 动作页 ---------- */

/* 体位自带构图：按姿势类型自动带 1–2 个滑条，省得每次手调 */
function autoPoseSliders(pose) {
  var t = ((pose.tags || []).join(' ') + ' ' + (pose.cn || '')).toLowerCase();
  var out = {};
  if (/all fours|from behind|后入|后背|趴伏/.test(t)) {
    out.bodyLean = 78; out.camDist = 75;
  } else if (/lying on back|正常位|屈曲|仰卧/.test(t)) {
    out.legSpread = 68; out.camDist = 80;
  } else if (/straddling|riding/.test(t)) {
    out.bodyLean = 22; out.camDist = 75;
  } else if (/卧姿|跪姿|俯身/.test(t)) {
    out.camDist = 48;
  } else if (/坐姿|跨坐/.test(t)) {
    out.camDist = 55;
  }
  if (/kneeling|on all fours|跪|趴/.test(t)) out.camHeight = 25;
  return out;
}

function renderPoseInline() {
  var box = $('#fields'); box.innerHTML = '';
  var tier = STATE.pose.tier;
  var td = POSES[tier];
  var cur = td.poses.find(function (p) { return p.id === STATE.pose.id; });
  var head = el('div', 'field');
  head.innerHTML = '<div class="field-head"><span class="name">当前姿势</span><span class="qi">!</span>' +
    '<span class="val">' + (cur ? cur.cn : '未选') + '</span></div>';
  if (cur && cur.hard) {
    var hw = el('div', 'hardbanner', '◇ 这类姿势较难还原：' + cur.hard + '（换动漫专用模型会更稳）');
    box.appendChild(hw);
  }
  bindTip(head.querySelector('.qi'), '<b>姿势库</b>\nSFW（单人 / 双人）、NSFW（性爱 / 侍奉）两大类。\n' +
    '点下面按钮打开弹层选。侍奉类里需要男性出场的，引擎会自动只输出局部（pov / male hands only）并在负向压制 male face。');
  var btn = el('button', 'btn primary', '📚 打开姿势库');
  btn.onclick = function () { openPose(tier); };
  head.appendChild(btn);
  box.appendChild(head);

  // 表情 / 视角 拆成两块分组卡（视觉沿用人物、服装页的分组头）
  var POSE_GIDX = 0;
  function poseGroup(key, name, note, cnt) {
    var card = el('div', 'field pose-grp');
    var collapsed = !(STATE._collapsed && STATE._collapsed['pose.' + key] === false);
    var gh = el('div', 'field-group-h' + (collapsed ? ' col' : ''));
    gh.style.setProperty('--gc', GC_COLORS[(POSE_GIDX++) % GC_COLORS.length]);
    gh.innerHTML = '<span class="fg-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
      '<span class="fg-name">' + name + '</span>' +
      (note ? '<span class="fg-note">' + note + '</span>' : '') +
      '<span class="fg-n">' + (cnt || 0) + '</span>';
    gh.title = collapsed ? ('点开「' + name + '」') : ('收起「' + name + '」');
    gh.onclick = function () {
      if (!STATE._collapsed) STATE._collapsed = {};
      STATE._collapsed['pose.' + key] = !collapsed;
      renderPanel();
      if (typeof queueSaveState === 'function') queueSaveState();
    };
    card.appendChild(gh);
    var body = el('div', 'pose-grp-body');
    if (collapsed) body.style.display = 'none';
    card.appendChild(body);
    box.appendChild(card);
    return body;
  }

  var exSel0 = STATE.feature.expression || [];
  var gzCur0 = STATE.feature.gaze;
  var camSel0 = STATE.scene.view || [];
  var view0 = STATE.pose.view || 'third';
  var exprN = exSel0.length + (STATE.character && STATE.character.mouthState ? 1 : 0);
  var viewN = (view0 === 'pov' ? 1 : 0) + camSel0.length + (gzCur0 ? 1 : 0);

  function compRow(target, label, hint) {
    var row = el('div', 'comp-row');
    var lab = el('div', 'comp-lab', label);
    if (hint) lab.title = hint;
    var body = el('div', 'comp-body');
    row.appendChild(lab); row.appendChild(body);
    target.appendChild(row);
    return body;
  }

  // ============ 表情组：表情 + 口部状态 ============
  var exBox = poseGroup('expr', '表情', '脸上的表情与嘴部开合；各取 1–2 个', exprN);

  var EXPR = (DATA.features.fields || []).find(function (f) { return f.id === 'expression'; });
  if (EXPR) {
    var b3 = compRow(exBox, '表情', '可多选，一般 1–2 个');
    var exWrap = el('div', 'pick-flat');
    var exBtn3 = el('button', 'pick-btn', '☰ 选择');
    exBtn3.onclick = function () { openPicker('feature', EXPR); };
    var exSum = el('span', 'pick-sum3');
    var exCn3 = exSel0.map(function (v) {
      var o = (EXPR.options || []).find(function (x) { return x.v === v; });
      return o ? o.cn : v;
    });
    if (exCn3.length) exSum.textContent = exCn3.join('、');
    else { exSum.textContent = '未选择'; exSum.classList.add('dim'); }
    exWrap.appendChild(exBtn3); exWrap.appendChild(exSum);
    b3.appendChild(exWrap);
  }

  var MOUTH = (DATA.characters.fields || []).find(function (f) { return f.id === 'mouthState' && f.uiIn === 'pose'; });
  if (MOUTH) {
    var b3b = compRow(exBox, '口部状态', '嘴张开/闭合；和表情一起决定表情强度');
    var mw = el('div', 'chips');
    (MOUTH.options || []).forEach(function (o) {
      var on = STATE.character[MOUTH.id] === o.v;
      var c = el('span', 'chip' + (on ? ' on' : ''), o.cn);
      c.onclick = function () {
        STATE.character[MOUTH.id] = (STATE.character[MOUTH.id] === o.v) ? null : o.v;
        renderPanel(); rebuild();
      };
      mw.appendChild(c);
    });
    b3b.appendChild(mw);
  }

  var exClr = el('div', 'comp-foot');
  var exBtn = el('button', 'mini', '⟲ 清空表情');
  exBtn.onclick = function () {
    STATE.feature.expression = [];
    STATE.character.mouthState = null;
    renderPanel(); rebuild(); status('表情已清空');
  };
  exClr.appendChild(exBtn);
  exBox.appendChild(exClr);

  // ============ 视角组：视角 + 机位 + 视线 ============
  var viewBox = poseGroup('view', '视角', '从哪拍、往哪看', viewN);

  var b1 = compRow(viewBox, '视角', '旁观＝两个人都在画面里；第一人称＝男方只露手/躯干');
  var vseg = el('span', 'sw-seg');
  vseg.innerHTML = '<b class="' + (view0 !== 'pov' ? 'on' : '') + '">旁观</b><b class="' + (view0 === 'pov' ? 'on' : '') + '">第一人称</b>';
  var segs = vseg.querySelectorAll('b');
  segs[0].onclick = function () { STATE.pose.view = 'third'; renderPanel(); rebuild(); };
  segs[1].onclick = function () { STATE.pose.view = 'pov'; renderPanel(); rebuild(); };
  if (!(cur && cur.male)) { vseg.style.opacity = '.35'; vseg.style.pointerEvents = 'none'; }
  b1.appendChild(vseg);

  var camField = (DATA.scenes.fields || []).find(function (f) { return f.uiIn === 'pose'; });
  if (camField) {
    var b2 = compRow(viewBox, '机位', '从哪个方向拍，可多选');
    var cw = el('div', 'chips');
    (camField.options || []).forEach(function (o) {
      var on = camSel0.indexOf(o.v) >= 0;
      var ch = el('span', 'chip' + (on ? ' on' : ''), o.cn);
      ch.onclick = function () {
        var a = STATE.scene[camField.id] || [];
        var i = a.indexOf(o.v);
        if (i >= 0) a.splice(i, 1); else a.push(o.v);
        STATE.scene[camField.id] = a; renderPanel(); rebuild();
      };
      cw.appendChild(ch);
    });
    var clr = el('span', 'chip', '清空');
    clr.onclick = function () { STATE.scene[camField.id] = []; renderPanel(); rebuild(); status('机位已清空'); };
    cw.appendChild(clr);
    b2.appendChild(cw);
  }

  var GAZE = (DATA.features.fields || []).find(function (f) { return f.id === 'gaze'; });
  if (GAZE) {
    var b4 = compRow(viewBox, '视线', '单选');
    var gw = el('div', 'chips');
    (GAZE.options || []).forEach(function (o) {
      var on = gzCur0 === o.v;
      var c = el('span', 'chip' + (on ? ' on' : ''), o.cn);
      c.onclick = function () {
        STATE.feature[GAZE.id] = (STATE.feature[GAZE.id] === o.v) ? null : o.v;
        renderPanel(); rebuild();
      };
      gw.appendChild(c);
    });
    b4.appendChild(gw);
  }

  var viewClr = el('div', 'comp-foot');
  var viewBtn = el('button', 'mini', '⟲ 清空视角');
  viewBtn.onclick = function () {
    STATE.pose.view = 'third';
    STATE.scene.view = [];
    STATE.feature.gaze = null;
    renderPanel(); rebuild(); status('视角已清空');
  };
  viewClr.appendChild(viewBtn);
  viewBox.appendChild(viewClr);


  // 人物互动：并入「当前姿势」卡片（不再单独占一个分组）
  var INTER = (DATA.features.fields || []).find(function (f) { return f.id === 'interact' && f.uiIn === 'pose'; });
  if (INTER) {
    var itSel0 = STATE.feature[INTER.id] || [];
    var itRow = el('div', 'pose-inline');
    itRow.appendChild(el('div', 'comp-lab', '人物互动'));
    var itWrap = el('div', 'pick-flat');
    var itBtn = el('button', 'pick-btn', '☰ 选择');
    itBtn.onclick = function () { openPicker('feature', INTER); };
    var itSum = el('span', 'pick-sum3');
    var itCn = itSel0.map(function (v) {
      var o = (INTER.options || []).find(function (x) { return x.v === v; });
      return o ? o.cn : v;
    });
    if (itCn.length) itSum.textContent = itCn.join('、');
    else { itSum.textContent = '未选择'; itSum.classList.add('dim'); }
    itWrap.appendChild(itBtn); itWrap.appendChild(itSum);
    if (itSel0.length) {
      var itClr = el('button', 'mini', '⟲');
      itClr.onclick = function () { STATE.feature[INTER.id] = []; renderPanel(); rebuild(); status('互动已清空'); };
      itWrap.appendChild(itClr);
    }
    itRow.appendChild(itWrap);
    head.appendChild(itRow);
  }

  // 通用滑条：按「镜头 / 身体 / 状态」分组，后两组默认收起，避免一屏压死
  var SLIDER_GROUPS = [
    { id: 'cam', name: '镜头', note: '取景远近与角度', ids: ['camDist', 'camHeight'] },
    { id: 'body', name: '身体', note: '腿/腰/头，多数体位不用调', ids: ['legSpread', 'bodyLean', 'bodyTilt', 'headAngle'] },
    { id: 'state', name: '状态', note: '表情、潮红、衣物', ids: ['exprInt', 'sweat', 'clothesRemain'] }
  ];
  var allSl = td.commonSliders || [];
  var usedIds = {};
  SLIDER_GROUPS.forEach(function (g) {
    var list = allSl.filter(function (x) { return g.ids.indexOf(x.id) >= 0; });
    if (!list.length) return;
    list.forEach(function (x) { usedIds[x.id] = 1; });   // 先登记，收起时也不再被「未归组」重复渲染
    var gkey = 'pose.sl.' + g.id;
    var saved = STATE._collapsed ? STATE._collapsed[gkey] : undefined;
    // 镜头组默认展开（最常用），身体/状态默认收起
    var collapsed = (saved === undefined) ? true : (saved !== false);
    var touchedN = list.filter(function (x) { return STATE.pose.sliders[x.id] != null; }).length;
    var gh = el('div', 'field-group-h sl-group' + (collapsed ? ' col' : ''));
    gh.style.setProperty('--gc', GC_COLORS[(POSE_GIDX++) % GC_COLORS.length]);
    gh.innerHTML = '<span class="fg-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
      '<span class="fg-name">' + g.name + '</span>' +
      (g.note ? '<span class="fg-note">' + g.note + '</span>' : '') +
      '<span class="fg-n">' + (touchedN ? touchedN + ' 项已调' : '默认') + '</span>';
    gh.onclick = function () {
      if (!STATE._collapsed) STATE._collapsed = {};
      STATE._collapsed[gkey] = collapsed ? false : true;
      renderPanel();
    };
    box.appendChild(gh);
    if (collapsed) return;

    list.forEach(function (s) {
      var card = el('div', 'field f-slider');
      var h = el('div', 'field-head');
      h.appendChild(el('span', 'name', s.label));
      var qi = el('span', 'qi', '!'); bindTip(qi, '<b>' + s.label + '</b>\n' + (s.hint || '')); h.appendChild(qi);
      // 未拖动 = 不写入状态 = 不进提示词
      var touched = STATE.pose.sliders[s.id] != null;
      var dvC = touched ? STATE.pose.sliders[s.id] : (s.default != null ? s.default : Math.round((s.min + s.max) / 2));
      var valEl = el('span', 'val', touched ? String(dvC) : '默认');
      if (!touched) valEl.classList.add('val-def');
      h.appendChild(valEl);
      var rstP = el('span', 'lockbtn rst', '✕');
      rstP.title = touched ? '清掉：这一项不再写进提示词' : '未设置（本来就不写进提示词）';
      if (!touched) rstP.style.opacity = '0.3';
      rstP.onclick = function () {
        delete STATE.pose.sliders[s.id]; renderPanel(); rebuild();
        status('已清掉「' + s.label + '」');
      };
      h.appendChild(rstP);
      card.appendChild(h);
      if (!touched) card.classList.add('untouched');
      card.appendChild(buildSlider(s, dvC, function (v) {
        STATE.pose.sliders[s.id] = v; touch('pose'); rebuild();
      }, card));
      box.appendChild(card);
    });
  });
  // 没归进任何组的滑条照旧平铺
  allSl.filter(function (x) { return !usedIds[x.id]; }).forEach(function (s) {
    var card = el('div', 'field f-slider');
    var h = el('div', 'field-head');
    h.appendChild(el('span', 'name', s.label));
    var qi = el('span', 'qi', '!'); bindTip(qi, '<b>' + s.label + '</b>\n' + (s.hint || '')); h.appendChild(qi);
    var touched = STATE.pose.sliders[s.id] != null;
    var dvC = touched ? STATE.pose.sliders[s.id] : (s.default != null ? s.default : 50);
    var valEl = el('span', 'val', touched ? String(dvC) : '默认');
    if (!touched) valEl.classList.add('val-def');
    h.appendChild(valEl);
    card.appendChild(h);
    if (!touched) card.classList.add('untouched');
    card.appendChild(buildSlider(s, dvC, function (v) {
      STATE.pose.sliders[s.id] = v; touch('pose'); rebuild();
    }, card));
    box.appendChild(card);
  });

  // 该姿势专属滑条
  (cur && cur.sliders ? cur.sliders : []).forEach(function (s) {
    var card = el('div', 'field f-slider');
    var h = el('div', 'field-head');
    h.appendChild(el('span', 'name', '★ ' + s.label));
    var qi = el('span', 'qi', '!'); bindTip(qi, '<b>' + s.label + '</b>\n该滑条仅对「' + cur.cn + '」生效。'); h.appendChild(qi);
    // 跟通用滑条一样：没拖过就不写状态（否则一进页面就把默认值灌进提示词，用户还以为是「没生效」）
    var tch3 = STATE.pose.sliders[s.id] != null;
    var dv = tch3 ? STATE.pose.sliders[s.id] : s.default;
    h.appendChild(el('span', 'val' + (tch3 ? '' : ' val-def'), tch3 ? String(dv) : '默认'));
    if (!tch3) card.classList.add('untouched');
    var rst3 = el('span', 'lockbtn rst', '⟲');
    rst3.title = '回到默认：这一项不写进提示词';
    rst3.onclick = function () {
      delete STATE.pose.sliders[s.id]; renderPanel(); rebuild();
      status('「' + s.label + '」已清空');
    };
    h.appendChild(rst3);
    card.appendChild(h);
    card.appendChild(buildSlider(s, dv, function (v) {
      STATE.pose.sliders[s.id] = v; touch('pose'); rebuild();
    }, card));
    box.appendChild(card);
  });
  // 体位细分（姿势子选项：谁跪谁躺、在哪儿）
  var subDefs = (cur && cur.subs && cur.subs.length) ? cur.subs : (td.subs || []);
  subDefs.forEach(function (sb) {
    var card = el('div', 'field');
    var h = el('div', 'field-head');
    h.appendChild(el('span', 'name', sb.label));
    var qs = el('span', 'qi', '!');
    bindTip(qs, '<b>' + sb.label + '</b>\n' + (sb.hint || ''));
    h.appendChild(qs);
    var curV = (STATE.pose.subs || {})[sb.id] || 'none';
    var curCn = (sb.options || []).reduce(function (a, o) { return o.v === curV ? o.cn : a; }, '不限');
    h.appendChild(el('span', 'val', curCn));
    var rstS = el('span', 'lockbtn rst', '✕');
    rstS.title = '移除：回归「不限」';
    rstS.onclick = function () {
      if (STATE.pose.subs) STATE.pose.subs[sb.id] = 'none';
      renderPanel(); rebuild(); status('已移除体位限定');
    };
    h.appendChild(rstS);
    card.appendChild(h);
    var wrapS = el('div', 'chips');
    (sb.options || []).forEach(function (o) {
      var on = curV === o.v;
      var c = el('span', 'chip' + (on ? ' on' : ''), o.cn);
      c.title = (o.tags && o.tags.length) ? o.tags.join(', ') : '不限（不额外输出位置词）';
      c.onclick = function () {
        if (!STATE.pose.subs) STATE.pose.subs = {};
        STATE.pose.subs[sb.id] = o.v;
        if (sb.id === 'posture') STATE.pose.subs.postureVariant = null;  // 换位置就清掉细分
        touch('pose'); renderPanel(); rebuild();
        status(sb.label + '：' + o.cn);
      };
      wrapS.appendChild(c);
    });
    card.appendChild(wrapS);

    // 二级细分：当前体位有 variants 时展开
    if (sb.id === 'posture') {
      var curOpt = (sb.options || []).reduce(function (a, o) { return o.v === curV ? o : a; }, null);
      if (curOpt && curOpt.variants && curOpt.variants.length) {
        var vr = el('div', 'variant-row');
        vr.appendChild(el('span', 'vr-lb', '细分'));
        curOpt.variants.forEach(function (vv) {
          var von = STATE.pose.subs.postureVariant === vv.v;
          var cv = el('span', 'chip sm' + (von ? ' on' : ''), vv.cn);
          cv.title = (vv.tags || []).join(', ') || '无';
          cv.onclick = function () {
            STATE.pose.subs.postureVariant = von ? null : vv.v;
            renderPanel(); rebuild();
            status('细分：' + vv.cn);
          };
          vr.appendChild(cv);
        });
        card.appendChild(vr);
      }
    }

    box.appendChild(card);
  });

  syncFills();
}

function openPose(tier) {
  var m = $('#modalPose'); m.classList.remove('hidden');
  var tabs = $('#poseTabs'); tabs.innerHTML = '';
  // 开源版只有 SFW 数据时，mid/service 可能不存在：按实际加载到的库过滤
  var ALLT = ['light', 'mid', 'service'].filter(function (t) { return !!POSES[t] && (POSES[t].poses || []).length; });
  var kindOf = function (t) { return (POSES[t] && POSES[t].kind) || 'sfw'; };
  var kind = kindOf(tier);
  var duoN = function (t) { return (POSES[t].poses || []).filter(function (p2) { return p2._duo; }).length; };
  var soloN = function (t) { return (POSES[t].poses || []).filter(function (p2) { return !p2._duo && !p2._multi; }).length; };
  var multiN = function (t) { return (POSES[t].poses || []).filter(function (p2) { return p2._multi; }).length; };

  // 第一层：SFW / NSFW
  var kb = el('div', 'pose-kinds');
  [['sfw', 'SFW · 一般向'], ['nsfw', 'NSFW · 成人向']].forEach(function (k) {
    var tk = ALLT.filter(function (x) { return kindOf(x) === k[0]; });
    if (!tk.length) return;      // 这个大类没有数据（开源版只有 SFW）就不显示按钮
    var b = el('button', 'kindbtn' + (kind === k[0] ? ' on' : ''));
    b.innerHTML = k[1] + '<i>' + tk.reduce(function (a2, x) { return a2 + POSES[x].poses.length; }, 0) + '</i>';
    b.onclick = function () {
      if (!tk.length) return;
      var t = tk[0];
      STATE.pose.tier = t; STATE.pose.subs = {};
      STATE.pose.crowdTab = 'solo';
      var f0 = POSES[t].poses.filter(function (p2) { return !p2._duo && !p2._multi; })[0] || POSES[t].poses[0];
      STATE.pose.id = f0.id;
      openPose(t); renderPanel(); rebuild();
    };
    kb.appendChild(b);
  });
  tabs.appendChild(kb);

  // 第二层：单人 / 双人
  var cb = el('div', 'pose-kinds pose-crowdrow');
  var curCrowd = STATE.pose.crowdTab || 'solo';
  var tkAll = ALLT.filter(function (x) { return kindOf(x) === kind; });
  var soloTotal = tkAll.reduce(function (a2, x) { return a2 + soloN(x); }, 0);
  var duoTotal = tkAll.reduce(function (a2, x) { return a2 + duoN(x); }, 0);
  var multiTotal = tkAll.reduce(function (a2, x) { return a2 + multiN(x); }, 0);
  [['solo', '单人', soloTotal], ['duo', '双人', duoTotal], ['multi', '多人', multiTotal]].forEach(function (k) {
    if (!k[2]) return;
    var b = el('button', 'kindbtn small' + (curCrowd === k[0] ? ' on' : ''));
    b.innerHTML = k[1] + '<i>' + k[2] + '</i>';
    b.onclick = function () {
      var wantD = (k[0] === 'duo');
      var wantM = (k[0] === 'multi');
      var hit = function (p2) { return wantM ? !!p2._multi : (wantD ? (!!p2._duo && !p2._multi) : (!p2._duo && !p2._multi)); };
      STATE.pose.crowdTab = k[0];
      // 只在当前大类里找有这种人数姿势的库；找不到就保持不动（绝不跨类跳）
      var hasCrowd = function (x) {
        return (POSES[x].poses || []).some(hit);
      };
      var t2 = hasCrowd(STATE.pose.tier) ? STATE.pose.tier : tkAll.filter(hasCrowd)[0];
      if (!t2) { STATE.pose.crowdTab = curCrowd; return; }   // 这个大类没有该人数的姿势
      STATE.pose.tier = t2;
      var first = (POSES[t2].poses || []).filter(hit)[0];
      if (first) STATE.pose.id = first.id;
      STATE.pose.subs = {};
      openPose(t2); renderPanel(); rebuild();
    };
    cb.appendChild(b);
  });
  if (cb.children.length > 1) tabs.appendChild(cb);

  // 第三层：该人数下的具体姿势库
  var tb = el('div', 'pose-tiers');
  var curHit = function (p2) { return curCrowd === 'multi' ? !!p2._multi : (curCrowd === 'duo' ? (!!p2._duo && !p2._multi) : (!p2._duo && !p2._multi)); };
  tkAll.filter(function (x) {
    return (POSES[x].poses || []).some(curHit);
  }).forEach(function (t) {
    var n = curCrowd === 'multi' ? multiN(t) : (curCrowd === 'duo' ? duoN(t) : soloN(t));
    var ttl = POSES[t].title.replace('单人 / 双人动作', (curCrowd === 'multi' ? '多人动作' : (curCrowd === 'duo' ? '双人动作' : '单人动作')));
    if (curCrowd === 'multi') ttl = ttl.replace('性爱姿势', '多人性爱').replace('侍奉姿势', '多人侍奉');
    var b = el('button', STATE.pose.tier === t ? 'on' : '', ttl + '（' + n + '）');
    b.onclick = function () {
      STATE.pose.tier = t; STATE.pose.subs = {};
      var first = (POSES[t].poses || []).filter(curHit)[0];
      if (first) STATE.pose.id = first.id;
      openPose(t); renderPanel(); rebuild();
    };
    tb.appendChild(b);
  });
  tabs.appendChild(tb);
    drawPoseList(tier, '');
  $('#poseSearch').value = '';
  $('#poseSearch').oninput = function () { drawPoseList(tier, this.value.toLowerCase()); };
}

// 库标题随「人数」变化（单人 / 双人 / 多人）
function poseTierTitle(td) {
  var c = STATE.pose.crowdTab;
  var t2 = td.title.replace('单人 / 双人动作', c === 'multi' ? '多人动作' : (c === 'duo' ? '双人动作' : '单人动作'));
  if (c === 'multi') t2 = t2.replace('性爱姿势', '多人性爱').replace('侍奉姿势', '多人侍奉');
  return t2;
}
function drawPoseList(tier, kw) {
  var box = $('#poseList'); box.innerHTML = '';
  var td = POSES[tier];
  var wantDuo = (STATE.pose.crowdTab === 'duo');
  var wantMulti = (STATE.pose.crowdTab === 'multi');
  var inCrowd = function (p2) {
    return wantMulti ? !!p2._multi : (wantDuo ? (!!p2._duo && !p2._multi) : (!p2._duo && !p2._multi));
  };
  var groups = td.groups || [{ id: '', name: '' }];
  // 顶部统计
  var all = td.poses.filter(function (p) { return inCrowd(p) && (!kw || (p.cn + ' ' + p.tags.join(' ')).toLowerCase().indexOf(kw) >= 0); });
  var stat = el('div', 'pose-stat');
  var statTitle = poseTierTitle(td);
  stat.innerHTML = '<b>' + statTitle + '</b> · 共 ' + all.length + ' 个';
  box.appendChild(stat);

  groups.forEach(function (g) {
    var list = td.poses.filter(function (p) { return inCrowd(p) && (!g.id || p.group === g.id); });
    list = list.filter(function (p) { return !kw || (p.cn + ' ' + p.tags.join(' ')).toLowerCase().indexOf(kw) >= 0; });
    list = favSortList('pose', 'tier.' + tier, list, function (p) { return p.id; });
    if (!list.length) return;
    var hN = list.filter(function (p) { return p.hard; }).length;
    var pkey = 'pose.' + tier + '.' + g.id;
    var pcol = !(STATE._collapsed && STATE._collapsed[pkey] === false);
    var h = el('div', 'pose-group-h' + (pcol ? ' col' : ''));
    h.innerHTML = '<span class="caret">' + (pcol ? '▸' : '▾') + '</span>' +
      (g.name || '全部') + (g.note ? '<i> · ' + g.note + '</i>' : '') +
      '<em>' + list.length + '</em>';
    var wrap = el('div', 'pose-group-body');
    if (pcol && !kw) wrap.style.display = 'none';
    list.forEach(function (p) {
      var pFav = isFav('pose', 'tier.' + tier, p.id);
      var c = el('div', 'pose-card' + (STATE.pose.id === p.id ? ' on' : '') + (p.hard ? ' hard' : '') + (pFav ? ' fav' : ''));
      var tgShort = p.tags.slice(0, 3).join(', ') + (p.tags.length > 3 ? ' …' : '');
      attachFav(c, 'pose', 'tier.' + tier, p.id, p.cn, function () { drawPoseList(tier, kw); });
      c.innerHTML = '<div class="n">' + (pFav ? '<span class="favstar">★</span>' : '') +
        p.cn + (p.male ? ' <span style="color:#d05050">♂</span>' : '') +
        (p.hard ? ' <span class="hardflag" title="' + p.hard + '">◇</span>' : '') + '</div>' +
        (p.hard ? '<div class="hardnote">◇ ' + p.hard + '</div>' : '') +
        '<div class="tg" title="' + p.tags.join(', ') + '">' + tgShort + '</div>' +
        (p.hint ? '<div class="grp">' + p.hint + '</div>' : '');
      c.onclick = function () {
        STATE.pose.tier = tier; STATE.pose.id = p.id; STATE.pose.subs = {}; touch('pose');
        STATE.pose.sliders = {};
        // 体位自带构图：自动带 1–2 个该体位常用的值
        var auto = autoPoseSliders(p);
        var autoN = 0;
        for (var k in auto) { STATE.pose.sliders[k] = auto[k]; autoN++; }
        renderPanel(); rebuild(); $('#modalPose').classList.add('hidden');
        var extra = '';
        status('已选姿势：' + p.cn + extra + (p.hard ? '（这类姿势较难还原）' : ''));
      };
      wrap.appendChild(c);
    });
    h.onclick = function () {
      if (!STATE._collapsed) STATE._collapsed = {};
      STATE._collapsed[pkey] = pcol ? false : true;
      drawPoseList(tier, kw);
    };
    box.appendChild(h); box.appendChild(wrap);
  });
}

// 分组标题用色板（按顺序轮换，暗色界面里都够亮又不过分刺眼）
var GC_COLORS = ['#5b9cff', '#4fc3a1', '#d8a84a', '#c58bff', '#ff7f9e', '#56c8e0', '#9ccc65', '#e0895a'];

/* ---------- 输出页 ---------- */
// 词条 → 软件里的中文原文（选项 cn / 滑条映射）
var CN_MAP = null;
function buildCnMap() {
  var m = {};
  var addFields = function (fields) {
    (fields || []).forEach(function (f) {
      (f.options || []).forEach(function (o) {
        if (o.v && o.cn && !m[o.v]) m[o.v] = o.cn;
      });
      (f.map || []).forEach(function (g) {
        (g.tags || []).forEach(function (t) {
          var k = String(t).toLowerCase();
          if (!m[k]) m[k] = (f.label || f.id) + (g.cn ? '·' + g.cn : '');
        });
      });
    });
  };
  ['characters', 'clothing', 'scenes', 'features', 'styles'].forEach(function (k) {
    if (DATA[k]) addFields(DATA[k].fields);
  });
  ['light', 'mid', 'service'].forEach(function (t) {
    if (!POSES[t]) return;
    addFields(POSES[t].commonSliders);
    (POSES[t].poses || []).forEach(function (p) {
      addFields(p.sliders);
      (p.subs || []).forEach(function (sb) { addFields([sb]); });
    });
  });
  CN_MAP = m;
  return m;
}
function cnOf(tag) {
  var t = String(tag || '').replace(/^\((.*):[\d.]+\)$/, '$1').trim();
  var m = CN_MAP || buildCnMap();
  return m[t] || m[t.toLowerCase()] || '';
}

function renderOutputInline() {
  var box = $('#fields'); box.innerHTML = '';
  var b = LASTBUILD || CPS.build(STATE, CTX());

  var negCard = el('div', 'field');
  negCard.innerHTML = '<div class="field-head"><span class="name">负面配方</span><span class="qi">!</span></div>';
  bindTip(negCard.querySelector('.qi'), '<b>负面配方</b>\n可多选组合。基础质量与人体修复建议常开；Pony 模型会自动追加 score_4/5/6。');
  var wrap = el('div', 'chips');
  DATA.negatives.groups.forEach(function (g) {
    if (g.auto) return;   // 男性压制这类自动配方不显示（引擎按体位自动加）
    var on = (STATE.negativeGroups || []).indexOf(g.id) >= 0;
    var c = el('span', 'chip' + (on ? ' on' : ''), g.name);
    c.title = g.tags.join(', ');
    c.onclick = function () {
      var a = STATE.negativeGroups || [];
      var i = a.indexOf(g.id); if (i >= 0) a.splice(i, 1); else a.push(g.id);
      STATE.negativeGroups = a; renderPanel(); rebuild();
    };
    wrap.appendChild(c);
  });
  negCard.appendChild(wrap);
  box.appendChild(negCard);

  var srcCard = el('div', 'field');
  srcCard.innerHTML = '<div class="field-head"><span class="name">正向来源（' + b.sources.length + ' 条，丢弃 ' + b.dropped.length + ' 条）</span></div>';
  var srcMap = { character: '人物', clothing: '服装', pose: '姿势', scene: '场景', feature: '特征', style: '画风' };
  var cur = '';
  var grid = null;
  b.sources.forEach(function (s) {
    if (s.src !== cur) {
      cur = s.src;
      srcCard.appendChild(el('div', 'pose-group-h', srcMap[cur] || cur));
      grid = el('div', 'tag-grid');
      srcCard.appendChild(grid);
    }
    if (!grid) { grid = el('div', 'tag-grid'); srcCard.appendChild(grid); }
    var muted = !!(STATE._muted && STATE._muted[s.tag]);
    var cn = cnOf(s.tag);
    var cell = el('div', 'tag-cell' + (muted ? ' muted' : ''));
    cell.innerHTML = '<div class="tc-en">' + s.tag + '</div>' +
      '<div class="tc-cn">' + (cn || '（无中文对应）') + '</div>';
    cell.title = muted ? '已取消：这条词不进提示词（点一下恢复）' : '点一下取消：灰掉后不进提示词，面板不清空';
    cell.onclick = function () {
      STATE._muted = STATE._muted || {};
      if (STATE._muted[s.tag]) delete STATE._muted[s.tag]; else STATE._muted[s.tag] = 1;
      renderPanel(); rebuild();
      status(STATE._muted[s.tag] ? '已取消「' + (cn || s.tag) + '」（不写进提示词）' : '已恢复「' + (cn || s.tag) + '」');
    };
    grid.appendChild(cell);
  });
  if (b.dropped.length) {
    srcCard.appendChild(el('div', 'pose-group-h', '因 token 超预算被丢弃'));
    var dg = el('div', 'tag-grid');
    b.dropped.forEach(function (t) {
      var cell = el('div', 'tag-cell muted');
      cell.innerHTML = '<div class="tc-en">' + t + '</div><div class="tc-cn">' + (cnOf(t) || '（无中文对应）') + '</div>';
      dg.appendChild(cell);
    });
    srcCard.appendChild(dg);
  }
  box.appendChild(srcCard);

  // 「出图服务」卡片已移除：嵌入版只做提示词，不出图
}

/* ---------- 随机 ---------- */
var rModal = false;
function openRandom() {
  $('#modalRandom').classList.remove('hidden');
  var t = TABS.find(function (x) { return x.id === CURTAB; });
  $('#rscopeName').textContent = t ? '（' + t.name + '）' : '';
  var labels = ['温和 ±10%', '标准 ±30%', '狂野（整段跳）'];
  $('#rIntensity').oninput = function () { $('#rIntensityTxt').textContent = labels[+this.value]; };
}
function doRandom() {
  var scope = document.querySelector('input[name=rscope]:checked').value;
  var inten = +$('#rIntensity').value;
  var ctx = CTX();
  var mods = ['character', 'clothing', 'scene', 'feature', 'style'];
  var targets = scope === 'all' ? mods : (scope === 'module' ? [CURTAB] : mods);
  var fieldsMap = { character: DATA.characters.fields, clothing: DATA.clothing.fields, scene: DATA.scenes.fields, feature: DATA.features.fields, style: DATA.styles.fields };

  targets.forEach(function (mod) {
    var fields = fieldsMap[mod]; if (!fields) return;
    fields.forEach(function (f) {
      if (LOCKS[mod + '.' + f.id]) return;
      // optional 字段：有一半概率保持停用，避免随机把 token 顶满
      if (f.optional && Math.random() < 0.75) {
        STATE[mod][f.id] = f.type === 'multi' ? [] : null;
        return;
      }
      var cur = STATE[mod][f.id];
      if (cur == null && f.type !== 'multi') cur = f.default;
      if (f.type === 'slider') {
        var v;
        if (scope === 'value' && inten < 2) {
          var delta = (f.max - f.min) * (inten === 0 ? 0.1 : 0.3);
          v = Math.round(Math.max(f.min, Math.min(f.max, cur + (Math.random() * 2 - 1) * delta)));
        } else {
          v = Math.round(f.min + Math.random() * (f.max - f.min));
        }
        STATE[mod][f.id] = v;
      } else if (f.type === 'multi') {
        if (scope === 'value' && Math.random() < 0.7) return;
        var pool = f.options.filter(function () { return Math.random() < (inten === 2 ? 0.35 : 0.18); }).map(function (o) { return o.v; });
        STATE[mod][f.id] = pool;
      } else if (f.type === 'select') {
        if (scope === 'value' && Math.random() < 0.7) return;
        var o = f.options[Math.floor(Math.random() * f.options.length)];
        STATE[mod][f.id] = o.v;
      } else if (f.type === 'color') {
        if (scope === 'value' && Math.random() < 0.7) return;
        STATE[mod][f.id] = f.options[Math.floor(Math.random() * f.options.length)].v;
      }
    });
  });

  if (scope === 'all') {
    // 只从实际加载到的姿势库里随机（嵌入模式可能只有 light，缺 mid/service）
    var tiers = ['light', 'mid', 'service'].filter(function (x) { return !!POSES[x] && (POSES[x].poses || []).length; });
    if (tiers.length) {
      var t = tiers[Math.floor(Math.random() * tiers.length)];
      var list = POSES[t].poses;
      STATE.pose.tier = t; STATE.pose.id = list[Math.floor(Math.random() * list.length)].id; STATE.pose.subs = {};
      (POSES[t].commonSliders || []).forEach(function (s) { if (!LOCKS['pose.' + s.id]) STATE.pose.sliders[s.id] = Math.round(s.min + Math.random() * (s.max - s.min)); });
    }
  }
  // 随机收敛：一次随机很容易把 token 顶到硬上限导致词被砍，超过 140 就按低优先级关掉停用字段
  for (var guard = 0; guard < 80; guard++) {
    var bb = CPS.build(STATE, ctx);
    if (bb.tokens <= 140) break;
    var cands = [];
    targets.forEach(function (mod) {
      var fs = fieldsMap[mod]; if (!fs) return;
      fs.forEach(function (f) {
        if (!f.optional || LOCKS[mod + '.' + f.id]) return;
        var v = STATE[mod][f.id];
        if (v == null || (Array.isArray(v) && v.length === 0)) return;
        cands.push({ mod: mod, f: f, pri: f.priority || 3 });
      });
    });
    if (!cands.length) break;
    cands.sort(function (a, b) { return b.pri - a.pri; });
    var pick = cands[Math.floor(Math.random() * Math.min(4, cands.length))];
    STATE[pick.mod][pick.f.id] = pick.f.type === 'multi' ? [] : null;
  }
  $('#modalRandom').classList.add('hidden');
  STATE._lastTouched = targets[0] || CURTAB;
  renderPanel(); rebuild();
  status('随机完成（' + (scope === 'all' ? '全部' : scope === 'module' ? '当前模块' : '当前值微调') + '）');
}

/* ---------- LoRA ---------- */


/* ---------- 通用引导弹框 ---------- */
function showGuide(title, bodyHtml, okText, onOk, cancelText, onCancel) {
  $('#guideTitle').textContent = title;
  $('#guideBody').innerHTML = bodyHtml;
  var ok = $('#guideOk'), cancel = $('#guideCancel');
  ok.textContent = okText || '继续';
  cancel.textContent = cancelText || '取消';
  $('#modalGuide').classList.remove('hidden');
  ok.onclick = function () { $('#modalGuide').classList.add('hidden'); if (onOk) onOk(); };
  cancel.onclick = function () { $('#modalGuide').classList.add('hidden'); if (onCancel) onCancel(); };
}
function hideGuide() { $('#modalGuide').classList.add('hidden'); }

/* ---------- 出图 ---------- */
var COMFLY = null;
async function pingComfy() {
  var st = $('#comfyStatus');
  st.textContent = '检测中…'; st.className = 'status busy';
  var r = await API.ping();
  if (r && r.ok) {
    COMFLY = true;
    var np = r.port || 8188;
    if (np !== COMFLY_PORT) { COMFLY_PORT = np; if (CWS) { try { CWS.close(); } catch (e) {} CWS = null; } initComfyWS(); }
    st.textContent = '已连接 :' + np; st.className = 'status ok';
  }
  else { COMFLY = false; st.textContent = '未连接'; st.className = 'status err'; }
  return COMFLY;
}

/* ---------- 嵌入模式：把当前生成的正向/负向/参数保存到主程序提示词库 ---------- */
function openSaveToLibrary() {
  doRebuild();  // 确保拿到最新结果
  var b = LASTBUILD;
  var positive = (b && b.positive) || '';
  var negative = (b && b.negative) || '';
  var param = b && b.param ? JSON.parse(JSON.stringify(b.param)) : null;

  // 弹框：输入名称 + 说明
  var overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'modalSaveLib';
  overlay.innerHTML =
    '<div class="modal-box">' +
    '<h3>保存到提示词库</h3>' +
    '<div class="row"><span style="width:52px">名称</span><input id="svName" maxlength="40" placeholder="给这套提示词起个名字" style="flex:1;padding:5px 9px;background:var(--panel);border:1px solid var(--line2);border-radius:6px;color:var(--txt)" /></div>' +
    '<div class="row"><span style="width:52px">说明</span><input id="svDesc" maxlength="200" placeholder="一句话说明（可选）" style="flex:1;padding:5px 9px;background:var(--panel);border:1px solid var(--line2);border-radius:6px;color:var(--txt)" /></div>' +
    '<div class="hint">将把当前右侧的正向、负向、采样参数一起存入「提示词库」，可之后查看复用。</div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button>' +
    '<button class="btn primary" id="svOk">保存</button></div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.classList.remove('hidden');
  overlay.querySelectorAll('[data-close]').forEach(function (x) { x.onclick = function () { overlay.remove(); }; });
  overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
  var nameEl = overlay.querySelector('#svName');
  if (nameEl) nameEl.focus();

  overlay.querySelector('#svOk').onclick = function () {
    var name = (nameEl.value || '').trim();
    if (!name) { status('请填写名称'); if (nameEl) nameEl.focus(); return; }
    var desc = (overlay.querySelector('#svDesc').value || '').trim();
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: 'cps:saveToLibrary',
        name: name,
        desc: desc,
        positive: positive,
        negative: negative,
        param: param
      }, '*');
      overlay.remove();
      status('已提交到提示词库');
    } else {
      status('保存失败：未连接到主程序');
    }
  };
}

async function generate() {
  // 每次出图前强制按当前 STATE 同步重建。
  // 原来只在 LASTBUILD 为空时重建，导致「改完设置立刻点出图」用的是上一次的旧提示词，
  // 表面上像是设置没生效 / 图不对劲。
  doRebuild();
  var b = LASTBUILD;

  // ===== 嵌入模式：把提示词回传宿主，不出图 =====
  if (window.__CPS_EMBED__ && window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({
        type: 'cps:prompt',
        positive: b && b.positive || '',
        negative: b && b.negative || '',
        param: b && b.param || null
      }, '*');
      status('提示词已发送到工作台');
    } catch (e) {
      status('回传失败：' + e.message);
    }
    return;
  }
  // ===== 嵌入模式结束 =====

  var el2 = $('#result');
  var st = $('#comfyStatus');
  st.textContent = '提交中…'; st.className = 'status busy';
  var n = +($('#batchCount') ? $('#batchCount').value : 1) || 1;
  progShow(n);
  var ok = await pingComfy();
  if (!ok) {
    st.textContent = '未连接 8188';
    progSet(100, '未连接', 'ComfyUI 没开：点「启动」或手动开 Comfy Desktop', 'err');
    setTimeout(progHide, 4000);
    status('ComfyUI 没开：点「启动」或手动开 Comfy Desktop');
    return;
  }

  var b = LASTBUILD, p = JSON.parse(JSON.stringify(b.param));
  p.positive = b.positive;
  p.negative = b.negative;
  if (n === 1) el2.innerHTML = '';
  for (var i = 0; i < n; i++) {
    p.seed = takeSeed(i, n);
    $('#seedInput').value = p.seed;          // 显示本次用的种子，想复现直接点锁
    SEED_ECHO = true;                        // 这是回显值，别当成"用户要固定种子"
    p.prefix = 'CPS_' + Date.now();
    if (n > 1) progSet(0, '第 ' + (i + 1) + ' / ' + n + ' 张 提交中…', '');
    else progSet(0, '提交中…', '');
    var wf = CPS.buildWorkflow(p, STATE.loras, STATE.controlnet).prompt;
    // 设置面板里的「默认分辨率」直接覆盖到工作流（比走 param 更可靠）
    if (wf['5'] && wf['5'].inputs) {
      if (STATE.overrideW) wf['5'].inputs.width = STATE.overrideW;
      if (STATE.overrideH) wf['5'].inputs.height = STATE.overrideH;
    }
    var r = await API.comfy({ method: 'POST', path: '/prompt', body: { prompt: wf } });
    if (!r.ok) {
      st.textContent = '提交失败'; st.className = 'status err';
      progSet(100, '提交失败', String(JSON.stringify(r.data || r.error)).slice(0, 90), 'err');
      setTimeout(progHide, 5000);
      status('提交失败：' + JSON.stringify(r.data || r.error).slice(0, 200));
      return;
    }
    var pid = r.data.prompt_id;
    PROG.pid = pid;
    progSet(null, (n > 1 ? '第 ' + (i + 1) + ' / ' + n + ' 张 · ' : '') + '已入队', '排队/加载模型中…');
    status('已入队 ' + pid.slice(0, 8) + '  等待出图…');
    var img = await waitImage(pid);
    if (img) {
      var wrap = el('div');
      wrap.innerHTML = '<img src="' + img.url + '" />';
      el2.appendChild(wrap);
      await saveGallery(img, p, b);
      renderHistory();
    }
  }
  queueSaveState();
  st.textContent = '完成'; st.className = 'status ok';
  progSet(100, n > 1 ? ('全部完成（' + n + ' 张）') : '完成', '', 'done');
  setTimeout(progHide, 2000);
  status('出图完成');
}

function waitImage(pid) {
  return new Promise(function (resolve) {
    var tries = 0;
    var timer = setInterval(async function () {
      tries++;
      if (tries > 180) { clearInterval(timer); resolve(null); return; }
      var h = await API.comfy({ path: '/history/' + pid });
      if (h.ok && h.data && h.data[pid] && h.data[pid].outputs) {
        clearInterval(timer);
        var outs = h.data[pid].outputs;
        for (var k in outs) {
          if (outs[k].images && outs[k].images.length) {
            var im = outs[k].images[0];
            var q = '/view?filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder || '') + '&type=' + (im.type || 'output');
            var v = await API.comfy({ path: q, json: false });
            if (v.ok && v.base64) { resolve({ url: 'data:' + (v.type || 'image/png') + ';base64,' + v.base64, filename: im.filename, sub: im.subfolder || '' }); }
            else resolve({ url: (BROWSER ? '/proxy' : 'http://127.0.0.1:8188') + q, filename: im.filename, sub: im.subfolder || '' });
            return;
          }
        }
        resolve(null);
      }
    }, 1000);
  });
}


/* ---------- 种子 / 历史条 / 状态自动恢复 ---------- */
var SEED_LOCK = false;
// 出图后会把实际种子写回输入框（方便复现）。但那个值是「上一张的回显」，
// 不代表用户想固定种子 —— 不区分的话，连点两次出图就会用同一个种子出同一张图。
var SEED_ECHO = false;
var _saveTimer = null;

function pickSeed() { return Math.floor(Math.random() * 1e9); }

/* ---------- 收藏：右键切换，收藏项自动排到前面 ---------- */
var FAV = {};
try { FAV = JSON.parse(localStorage.getItem('cps_favs') || '{}') || {}; } catch (e) { FAV = {}; }
function isFav(mod, fid, v) { var k = mod + '.' + fid; return !!(FAV[k] && FAV[k][v]); }
function toggleFav(mod, fid, v) {
  var k = mod + '.' + fid;
  FAV[k] = FAV[k] || {};
  if (FAV[k][v]) delete FAV[k][v]; else FAV[k][v] = 1;
  if (!Object.keys(FAV[k]).length) delete FAV[k];
  try { localStorage.setItem('cps_favs', JSON.stringify(FAV)); } catch (e) {}
  return isFav(mod, fid, v);
}
// 收藏优先，其余保持原顺序
function favSortOptions(mod, fid, options) {
  var fav = [], rest = [];
  (options || []).forEach(function (o) { (isFav(mod, fid, o.v) ? fav : rest).push(o); });
  return fav.concat(rest);
}
function favSortList(mod, fid, arr, getV) {
  var fav = [], rest = [];
  (arr || []).forEach(function (x) { (isFav(mod, fid, getV(x)) ? fav : rest).push(x); });
  return fav.concat(rest);
}
// 给任意元素加右键收藏（label 用于状态栏提示，after 用于重绘）
function attachFav(node, mod, fid, v, label, after) {
  node.addEventListener('contextmenu', function (ev) {
    ev.preventDefault(); ev.stopPropagation();
    var on = toggleFav(mod, fid, v);
    status((on ? '★ 已收藏「' : '已取消收藏「') + (label || v) + '」· 收藏项会自动排到前面');
    if (after) after();
  });
  node.title = (node.title ? node.title + '\n' : '') + '（右键可收藏）';
}

function takeSeed(i, total) {
  var v = ($('#seedInput').value || '').trim();
  if (SEED_LOCK && v) return +v;          // 锁定：每张都用同一个
  // 手动填了但没锁：这一张用它。回显值不算「手动填」，否则连点出图永远是同一张。
  if (!SEED_LOCK && v && total === 1 && !SEED_ECHO) return +v;
  return pickSeed();
}

function syncSeedUI() {
  var lock = $('#btnSeedLock');
  if (!lock) return;
  lock.textContent = SEED_LOCK ? '🔒' : '🔓';
  lock.classList.toggle('on', SEED_LOCK);
  lock.title = SEED_LOCK ? '种子已锁定，点一下解锁（每次随机）' : '点一下锁定当前种子，之后每次出图都用它';
}

function initSeedUI() {
  var inp = $('#seedInput'), lock = $('#btnSeedLock');
  if (!inp || !lock) return;
  // 启动不恢复上次种子（隐私 + 默认随机）
  inp.value = '';
  lock.onclick = function () {
    SEED_LOCK = !SEED_LOCK;
    if (SEED_LOCK && !inp.value.trim()) inp.value = pickSeed();
    SEED_ECHO = false;
    syncSeedUI();
    status(SEED_LOCK ? '种子已锁定 ' + inp.value + '，改提示词也会保留画面结构' : '种子已解锁，每次随机');
  };
  inp.oninput = function () { SEED_ECHO = false; };   // 用户自己改过 → 这个值算他填的
  inp.onkeydown = function (e) {
    if (e.key === 'Enter') { SEED_LOCK = true; SEED_ECHO = false; syncSeedUI(); status('种子已锁定 ' + this.value); }
  };
  restSeedUI();
}

function restSeedUI() {
  var bc = $('#batchCount');
  if (bc) {
    bc.onchange = function () { status('每次出 ' + this.value + ' 张'); };
  }
}

/* 历史缩略图条：直接复用图库记录 */
var HISTORY_OPEN = false;   // 默认收起，每次启动都是关的

function renderHistory() {
  var box = $('#history');
  if (!box) return;
  var hb = $('#btnHistory');
  if (hb) { hb.textContent = HISTORY_OPEN ? '历史 ▴' : '历史 ▾'; hb.style.opacity = GALLERY.length ? '1' : '.45'; }
  if (!GALLERY.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  if (!HISTORY_OPEN) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  GALLERY.slice(0, 14).forEach(function (g, i) {
    var d = el('div', 'hist-item' + (i === 0 ? ' on' : ''));
    d.innerHTML = '<img src="' + (g.thumb || '') + '" onerror="this.style.opacity=.15" />';
    d.title = new Date(g.t).toLocaleString('zh-CN', { hour12: false }) + '\n种子 ' + g.seed + '\n点击看大图 · 双击回填这组参数';
    d.onclick = function () {
      var r = $('#result');
      if (!g.thumb) return;
      r.innerHTML = '<img src="' + g.thumb + '" />';
      Array.prototype.forEach.call(box.children, function (c) { c.classList.remove('on'); });
      d.classList.add('on');
      status('回看：种子 ' + g.seed);
    };
    d.ondblclick = function (e) {
      e.preventDefault();
      if (!g.state) return;
      STATE = JSON.parse(JSON.stringify(g.state));
      if (g.seed) { $('#seedInput').value = g.seed; SEED_LOCK = true; syncSeedUI(); }
      renderModels(); renderPanel(); rebuild();
      status('已回填这组参数 + 种子 ' + g.seed + '，点出图可复现');
    };
    box.appendChild(d);
  });
  // 启动不自动显示任何图（隐私），结果区保持「点出图后在此显示」
}

/* 状态自动恢复：改一下存一次，关软件不丢 */
// 隐私考虑：不再把人物/服装/种子写进 localStorage（界面偏好另有单独的键，不含内容）
function queueSaveState() {
  clearTimeout(_saveTimer);
}

async function loadGallery() {
  try {
    var r = await API.readJSON('gallery/index.json');
    if (r && r.data && Array.isArray(r.data)) GALLERY = r.data;
  } catch (e) {}
}

function restoreState() {
  try {
    var raw = localStorage.getItem('cps_state');
    if (!raw) return false;
    var st = JSON.parse(raw);
    if (!st || typeof st !== 'object' || !st.character) return false;
    STATE = st;
    if (STATE.pose && !STATE.pose.view) STATE.pose.view = 'third';
    return true;
  } catch (e) { return false; }
}


/* ---------- 图库 ---------- */
var GALLERY = [];
async function saveGallery(img, param, build) {
  var rec = { t: Date.now(), seed: param.seed, pos: build.positive, neg: build.negative, param: param, state: JSON.parse(JSON.stringify(STATE)) };
  var nm = 'g_' + Date.now() + '.png';
  if (window.cps && API.saveImage && img.url.indexOf('data:') === 0) {
    var r = await API.saveImage({ name: nm, base64: img.url });
    if (r && r.ok) rec.thumb = 'file:///' + String(r.path).replace(/\\/g, '/');
  }
  if (!rec.thumb && img.filename) {
    var prefix = BROWSER ? '/proxy' : '';
    rec.thumb = prefix + '/view?filename=' + encodeURIComponent(img.filename) + '&type=output';
  }
  if (!rec.thumb) rec.thumb = '';
  GALLERY.unshift(rec);
  await API.writeJSON('gallery/index.json', GALLERY.slice(0, 200));
}

async function openGallery() {
  $('#modalGallery').classList.remove('hidden');
  var box = $('#galleryList'); box.innerHTML = '';
  var r = await API.readJSON('gallery/index.json');
  if (r && r.data && Array.isArray(r.data)) GALLERY = r.data;
  if (!GALLERY.length) { box.innerHTML = '<div class="hint">还没有出图记录</div>'; return; }
  GALLERY.forEach(function (g) {
    var d = el('div', 'gal-item');
    d.innerHTML = '<img src="' + (g.thumb || '') + '" onerror="this.style.opacity=.2" />' +
      '<div class="cap">' + new Date(g.t).toLocaleString('zh-CN', { hour12: false }) + '</div>' +
      (g.seed ? '<div class="cap seed">种子 ' + g.seed + '</div>' : '');
    d.title = '点击回填这组参数（含种子）';
    d.onclick = function () {
      if (g.state) {
        STATE = JSON.parse(JSON.stringify(g.state));
        if (g.seed) { $('#seedInput').value = g.seed; SEED_LOCK = true; syncSeedUI(); }
        renderModels(); renderPanel(); rebuild();
        status('已回填参数' + (g.seed ? '，种子已锁定 ' + g.seed : ''));
        $('#modalGallery').classList.add('hidden');
      } else {
        status('这条记录没有保存参数，只能看不能回填');
      }
    };
    box.appendChild(d);
  });
}

/* ---------- 事件 ---------- */
function bindEvents() {
  $('#btnGen').onclick = generate;
  $('#btnRandom').onclick = openRandom;
  $('#btnReset').onclick = function () {
    STATE = CPS.defaultState({ models: DATA.models, characters: DATA.characters, clothing: DATA.clothing, scenes: DATA.scenes, features: DATA.features, styles: DATA.styles, poses: POSES });
    renderModels(); renderPanel(); rebuild(); status('已全部重置');
  };
  var foldBtn = $('#btnFoldAll');
  if (foldBtn) foldBtn.onclick = function () {
    var cfg = currentFields();
    if (!cfg || !cfg.groups) return;
    if (!STATE._collapsed) STATE._collapsed = {};
    var allCollapsed = cfg.groups.every(function (g) { return STATE._collapsed[cfg.mod + '.' + g.id] !== false; });
    cfg.groups.forEach(function (g) { STATE._collapsed[cfg.mod + '.' + g.id] = allCollapsed ? false : true; });
    renderPanel(); queueSaveState();
    status(allCollapsed ? '已全部展开' : '已全部收起');
  };
  $('#btnPanelReset').onclick = function () {
    if (['character', 'clothing', 'scene', 'feature', 'style'].indexOf(CURTAB) < 0) return;
    var cfg = currentFields();
    cfg.fields.forEach(function (f) {
      if (LOCKS[cfg.mod + '.' + f.id]) return;
      if (f.optional) { STATE[cfg.mod][f.id] = f.type === 'multi' ? [] : null; return; }
      STATE[cfg.mod][f.id] = Array.isArray(f.default) ? JSON.parse(JSON.stringify(f.default)) : f.default;
    });
    renderPanel(); rebuild(); status('已重置本页');
  };
  $('#btnLock').onclick = function () {
    var any = Object.keys(LOCKS).some(function (k) { return LOCKS[k]; });
    if (any) { LOCKS = {}; status('已解锁全部'); }
    else {
      ['character', 'clothing', 'scene', 'feature', 'style'].forEach(function (m) {
        var fs = { character: DATA.characters.fields, clothing: DATA.clothing.fields, scene: DATA.scenes.fields, feature: DATA.features.fields, style: DATA.styles.fields }[m];
        fs.forEach(function (f) { LOCKS[m + '.' + f.id] = true; });
      });
      status('已锁定全部（' + Object.keys(LOCKS).length + ' 项）');
    }
    renderPanel();
  };
  $('#btnSave').onclick = function () { openSaveToLibrary(); };
  // 「读取」按钮已移除：存档功能在本嵌入版不可用
  // 设置/模型管理、人物卡绑定已移除（嵌入模式只做提示词，相关 DOM 已删除）
  var bh = $('#btnHistory');
  if (bh) bh.onclick = function () {
    HISTORY_OPEN = !HISTORY_OPEN;
    renderHistory();
    status(HISTORY_OPEN ? '已展开历史' : '已收起历史');
  };
  $('#btnGallery').onclick = openGallery;
  $('#btnFolder').onclick = function () {
    if (!API.openFolder) { status('当前模式不支持打开本地目录'); return; }
    Promise.resolve(API.openFolder('output')).then(function (r) {
      if (r && r.ok === false) status('打开失败：' + (r.error || '目录不存在'));
      else status('已打开输出目录');
    }).catch(function (e) { status('打开失败：' + e.message); });
  };
  $('#btnCopyPos').onclick = function () { copy($('#posText').value); };
  $('#btnCopyNeg').onclick = function () { copy($('#negText').value); };
  $('#rGo').onclick = doRandom;
  $('#search').oninput = function () {
    var kw = this.value.toLowerCase();
    // 折叠状态下字段根本没渲染，先重建一次（renderPanel 读到搜索词会自动展开所有组）
    if (!$('#fields').querySelector('.field') && kw) renderPanel();
    $$('.field').forEach(function (c) { c.style.display = (!kw || (c.dataset.search || '').indexOf(kw) >= 0) ? '' : 'none'; });
    // 分组标题跟着走：组内一个都没匹配就整组藏起来
    $$('#fields .field-group-h').forEach(function (h) {
      var n = 0, el2 = h.nextElementSibling;
      while (el2 && !el2.classList.contains('field-group-h')) {
        if (el2.classList.contains('field') && el2.style.display !== 'none') n++;
        el2 = el2.nextElementSibling;
      }
      h.style.display = n ? '' : 'none';
    });
  };
  $$('[data-close]').forEach(function (b) { b.onclick = function () { b.closest('.modal').classList.add('hidden'); }; });
  $$('.modal').forEach(function (m) { m.onclick = function (e) { if (e.target === m) m.classList.add('hidden'); }; });
  $('#posText').oninput = function () { /* 允许手改，不回写状态 */ };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $$('.modal').forEach(function (m) { m.classList.add('hidden'); });
    if (e.ctrlKey && e.key === 'z') { renderPanel(); rebuild(); status('已回退到当前状态'); }
  });
}

function copy(txt) {
  navigator.clipboard.writeText(txt).then(function () { status('已复制 ' + txt.length + ' 字符'); }).catch(function () { status('复制失败'); });
}

window.addEventListener('DOMContentLoaded', function () { bindEvents(); boot().catch(function (e) { status('启动失败：' + e.message); console.error(e); }); });
