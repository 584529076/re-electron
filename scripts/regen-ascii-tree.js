// scripts/regen-ascii-tree.js
// 从 categories.json 重新生成 01-完整分类树-ASCII.md
// 格式：
//   ## MM-模块名
//   ```
//   └── M MM-模块名  [MM.000.000.000]
//       ├── M.X xxx  [MM.SSS.000.000]
//       │   ├── M.X.Y yyy  [MM.SSS.SSS.000]
//       │   └── M.X.Z zzz  [MM.SSS.SSS.000]
//       └── ...
//   ```
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');
const MD_PATH = 'D:\\nsfw-prompt-templates-asian解析文件\\01-完整分类树-ASCII.md';

function cleanTitle(s) {
    if (!s) return '';
    return String(s).trim();
}

function buildTree(entries) {
    // 按 module_code 分组
    const byModule = new Map();
    for (const e of entries) {
        if (!byModule.has(e.module_code)) byModule.set(e.module_code, []);
        byModule.get(e.module_code).push(e);
    }

    const lines = [];
    const moduleCodes = [...byModule.keys()].sort();
    for (const mc of moduleCodes) {
        const ents = byModule.get(mc);
        const root = ents.find(e => e.level === 1);
        if (!root) continue;

        // 模块标题
        lines.push(`## ${root.title}`);
        lines.push('');
        lines.push('```');

        // 树
        const treeLines = [];
        // 根行：固定 '└── ' 前缀
        treeLines.push('└── ' + mcNum(mc) + ' ' + root.title + '  [' + root.code + ']');
        const children = ents.filter(e => e.parent_code === root.code).sort((a, b) => a.code.localeCompare(b.code));
        for (let i = 0; i < children.length; i++) {
            const isLast = i === children.length - 1;
            const childNum = mcNum(mc) + '.' + (i + 1);
            treeLines.push(...buildSubtree(children[i], ents, childNum, 0, isLast, []));
        }
        lines.push(...treeLines);
        lines.push('```');
        lines.push('');
    }

    return lines;
}

function mcNum(mc) {
    // module_code 已经是 '00'..'14' 字符串，直接用
    return String(Number(mc));
}

function buildNodeLine(entry, mc, numPrefix, depth, isLast, ancestorIsLast) {
    const branch = isLast ? '└── ' : '├── ';
    const indent = ancestorIsLast.map(a => a ? '    ' : '│   ').join('');
    const prefix = depth === 0 ? '' : branch;
    const title = cleanTitle(entry.title);
    return indent + prefix + numPrefix + ' ' + title + '  [' + entry.code + ']';
}

function buildSubtree(entry, allEnts, numPrefix, depth, isLast, ancestorIsLast) {
    const out = [];
    // depth 0 = root (handled outside); depth 1 = direct child of root
    // 需要 4 空格缩进（因为根用 '└── '，子项相对根的字符宽度对齐到内容起点）
    const lineDepth = depth + 1;
    const baseIndent = ancestorIsLast.map(a => a ? '    ' : '│   ').join('');
    const childIndent = '    ' + baseIndent;
    const branch = isLast ? '└── ' : '├── ';
    const title = cleanTitle(entry.title);
    out.push(childIndent + branch + numPrefix + ' ' + title + '  [' + entry.code + ']');

    const newAncestorIsLast = [...ancestorIsLast, isLast];
    const kids = allEnts.filter(e => e.parent_code === entry.code).sort((a, b) => a.code.localeCompare(b.code));
    for (let i = 0; i < kids.length; i++) {
        const isLastKid = i === kids.length - 1;
        const childNum = numPrefix + '.' + (i + 1);
        // 递归时 children 的 ancestorIsLast 不变（当前 entry 之前的兄弟连接线由当前 isLast 决定）
        out.push(...buildSubtree(kids[i], allEnts, childNum, depth + 1, isLastKid, newAncestorIsLast));
    }
    return out;
}

function main() {
    console.log('▶ regen-ascii-tree');
    const cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  source cats:', cats.length);

    const lines = buildTree(cats);

    const header = [
        '# NSFW 模板库 — 完整分类树（ASCII）',
        '',
        '> 自动从 categories.json 生成',
        `> 类目总数：${cats.length} | 模块数：${new Set(cats.map(c => c.module_code)).size}`,
        '',
        ''
    ];

    const out = header.concat(lines).join('\n');
    fs.writeFileSync(MD_PATH, out, 'utf8');

    const lineCount = out.split('\n').length;
    console.log('  wrote:', MD_PATH);
    console.log('  lines:', lineCount);
    console.log('✓ 完成');
}

main();