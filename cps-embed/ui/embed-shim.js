/* 嵌入模式桥接：在 file:// iframe 内提供安全的 window.cps 空实现，
 * 屏蔽 ComfyUI/配置/生图/图库/训练能力；数据取自 data-bundle.js 的 window.CPS_DATA。 */
(function () {
  'use strict';

  // 标记嵌入态：CSS 用它隐藏 ComfyUI/图库/训练等无关区域
  try { document.documentElement.classList.add('cps-embed'); } catch (e) {}

  var NOOP_OK = function () { return Promise.resolve({ ok: true }); };
  var NOOP_FAIL = function (msg) { return Promise.resolve({ ok: false, error: msg || 'embed mode' }); };

  window.cps = {
    // 字段库：从打包好的 data-bundle 读取
    readJSON: function (rel) {
      var d = window.CPS_DATA && window.CPS_DATA[rel];
      if (d) return Promise.resolve({ ok: true, data: d });
      return Promise.resolve({ ok: false, error: 'no data: ' + rel });
    },
    writeJSON: NOOP_OK,        // 存档不落盘（内存态仍可用）

    // ComfyUI / 生图相关：全部停用
    comfy: function () { return NOOP_FAIL('嵌入模式不出图'); },
    ping: function () { return NOOP_FAIL(); },
    launch: function () { return NOOP_FAIL(); },
    kill: function () { return NOOP_FAIL(); },
    saveImage: function () { return NOOP_FAIL(); },
    openFolder: function () { return NOOP_OK(); },
    pickControl: function () { return NOOP_FAIL(); },

    // 配置：返回未安装，避免 boot 弹设置（同时 embed 分支已跳过那段）
    configGet: function () { return Promise.resolve({ ok: true, config: { installed: true, res: '', model: '' } }); },
    configSave: NOOP_OK,
    setupCheck: function () { return Promise.resolve({ ok: true, issues: [] }); },
    setupDetect: function () { return Promise.resolve({ ok: false }); },

    // 模型管理 / 训练 / LoRA 管理：给同形状空返回，界面不会崩
    modelsScan: function () { return Promise.resolve({ ok: false, files: [], error: '嵌入模式不可用' }); },
    modelsSave: NOOP_FAIL,
    modelsRemove: NOOP_FAIL,
    trainScan: function () { return Promise.resolve({ ok: false, items: [] }); },
    trainEnv: NOOP_FAIL,
    trainCkpts: function () { return Promise.resolve({ ok: false, list: [] }); },
    trainCaption: function () { return Promise.resolve({ ok: false, items: [] }); },
    trainStatus: function () { return Promise.resolve({ ok: false, outputs: [] }); },
    trainPrepare: NOOP_FAIL,
    trainStart: NOOP_FAIL,
    trainStop: NOOP_FAIL,
    trainLog: function () { return Promise.resolve({ ok: false, text: '' }); },
    trainSets: function () { return Promise.resolve({ ok: true, items: [] }); },
    loraRemove: NOOP_FAIL,
    loraExport: NOOP_FAIL,
    loraRename: NOOP_FAIL

    // 注意：故意不提供 win.* —— bindWinCtl/initWinCtl 会安全 early-return
  };

  // 左上角「关闭提示词生成器」页面按钮（非浮动）：通知宿主返回工作台
  function bindBackBtn() {
    var b = document.getElementById('cpsBackBtn');
    if (!b) return;
    b.addEventListener('click', function () {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'cps:close' }, '*');
        }
      } catch (e) {}
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindBackBtn);
  } else {
    bindBackBtn();
  }
})();
