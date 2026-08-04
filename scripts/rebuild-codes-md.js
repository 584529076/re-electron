// scripts/rebuild-codes-md.js
// 简化版：以 markdown ASCII 树为视觉真值，重新分配 codes.json 中所有代码
// 格式：MM.SSS.SSS.SSS，每级在父节点下从 001 重新计数
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

function cleanTitle(s) {
    if (!s) return '';
    let t = String(s)
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '')
        .replace(/[️]/g, '')
        .trim();
    // 去掉 'undefined[wr]+ ' 前缀（历史 brackets 错位污染）
    t = t.replace(/^undefined[wrs]+\s+/i, '').trim();
    return t;
}

// 解析单行 → {depth, title, bracketCode}（depth 通过前导 4-char nest 单元数）
function parseLine(line) {
    let i = 0, depth = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '│') i++; else break;
        if (i % 4 === 0) depth++;
    }
    if (i >= line.length) return null;
    if (line[i] !== '├' && line[i] !== '└') return null;
    i++;
    if (line[i] !== '─' || line[i+1] !== '─') return null;
    i += 2;
    if (line[i] !== ' ') return null;
    i++;
    const rest = line.substring(i);
    const bracketMatch = rest.match(/\[([^\]]+)\]\s*$/);
    if (!bracketMatch) return null;
    const beforeBracket = rest.substring(0, rest.length - bracketMatch[0].length).trimEnd();
    const visualMatch = beforeBracket.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
    const title = cleanTitle(visualMatch ? visualMatch[2] : beforeBracket);
    if (!title) return null;
    return { depth, title, bracketCode: bracketMatch[1] };
}

function parseMdTree(mdText) {
    const nodes = [];
    for (const line of mdText.split('\n')) {
        const n = parseLine(line);
        if (n) nodes.push(n);
    }
    // 给每个 node 唯一 idx + 父 idx（栈式）
    const stack = [];
    for (let idx = 0; idx < nodes.length; idx++) {
        const n = nodes[idx];
        n.idx = idx;
        while (stack.length > n.depth) stack.pop();
        if (n.depth > 0 && stack.length >= n.depth) {
            n.parentIdx = stack[n.depth - 1];
        } else {
            n.parentIdx = null;
        }
        stack[n.depth] = idx;
    }
    return nodes;
}

