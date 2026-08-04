// scripts/rebuild-from-md.js
// 一次性：以 markdown ASCII 树为视觉真值，重建 categories.json 的层级 + codes
// 格式：MM.SSS.SSS.SSS（4 段，缺位补 000）
'use strict';

const fs = require('fs');
const path = require('path');

const MD_PATH = 'D:\\nsfw-prompt-templates-asian解析文件\\01-完整分类树-ASCII.md';
const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function pad4(parts) {
    const out = [String(Number(parts[0])).padStart(2, '0')];
    for (let i = 1; i < 4; i++) {
        out.push(i < parts.length
            ? String(Number(parts[i])).padStart(3, '0')
            : '000');
    }
    return out.join('.');
}

function cleanTitle(s) {
    if (!s) return '';
    let t = String(s)
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '')
        .replace(/[️]/g, '')
        .trim();
    // 去掉 'undefined[wr]+ ' 前缀（brackets 错位后留下的）
    t = t.replace(/^undefined[wrs]+[:\s]*/i, '').trim();
    return t;
}

function parseLine(line) {
    let i = 0;
    let depth = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === ' ' || ch === '│') {
            i++;
        } else break;
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
    const bracketCode = bracketMatch[1];
    const beforeBracket = rest.substring(0, rest.length - bracketMatch[0].length).trimEnd();
    const visualMatch = beforeBracket.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
    let visualPos = '', title;
    if (visualMatch) {
        visualPos = visualMatch[1];
        title = cleanTitle(visualMatch[2]);
    } else {
        title = cleanTitle(beforeBracket);
    }
    if (!title) return null;
    return { depth, visualPos, title, bracketCode };
}

function parseMdTree(mdText) {
    const lines = mdText.split('\n');
    const nodes = [];
    for (const line of lines) {
        const n = parseLine(line);
        if (n) nodes.push(n);
    }
    const stack = [];  // stack[depth] = node index
    for (let idx = 0; idx < nodes.length; idx++) {
        const n = nodes[idx];
        n.idx = idx;
        while (stack.length > n.depth) stack.pop();
        if (n.depth > 0 && stack.length >= n.depth) {
            n.parentIdx = stack[n.depth - 1];
            n.parentTitle = nodes[stack[n.depth - 1]].title;
        } else {
            n.parentIdx = null;
            n.parentTitle = null;
        }
        stack[n.depth] = idx;
    }
    return nodes;
}

