// scripts/rebuild-codes-bracket.js
// 以 markdown bracket code 作为层级真值（不是视觉缩进）
// 格式：MM.SSS.SSS.SSS 严格 4 段
// - module 01-14 的 corrupted 根行（[undefinedr...]）跳过
// - 5 段 bracket 跳过（格式塞不下）
// - 缺失的中间层（某 MM.SSS 存在但其父 MM 不存在）→ 合成占位父
// - 同 base bracket 冲突（_w / _rr 后缀）→ LATER 用 L4 补位
'use strict';

const fs = require('fs');
const path = require('path');

const MD_PATH = 'D:\\nsfw-prompt-templates-asian解析文件\\01-完整分类树-ASCII.md';
const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function pad4(parts) {
    const out = [String(Number(parts[0])).padStart(2, '0')];
    for (let i = 1; i < 4; i++) {
        out.push(i < parts.length ? String(Number(parts[i])).padStart(3, '0') : '000');
    }
    return out.join('.');
}

function bracketToCode(baseBracket) {
    return pad4(baseBracket.split('.'));
}

function parentBracket(baseBracket) {
    const segs = baseBracket.split('.');
    return segs.length > 1 ? segs.slice(0, -1).join('.') : null;
}

function cleanTitle(s) {
    if (!s) return '';
    let t = String(s)
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '')
        .replace(/[\uFE0F]/g, '')
        .trim();
    // 去掉 'undefined[wr]+ ' 前缀（含 'undefinedrrrr.1 ' 这种带数字点的）
    t = t.replace(/^undefined[wrs]+(\.\d+)?\s+/i, '').trim();
    return t;
}

function stripSuffix(code) {
    return String(code).replace(/[_][wrx]+$/, '');
}

function parseLine(line) {
    let i = 0, depth = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '\u2502') i++; else break;
        if (i % 4 === 0) depth++;
    }
    if (i >= line.length) return null;
    if (line[i] !== '\u251C' && line[i] !== '\u2514') return null;
    i++;
    if (line[i] !== '\u2500' || line[i+1] !== '\u2500') return null;
    i += 2;
    if (line[i] !== ' ') return null;
    i++;
    const rest = line.substring(i);
    const bracketMatch = rest.match(/\[([^\]]+)\]\s*$/);
    if (!bracketMatch) return null;
    const fullBracket = bracketMatch[1];
    if (/^undefined/.test(fullBracket)) return null;  // skip corrupted module roots
    const baseBracket = stripSuffix(fullBracket);
    if (baseBracket.split('.').length > 4) return null;  // skip 5-segment
    const beforeBracket = rest.substring(0, rest.length - bracketMatch[0].length).trimEnd();
    const visualMatch = beforeBracket.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
    const title = cleanTitle(visualMatch ? visualMatch[2] : beforeBracket);
    if (!title) return null;
    return { depth, title, fullBracket, baseBracket };
}

