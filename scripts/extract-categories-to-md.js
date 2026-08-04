// scripts/extract-categories-to-md.js
// 把 parsed-nsfw-asian/categories.json 渲染成层级 md 文件：
//   1. 总览（单个 .md，按模块分组，每条以 ## / ### / ... 缩进）
//   2. 每个模块一个 .md
//   3. 一份纯层级树（用 ┌─ / └─ 风格）
//
// 用法：node scripts/extract-categories-to-md.js [categories.json] [out_dir]

'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = (process.argv.slice(2).find(a => !a.startsWith('--'))) || path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');
const OUT_DIR = path.join('D:', 'nsfw-prompt-templates-asian解析文件');

// 噪声分类过滤：纯装饰线 / "第N部分" / 标题噪音不算有效分类
function isNoiseCategory(cat) {
    const t = String(cat.title || cat.name || '').trim();
    if (!t) return true;
    // 纯装饰字符（>=70% 是同一符号）
    const deco = '═─━_■□◯●*·•=';
    let decoCount = 0;
    for (const ch of t) if (deco.includes(ch)) decoCount++;
    if (decoCount >= t.length * 0.7) return true;
    // 第一级 (模块根) 不能滤
    if (cat.level === 1) return false;
    // 完全等于 "第N部分" 风格（无具体语义）
    if (/^第[一二三四五六七八九十百零\d]+(部分|章|节)?$/.test(t)) return true;
    if (/^PART\s*[IVX\d]*$/i.test(t)) return true;
    // 文件名自指（parser 把"# 01-场景主题.md — 标题" 也当 heading 抓）
    if (cat.level === 2 && /—.*（.*）/.test(t) && t.length > 30) return true;
    return false;
}

