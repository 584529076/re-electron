// scripts/rebuild-from-source-v2.js
// 从 D:\nsfw-prompt-templates-asian 提取 markdown 标题 (#/##/###/####)
// + module 14 表格行 (人格卡片)
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = 'D:\\nsfw-prompt-templates-asian';
const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function cleanTitle(s) {
    if (!s) return '';
    return String(s)
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
        .replace(/^undefined[wrs]+(\.\d+)?\s+/i, '')
        .replace(/^[\s\-─—•·#*]+|[\s\-─—#*]+$/g, '')
        .trim();
}

function pad4(parts) {
    const out = [];
    for (let i = 0; i < 4; i++) {
        // i=0: 模块代码 (MM) 2 位；i>=1: 子段 (SSS) 3 位
        const width = i === 0 ? 2 : 3;
        out.push(i < parts.length ? String(parts[i]).padStart(width, '0') : '000');
    }
    return out.join('.');
}

function headerLevel(line) {
    const m = line.match(/^(#{1,6})\s+/);
    return m ? m[1].length : 0;
}

function headerText(line) {
    return line.replace(/^#+\s+/, '').trim();
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

    const segCounters = { 2: 0, 3: 0, 4: 0, 5: 0 };
    let firstH1Skipped = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 模块 14 特殊处理：从大表格（首列是 "序"）提取人格卡片
        if (mc === '14' && line.trim().startsWith('|') && /^\|\s*序\s*\|/.test(line.trim())) {
            // 后续行是人格卡片
            i++; // 跳过表头
            if (i < lines.length && /^\|[\s:|-]+\|$/.test(lines[i].trim())) i++; // 跳过分隔行
            let personaIdx = 0;
            while (i < lines.length) {
                const rowLine = lines[i].trim();
                if (!rowLine.startsWith('|')) break;
                if (/^\|[\s:|-]+\|$/.test(rowLine)) { i++; continue; }
                // 提取第 2 列（人格名）
                const cells = rowLine.split('|').map(c => c.trim()).filter(c => c.length);
                if (cells.length >= 2) {
                    const personaName = cells[1].trim();
                    if (personaName && !/^\d+$/.test(personaName)) {
                        personaIdx++;
                        segCounters[3] = personaIdx;  // 人格卡片是 L3
                        for (let d = 4; d <= 5; d++) segCounters[d] = 0;
                        const code = pad4([mc, segCounters[2] || 1, segCounters[3], 0]);
                        cats.push({
                            code,
                            parent_code: root.code,  // 直接挂在模块根下
                            level: 3,
                            module_code: mc,
                            title: cleanTitle(personaName),
                            description: cells.length > 5 ? cells[5] : ''
                        });
                    }
                }
                i++;
            }
            continue;
        }

        if (!line.match(/^#{1,6}\s+/)) continue;
        const lv = headerLevel(line);

        // 第一个 H1 跳过 (视为模块描述)
        if (lv === 1 && !firstH1Skipped) {
            firstH1Skipped = true;
            continue;
        }

        // 只处理 H2..H5
        if (lv < 2 || lv > 5) continue;

        const txt = headerText(line);
        if (!txt) continue;

        segCounters[lv] = (segCounters[lv] || 0) + 1;
        for (let d = lv + 1; d <= 5; d++) segCounters[d] = 0;

        const codeParts = [mc];
        for (let d = 2; d <= 4; d++) {
            codeParts.push(d <= lv ? segCounters[d] : 0);
        }
        const code = pad4(codeParts);

        // 找 parent：找最近 lv-1 的前一个 category
        let parentCode = root.code;
        for (let j = cats.length - 1; j >= 0; j--) {
            if (cats[j].level === lv - 1) {
                parentCode = cats[j].code;
                break;
            }
        }

        cats.push({
            code,
            parent_code: parentCode,
            level: lv,
            module_code: mc,
            title: cleanTitle(txt),
            description: ''
        });
    }

    return cats;
}

function main() {
    console.log('▶ rebuild-from-source-v2');
    const files = fs.readdirSync(SRC_DIR).filter(f => /^\d{2}-.*\.md$/.test(f)).sort();
    console.log('  source files:', files.length);

    const finalCats = [];
    const MODULE_NAMES = {
        '00': '00-范例', '01': '01-场景主题', '02': '02-景别构图',
        '03': '03-裸露液体', '04': '04-服装专项', '05': '05-光影氛围',
        '06': '06-姿势动作', '07': '07-表情眼神', '08': '08-风格胶片',
        '09': '09-妆容专项', '10': '10-发型饰品', '11': '11-瑕疵细节',
        '12': '12-纹身标记', '13': '13-道具宠物', '14': '14-人格卡片'
    };

    for (const f of files) {
        const mc = f.substring(0, 2);
        const modName = MODULE_NAMES[mc] || f.replace('.md', '');
        const cats = processFile(path.join(SRC_DIR, f), mc, modName);
        const dupes = new Set();
        const seenT = new Map();
        for (const c of cats) {
            const k = c.title;
            seenT.set(k, (seenT.get(k) || 0) + 1);
        }
        for (const [k, v] of seenT) if (v > 1) dupes.add(k);
        console.log(`  ${f} (mc=${mc}): ${cats.length} entries${dupes.size ? ` ⚠ ${dupes.size} dup titles` : ''}`);
        finalCats.push(...cats);
    }

    const cc = new Map();
    for (const c of finalCats) cc.set(c.code, (cc.get(c.code) || 0) + 1);
    const dups = [...cc.entries()].filter(([k, v]) => v > 1);
    console.log('');
    console.log('  全局 code 重复:', dups.length);
    if (dups.length) for (const [k] of dups.slice(0, 5)) console.log('    [' + k + ']');

    const lvlS = {};
    for (const c of finalCats) lvlS[c.level] = (lvlS[c.level] || 0) + 1;
    console.log('  Level 分布:', JSON.stringify(lvlS));

    // module 子树大小
    const byCode = new Map(finalCats.map(c => [c.code, c]));
    function rootOf(c) {
        let cur = c;
        let safety = 10;
        while (cur && cur.parent_code && safety-- > 0) {
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
    console.log('=== Module subtree ===');
    const sortedMods = [...modCount.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [code, cnt] of sortedMods) {
        const r = byCode.get(code);
        console.log(`  [${code}] ${cnt} | ${r.title}`);
    }

    fs.writeFileSync(CATS_PATH, JSON.stringify(finalCats, null, 2), 'utf8');
    console.log('');
    console.log('✓ 完成 总条数:', finalCats.length);
}

main();