// scripts/apply-user-edits.js v2
// 应用用户在历史会话里的具体删除指令
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function findByCode(cats, code) {
    return cats.find(c => c.code === code);
}
function findChildren(cats, parentCode) {
    return cats.filter(c => c.parent_code === parentCode).sort((a, b) => a.code.localeCompare(b.code));
}
function findDescendants(cats, code) {
    const out = new Set();
    const stack = [code];
    while (stack.length) {
        const c = stack.pop();
        if (out.has(c)) continue;
        out.add(c);
        for (const k of cats.filter(k => k.parent_code === c)) stack.push(k.code);
    }
    return out;
}
function deleteByCodes(cats, codes) {
    const set = new Set(codes);
    let count = 0;
    for (let i = cats.length - 1; i >= 0; i--) {
        if (set.has(cats[i].code)) { cats.splice(i, 1); count++; }
    }
    return count;
}

// 递归重新编码：以 newRootCode 为新的根（含模块代码），按位置生成连续 segment
function recodeSubtree(cats, entry, newRootCode, newRootLevel, newRootParentCode, depthOffset) {
    // entry 是要重新编码的节点（以及它的后代）
    const moduleCode = newRootCode.split('.')[0];

    // BFS 遍历 entry 及其后代
    const queue = [{ entry, relPath: '' }];
    while (queue.length) {
        const { entry: e, relPath } = queue.shift();

        // 计算新 code
        let newCode, newLevel;
        if (relPath === '') {
            // 根节点
            newCode = newRootCode;
            newLevel = newRootLevel;
        } else {
            // relPath 形如 '.001' 或 '.001.005'
            const segs = relPath.split('.').filter(s => s).map(s => String(Number(s)).padStart(3, '0'));
            newCode = moduleCode + '.' + segs.join('.');
            // 补齐到 4 段
            while (newCode.split('.').length < 4) newCode += '.000';
            // 取段数
            newLevel = moduleCode.split('.').length + segs.length;
        }

        e.code = newCode;
        e.level = newLevel;
        e.parent_code = relPath === '' ? newRootParentCode : (relPath.split('.').filter(s => s).length === 1
            ? newRootCode
            : (() => {
                const segs = relPath.split('.').filter(s => s);
                const parentSegs = segs.slice(0, -1);
                return moduleCode + '.' + parentSegs.map(s => String(Number(s)).padStart(3, '0')).join('.') + '.000'.repeat(Math.max(0, 4 - 1 - parentSegs.length));
            })());

        // 找当前 entry 的直接子项（基于原始 code 的 parent_code）
        const kids = findChildren(cats, e.code === newCode ? findOriginalCode(cats, e) : e.code);
        // 上面的判断有点复杂，简化：我们用 entry 的 _oldCode 字段来追踪
    }
}

// 简化版：直接递归处理 promote
function promoteChildrenUp(cats, parentCode, moduleCode) {
    const parent = findByCode(cats, parentCode);
    if (!parent) return 0;
    const grandParentCode = parent.parent_code;
    const kids = findChildren(cats, parentCode);
    const moduleRootCode = `${moduleCode}.000.000.000`;

    // 收集现有的 module L2 编号最大值
    const existingL2 = cats.filter(c => c.parent_code === moduleRootCode && c.code !== moduleRootCode);
    let maxSss = 0;
    for (const e of existingL2) {
        const seg = parseInt(e.code.split('.')[1], 10);
        if (!isNaN(seg) && seg > maxSss) maxSss = seg;
    }

    let sss = maxSss;

    // 保存 kid 的原始 code 作为 mapping
    const kidOriginalCodes = kids.map(k => k.code);

    for (let idx = 0; idx < kids.length; idx++) {
        const k = kids[idx];
        sss++;
        const newKidCode = `${moduleCode}.${String(sss).padStart(3, '0')}.000.000`;
        const oldKidCode = k.code;

        // 递归重编码 kid + 所有后代
        // 用临时 _origCode 字段追踪旧 code
        function recode(entry, newCode, newParentCode, newLevel) {
            entry._origCode = entry.code;
            entry.code = newCode;
            entry.parent_code = newParentCode;
            entry.level = newLevel;
            // 子项基于原始 code 的 parent_code 查找
            const kids = cats.filter(x => x.parent_code === entry._origCode);
            for (let j = 0; j < kids.length; j++) {
                const segs = newCode.split('.').slice(1);  // 去掉 module
                const kidSegs = segs.filter(s => s !== '000');
                const kidNewSegs = [...kidSegs, String(j + 1).padStart(3, '0')];
                let kidNewCode = moduleCode + '.' + kidNewSegs.join('.');
                // 补齐到 4 段
                while (kidNewCode.split('.').length < 4) kidNewCode += '.000';
                recode(kids[j], kidNewCode, newCode, kidNewSegs.length + 1);
            }
        }

        recode(k, newKidCode, moduleRootCode, 2);
    }

    // 清理 _origCode 字段
    for (const c of cats) delete c._origCode;

    // 删除原 parent
    deleteByCodes(cats, [parentCode]);
    return kids.length;
}

