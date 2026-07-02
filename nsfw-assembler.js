// nsfw-assembler.js — D-30 NSFW 提示词拼装引擎
//
// 输入：用户选中的 tag 列表（按 module 分组） + 14 模块定义
// 输出：完整 150-250 词英文 prompt
//
// 算法：
//   1) 必选 7 项按 order 1-7 填充（缺则按 weight 随机选 1 个）
//   2) 选项目随机选 3-5 个（用户选了的优先；不够则按 weight 补）
//   3) 每词条 .en 拼成一段逗号分隔的英文
//   4) 末尾追加画质强化
//   5) 6 条核心规则自动应用（违反 = 自动修复）
'use strict';

const QUALITY_BOOSTER = ', masterpiece, best quality, 8k, highly detailed, sharp focus';

// 裸露等级枚举（用于规则 4 - 替换 sheer 系列）
const NUDITY_LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];

// 设备 → 推荐画质的映射（用于规则 2 - 设备/画质匹配）
const DEVICE_QUALITY = {
    phone:    null,  // 手机不加 masterpiece / 8K
    amateur:  null,
    compact:  null,
    dslr:     'dslr',
    cinema:   'cinema',
    film:     'film',
};

// ============ 拼装主函数 ============
/**
 * @param {Object} opts
 * @param {Array} opts.modules - 14 模块定义（从 db 来）
 * @param {Map<string, Array>} opts.selectedTagsByModule - 用户选中的 tag（按 module 分组）
 * @param {Map<string, Array>} opts.allTagsByModule - 全量 tag（按 module 分组，用于缺省补全）
 * @param {number} [opts.seed] - 随机种子（不传则用 Math.random）
 * @returns {{ok, text, wordCount, rulesApplied, breakdown}}
 */
function assemble({ modules, selectedTagsByModule, allTagsByModule, seed }) {
    const rand = seed !== undefined ? mulberry32(seed) : Math.random;
    const modulesById = new Map(modules.map(m => [m.id, m]));

    // ---- Step 1: 必选 7 项按 order 排序填充 ----
    const mustHaves = modules
        .filter(m => m.mustHave)
        .sort((a, b) => a.order - b.order);

    const chosen = [];  // 已选 tag 列表
    const breakdown = [];  // 每条来源记录
    const fillForMust = (m) => {
        const userPicked = (selectedTagsByModule.get(m.id) || []).filter(t => t);
        if (userPicked.length > 0) {
            for (const t of userPicked) {
                chosen.push(t);
                breakdown.push({ module: m.id, name: t.name, source: 'user' });
            }
        } else {
            // 没选：随机补 2-3 个（跟 README "2-3 个" 一致）
            const pool = allTagsByModule.get(m.id) || [];
            const num = pool.length > 0 ? Math.min(2 + Math.floor(rand() * 2), pool.length) : 0;
            for (let i = 0; i < num; i++) {
                const picked = pickByWeight(pool.filter(p => !chosen.includes(p)), rand);
                if (picked) {
                    chosen.push(picked);
                    breakdown.push({ module: m.id, name: picked.name, source: 'auto' });
                }
            }
        }
    };
    mustHaves.forEach(fillForMust);

    // ---- Step 2: 选项目随机挑 3-5 个 ----
    const optional = modules.filter(m => m.canSkip);
    const userOptionalPicked = [];
    for (const m of optional) {
        const userPicked = (selectedTagsByModule.get(m.id) || []);
        for (const t of userPicked) userOptionalPicked.push(t);
    }
    const numOptional = userOptionalPicked.length > 0
        ? Math.min(userOptionalPicked.length, 3 + Math.floor(rand() * 3))  // 3-5，或全用（如果选得少）
        : 3 + Math.floor(rand() * 3);  // 3-5
    const sampled = sampleByWeight(userOptionalPicked, numOptional, rand);
    for (const t of sampled) {
        chosen.push(t);
        const m = modulesById.get(t.module);
        breakdown.push({ module: t.module, name: t.name, source: 'user' });
    }

    // ---- Step 3: 拼接英文 ----
    const fragments = chosen.map(t => t.en);
    let text = fragments.join(', ');

    // ---- Step 4: 末尾加画质强化（只在没检测到手机/监控时）----
    const hasAmateurDevice = /\b(iPhone|camera phone|smartphone|webcam|security camera|CCTV)\b/i.test(text);
    if (!hasAmateurDevice) {
        text += QUALITY_BOOSTER;
    }

    // ---- Step 5: 6 条核心规则应用 ----
    const rulesApplied = applyCoreRules(text);

    // ---- Step 6: 不截断（用户明确要求"超长也算"）----
    const wordCount = rulesApplied.text.split(/\s+/).filter(Boolean).length;

    return {
        ok: true,
        text: rulesApplied.text,
        wordCount,
        rulesApplied: rulesApplied.applied,
        breakdown,
    };
}

