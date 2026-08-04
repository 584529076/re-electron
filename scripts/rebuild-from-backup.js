// scripts/rebuild-from-backup.js
// 从 4MB 备份 (clear-all-nsfw-imported-2026-07-12T04-23-37.json) 重建 categories.json
// - 转换 parent_id 结构 → code/parent_code 结构
// - 每个模块内用 L2/L3/L4/L5 sibling order 分配 SS segment
// - 保留 5 段深度（max 5 segments: MM.SSS.SSS.SSS.SSS）
'use strict';

const fs = require('fs');
const path = require('path');

const BACKUP_PATH = 'D:\\re-electron\\backups\\clear-all-nsfw-imported-2026-07-12T04-23-37.json';
const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function pad4(parts) {
    const out = [];
    for (let i = 0; i < 4; i++) {
        out.push(i < parts.length ? String(parts[i]).padStart(3, '0') : '000');
    }
    return out.join('.');
}

function cleanTitle(s) {
    if (!s) return '';
    let t = String(s)
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
        .trim();
    t = t.replace(/^undefined[wrs]+(\.\d+)?\s+/i, '').trim();
    return t;
}

function main() {
    console.log('▶ rebuild-from-backup');
    const bak = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
    const srcMenu = bak.prompt_menu;
    console.log('  backup prompt_menu entries:', srcMenu.length);

    // 1. 按 id 建索引 + parent_id → module root 映射
    const byId = new Map();
    for (const c of srcMenu) byId.set(c.id, c);

    function moduleRootOf(c) {
        let cur = c;
        while (cur && cur.parent_id !== 0 && cur.parent_id != null) {
            cur = byId.get(cur.parent_id);
        }
        return cur;
    }

    // 2. 提取 15 个 module root
    const roots = srcMenu.filter(c => c.parent_id === 0 || c.parent_id == null);
    console.log('  module roots:', roots.length);

    // 3. 给每个 module 内的 entry 按 sibling order 分配 segment
    //    按 (module_id, depth, parent_id) 分组，组内按 id 升序分配 001, 002...
    const moduleSegCounters = new Map();  // module_id → 4-element array [L2cnt, L3cnt, L4cnt, L5cnt]
    const parentToSegIdx = new Map();     // entry.id → segIdx (e.g. 2,3,4,5 表示层级)
    const codeOf = new Map();             // entry.id → code string
    const parentCodeOf = new Map();       // entry.id → parent code

    // init counters for each module
    for (const r of roots) moduleSegCounters.set(r.id, [0, 0, 0, 0]);

    // 层级处理顺序：先 L1 (roots), 然后 L2, L3, L4, L5
    // root → L2 → L3 → L4 → L5
    function depthOf(c) {
        return (c.pid_list || '').split('/').filter(x => x).length;
    }

    // 先给所有 roots 分配 code (MM.000.000.000)
    for (const r of roots) {
        const mc = String(roots.indexOf(r) + 1).padStart(2, '0'); // 1-based mm index
        // 注意：roots 顺序：00,01,02..14，对应 MM 编号
        const code = `${mc}.000.000.000`;
        codeOf.set(r.id, code);
        parentCodeOf.set(r.id, null);
        parentToSegIdx.set(r.id, 1);
    }
    // 实际 module index 应按 category_name 排序映射
    // 上面用 indexOf 不稳定，改用按 category_name 提取 MM 前缀
    const mmByName = new Map();
    for (let i = 0; i < roots.length; i++) {
        const n = roots[i].category_name;
        const mm = String(i).padStart(2, '0');
        mmByName.set(n, mm);
    }
    // 重新分配 root codes
    for (let i = 0; i < roots.length; i++) {
        const r = roots[i];
        const mc = String(i).padStart(2, '0');
        codeOf.set(r.id, `${mc}.000.000.000`);
    }

    // BFS: L2 → L3 → L4 → L5
    const queue = [...roots];
    while (queue.length) {
        const c = queue.shift();
        const kids = srcMenu.filter(k => k.parent_id === c.id);
        const mc = mmByName.get(moduleRootOf(c).category_name);
        const counters = moduleSegCounters.get(moduleRootOf(c).id);
        const myLevel = parentToSegIdx.get(c.id);  // 1/2/3/4
        // kids level = myLevel + 1
        const kidLevel = myLevel + 1;
        if (kidLevel > 5) continue;  // 太深，丢弃

        let segIdx = 0;
        for (const k of kids) {
            segIdx++;
            counters[kidLevel - 2] = Math.max(counters[kidLevel - 2], segIdx);

            // build code: 4 segments for kidLevel 2/3/4, 5 segments for kidLevel 5
            const parts = [Number(mc)];
            if (kidLevel >= 2) parts.push(segIdx);
            if (kidLevel >= 3) parts.push(0);  // will fill below for kid's kids
            if (kidLevel >= 4) parts.push(0);
            if (kidLevel >= 5) parts.push(0);
            // parent code has 4 segments (max), truncate trailing zeros of parent
            const parentCode = codeOf.get(c.id);

            let code;
            if (kidLevel === 2) code = `${mc}.${String(segIdx).padStart(3,'0')}.000.000`;
            else if (kidLevel === 3) {
                // parent is L2: mc.SSS.000.000 → kid = mc.SSS.NNN.000
                const pSeg = parentCode.split('.');
                code = `${mc}.${pSeg[1]}.${String(segIdx).padStart(3,'0')}.000`;
            } else if (kidLevel === 4) {
                const pSeg = parentCode.split('.');
                code = `${mc}.${pSeg[1]}.${pSeg[2]}.${String(segIdx).padStart(3,'0')}`;
            } else if (kidLevel === 5) {
                // 5 segments: mc.SSS.SSS.SSS.NNN (special extension)
                const pSeg = parentCode.split('.');
                code = `${mc}.${pSeg[1]}.${pSeg[2]}.${pSeg[3]}.${String(segIdx).padStart(3,'0')}`;
            }

            codeOf.set(k.id, code);
            parentCodeOf.set(k.id, parentCode);
            parentToSegIdx.set(k.id, kidLevel);
            queue.push(k);
        }
    }

    // 4. 转成目标 JSON 结构
    const finalCats = [];
    const dropped = [];
    for (const c of srcMenu) {
        const code = codeOf.get(c.id);
        if (!code) { dropped.push(c); continue; }
        const level = parentToSegIdx.get(c.id);
        const root = moduleRootOf(c);
        const mc = mmByName.get(root.category_name);
        finalCats.push({
            code,
            parent_code: parentCodeOf.get(c.id),
            level,
            module_code: mc,
            title: cleanTitle(c.category_name),
            description: c.description || '',
            is_required: c.is_required ? 1 : 0,
            tag_required: c.tag_required || '',
            tag_exclusive_group: c.tag_exclusive_group || '',
            exclusive_with: c.exclusive_with || '',
            exclusive_group: c.exclusive_group || '',
            source_id: c.id,
            created_at: c.created_at,
            updated_at: c.updated_at
        });
    }

    // 5. 验证
    const cc = new Map();
    for (const c of finalCats) cc.set(c.code, (cc.get(c.code) || 0) + 1);
    const dups = [...cc.entries()].filter(([k, v]) => v > 1);
    console.log('  code 重复:', dups.length);
    if (dups.length) for (const [k] of dups.slice(0, 5)) console.log('    [' + k + ']');

    console.log('  dropped (no code assigned):', dropped.length);
    if (dropped.length) for (const d of dropped.slice(0, 3)) console.log('    id=' + d.id + ' ' + d.category_name);

    const lvlS = {};
    for (const c of finalCats) lvlS[c.level] = (lvlS[c.level] || 0) + 1;
    console.log('  Level 分布:', JSON.stringify(lvlS));

    // 6. module subtree summary
    const subCount = new Map();
    for (const c of finalCats) {
        if (c.parent_code) subCount.set(c.parent_code, (subCount.get(c.parent_code) || 0) + 1);
    }
    console.log('');
    console.log('=== Module roots (L1) ===');
    const sorted = finalCats.filter(x => x.level === 1).sort((a, b) => Number(a.module_code) - Number(b.module_code));
    for (const r of sorted) {
        const cnt = subCount.get(r.code) || 0;
        console.log('  [' + r.code + '] mc=' + r.module_code + ' children=' + cnt + ' | ' + r.title.substring(0, 40));
    }

    // 7. 写回
    fs.writeFileSync(CATS_PATH, JSON.stringify(finalCats, null, 2), 'utf8');
    console.log('');
    console.log('✓ 完成 总条数:', finalCats.length);
}

main();