function main() {
    console.log('▶ rebuild-codes-md');
    const md = fs.readFileSync(MD_PATH, 'utf8');
    const cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  md chars:', md.length, '| cats:', cats.length);

    const mdNodes = parseMdTree(md);
    console.log('  md nodes:', mdNodes.length);

    // 1. 模块根 (depth=0)：md 中按顺序排列（00 → 14），用位置定 mc
    //    历史 brackets 错位污染了标题（'undefinedr 01-场景主题'），需从 title 推断 mc
    function mcFromText(title) {
        const t = String(title || '').replace(/^undefined[wrs]+\s*/i, '');
        const m = t.match(/^(\d{2})\s*[-—]/);
        return m ? m[1] : null;
    }
    const roots = mdNodes.filter(n => n.depth === 0);
    roots.forEach((r, idx) => {
        r.mc = mcFromText(r.title) || String(idx).padStart(2, '0');
    });
    roots.sort((a, b) => Number(a.mc) - Number(b.mc));
    console.log('  modules:', roots.length, '→', roots.map(r => r.mc).join(','));

    // 2. DFS 给每个 node 分配 code
    const codesByIdx = new Map();
    roots.forEach((root) => {
        const modIdx = Number(root.mc);
        codesByIdx.set(root.idx, { code: pad4([String(modIdx)]), parentIdx: null });
    });
    function walk(parent) {
        const pE = codesByIdx.get(parent.idx);
        if (!pE) return;
        const kids = mdNodes.filter(n => n.parentIdx === parent.idx);
        kids.forEach((k, i) => {
            const ps = pE.code.split('.');
            const parts = [ps[0]];
            for (let l = 1; l < 4; l++) {
                parts.push(l === parent.depth + 1 ? String(i + 1).padStart(3, '0') : ps[l]);
            }
            const nc = pad4(parts);
            codesByIdx.set(k.idx, { code: nc, parentIdx: parent.idx });
            walk(k);
        });
    }
    roots.forEach(r => walk(r));

    // 3. 验证 md 内唯一性
    const cc = new Map();
    for (const v of codesByIdx.values()) cc.set(v.code, (cc.get(v.code) || 0) + 1);
    console.log('  md 唯一性冲突:', [...cc.entries()].filter(([k, v]) => v > 1).length);

    // 4. 用 md 真值匹配到 JSON（按 title）
    //    注意：标题可能在多模块重复，所以需要把 module 上下文传过去
    //    但简单起见：先用 (title) 当 key 匹配，匹配到的第一个 JSON 算
    //    进一步：通过 module_code 字段反推根：先看哪个 root 的 bracketCode 显示了 module_code
    //    最稳：JSON entry 本身有 module_code，直接用它和 md node 的 mc 比对

    // 给每个非根 md node 找 module_code：
    //   - markdown 结构是所有内容挂在 module 00 根下（depth=0 节点只有 1 个为视觉真根）
    //   - 真实 module 通过 bracketCode 的 MM 段识别
    function mcFromBracket(bracketCode) {
        if (!bracketCode) return null;
        const stripped = String(bracketCode).replace(/[_][wr]+$/, '');
        const m = stripped.match(/^(\d{2})/);
        return m ? m[1] : null;
    }
    for (const n of mdNodes) {
        if (n.mc) continue;  // 已设置（root）
        const mc = mcFromBracket(n.bracketCode);
        if (mc) n.mc = mc;
    }

    // 5. JSON 按 (module_code, cleanTitle) 索引
    const catsByMT = new Map();
    for (const c of cats) {
        const mc = String(c.module_code || '').padStart(2, '0');
        const k = mc + '|' + cleanTitle(c.title);
        if (!catsByMT.has(k)) catsByMT.set(k, []);
        catsByMT.get(k).push(c);
    }

    // 6. 应用：把 md 真值的 code 写到匹配 JSON entry
    //    并去重（同一 JSON (mc, title) 多条 → 保留首条）
    let matched = 0, updated = 0, droppedDup = 0;
    const usedCodes = new Set();
    const finalCats = [];
    const orphans = [];
    const seenFromMd = new Set();
    const cursorByMT = new Map();  // 每个 (mc,title) 的 cursor，按 md 节点顺序逐个分配

    for (const n of mdNodes) {
        const e = codesByIdx.get(n.idx);
        if (!e || !n.mc) continue;
        const k = n.mc + '|' + n.title;
        const cs = catsByMT.get(k) || [];
        const cur = cursorByMT.get(k) || 0;
        if (cur >= cs.length) { droppedDup++; continue; }  // 没有剩余 JSON 条目
        cursorByMT.set(k, cur + 1);
        const c = cs[cur];
        matched++;
        const newCode = e.code;
        const newParentCode = n.parentIdx != null
            ? (codesByIdx.get(n.parentIdx)?.code || null)
            : null;
        c.code = newCode;
        c.parent_code = newParentCode;
        c.level = n.depth + 1;
        usedCodes.add(newCode);
        finalCats.push(c);
        seenFromMd.add(c);
        updated++;
    }

    // 7. JSON 中不在 md 视觉树里的 entries（wrappers / TOCs / 已被视觉移除的内容）→ 删除
    for (const c of cats) {
        if (!seenFromMd.has(c)) orphans.push(c);
    }
    console.log('  matched JSON:', matched, '| updated:', updated, '| dropped dup:', droppedDup);
    console.log('  orphans (removed):', orphans.length);

    // 8. 验证最终唯一性
    const finalCc = new Map();
    for (const c of finalCats) finalCc.set(c.code, (finalCc.get(c.code) || 0) + 1);
    const finalDups = [...finalCc.entries()].filter(([k, v]) => v > 1);
    console.log('  最终 code 重复:', finalDups.length);

    // 9. 写回（只保留 finalCats，删除 orphans）
    fs.writeFileSync(CATS_PATH, JSON.stringify(finalCats, null, 2), 'utf8');

    // stats
    const lvlS = {};
    for (const c of finalCats) lvlS[c.level] = (lvlS[c.level] || 0) + 1;
    console.log('');
    console.log('✓ 完成');
    console.log('  总条数:', finalCats.length);
    console.log('  Level 分布:', JSON.stringify(lvlS));
    console.log('  移除 (md 视觉树外):', orphans.length);

    // 顶层预览
    console.log('');
    console.log('=== 顶层 modules ===');
    for (let i = 0; i < roots.length; i++) {
        const r = roots[i];
        const ent = codesByIdx.get(r.idx);
        console.log('  ' + ent.code + ' | ' + r.title);
    }

    // 抽样验证：'场景篇' 的层级归属
    console.log('');
    console.log('=== 抽样验证 ===');
    const samples = ['场景篇', '主题角色篇', '🏞️ 场景词库', '范例 C01', '范例 H01'];
    for (const t of samples) {
        const found = finalCats.filter(c => cleanTitle(c.title).includes(t));
        for (const c of found.slice(0, 2)) console.log('  [' + c.code + '] parent=' + c.parent_code + ' | ' + c.title.substring(0, 50));
    }
}

main();
