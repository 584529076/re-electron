// scripts/rebuild-codes-final.js
// 一次性、按视觉层级重建 codes.json 中所有条目的 code + parent_code
// 格式：MM.SSS.SSS.SSS（4 段），每级在父节点下从 001 重新计数
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

// 剥 _w / _r 及其累计复合（_wr_w, _rr 等）
function stripSuffix(s) {
    let x = String(s);
    while (/[_][wr]+$/.test(x)) x = x.slice(0, x.lastIndexOf('_'));
    return x;
}

function pad4(parts) {
    // parts[0] = module (int), parts[1..3] = per-level (int)
    // 缺位补 000
    const out = [];
    out.push(String(Number(parts[0])).padStart(2, '0'));
    for (let i = 1; i < 4; i++) {
        out.push(i < parts.length
            ? String(Number(parts[i])).padStart(3, '0')
            : '000');
    }
    return out.join('.');
}

// wrapper 检测（启发式）
function isWrapperLike(t) {
    if (!t) return true;
    const s = String(t);
    if (/（情色向）|（专项）|（专项词库）|提示词库|^[\w ]+词库|（核心模块|（v\d+\.\d+）/i.test(s)) return true;
    if (/索引|目录|快速定位|快查|速查|^\s*═{3,}|─{3,}|^═/i.test(s)) return true;
    if (/\.md\s*[—–-]/.test(s)) return true;
    if (/^第[一二三四五六七八九十百零\d]+(部分|章|节)?$/.test(s)) return true;
    if (/^PART\s*[IVX\d]*$/i.test(s)) return true;
    if (/一、/.test(s) && s.length < 12) return true; // "一、穿着原则" 等短标题
    return false;
}