function main() {
    console.log('▶ rebuild-codes-bracket');
    const md = fs.readFileSync(MD_PATH, 'utf8');
    const cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  cats before:', cats.length);

    // 1. 解析 markdown
    const mdNodes = [];
    for (const line of md.split('\n')) {
        const n = parseLine(line);
        if (n) mdNodes.push(n);
    }
    // 合成 modules 01-14 的根（它们的 markdown 行被 corrupted bracket 过滤掉了）
    const MODULE_NAMES = {
        '01': '01-场景主题',
        '02': '02-景别构图',
        '03': '03-裸露液体',
        '04': '04-服装专项',
        '05': '05-光影氛围',
        '06': '06-姿势动作',
        '07': '07-表情眼神',
        '08': '08-风格胶片',
        '09': '09-妆容专项',
        '10': '10-发型饰品',
        '11': '11-瑕疵细节',
        '12': '12-纹身标记',
        '13': '13-道具宠物',
        '14': '14-人格卡片'
    };
    // 检查哪些 module 根真正被解析（baseBracket 必须是单段 'MM'）
    const existingMod = new Set(mdNodes.filter(n => n.baseBracket.split('.').length === 1 && /^\d{2}$/.test(n.baseBracket)).map(n => n.baseBracket));
    for (let m = 1; m <= 14; m++) {
        const mc = String(m).padStart(2, '0');
        if (!existingMod.has(mc)) {
            mdNodes.push({
                depth: 0,
                title: MODULE_NAMES[mc],
                fullBracket: mc,
                baseBracket: mc,
                isSynth: true
            });
        }
    }
    console.log('  md nodes (incl synth module roots):', mdNodes.length);

    // 2. 给每个 md node 分配 code：直接由 bracket 转 4 段
    //    同 base 冲突时（_w / _rr 后缀）：LATER 用同一 base 的下一个 L4 位置
    const baseCount = new Map();  // base → 已分配的 L4 计数器
    const usedCodes = new Set();
    const mdCode = new Map();  // md node idx → { code, parentCode, level }
    const mdByBase = new Map();  // base → first idx (canonical)
    const collisions = [];  // [laterIdx, canonicalIdx, base]

    for (let i = 0; i < mdNodes.length; i++) {
        const n = mdNodes[i];
        const base = n.baseBracket;
        let code, level, parentCode;
        if (base.split('.').length === 1) {
            // module root
            code = pad4([base]);
            parentCode = null;
            level = 1;
        } else {
            if (!mdByBase.has(base)) {
                // canonical first occurrence
                code = bracketToCode(base);
                parentCode = bracketToCode(parentBracket(base));
                level = base.split('.').length;
                mdByBase.set(base, i);
                baseCount.set(base, 1);
            } else {
                // collision: assign next L4 under canonical's code
                const canonicalCode = mdCode.get(mdByBase.get(base)).code;
                const cnt = baseCount.get(base);
                code = canonicalCode.slice(0, -3) + String(cnt).padStart(3, '0');
                parentCode = canonicalCode;
                level = 4;
                baseCount.set(base, cnt + 1);
                collisions.push({ laterIdx: i, base });
            }
        }
        mdCode.set(i, { code, parentCode, level });
        usedCodes.add(code);
    }
    console.log('  base bracket collisions resolved:', collisions.length);

    // 3. 验证 md 唯一性
    const dupCheck = new Map();
    for (const v of mdCode.values()) dupCheck.set(v.code, (dupCheck.get(v.code) || 0) + 1);
    const dups = [...dupCheck.entries()].filter(([k, v]) => v > 1);
    console.log('  md code 重复:', dups.length);
    if (dups.length) for (const [k] of dups.slice(0, 5)) console.log('    [' + k + ']');

    // 4. 合成缺失的中间层 parent（如果某个 baseBracket 的 parentBracket 不在 mdByBase）
    //    合成节点不入 JSON（仅用于 parent_code 验证），用 'isSynth' 标记
    const allCodeToNode = new Map();  // code → md node idx (or synth idx)
    for (let i = 0; i < mdNodes.length; i++) allCodeToNode.set(mdCode.get(i).code, i);
    let synthCount = 0;
    for (let i = 0; i < mdNodes.length; i++) {
        const n = mdNodes[i];
        const segs = n.baseBracket.split('.');
        for (let s = 1; s < segs.length; s++) {
            const midBase = segs.slice(0, s).join('.');
            if (!mdByBase.has(midBase)) {
                // 合成中间层
                const midCode = bracketToCode(midBase);
                if (!allCodeToNode.has(midCode)) {
                    allCodeToNode.set(midCode, `synth_${synthCount++}`);
                }
                mdByBase.set(midBase, `synth_${synthCount - 1}`);
            }
        }
    }
    console.log('  synth intermediate parents:', synthCount);

    // 5. JSON 匹配：按 (module_code, cleanTitle) 索引
    const catsByMT = new Map();
    for (const c of cats) {
        const mc = String(c.module_code || '').padStart(2, '0');
        const k = mc + '|' + cleanTitle(c.title);
        if (!catsByMT.has(k)) catsByMT.set(k, []);
        catsByMT.get(k).push(c);
    }

    // 6. 应用：每个 md node 找一个 JSON entry；多 md node 共享 (mc, title) → 顺序分配
    const cursorByMT = new Map();
    const usedJsonIds = new Set();
    const finalCats = [];
    const matchedSet = new Set();
    let matched = 0, updated = 0, droppedDup = 0, synthAdded = 0;

    // 6a. 先添加 synth 中间层 parent（确保所有 parent_code 引用都存在）
    const allCodesInFinal = new Set();
    // 先把模块根加入 allCodesInFinal（避免被重复 synth）
    for (let i = 0; i < mdNodes.length; i++) {
        if (mdNodes[i].baseBracket.split('.').length === 1) {
            allCodesInFinal.add(mdCode.get(i).code);
        }
    }
    for (let i = 0; i < mdNodes.length; i++) {
        const n = mdNodes[i];
        const segs = n.baseBracket.split('.');
        for (let s = 1; s < segs.length; s++) {
            const midBase = segs.slice(0, s).join('.');
            if (!allCodesInFinal.has(bracketToCode(midBase))) {
                // 找这个 midBase 的 md node idx（可能存在也可能不存在）
                const midIdx = mdByBase.get(midBase);
                let midTitle;
                if (midIdx !== undefined && !String(midIdx).startsWith('synth_')) {
                    midTitle = mdNodes[midIdx].title;
                } else {
                    midTitle = `(${midBase})`;  // 合成占位 title
                }
                const mc = String(Number(midBase.split('.')[0])).padStart(2, '0');
                const parentBase = parentBracket(midBase);
                const midEntry = {
                    code: bracketToCode(midBase),
                    parent_code: parentBase ? bracketToCode(parentBase) : null,
                    level: midBase.split('.').length,
                    module_code: mc,
                    title: midTitle,
                    isSynth: true
                };
                finalCats.push(midEntry);
                allCodesInFinal.add(midEntry.code);
                synthAdded++;
            }
        }
        const e = mdCode.get(i);
        allCodesInFinal.add(e.code);
    }

    // 6b. 处理所有 md nodes
    for (let i = 0; i < mdNodes.length; i++) {
        const n = mdNodes[i];
        const e = mdCode.get(i);
        const mc = String(Number(n.baseBracket.split('.')[0])).padStart(2, '0');
        const k = mc + '|' + n.title;
        const cs = catsByMT.get(k) || [];
        const cur = cursorByMT.get(k) || 0;
        let c = null;
        for (let j = cur; j < cs.length; j++) {
            if (!usedJsonIds.has(cs[j])) { c = cs[j]; cursorByMT.set(k, j + 1); break; }
        }
        if (!c) {
            // 没有匹配 JSON entry：synth 模块根直接添加
            if (n.isSynth && e.level === 1) {
                c = {
                    code: e.code,
                    parent_code: null,
                    level: 1,
                    module_code: mc,
                    title: n.title,
                    isSynth: true
                };
                synthAdded++;
            } else {
                droppedDup++;
                continue;
            }
        }
        usedJsonIds.add(c);
        matched++;
        c.code = e.code;
        c.parent_code = e.parentCode;
        c.level = e.level;
        usedCodes.add(e.code);
        finalCats.push(c);
        matchedSet.add(c);
        updated++;
    }

    // 7. 不在 md 树里的 → orphan（删除）
    const orphans = cats.filter(c => !matchedSet.has(c));
    console.log('  matched JSON:', matched, '| updated:', updated, '| dropped dup:', droppedDup);
    console.log('  orphans (removed):', orphans.length);

    // 8. 最终唯一性验证
    const finalCc = new Map();
    for (const c of finalCats) finalCc.set(c.code, (finalCc.get(c.code) || 0) + 1);
    const finalDups = [...finalCc.entries()].filter(([k, v]) => v > 1);
    console.log('  最终 code 重复:', finalDups.length);

    // 9. 写回
    fs.writeFileSync(CATS_PATH, JSON.stringify(finalCats, null, 2), 'utf8');

    const lvlS = {};
    for (const c of finalCats) lvlS[c.level] = (lvlS[c.level] || 0) + 1;
    console.log('');
    console.log('✓ 完成');
    console.log('  总条数:', finalCats.length);
    console.log('  Level 分布:', JSON.stringify(lvlS));
    console.log('  移除 (md 视觉树外):', orphans.length);

    // module root summary
    const moduleChildren = new Map();
    for (const c of finalCats) {
        if (c.parent_code) moduleChildren.set(c.parent_code, (moduleChildren.get(c.parent_code) || 0) + 1);
    }
    console.log('');
    console.log('=== Module roots (L1) ===');
    const roots = finalCats.filter(x => x.level === 1).sort((a, b) => Number(a.module_code) - Number(b.module_code));
    for (const r of roots) {
        const cnt = moduleChildren.get(r.code) || 0;
        console.log('  [' + r.code + '] mc=' + r.module_code + ' children=' + cnt + ' | ' + r.title.substring(0, 40));
    }
}

main();