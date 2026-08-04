// scripts/rebuild-06-pose.js
// 重新从 06-姿势动作.md 提取模块 06 结构:
//   L1 = 06-姿势动作
//   L2 = 8 大部分（静态姿势/动态动作/过渡姿态/挑逗暗示/口交·深喉/颜射·体液/插入·肢体接触/多人场景）
//   L3 = L2 下的具体系列（如 跪姿系列/坐姿系列/...）
//   L4 = L3 下的子分类（如 臣服姿态/眼神方向/...）
// 只动 module 06，不影响其它模块
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function main() {
    const moduleCode = '06';
    const moduleRoot = '06.000.000.000';

    console.log('▶ rebuild-06-pose');
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);
    console.log('  module 06 initial:', cats.filter(c => c.module_code === moduleCode).length);

    // Step 1: 从 cats 提取 module 06 现有所有 title（按旧 code 索引）
    const m06Old = cats.filter(c => c.module_code === moduleCode);
    const byCode = new Map(m06Old.map(c => [c.code, c]));

    // Step 2: 定义新的层级结构（基于源 markdown 6-姿势动作.md）
    // 格式：[L2 名称, [L3 名称, [L4 名称, ...] | null], ...]
    const structure = [
        ['静态姿势', [
            ['跪姿系列', ['臣服姿态', '眼神方向', '腿部分开度', '口交前奏', '束缚跪姿', '经典跪姿场景组合', '四肢着地']],
            ['坐姿系列', ['基本坐姿', '腿部分开', '特殊坐姿', '坐姿上半身']],
            ['站姿系列', ['基本站姿', '身体动态', '场景站姿', '性爱站姿']],
            ['躺姿系列', ['基本躺姿', '腿部变化', '身体动态']],
        ]],
        ['动态动作', [
            ['行走系列', ['基本行走', '方向关系', '回眸行走', '环境行走', '情色化行走']],
            ['奔跑系列', ['基本奔跑', '方向关系', '追逐/逃跑', '奔跑中的身体状态', '场景化奔跑']],
            ['跳跃·攀爬系列', ['跳跃', '攀爬', '跨越']],
            ['舞蹈·旋转系列', ['基本舞蹈', '旋转中的身体', '舞蹈场景']],
            ['游泳·水中系列', []],
            ['日常动态', ['进出动作', '弯腰·伸展', '日常行为']],
        ]],
        ['过渡姿态', [
            ['脱衣过程中', []],
            ['身体转向', []],
            ['弯腰/起身', []],
            ['手部过渡', []],
            ['面部/口部过渡', []],
            ['性爱过渡', []],
        ]],
        ['挑逗暗示', [
            ['挑逗姿态', []],
        ]],
        ['口交·深喉', [
            ['基础锚定', []],
            ['视觉强化', []],
            ['空间关系', []],
            ['口交角度/构图', []],
            ['手口配合', []],
            ['深喉分级', []],
            ['深喉专属', []],
            ['窒息反应链', []],
            ['喉部视觉锚定', []],
            ['吞咽系列', []],
            ['口交连续动作', []],
            ['场景化口交', []],
            ['被迫口交', []],
            ['口交标准组合', []],
        ]],
        ['颜射·体液', [
            ['射精瞬间', []],
            ['体液在脸上的状态', []],
            ['她的表情反应', []],
            ['射精动作', []],
            ['颜射场景组合', []],
            ['颜射×口交联合', []],
        ]],
        ['插入·肢体接触', [
            ['插入入口关系', []],
            ['插入深度', []],
            ['内部状态', []],
            ['抽插动作', []],
            ['乳房接触', []],
            ['臀部接触', []],
            ['身体贴合', []],
            ['位置关系词', []],
        ]],
        ['多人场景', [
            ['双人支撑点', []],
            ['双人体重分布', []],
            ['双人接触力', []],
            ['体重压迫', []],
            ['手部协作', []],
            ['面部距离', []],
            ['双人姿势组合', []],
            ['双人动态力学', []],
            ['3P / 三人行专项', ['角色定义', '双穴同入', '口穴+下穴', '三人姿势组合', '三人手部协作', '三人动态力学', '三人面部/情绪', '三人等待/轮替', '三人场景组合']],
        ]],
    ];

    // Step 3: 收集原数据中所有 索引 / 跪姿系列 等旧 L2 的 title（用于匹配）
    // 由于新结构基本是平移，我们可以：
    //   - 删除 索引（唯一 L2 索引条目）
    //   - 旧的 L2 跪姿/坐姿/站姿/躺姿/行走/.../3P 转为新 L3
    //   - 旧的 L3 臣服姿态/... 转为新 L4
    //   - 新增 8 个 L2（静态姿势/动态动作/过渡姿态/挑逗暗示/口交·深喉/颜射·体液/插入·肢体接触/多人场景）
    //
    // 我们用「按 title 匹配旧条目」的方式（title 是唯一的标识）：

    // 收集原数据中所有 module 06 条目（按 title 索引）
    const byTitle = new Map();
    for (const c of m06Old) {
        if (c.title) byTitle.set(c.title, c);
    }

    // Step 4: 构建新 module 06 条目
    const newM06 = [];
    let l2Idx = 0;
    for (const [l2Title, l3List] of structure) {
        l2Idx++;
        const l2Code = `${moduleCode}.${String(l2Idx).padStart(3, '0')}.000.000`;

        // 创建新 L2（其内容来自源 markdown，是新条目）
        newM06.push({
            module_code: moduleCode,
            code: l2Code,
            title: l2Title,
            level: 2,
            parent_code: moduleRoot,
        });

        let l3Idx = 0;
        for (const l3Item of l3List) {
            const l3Title = l3Item[0];
            const l4List = l3Item[1] || [];

            l3Idx++;
            const l3Code = `${l2Code.split('.')[0]}.${l2Code.split('.')[1]}.${String(l3Idx).padStart(3, '0')}.000`;

            // 找原 module 06 中 title 匹配的 L2 条目（旧的 L2 跪姿系列等）
            // 或者原 module 06 中 title 匹配的 L3 条目（旧的 L3 臣服姿态等）
            const old = byTitle.get(l3Title);
            const newL3 = old ? { ...old } : {
                module_code: moduleCode,
                code: l3Code,
                title: l3Title,
                level: 3,
                parent_code: l2Code,
            };
            newL3.code = l3Code;
            newL3.level = 3;
            newL3.parent_code = l2Code;
            newL3.title = l3Title;
            newM06.push(newL3);

            // L4
            for (let l4Idx = 0; l4Idx < l4List.length; l4Idx++) {
                const l4Title = l4List[l4Idx];
                const l4Code = `${l3Code.split('.')[0]}.${l3Code.split('.')[1]}.${l3Code.split('.')[2]}.${String(l4Idx + 1).padStart(3, '0')}`;
                const oldL4 = byTitle.get(l4Title);
                const newL4 = oldL4 ? { ...oldL4 } : {
                    module_code: moduleCode,
                    code: l4Code,
                    title: l4Title,
                    level: 4,
                    parent_code: l3Code,
                };
                newL4.code = l4Code;
                newL4.level = 4;
                newL4.parent_code = l3Code;
                newL4.title = l4Title;
                newM06.push(newL4);
            }
        }
    }

    console.log('  new module 06 total:', newM06.length);

    // Step 5: 验证新结构无重复
    const newCodes = new Set();
    let dupCount = 0;
    for (const c of newM06) {
        if (newCodes.has(c.code)) {
            console.log('    !! 内部重复 code:', c.code, c.title);
            dupCount++;
        }
        newCodes.add(c.code);
    }
    console.log('  内部重复 code:', dupCount);

    // Step 6: 替换 module 06 entries（保留 L1 根）
    const l1Root = m06Old.find(c => c.code === moduleRoot);
    const newCats = cats
        .filter(c => c.module_code !== moduleCode || c.code === moduleRoot)
        .concat(newM06);

    // L1 根如果丢失则补回
    if (l1Root && !newCats.find(c => c.code === moduleRoot)) {
        newCats.push(l1Root);
    }

    // Step 7: 验证
    console.log('');
    console.log('=== 验证 ===');
    const cm = new Map();
    for (const c of newCats) cm.set(c.code, (cm.get(c.code) || 0) + 1);
    const dupes = [...cm.entries()].filter(([k, v]) => v > 1);
    console.log('  重复 code:', dupes.length);
    if (dupes.length) for (const [k] of dupes) console.log('    ' + k);

    const orphans = newCats.filter(c => c.parent_code && !cm.has(c.parent_code));
    console.log('  orphans:', orphans.length);
    if (orphans.length) for (const o of orphans.slice(0, 5)) console.log('    ' + o.code + ' parent=' + o.parent_code);

    // 显示新 module 06 L2 列表
    console.log('');
    console.log('=== Module 06 新 L2 列表 ===');
    const newL2 = newCats
        .filter(c => c.module_code === moduleCode && c.level === 2)
        .sort((a, b) => a.code.localeCompare(b.code));
    for (const c of newL2) {
        const l3Kids = newCats.filter(k => k.parent_code === c.code).sort((a, b) => a.code.localeCompare(b.code));
        console.log(`  [${c.code}] L2 ${c.title} (${l3Kids.length} L3)`);
        for (const k of l3Kids) {
            const l4Kids = newCats.filter(g => g.parent_code === k.code);
            console.log(`    [${k.code}] L3 ${k.title}${l4Kids.length > 0 ? ` (${l4Kids.length} L4)` : ''}`);
            for (const g of l4Kids.sort((a, b) => a.code.localeCompare(b.code))) {
                console.log(`      [${g.code}] L4 ${g.title}`);
            }
        }
    }

    console.log('');
    console.log(`  final: ${newCats.length} (变化 ${newCats.length - cats.length})`);
    fs.writeFileSync(CATS_PATH, JSON.stringify(newCats, null, 2), 'utf8');
    console.log('✓ 完成');
}

main();