function main() {
    console.log('▶ apply-user-edits v2');
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);

    const log = [];

    // 00: 删 0.1, 0.2; 0.3 标题去掉 + 子级提级
    {
        const n1 = deleteByCodes(cats, [...findDescendants(cats, '00.001.000.000')]);
        log.push(`00.1: -${n1}`);
        const n2 = deleteByCodes(cats, [...findDescendants(cats, '00.002.000.000')]);
        log.push(`00.2: -${n2}`);
        const n3 = promoteChildrenUp(cats, '00.003.000.000', '00');
        log.push(`00.3 promote: +${n3} L2 (00.3 title removed)`);
    }

    // 01: 删 1.1
    {
        const n = deleteByCodes(cats, [...findDescendants(cats, '01.001.000.000')]);
        log.push(`01.1: -${n}`);
    }

    // 02: 删 2.1, 2.2
    {
        const n1 = deleteByCodes(cats, [...findDescendants(cats, '02.001.000.000')]);
        log.push(`02.1: -${n1}`);
        const n2 = deleteByCodes(cats, [...findDescendants(cats, '02.002.000.000')]);
        log.push(`02.2: -${n2}`);
    }

    // 10: 删 10.1, 10.4.3
    {
        const n1 = deleteByCodes(cats, [...findDescendants(cats, '10.001.000.000')]);
        log.push(`10.1: -${n1}`);
        const kids = findChildren(cats, '10.004.000.000');
        if (kids.length >= 3) {
            const n2 = deleteByCodes(cats, [...findDescendants(cats, kids[2].code)]);
            log.push(`10.4.3: -${n2}`);
        } else {
            log.push(`10.4.3: SKIP (10.004 has ${kids.length} children)`);
        }
    }

    // 11: 删 11.7.6
    {
        const kids = findChildren(cats, '11.007.000.000');
        if (kids.length >= 6) {
            const n = deleteByCodes(cats, [...findDescendants(cats, kids[5].code)]);
            log.push(`11.7.6: -${n}`);
        } else {
            log.push(`11.7.6: SKIP (11.007 has ${kids.length} children, need 6+)`);
        }
    }

    // 12: 删 12.1 标题 + 子级提级 (12.1.1 → 12.1, 12.1.2 → 12.2), 再删 12.1.2
    {
        const kids = findChildren(cats, '12.001.000.000');
        if (kids.length >= 2) {
            const n1 = promoteChildrenUp(cats, '12.001.000.000', '12');
            log.push(`12.1 promote: +${n1} L2`);
            const n2 = deleteByCodes(cats, [...findDescendants(cats, '12.002.000.000')]);
            log.push(`12.1.2 (now 12.002): -${n2}`);
        } else {
            log.push(`12.1: SKIP (only ${kids.length} children, need 2+)`);
        }
    }

    // 13: 删 13.1, 13.8, 13.9
    {
        const n1 = deleteByCodes(cats, [...findDescendants(cats, '13.001.000.000')]);
        log.push(`13.1: -${n1}`);
        const n2 = deleteByCodes(cats, [...findDescendants(cats, '13.008.000.000')]);
        log.push(`13.8: -${n2}`);
        const n3 = deleteByCodes(cats, [...findDescendants(cats, '13.009.000.000')]);
        log.push(`13.9: -${n3}`);
    }

    console.log('');
    console.log('=== 应用日志 ===');
    for (const l of log) console.log('  ' + l);
    console.log('');
    console.log('  final:', cats.length);

    const cc = new Map();
    for (const c of cats) cc.set(c.code, (cc.get(c.code) || 0) + 1);
    console.log('  code 重复:', [...cc.values()].filter(v => v > 1).length);

    const byCode = new Map(cats.map(c => [c.code, c]));
    const orphans = cats.filter(c => c.parent_code && !byCode.has(c.parent_code));
    console.log('  orphans:', orphans.length);
    if (orphans.length) for (const o of orphans.slice(0, 5)) console.log('    ' + o.code + ' parent=' + o.parent_code);

    fs.writeFileSync(CATS_PATH, JSON.stringify(cats, null, 2), 'utf8');
    console.log('');
    console.log('✓ 完成');
}

main();