function main() {
    if (!fs.existsSync(CATS_PATH)) {
        console.error('!! 找不到 ' + CATS_PATH);
        process.exit(1);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(path.join(OUT_DIR, 'modules'), { recursive: true });

    const rawCats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    const cats = rawCats.filter(c => !isNoiseCategory(c));
    const noiseCount = rawCats.length - cats.length;
    console.log('▶ extract-categories-to-md');
    console.log('  src: ' + CATS_PATH);
    console.log('  out: ' + OUT_DIR);
    console.log('  raw:   ' + rawCats.length + ' 过滤噪声 ' + noiseCount + ' 条 → 有效 ' + cats.length);

    // 按模块分组
    const byModule = new Map();
    for (const c of cats) {
        const m = c.module || '(无模块)';
        if (!byModule.has(m)) byModule.set(m, []);
        byModule.get(m).push(c);
    }

    // 按 module_code 排序模块名
    const moduleNames = Array.from(byModule.keys()).sort((x, y) => {
        const xc = String(x).match(/^(\d+)/);
        const yc = String(y).match(/^(\d+)/);
        if (xc && yc) return Number(xc[1]) - Number(yc[1]);
        return x.localeCompare(y);
    });

    // 索引：path → cat
    const byPath = new Map(cats.map(c => [c.path, c]));
    // 索引：code → cat
    const byCode = new Map(cats.map(c => [c.code, c]));
    // 重新链接：被过滤的父分类 → 祖父级
    // 例如：6.005 (═══ noise) 已过滤，子节点原本 parent_code='6.005' 改为 '6'
    const noiseCodes = new Set(rawCats.filter(c => isNoiseCategory(c)).map(c => c.code));
    const relinked = new Map();
    for (const c of cats) {
        if (c.parent_code && noiseCodes.has(c.parent_code)) {
            // 上溯
            let pcode = c.parent_code;
            const seen = new Set([c.code]);
            while (pcode && noiseCodes.has(pcode) && !seen.has(pcode)) {
                seen.add(pcode);
                const nc = rawCats.find(x => x.code === pcode);
                pcode = nc ? nc.parent_code : null;
            }
            relinked.set(c.code, pcode || c.module_code || '__ROOT__');
        }
    }

    // ========== 第二轮重链接：消除「📋 索引」TOC + 识别章节横幅 ==========
    // 目标结构：module → banners (L2) → content (L3)
    // 规则：
    //   1. 识别 TOC L2（标题含 📋 索引 / 📑 快速索引 / 📚 目录）→ 标记移除
    //   2. 识别文件名回声 L2（如 "04-服装专项.md — ..."）→ 标记移除，子节点上提
    //   3. TOC 下识别「章节横幅」（短标题 + 篇/章/类/部分/第N部分/一、xx 等）→ 提升为 module 子节点
    //   4. 非横幅的兄弟节点 → 重链接到当前 banner（或无 banner 时直接挂 module）
    //   5. 06 模块特殊处理：剔除 ═══ 装饰行；提升「第N部分」为 banner；其下属挂该 banner
    const stripEmoji = (s) => String(s || '').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const isToc = (c) => /^(?:[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]?\s*)?(?:📋|📑|📚)/u.test(c.title) && /索引|目录/.test(c.title);
    const isFileNameEchoL2 = (c) => c.level === 2 && /\.md\s*[—–-]/.test(c.title) && c.title.length > 20;
    const isSectionBanner = (c) => {
        const t = stripEmoji(c.title);
        if (/^(场景篇|主题角色篇|场景主题篇)$/.test(t)) return true;
        if (/^[一二三四五六七八九十]+、/.test(t)) return true;
        if (/^第[一二三四五六七八九十百\d]+(部分|章|节)$/.test(t)) return true;
        if (/^Part\s*\d+/i.test(t)) return true;
        if (/^(第一|第二|第三|第四|第五|第六|第七|第八|第九|第十)层/.test(t)) return true;
        return false;
    };

    const toRemove2 = new Set();
    const relink2 = new Map();
    for (const [modName, modCats] of byModule) {
        const modCode = modRoot => modRoot.code.split('.')[0];
        const modRoot = modCats.find(c => c.level === 1);
        if (!modRoot) continue;
        const mc = modCode(modRoot);
        const l2 = modCats.filter(c => c.level === 2);
        // 任意层级的 TOC 都识别
        const tocAll = modCats.filter(isToc);
        const tocL2 = tocAll.filter(c => c.level === 2);
        const fnameL2 = l2.filter(isFileNameEchoL2);
        for (const c of [...tocAll, ...fnameL2]) toRemove2.add(c.code);

        // 文件名回声 wrapper：把它的子节点直接挂到 modRoot
        for (const w of fnameL2) {
            for (const k of modCats.filter(c => c.parent_code === w.code)) {
                relink2.set(k.code, modRoot.code);
            }
        }

        // TOC：提升 banner 上提；非 banner 内容挂到当前 banner
        for (const toc of tocL2) {
            const kids = modCats.filter(c => c.parent_code === toc.code)
                .sort((a, b) => String(a.code).localeCompare(String(b.code)));
            let banner = null;
            for (const k of kids) {
                if (isSectionBanner(k)) {
                    relink2.set(k.code, modRoot.code);
                    banner = k;
                } else if (banner) {
                    relink2.set(k.code, banner.code);
                } else {
                    relink2.set(k.code, modRoot.code);
                }
            }
        }

        // 模块 00 专项纠正：
        //   - 0.1（📝 完整 Prompt 范例）整个删除（标题 + 子节点）
        //   - 0.2（📑 范例速查表）整个删除（标题 + 子节点）
        //   - 0.3（🎯 具体范例）删除标题，子节点上提为 module 直接子节点
        //     （0.31 → 0.1，0.31.1 → 0.1.1，…；0.4 统计汇总 重编号为 0.6）
        // 模块 02 专项纠正：
        //   - 删 2.1「📷 景别·构图·设备·视角（情色向）」空 wrapper
        //   - 删 2.2「索引（快速定位）」TOC
        // 模块 03 专项纠正：删 3.1「👙 裸露/液体词库（核心模块 v5.0）」空 wrapper
        // 模块 04 专项纠正：删 4.1「一、穿着原则」空章节
        if (mc === '04') {
            const wrap = modCats.find(c => /一、穿着原则/.test(c.title));
            if (wrap) toRemove2.add(wrap.code);
        }

        // 模块 07 专项纠正：按 code 删 8 个非分类条目
        if (mc === '07') {
            for (const code of ['07.001.014.015','07.001.014.025','07.001.014.026',
                                '07.001.027.033','07.001.042.049',
                                '07.001.050','07.001.051','07.001.052']) {
                toRemove2.add(code);
            }
        }

        // 模块 08 专项纠正：删 8.1 file-name echo + 8.6/8.7 附录
        if (mc === '08') {
            for (const code of ['08.001', '08.028', '08.029']) {
                toRemove2.add(code);
            }
        }

        // 模块 09 专项纠正：删 9.1 file-name echo + 9.5「工具」附录
        if (mc === '09') {
            for (const code of ['09.001', '09.051']) {
                toRemove2.add(code);
            }
        }

        // 模块 10 专项纠正：删 10.1 file-name echo（含其唯一子节点 10.1.1）+ 10.4.3 负面提示
        if (mc === '10') {
            for (const code of ['10.001', '10.001.002', '10.019.033']) {
                toRemove2.add(code);
            }
        }

        // 模块 11 专项纠正：删 11.7.6 随机瑕疵生成规则
        if (mc === '11') {
            toRemove2.add('11.001.041.047');
        }

        // 模块 12 专项纠正：
        //   - 删 12.1（🏷️ 纹身标记词库 L2 wrapper = 12.001），所有直接子节点上提到 module 根
        //   - 删 12.1.2（📌 核心规则 = 12.001.008）
        if (mc === '12') {
            toRemove2.add('12.001');
            toRemove2.add('12.001.008');
            for (const c of modCats) {
                if (c.parent_code === '12.001' && c.code !== '12.001.008') {
                    relink2.set(c.code, modRoot.code);
                }
            }
        }

        // 模块 13 专项纠正：
        //   - 删 13.1（🎯 使用原则 + 4 个铁律子节点）
        //   - 删 13.8（🔀 道具×场景速查表）
        //   - 删 13.9（💡 高级技巧 + 3 个技巧子节点）
        if (mc === '13') {
            for (const code of ['13.001.003', '13.001.003.004', '13.001.003.005', '13.001.003.006', '13.001.003.007',
                                '13.001.053',
                                '13.001.054', '13.001.054.055', '13.001.054.056', '13.001.054.057']) {
                toRemove2.add(code);
            }
        }

        if (mc === '03') {
            const wrap = modCats.find(c => c.level === 2 && /裸露\/液体词库|裸露液体词库/.test(c.title));
            if (wrap) toRemove2.add(wrap.code);
        }

        if (mc === '02') {
            const wrap1 = modCats.find(c => c.level === 2 && /景别·构图·设备·视角/.test(c.title));
            if (wrap1) toRemove2.add(wrap1.code);
            const toc2 = modCats.find(c => c.level === 2 && /^\s*索引/.test(stripEmoji(c.title)));
            if (toc2) toRemove2.add(toc2.code);
        }

        if (mc === '00') {
            for (const k of modCats) {
                if (/^📝\s*完整\s*Prompt\s*范例|^完整\s*Prompt\s*范例/.test(stripEmoji(k.title))) {
                    toRemove2.add(k.code);
                } else if (/^📑\s*范例速查表|^范例速查表/.test(stripEmoji(k.title))) {
                    toRemove2.add(k.code);
                } else if (/^🎯\s*具体范例|^具体范例/.test(stripEmoji(k.title))) {
                    // 0.3 删除标题，但子节点上提
                    toRemove2.add(k.code);
                    for (const g of modCats.filter(c => c.parent_code === k.code)) {
                        relink2.set(g.code, modRoot.code);
                    }
                }
            }
        }

        // 模块 01 专项纠正：
        //   24 scenes（01.002.005~028）原属 TOC，已被上述逻辑挂在「主题角色篇」，
        //   应改为挂在「场景篇」（首个 banner）
        //   22 themes（01.029.030~058，原属「主题/角色词库」）+ 10 themes（01.060.061~070）
        //   → 全部挂到「主题角色篇」
        if (mc === '01') {
            // 删掉 1.1「🏞️ 场景词库（…）」空 wrapper（无实际子节点）
            const emptyWrapper = modCats.find(c => /场景词库/.test(c.title) && c.level === 2);
            if (emptyWrapper) toRemove2.add(emptyWrapper.code);
            const sceneBanner = modCats.find(c => stripEmoji(c.title).replace(/^[️\s]+/, '') === '场景篇');
            const themeBanner = modCats.find(c => stripEmoji(c.title).replace(/^[️\s]+/, '') === '主题角色篇');
            if (sceneBanner && themeBanner) {
                // 重写：把 TOC 下非 banner 的兄弟全部挂到场景篇
                const tocCodes = new Set(tocL2.map(t => t.code));
                for (const k of modCats) {
                    if (k.code !== sceneBanner.code && k.code !== themeBanner.code && tocCodes.has(k.parent_code)) {
                        relink2.set(k.code, sceneBanner.code);
                    }
                }
                // 「主题/角色词库」下的 themes 挂到主题角色篇
                const themeMenu = modCats.find(c => /主题\/角色词库/.test(c.title));
                if (themeMenu) {
                    for (const t of modCats.filter(c => c.parent_code === themeMenu.code)) {
                        relink2.set(t.code, themeBanner.code);
                    }
                    toRemove2.add(themeMenu.code);
                }
                // 「场景生成规则」下的 themes 挂到主题角色篇
                const sceneRules = modCats.find(c => /场景生成规则/.test(c.title));
                if (sceneRules) {
                    for (const t of modCats.filter(c => c.parent_code === sceneRules.code)) {
                        relink2.set(t.code, themeBanner.code);
                    }
                    toRemove2.add(sceneRules.code);
                }
                // 「场景感官锚定速查表」没内容，标记移除
                const sensTable = modCats.find(c => /场景感官锚定/.test(c.title));
                if (sensTable) toRemove2.add(sensTable.code);
            }
        }

        // 模块 06：移除 ═══ 装饰 + 提升「第N部分」为 banner
        if (mc === '06') {
            // 装饰行的 code 已经在 noiseCodes 里了
            const decoSet = new Set();
            for (const c of rawCats) {
                if (/═/.test(c.title || '')) decoSet.add(c.code);
            }
            // 「第N部分」banner
            const partBanners = modCats.filter(c => /第[一二三四五六七八九十]+部分/.test(c.title));
            const ordered = modCats.slice().sort((a, b) => String(a.code).localeCompare(String(b.code)));
            for (const pb of partBanners) {
                relink2.set(pb.code, modRoot.code);
                // 在文档顺序上找 pb 之后、下一「第N部分」之前的所有内容
                const idx = ordered.findIndex(x => x.code === pb.code);
                let end = ordered.length;
                for (let i = idx + 1; i < ordered.length; i++) {
                    if (/^第[一二三四五六七八九十]+部分/.test(ordered[i].title)) { end = i; break; }
                }
                for (let i = idx + 1; i < end; i++) {
                    const c = ordered[i];
                    if (decoSet.has(c.parent_code)) {
                        relink2.set(c.code, pb.code);
                    }
                }
            }
        }
    }

    // 把 relink2 合并进 relinked（已有覆盖）
    for (const [k, v] of relink2) relinked.set(k, v);
    const toRemoveFinal = new Set([...noiseCodes, ...toRemove2]);

    // 索引：parent_code (重链接后) → children[]
    const childrenOf = new Map();
    for (const c of cats) {
        if (toRemoveFinal.has(c.code)) continue;
        const p = relinked.get(c.code) || c.parent_code || '__ROOT__';
        if (!childrenOf.has(p)) childrenOf.set(p, []);
        childrenOf.get(p).push(c);
    }
    // 子节点按 code 排序
    for (const arr of childrenOf.values()) arr.sort((a, b) => String(a.code).localeCompare(String(b.code)));

    // ========== 第三轮：扁平十进制编号 ==========
    // 规则：每级均用「.」分隔：module = N；banner = N.M；child = N.M.K；grandchild = N.M.K.L
    // 例：1, 1.1, 1.1.1, 1.1.2, 1.2, 1.2.1
    const numbering = new Map();
    for (const m of moduleNames) {
        const modRoot = byModule.get(m)[0];
        if (!modRoot) continue;
        const modNum = String(modRoot.code).replace(/^0+/, '') || '0';
        numbering.set(modRoot.code, modNum);
        const banners = childrenOf.get(modRoot.code) || [];
        banners.forEach((b, bi) => {
            const bNum = `${modNum}.${bi + 1}`;
            numbering.set(b.code, bNum);
            const kids = childrenOf.get(b.code) || [];
            kids.forEach((k, ki) => {
                const kNum = `${bNum}.${ki + 1}`;
                numbering.set(k.code, kNum);
                const gcs = childrenOf.get(k.code) || [];
                gcs.forEach((g, gi) => {
                    numbering.set(g.code, `${kNum}.${gi + 1}`);
                });
            });
        });
    }

    // ---------- 写「总览」 ----------
    {
        const md = [];
        md.push('# NSFW 模板库分类总览');
        md.push('');
        md.push('> 数据源：`D:/nsfw-prompt-templates-asian`（14 个模块）');
        md.push('> 解析时间：' + new Date().toISOString().slice(0, 19));
        md.push('> 总分类数：**' + cats.length + '** 个，覆盖 ' + moduleNames.length + ' 个模块');
        md.push('');
        md.push('## 模块清单');
        md.push('');
        md.push('| # | 模块 | 分类数 | 模块路径 |');
        md.push('|---|------|--------|----------|');
        for (const m of moduleNames) {
            md.push('| ' + String(moduleNames.indexOf(m) + 1) + ' | `' + m + '` | ' + byModule.get(m).length + ' | [详情](./modules/' + m.replace(/\s/g, '_') + '分类树.md) |');
        }
        md.push('');
        md.push('---');
        md.push('');

        // 每个模块一节，渲染为紧凑分层列表（按 depth 缩进）
        for (const m of moduleNames) {
            md.push('## 📂 ' + m);
            md.push('');
            md.push('分类数：**' + byModule.get(m).length + '**');
            md.push('');
            // 找出本模块的根分类
            const modRoot = byModule.get(m)[0];
            const roots = childrenOf.get(modRoot.code) || [];
            for (const r of roots) {
                renderTreeNode(md, r, byPath, childrenOf, 0, numbering);
            }
            md.push('');
        }

        fs.writeFileSync(path.join(OUT_DIR, '00-分类总览.md'), md.join('\n'), 'utf8');
        console.log('  ✓ 00-分类总览.md');
    }

    // ---------- 写每个模块的独立文件 ----------
    for (const m of moduleNames) {
        const md = [];
        md.push('# ' + m + ' — 分类树');
        md.push('');
        md.push('> 模块路径：`' + m + '`');
        md.push('> 分类数：**' + byModule.get(m).length + '**');
        md.push('');
        const modRoot = byModule.get(m)[0];
        md.push('## 层级结构');
        md.push('');
        md.push('```');
        // 树状字符画
        renderAsciiTree(md, modRoot, byPath, childrenOf, '', true, numbering);
        md.push('```');
        md.push('');

        // 路径列表（用重链接后的新结构重建路径）
        md.push('## 路径列表（按 depth 排序）');
        md.push('');
        md.push('| Level | 完整路径 | 名称 | code | 描述 |');
        md.push('|------|---------|-----|------|------|');
        const newPath = new Map();
        newPath.set(modRoot.code, modRoot.title.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '').trim());
        function visit(c) {
            const children = childrenOf.get(c.code) || [];
            for (const ch of children) {
                const parentPath = newPath.get(c.code) || '';
                const name = ch.title.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '').trim();
                newPath.set(ch.code, parentPath + '/' + name);
                visit(ch);
            }
        }
        visit(modRoot);
        const sortedMod = byModule.get(m).filter(c => !toRemoveFinal.has(c.code))
            .sort((a, b) => Number(a.level) - Number(b.level) || String(a.code).localeCompare(String(b.code)));
        for (const c of sortedMod) {
            const path = newPath.get(c.code) || c.path;
            md.push('| ' + c.level + ' | `' + path + '` | ' + c.title.replace(/\|/g, '\\|') + ' | `' + c.code + '` | ' + (c.description ? truncate(c.description.replace(/[\r\n]+/g, ' '), 80).replace(/\|/g, '\\|') : '') + ' |');
        }
        md.push('');

        fs.writeFileSync(path.join(OUT_DIR, 'modules', m.replace(/\s/g, '_') + '分类树.md'), md.join('\n'), 'utf8');
        console.log('  ✓ modules/' + m.replace(/\s/g, '_') + '分类树.md');
    }

    // ---------- 一份纯 ASCII 大树 ----------
    {
        const md = [];
        md.push('# NSFW 模板库 — 完整分类树（ASCII）');
        md.push('');
        for (const m of moduleNames) {
            md.push('## ' + m);
            md.push('');
            md.push('```');
            const modRoot = byModule.get(m)[0];
            renderAsciiTree(md, modRoot, byPath, childrenOf, '', true, numbering);
            md.push('```');
            md.push('');
        }
        fs.writeFileSync(path.join(OUT_DIR, '01-完整分类树-ASCII.md'), md.join('\n'), 'utf8');
        console.log('  ✓ 01-完整分类树-ASCII.md');
    }

    // ---------- 第四轮（可选）：按当前视觉层级重写 categories.json 的 code + parent_code ----------
    // 格式：保持零填充点分十进制 (MM.SSS[.SSS[.SSS]])；
    //       每段数字 = 该深度下的视觉位置号（从 1 起）
    // 例：视觉 12.1 → 12.001；视觉 12.1.2 → 12.001.002；视觉 12.1.2.3 → 12.001.002.003
    // 用法：node scripts/extract-categories-to-md.js --rebuild-codes
    if (process.argv.includes('--rebuild-codes')) {
        const padCode = (visual) => {
            if (!visual) return null;
            const parts = String(visual).split('.');
            const head = String(Number(parts[0])).padStart(2, '0');
            const tail = parts.slice(1).map(p => String(Number(p)).padStart(3, '0'));
            return [head, ...tail].join('.');
        };
        const codeRemap = new Map();
        for (const [oldCode, visual] of numbering) {
            codeRemap.set(oldCode, padCode(visual));
        }
        // 1) 激活分类按视觉层级重写 code + parent_code
        let rewritten = 0;
        const usedCodes = new Set();
        for (const c of cats) {
            if (!codeRemap.has(c.code)) continue;
            const oldCode = c.code;
            const newCode = codeRemap.get(oldCode);
            const parentOld = relinked.get(oldCode) || c.parent_code;
            c.code = newCode;
            usedCodes.add(newCode);
            if (!parentOld || parentOld === '__ROOT__') {
                c.parent_code = null;
            } else if (codeRemap.has(parentOld)) {
                c.parent_code = codeRemap.get(parentOld);
            } else {
                c.parent_code = parentOld;
            }
            rewritten++;
        }
        // 2) 已删除 / 孤儿分类：保留原 code，若与激活 code 冲突 → 加 _r 后缀
        let renamed = 0;
        let kept = 0;
        for (const c of cats) {
            if (codeRemap.has(c.code)) continue;
            if (usedCodes.has(c.code)) {
                let alt = c.code + '_r';
                while (usedCodes.has(alt)) alt += 'r';
                c.code = alt;
                usedCodes.add(alt);
                renamed++;
            } else {
                usedCodes.add(c.code);
                kept++;
            }
        }
        fs.writeFileSync(CATS_PATH, JSON.stringify(rawCats, null, 2), 'utf8');
        console.log('');
        console.log('  ✓ code 已重建：激活 ' + rewritten + ' 条按视觉层级 / 保留原 code ' + kept + ' 条 / 冲突后改名 ' + renamed + ' 条');
        console.log('    → ' + CATS_PATH);
    }

    console.log('');
    console.log('✓ 完成，输出在 ' + OUT_DIR);
}

