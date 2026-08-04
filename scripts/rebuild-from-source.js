// scripts/rebuild-from-source.js
// 从 D:\nsfw-prompt-templates-asian\ 14 个原始 .md 文件提取所有类目
// 层级来源：markdown 标题 (#/##/###/####) + 表格首列粗体行 (作为子级)
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = 'D:\\nsfw-prompt-templates-asian';
const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function cleanTitle(s) {
    if (!s) return '';
    let t = String(s)
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
        .replace(/^undefined[wrs]+(\.\d+)?\s+/i, '')
        .trim();
    return t;
}

function pad4(parts) {
    const out = [];
    for (let i = 0; i < 4; i++) {
        out.push(i < parts.length ? String(parts[i]).padStart(3, '0') : '000');
    }
    return out.join('.');
}

function stripPunct(s) {
    return String(s || '').replace(/^[\s\-─—•·]+|[\s\-─—]+$/g, '');
}

function isHeaderLine(line) {
    return /^#{1,6}\s+/.test(line);
}

function headerLevel(line) {
    const m = line.match(/^(#{1,6})\s+/);
    return m ? m[1].length : 0;
}

function headerText(line) {
    return stripPunct(line.replace(/^#+\s+/, '').trim());
}

// 从表格行提取粗体首列 (例如 | **卧室私密** | ... |)
function extractTableBoldRows(lines, startLine) {
    const rows = [];
    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('|')) break;
        if (/^\|[\s:|-]+\|$/.test(line)) continue; // 分隔行
        // 提取首个 | 后到下一个 | 之间的内容
        const cells = line.split('|').map(c => c.trim()).filter(c => c.length);
        if (cells.length === 0) continue;
        const first = cells[0].replace(/^\*\*|\*\*$/g, '').trim();
        if (!first) continue;
        // 过滤纯 emoji / 标点
        if (/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\s]+$/u.test(first)) continue;
        rows.push(first);
    }
    return rows;
}

function processFile(filePath, mc, moduleName) {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);

    const cats = [];
    const root = {
        code: `${mc}.000.000.000`,
        parent_code: null,
        level: 1,
        module_code: mc,
        title: moduleName,
        description: ''
    };
    cats.push(root);

    // 父级栈：[(level, code, idx)]  按 level 升序
    const parentStack = [{ level: 1, code: root.code, idx: 0 }];
    const segCounters = { 2: 0, 3: 0, 4: 0, 5: 0 };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (isHeaderLine(line)) {
            const lv = headerLevel(line);
            const txt = headerText(line);

            // 第一个 H1 当成 module 描述（不入库）
            if (lv === 1) {
                i++;
                continue;
            }

            // H2..H5 = L2..L5
            const targetLevel = lv; // header level = category level
            // 计算 segment
            segCounters[targetLevel] = (segCounters[targetLevel] || 0) + 1;
            // 重置更深层 counter
            for (let d = targetLevel + 1; d <= 5; d++) segCounters[d] = 0;

            const seg = segCounters[targetLevel];

            // 找 parent
            while (parentStack.length > 0 && parentStack[parentStack.length - 1].level >= targetLevel) {
                parentStack.pop();
            }
            const parent = parentStack[parentStack.length - 1];

            // 构造 code
            const codeParts = [Number(mc)];
            for (let d = 2; d <= 4; d++) {
                if (d <= targetLevel) codeParts.push(segCounters[d]);
                else codeParts.push(0);
            }
            const code = pad4(codeParts);

            // H2 在 module 下面 → 直接用 module_code 作 parent_code
            const parentCode = parent ? parent.code : root.code;

            const cat = {
                code,
                parent_code: parentCode,
                level: targetLevel,
                module_code: mc,
                title: cleanTitle(txt),
                description: ''
            };
            const idx = cats.length;
            cats.push(cat);
            parentStack.push({ level: targetLevel, code, idx });

            i++;
            continue;
        }

        // 表格首行粗体 → 作为 header 的子级
        const tstart = line.trim();
        if (tstart.startsWith('|') && /\*\*[^*]+\*\*/.test(tstart)) {
            // 找到当前 parent (栈顶 H3 或 H2)
            if (parentStack.length > 0) {
                const lastParent = parentStack[parentStack.length - 1];
                const parentLv = lastParent.level;
                const childLv = parentLv + 1;
                if (childLv <= 5) {
                    const rows = extractTableBoldRows(lines, i);
                    // 收集连续的同表
                    // 提取列：第一列粗体文本
                    let j = i + 1;
                    while (j < lines.length) {
                        const l = lines[j].trim();
                        if (!l.startsWith('|')) break;
                        if (/^\|[\s:|-]+\|$/.test(l)) { j++; continue; }
                        const cells = l.split('|').map(c => c.trim()).filter(c => c.length);
                        if (cells.length === 0) { j++; continue; }
                        const first = cells[0].replace(/^\*\*|\*\*$/g, '').trim();
                        if (!first) { j++; continue; }
                        if (/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\s]+$/u.test(first)) { j++; continue; }
                        rows.push(first);
                        j++;
                    }
                    // 处理 rows 作为子级
                    for (const r of rows) {
                        segCounters[childLv] = (segCounters[childLv] || 0) + 1;
                        for (let d = childLv + 1; d <= 5; d++) segCounters[d] = 0;
                        const seg = segCounters[childLv];
                        const codeParts = [Number(mc)];
                        for (let d = 2; d <= 4; d++) {
                            if (d <= childLv) codeParts.push(segCounters[d]);
                            else codeParts.push(0);
                        }
                        const code = pad4(codeParts);
                        // parent 是 header (lastParent.code)
                        cats.push({
                            code,
                            parent_code: lastParent.code,
                            level: childLv,
                            module_code: mc,
                            title: cleanTitle(r),
                            description: ''
                        });
                    }
                    i = j;
                    continue;
                }
            }
        }

        i++;
    }

    return cats;
}