// ============ 6 条核心规则 ============
function applyCoreRules(text) {
    const applied = [];

    // 规则 1: 必有 nuidty + pose（不强加，因为缺了用户会自己选）
    // 跳过强制添加——用户没选就是没选

    // 规则 2: 设备/画质匹配 — 已在 Step 4 处理

    // 规则 3: 冲突词检测（panties showing + pussy visible → 二选一）
    const hasPantiesShowing = /\bpanties showing\b/i.test(text);
    const hasPussyVisible = /\b(pussy|vagina)\s+visible\b/i.test(text);
    if (hasPantiesShowing && hasPussyVisible) {
        text = text.replace(/panties showing/gi, 'no panties');
        applied.push('R3: panties showing + pussy visible → no panties, pussy visible');
    }

    // 规则 4: 替换 sheer 系列
    const sheerReplacements = [
        { from: /\bsheer\s+([\w]+)/gi, to: 'unbuttoned $1' },
        { from: /\bsee-through\s+([\w]+)/gi, to: 'slipping off $1' },
        { from: /\btransparent\s+([\w]+)/gi, to: 'lifted $1' },
    ];
    for (const { from, to } of sheerReplacements) {
        if (from.test(text)) {
            text = text.replace(from, to);
            applied.push(`R4: 替换 sheer 系列`);
        }
    }

    // 规则 5: 液体词最小量化（"dripping" → "single drop"）
    const liquidDampeners = [
        { from: /\bdripping\s+with\s+(\w+)/gi, to: 'single drop of $1' },
        { from: /\bcovered\s+in\s+(\w+)/gi, to: 'thin streak of $1' },
        { from: /\bsoaked\s+with\s+(\w+)/gi, to: 'faint trace of $1' },
    ];
    for (const { from, to } of liquidDampeners) {
        if (from.test(text)) {
            text = text.replace(from, to);
            applied.push(`R5: 液体词最小量化`);
        }
    }

    // 规则 6: 纹身必带 6 词皮肤融合（如果用户选了 tattoo 但缺融合词）
    if (/\btattoo/i.test(text) && !/integrated into skin|seamless integration|following body contour/i.test(text)) {
        text += ', integrated into skin, seamless integration, following body contour';
        applied.push('R6: 纹身自动追加 6 词皮肤融合');
    }

    return { text, applied };
}

// ============ 工具函数 ============
function pickByWeight(pool, rand) {
    if (pool.length === 0) return null;
    const total = pool.reduce((s, t) => s + (t.weight || 0.5), 0);
    let r = rand() * total;
    for (const t of pool) {
        r -= (t.weight || 0.5);
        if (r <= 0) return t;
    }
    return pool[0];
}

function sampleByWeight(arr, n, rand) {
    if (arr.length <= n) return [...arr];
    // 简单洗牌
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
}

function mulberry32(a) {
    return function() {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = a;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

module.exports = { assemble, applyCoreRules, pickByWeight, sampleByWeight };