function main() {
    console.log('▶ rebuild-codes-final');
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  原始条数:', cats.length);

    // ====== 阶段 0：预清环 & 把模块根 parent_code 强制设为 null ======
    let cyclesBroken = 0;
    {
        const byCode = new Map();
        for (const c of cats) byCode.set(c.code, c);
        // 先把所有模块根 parent_code 设为 null
        for (const c of cats.filter(x => x.level === 1)) {
            if (c.parent_code !== null) { c.parent_code = null; cyclesBroken++; }
        }
        // 再逐个修非根条目，限制最大跟踪深度防止无限循环
        const fixed = new Set();
        for (const c of cats) {
            if (c.level === 1) continue;
            const seen = new Set();
            let cur = c;
            let depth = 0;
            while (cur && cur.parent_code && depth < 50) {
                if (seen.has(cur.code)) {
                    // 自环：把当前条目的 parent_code 重置为 module root
                    const mc = String(c.module_code || '').padStart(2, '0');
                    const modRoot = cats.find(x => x.level === 1 && x.module_code === mc);
                    c.parent_code = modRoot ? modRoot.code : null;
                    cyclesBroken++;
                    break;
                }
                seen.add(cur.code);
                cur = byCode.get(cur.parent_code);
                depth++;
            }
        }
    }
    console.log('  预清（断环/根 parent）:', cyclesBroken);

    // ====== 阶段 1：用 module_code 锚定所有模块根 ======
    // 把 14 个模块按 module_code 升序，固定模块编号 00..13
    const byModuleCode = new Map();
    for (const c of cats) {
        const mc = String(c.module_code || '').padStart(2, '0');
        if (!byModuleCode.has(mc)) byModuleCode.set(mc, []);
        byModuleCode.get(mc).push(c);
    }
    const moduleCodes = [...byModuleCode.keys()].sort();
    console.log('  模块数:', moduleCodes.length, '→', moduleCodes.join(','));

    // 每个模块创建一个 module root（保留原 entry 的元数据，只重置 code）
    // 找 level=1 的 entry；缺失则用该模块第一条的副本
    const moduleRoots = new Map();
    for (const mc of moduleCodes) {
        const entries = byModuleCode.get(mc);
        const existing = entries.find(e => e.level === 1);
        if (existing) {
            moduleRoots.set(mc, existing);
        } else {
            // 兜底：克隆第一条
            const root = { ...entries[0], level: 1, code: mc, parent_code: null };
            cats.push(root);
            moduleRoots.set(mc, root);
        }
        // 强制：模块根 parent_code = null
        const r = moduleRoots.get(mc);
        r.parent_code = null;
    }

    // ====== 阶段 2：剥所有 _w / _r 后缀 ======
    let strippedTotal = 0;
    for (const c of cats) {
        const oc = c.code, op = c.parent_code;
        c.code = stripSuffix(c.code);
        if (c.parent_code) c.parent_code = stripSuffix(c.parent_code);
        if (c.code !== oc) strippedTotal++;
    }
    console.log('  剥后缀条目:', strippedTotal);

    // ====== 阶段 3：处理剥后缀导致 code 重复 ======
    // 启发式：同一 code 的多条目中，wrapper 那个给个独立 code，其他保留
    let collisionResolved = 0;
    {
        const groups = new Map();
        for (const c of cats) {
            if (!groups.has(c.code)) groups.set(c.code, []);
            groups.get(c.code).push(c);
        }
        for (const [code, group] of groups) {
            if (group.length < 2) continue;
            // 按 level 升序：L1 优先
            group.sort((a, b) => (a.level || 99) - (b.level || 99));
            // 第一个非 wrapper 优先；否则第一个
            const primary = group.find(e => !isWrapperLike(e.title)) || group[0];
            for (const dup of group) {
                if (dup === primary) continue;
                // 改 dup 的 code 避免冲突：保留旧值末段加 _z
                dup.code = code + '_z' + (++collisionResolved);
            }
        }
    }
    console.log('  冲突化解:', collisionResolved);

    // ====== 阶段 4：修补 orphan parent_code ======
    // 规则：parent_code 不存在于 codeSet → 找最近的 module root（按 module_code）
    let orphanFixed = 0;
    const codeSet = new Set(cats.map(c => c.code));
    for (const c of cats) {
        if (!c.parent_code) continue;
        if (codeSet.has(c.parent_code)) continue;
        const mc = String(c.module_code || '').padStart(2, '0');
        const root = moduleRoots.get(mc);
        c.parent_code = root ? root.code : null;
        orphanFixed++;
    }
    console.log('  孤儿 parent 修补:', orphanFixed);

    // ====== 阶段 5：构树，按视觉层级走 ======
    const childrenOf = new Map();
    for (const c of cats) {
        const k = c.parent_code || '__ROOT__';
        if (!childrenOf.has(k)) childrenOf.set(k, []);
        childrenOf.get(k).push(c);
    }
    // 子节点稳定排序：
    //   - 优先按 level 升序
    //   - 同 level 按现 code 字典序（保留下原始视觉顺序的痕迹）
    for (const arr of childrenOf.values()) {
        arr.sort((a, b) => (a.level || 99) - (b.level || 99) || String(a.code).localeCompare(String(b.code)));
    }

    // ====== 阶段 6：DFS 按用户格式分配新 code ======
    const codeRemap = new Map(); // oldCode → newCode
    moduleCodes.forEach((mc, idx) => {
        const modNum = String(idx).padStart(2, '0');
        const root = moduleRoots.get(mc);
        const newRootCode = pad4([modNum]);  // MM.000.000.000
        codeRemap.set(root.code, newRootCode);

        (function walk(oldParentCode, prefixParts) {
            const kids = childrenOf.get(oldParentCode) || [];
            kids.forEach((k, i) => {
                const newParts = [...prefixParts, String(i + 1).padStart(3, '0')];
                const newCode = pad4(newParts);
                codeRemap.set(k.code, newCode);
                walk(k.code, newParts);
            });
        })(root.code, [modNum]);
    });

    // ====== 阶段 7：应用 remap ======
    let applied = 0;
    const newRootCodes = new Set([...codeRemap.values()].filter(v => /^\d{2}\.000\.000\.000$/.test(v)));
    for (const c of cats) {
        if (!codeRemap.has(c.code)) {
            // 不在树中（孤儿），保持原 code 不动
            continue;
        }
        const oldParent = c.parent_code;
        const newCode = codeRemap.get(c.code);
        c.code = newCode;
        if (newRootCodes.has(newCode)) {
            // 模块根：parent 必须为 null（避免自环）
            c.parent_code = null;
        } else if (oldParent && codeRemap.has(oldParent)) {
            c.parent_code = codeRemap.get(oldParent);
        } else {
            // parent 不在 remap（被冲突化解或孤儿），链路到 module root
            const mc = String(c.module_code || '').padStart(2, '0');
            const root = moduleRoots.get(mc);
            c.parent_code = root ? root.code : null;
        }
        applied++;
    }
    console.log('  应用新 code:', applied);

    // ====== 阶段 7b：处理 level=5（4 段格式截断） ======
    // 当前格式只支持 4 段（MM.SSS.SSS.SSS）。
    // L5 残留：37 个完全孤儿（不在 markdown 视觉树里）→ 删除
    //         34 个其实在视觉树里但 level 标错 → 把 level 降为 4（L4 视觉位置）
    // 检测方式：code 段数 > 4 → 删除；level > 4 但 code 段数 ≤ 4 → 改 level
    const toRemove = new Set();
    const toLevelDown = [];
    for (const c of cats) {
        const segs = String(c.code).split('.').length;
        if (segs > 4) {
            toRemove.add(c.code);
        } else if (c.level > 4) {
            toLevelDown.push(c);
        }
    }
    let removed = 0;
    const newCats = [];
    for (const c of cats) {
        if (toRemove.has(c.code)) { removed++; continue; }
        if (c.level > 4) c.level = 4;
        newCats.push(c);
    }
    cats = newCats;
    console.log('  L5 移除（段数 >4）:', removed);
    console.log('  L5 改 level→4:', toLevelDown.length);

    // ====== 阶段 7c：处理orphan（parent_code=null 非根） ======
    // 检查已知清理列表（提取自 extract-categories-to-md.js 的 toRemove2 区块）：
    // - 07 / 13 模块的 toRemove 列表 → 直接删
    // - 11.001.041.047「随机瑕疵生成规则」（meta 规则描述）→ 删
    // - 12.001.002.003「图案速查」（速查 wrapper）→ 删
    // 其他（06 / 10 等的 real 类别条目）→ 重新挂到模块根
    const metaOrphansToRemove = new Set([
        // module 07 cleanup
        '07.001.014.015', '07.001.014.025', '07.001.014.026',
        '07.001.027.033', '07.001.042.049',
        // module 13 cleanup
        '13.001.003.004', '13.001.003.005', '13.001.003.006', '13.001.003.007',
        // other meta
        '11.001.041.047',
        '12.001.002.003',
        '10.019.033'  // 负面提示（饰品相关），元规则
    ]);

    let metaRemoved = 0;
    let reLinked = 0;
    cats = cats.filter(c => {
        if (c.parent_code === null && c.level !== 1) {
            if (metaOrphansToRemove.has(c.code)) {
                metaRemoved++;
                return false;
            }
            // 重新挂到所属模块根
            const mc = String(c.module_code || '').padStart(2, '0');
            const root = moduleRoots.get(mc);
            if (root) {
                c.parent_code = root.code;
                reLinked++;
            }
            return true;
        }
        return true;
    });
    console.log('  Orphan meta 移除:', metaRemoved);
    console.log('  Orphan 重新挂模块根:', reLinked);

    // ====== 阶段 8：写回 ======
    fs.writeFileSync(CATS_PATH, JSON.stringify(cats, null, 2), 'utf8');

    // ====== 验证 ======
    const finalCounts = new Map();
    for (const c of cats) finalCounts.set(c.code, (finalCounts.get(c.code) || 0) + 1);
    const dups = [...finalCounts.entries()].filter(([k, v]) => v > 1);
    const stillWrappers = cats.filter(c => /_w|_r|_z/.test(c.code)).length;
    const lvlStats = {};
    for (const c of cats) lvlStats[c.level] = (lvlStats[c.level] || 0) + 1;

    console.log('');
    console.log('✓ 完成');
    console.log('  总条数:', cats.length);
    console.log('  Level 分布:', JSON.stringify(lvlStats));
    console.log('  重复 code:', dups.length);
    console.log('  仍带 _w/_r/_z:', stillWrappers);
    if (dups.length) {
        console.log('  剩余冲突（前 8）:');
        for (const [k] of dups.slice(0, 8)) {
            const es = cats.filter(c => c.code === k);
            for (const e of es) console.log('    [' + k + '] L' + e.level + ' | ' + e.title.substring(0, 50));
        }
    }
}

main();
