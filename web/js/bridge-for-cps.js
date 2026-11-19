// bridge-for-cps.js — 宿主侧兼容层：hpCPS 模式下替代原 prompt-gen.js 的全局接口
// 目的：让 settings.js / script.js 里对旧提示词模块的调用变成安全空操作，避免报错。
(function () {
    'use strict';

    window.promptGen = {
        open: function () { if (window.workbench) window.workbench.open(); },
        close: function () { if (window.workbench && window.workbench.close) window.workbench.close(); },
        isOpen: function () { return false; },
        refreshOllamaStatus: function () { return Promise.resolve({ ok: false }); }
    };
    window.promptGenEmbedded = {
        openEmbedded: function (host, onChange) {
            // 兼容旧调用：直接打开工作台内嵌 CPS
            if (window.workbench) window.workbench.open();
        },
        liveAssemble: function () { return ''; },
        liveAssembleAndUpdate: function () {}
    };
    window.promptGenOpenConfigModal = function (opts) {
        // CPS 的配置页在嵌入模式下无用；给个友好提示
        if (window.showToast) window.showToast('提示词配置已迁移到「提示词生成器」界面', 'info');
    };
    window.promptGenLiveAssembleAndUpdate = function () {};
})();