function main() {
    console.log('▶ rebuild-from-source');
    const files = fs.readdirSync(SRC_DIR).filter(f => /^\d{2}-.*\.md$/.test(f)).sort();
    console.log('  source files:', files.length);

    const finalCats = [];
    const MODULE_NAMES = {
        '00': '00-范例',
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

    const seenTitles = new Map();  // (mc, title) → count, for dup detection
    for (const f of files) {
        const mc = f.substring(0, 2);
        const modName = MODULE_NAMES[mc] || f.replace('.md', '');
        const filePath = path.join(SRC_DIR, f);
        const cats = processFile(filePath, mc, modName);
        console.log(`  ${f} (mc=${mc}): ${cats.length} entries`);
        finalCats.push(...cats);

        // 统计模块内重复 title
        const titleCount = new Map();
        for (const c of cats) {
            const k = c.title;
            titleCount.set(k, (titleCount.get(k) || 0) + 1);
        }
        const dupTitles = [...titleCount.entries()].filter(([k, v]) => v > 1);
        if (dupTitles.length) console.log(`    ⚠ ${dupTitles.length} duplicate titles in module`);
    }

    // 全局唯一性检查
    const cc = new Map();
    for (const c of finalCats) cc.set(c.code, (cc.get(c.code) || 0) + 1);
    const dups = [...cc.entries()].filter(([k, v]) => v > 1);
    console.log('');
    console.log('  全局 code 重复:', dups.length);
    if (dups.length) for (const [k] of dups.slice(0, 10)) console.log('    [' + k + ']');

    const lvlS = {};
    for (const c of finalCats) lvlS[c.level] = (lvlS[c.level] || 0) + 1;
    console.log('  Level 分布:', JSON.stringify(lvlS));

    // module 子树大小
    const byCode = new Map(finalCats.map(c => [c.code, c]));
    function rootOf(c) {
        let cur = c;
        while (cur && cur.parent_code) {
            const p = byCode.get(cur.parent_code);
            if (!p) break;
            cur = p;
        }
        return cur;
    }
    const modCount = new Map();
    for (const c of finalCats) {
        const r = rootOf(c);
        if (r) modCount.set(r.code, (modCount.get(r.code) || 0) + 1);
    }
    console.log('');
    console.log('=== Module subtree (transitive) ===');
    const sortedMods = [...modCount.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [code, cnt] of sortedMods) {
        const r = byCode.get(code);
        console.log(`  [${code}] ${cnt} | ${r.title}`);
    }

    // 写回
    fs.writeFileSync(CATS_PATH, JSON.stringify(finalCats, null, 2), 'utf8');
    console.log('');
    console.log('✓ 完成 总条数:', finalCats.length);
}

main();