function renderTreeNode(md, cat, byPath, childrenOf, depth, numbering) {
    const indent = '  '.repeat(depth);
    const marker = depth === 0 ? '###' : (depth === 1 ? '####' : (depth === 2 ? '#####' : '######'));
    const descSnippet = cat.description ? ' — ' + truncate(cat.description.replace(/[\r\n]+/g, ' '), 50) : '';
    const num = numbering && numbering.get(cat.code) ? numbering.get(cat.code) + ' ' : '';
    md.push(indent + marker + ' ' + num + cat.title.replace(/[\r\n]+/g, ' ').trim() + ' `' + cat.path + '`' + descSnippet);

    const children = childrenOf.get(cat.code) || [];
    for (const ch of children) {
        renderTreeNode(md, ch, byPath, childrenOf, depth + 1, numbering);
    }
}

function renderAsciiTree(md, cat, byPath, childrenOf, prefix, isLast, numbering) {
    const connector = isLast ? '└── ' : '├── ';
    const num = numbering && numbering.get(cat.code) ? numbering.get(cat.code) + ' ' : '';
    md.push(prefix + connector + num + cat.title.replace(/[\r\n]+/g, ' ').trim() + '  [' + cat.code + ']');

    const children = childrenOf.get(cat.code) || [];
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const last = (i === children.length - 1);
        renderAsciiTree(md, child, byPath, childrenOf, childPrefix, last, numbering);
    }
}

function truncate(s, n) {
    s = String(s || '').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
}

main();