function main() {
    console.log('▶ rebuild-from-md');
    const md = fs.readFileSync(MD_PATH, 'utf8');
    const cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  JSON 条目:', cats.length);

    // 1. 解析 markdown
    const mdNodes = parseMdTree(md);
    console.log('  md 节点:', mdNodes.length);

    // 2. 找模块根
    const modRoots = mdNodes.filter(n => n.depth === 0);
    console.log('  模块根:', modRoots.length);

    // 3. 推断每个 md node 的 module_code：先建立 root title → module_code 映射
    //    root title 可能被污染（"undefinedr 01-场景主题"），用 cleaning 后提取前 2 位数字
    function extractModFromTitle(t) {
        const m = String(t).match(/(\d{2})\s*[-—]/);
        return m ? m[1] : null;
    }
    const rootMcByTitle = new Map();
    for (const r of modRoots) {
        const mc = extractModFromTitle(r.title);
        if (mc) rootMcByTitle.set(r.title, mc);
    }
    console.log('  root mc 映射:', rootMcByTitle.size, '个');

    // 给每个 node 加 mc：通过 parentTitle 链找到 root
    function findRootTitle(nodeTitle) {
        const node = mdNodes.find(n => n.title === nodeTitle);
        if (!node) return null;
        if (node.depth === 0) return node.title;
        return findRootTitle(node.parentTitle);
    }
    for (const n of mdNodes) {
        const rootT = findRootTitle(n.title);
        n.mc = rootT ? rootMcByTitle.get(rootT) : null;
    }

    // 4. 给模块根排序 + 分配 codes（用 idx 当唯一 key）
    modRoots.sort((a, b) => Number(rootMcByTitle.get(a.title)) - Number(rootMcByTitle.get(b.title)));

    const nodeByIdx = new Map(mdNodes.map((n, i) => [i, n]));
    const newCodes = new Map();  // idx → { code, parentIdx }
    modRoots.forEach((root, idx) => {
        const modNum = String(idx).padStart(2, '0');
        newCodes.set(root.idx, { code: pad4([modNum]), parentIdx: null });
    });

    function walk(parent) {
        const parentEntry = newCodes.get(parent.idx);
        if (!parentEntry) return;
        const kids = mdNodes.filter(n => n.parentIdx === parent.idx);
        kids.forEach((k, i) => {
            const pSegs = parentEntry.code.split('.');
            const newParts = [pSegs[0]];
            for (let l = 1; l < 4; l++) {
                newParts.push(l === parent.depth + 1
                    ? String(i + 1).padStart(3, '0')
                    : pSegs[l]);
            }
            const nc = pad4(newParts);
            newCodes.set(k.idx, { code: nc, parentIdx: parent.idx });
            walk(k);
        });
    }
    for (const root of modRoots) walk(root);

    // 5. 验证 md 内部唯一性
    const codeCount = new Map();
    for (const v of newCodes.values()) codeCount.set(v.code, (codeCount.get(v.code) || 0) + 1);
    const dups = [...codeCount.entries()].filter(([k, v]) => v > 1);
    console.log('  md 内 code 重复:', dups.length);

    // 6. 把 md 真值的层级反推回 JSON
    //    索引：JSON entry by (module_code, cleanTitle)
    const catsByModTitle = new Map();
    for (const c of cats) {
        const mc = String(c.module_code || '').padStart(2, '0');
        const k = mc + '|' + cleanTitle(c.title);
        if (!catsByModTitle.has(k)) catsByModTitle.set(k, []);
        catsByModTitle.get(k).push(c);
    }

    // 7. 计算每个 md node 的 module_code：通过 parentIdx 链上溯到 root
    for (const n of mdNodes) {
        if (n.mc) continue;  // 已有
        let cur = n;
        const seen = new Set();
        while (cur && cur.depth > 0 && !seen.has(cur.idx)) {
            seen.add(cur.idx);
            cur = mdNodes[cur.parentIdx];
        }
        n.mc = (cur && cur.mc) ? cur.mc : null;
    }

    // 8. 更新 JSON
    let matched = 0;
    let updatedCode = 0;
    let updatedParent = 0;
    const usedCodes = new Set();
    const finalCats = [];
    const orphanCats = [];

    for (const mdNode of mdNodes) {
        const e = newCodes.get(mdNode.idx);
        if (!e) continue;
        const mc = mdNode.mc;
        if (!mc) continue;

        const k = mc + '|' + mdNode.title;
        const candidates = catsByModTitle.get(k) || [];

        for (const c of candidates) {
            c.code = e.code;
            c.level = mdNode.depth + 1;
            if (mdNode.parentIdx != null) {
                const parentMd = mdNodes[mdNode.parentIdx];
                const parentEntry = newCodes.get(parentMd.idx);
                c.parent_code = parentEntry ? parentEntry.code : null;
            } else {
                c.parent_code = null;
            }
            c.__fromMd = true;
            usedCodes.add(c.code);
            finalCats.push(c);
            matched++;
            updatedCode++;
            if (c.parent_code) updatedParent++;
        }
    }

    // 9. 不在 md 树里的（orphan）保留
    for (const c of cats) {
        if (!c.__fromMd) orphanCats.push(c);
    }
    for (const c of finalCats) delete c.__fromMd;

    console.log('  matched entries:', matched);
    console.log('  code 被改:', updatedCode);
    console.log('  parent 被改:', updatedParent);
    console.log('  orphans:', orphanCats.length);

    // 检查冲突
    const codeCountFinal = new Map();
    for (const c of finalCats) codeCountFinal.set(c.code, (codeCountFinal.get(c.code) || 0) + 1);
    const dupsFinal = [...codeCountFinal.entries()].filter(([k, v]) => v > 1);
    if (dupsFinal.length) {
        console.log('  剩余重复:');
        for (const [k] of dupsFinal.slice(0, 8)) {
            const es = finalCats.filter(c => c.code === k);
            for (const e of es) console.log('    [' + k + '] L' + e.level + ' | ' + e.title.substring(0, 50));
        }
    }

    // 写回：合并
    const merged = [...finalCats, ...orphanCats];

    let orphanRenamed = 0;
    for (const c of orphanCats) {
        if (usedCodes.has(c.code)) {
            let alt = c.code + '_x';
            while (usedCodes.has(alt)) alt += 'x';
            c.code = alt;
            orphanRenamed++;
        }
        usedCodes.add(c.code);
    }
    console.log('  orphan code rename:', orphanRenamed);

    fs.writeFileSync(CATS_PATH, JSON.stringify(merged, null, 2), 'utf8');

    const lvlStats = {};
    for (const c of merged) lvlStats[c.level] = (lvlStats[c.level] || 0) + 1;
    console.log('');
    console.log('✓ 完成');
    console.log('  总条数:', merged.length);
    console.log('  Level 分布:', JSON.stringify(lvlStats));
    console.log('  in md:', finalCats.length, 'orphan:', orphanCats.length);
    console.log('  仍带 _w/_r/_x:', merged.filter(c => /_[wrx]/.test(c.code)).length);
}

main();
