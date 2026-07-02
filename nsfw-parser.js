// nsfw-parser.js — D-30 NSFW 模板解析器
//
// 输入：14 个 .md 文件（从 ShuaiHui/nsfw-prompt-templates-asian）
// 输出：结构化数据（modules[] + tags[]）
//
// 解析策略（按文件结构差异处理）：
//   1) 13 个标准 .md（01-13）：用 markdown 表格 + code block 提取词条
//   2) 14-人格卡片.md：纯表格（7 列），最后一列是英文核心
//   3) 00-范例.md：跳过（只是示例，不是数据源）
//   4) README.md：跳过（说明性）
//
// 词条来源：
//   - 表格：`| \`xxx, yyy\` | 中文描述 |` → tag.en = `xxx, yyy`，tag.name = 中文
//   - code block（多行逗号分隔）：`a, b, c,\nd, e` → 拆成多个独立 tag
'use strict';

const fs = require('fs');
const path = require('path');

// ============ 14 个模块元信息（硬编码，因为 README 描述清晰） ============
const MODULE_META = [
    { file: '01-场景主题.md', id: 'scene',         name: '场景+主题',     order: 1,  mustHave: true,  canSkip: false, weight: 0.18, desc: '去哪？什么故事？' },
    { file: '02-景别构图.md', id: 'shot',          name: '景别+视角+设备', order: 2,  mustHave: true,  canSkip: false, weight: 0.12, desc: '怎么拍？什么角度？' },
    { file: '03-裸露液体.md', id: 'nudity',        name: '裸露+液体',     order: 3,  mustHave: true,  canSkip: false, weight: 0.18, desc: '露多少？什么液体？' },
    { file: '04-服装专项.md', id: 'clothing',      name: '服装状态',     order: 4,  mustHave: true,  canSkip: false, weight: 0.10, desc: '穿什么？怎么脱？' },
    { file: '05-光影氛围.md', id: 'lighting',      name: '光影氛围',     order: 5,  mustHave: true,  canSkip: false, weight: 0.10, desc: '什么光？什么色温？' },
    { file: '06-姿势动作.md', id: 'pose',          name: '姿势动作',     order: 6,  mustHave: true,  canSkip: false, weight: 0.15, desc: '什么姿势？什么动作？' },
    { file: '07-表情眼神.md', id: 'expression',    name: '表情眼神',     order: 7,  mustHave: true,  canSkip: false, weight: 0.07, desc: '什么表情？' },
    { file: '08-风格胶片.md', id: 'film',          name: '风格胶片',     order: 8,  mustHave: false, canSkip: true,  weight: 0.05, desc: '风格/胶片/电影' },
    { file: '09-妆容专项.md', id: 'makeup',        name: '妆容',         order: 9,  mustHave: false, canSkip: true,  weight: 0.04, desc: '妆容/美甲' },
    { file: '10-发型饰品.md', id: 'hair',          name: '发型饰品',     order: 10, mustHave: false, canSkip: true,  weight: 0.04, desc: '发型/首饰' },
    { file: '11-瑕疵细节.md', id: 'imperfection',  name: '瑕疵细节',     order: 11, mustHave: false, canSkip: true,  weight: 0.03, desc: '痣/手足/光影/年龄感' },
    { file: '12-纹身标记.md', id: 'tattoo',        name: '纹身标记',     order: 12, mustHave: false, canSkip: true,  weight: 0.03, desc: '纹身图案/文字' },
    { file: '13-道具宠物.md', id: 'prop',          name: '道具宠物',     order: 13, mustHave: false, canSkip: true,  weight: 0.04, desc: '道具/宠物/氛围物件' },
    { file: '14-人格卡片.md', id: 'persona',       name: '人格卡片',     order: 14, mustHave: false, canSkip: true,  weight: 0.07, desc: '身份/职业/人格纵深' },
];

// ============ 解析单文件 ============
function parseFile(filePath, moduleMeta) {
    // 14-人格卡片 用特殊解析：7 列表格
    if (moduleMeta.id === 'persona') {
        return parsePersonaFile(filePath, moduleMeta);
    }
    return parseStandardFile(filePath, moduleMeta);
}

// 14-人格卡片：7 列表格，第 1 列序/第 2 列身份职业/第 7 列英文核心
function parsePersonaFile(filePath, moduleMeta) {
    const text = fs.readFileSync(filePath, 'utf-8');
    const tags = [];
    let currentSection = '';
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.startsWith('## ') && !t.startsWith('### ')) {
            currentSection = stripMdBold(stripEmoji(t.replace(/^##\s+/, '')));
            continue;
        }
        if (!t.startsWith('|') || !t.endsWith('|')) continue;
        const cells = splitTableRow(t);
        if (cells.length < 7) continue;
        // 第 1 列必须是数字（序号）
        if (!/^\d+$/.test(cells[0])) continue;
        // 第 2 列是身份职业（中文）
        const jobZh = stripMdBold(stripEmoji(cells[1])).trim();
        // 第 7 列是英文核心
        const enRaw = cells[6];
        if (!isMostlyEnglish(enRaw)) continue;
        const en = enRaw.replace(/^[`"'*\s,]+|[`"'*\s,]+$/g, '').trim();
        if (!en || en.length < 5) continue;
        tags.push({
            id: makeId('persona', en),
            module: 'persona',
            name: jobZh || en.split(',')[0].slice(0, 20),
            en: en,
            weight: moduleMeta.weight,
            section: currentSection,
            subSection: '',
            desc: jobZh,
        });
    }
    return tags;
}

function parseStandardFile(filePath, moduleMeta) {
    const text = fs.readFileSync(filePath, 'utf-8');
    const tags = [];

    // 按行扫描
    const lines = text.split('\n');
    let currentSection = null;  // 当前 ## 标题（用作 tag 的 section 字段）
    let currentSubSection = null;  // 当前 ### 标题

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 跟踪章节
        if (line.startsWith('## ') && !line.startsWith('### ')) {
            currentSection = stripEmoji(line.replace(/^##\s+/, '')).trim();
            currentSubSection = null;
            continue;
        }
        if (line.startsWith('### ')) {
            currentSubSection = stripEmoji(line.replace(/^###\s+/, '')).trim();
            continue;
        }

        // 1) 表格行：| `xxx, yyy` | 中文 |
        if (line.startsWith('|') && line.endsWith('|') && line.includes('`')) {
            const cells = splitTableRow(line);
            // 找第一个含反引号的 cell
            const codeCell = cells.find(c => c.includes('`'));
            if (!codeCell) continue;
            // 提取反引号里的所有英文片段
            const enFragments = extractCodeFragments(codeCell);
            if (enFragments.length === 0) continue;
            // 找第一个中文描述 cell
            const descCell = cells.find(c => !c.includes('`') && /[\u4e00-\u9fa5]/.test(c));

            for (const en of enFragments) {
                if (!en || en.length < 3) continue;
                const tag = buildTag(moduleMeta, en, currentSection, currentSubSection, descCell);
                if (tag) tags.push(tag);
            }
            continue;
        }

        // 2) code block：多行逗号分隔的英文词条（在 ``` 内）
        if (line.startsWith('```') && !line.includes('```', 3)) {
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            const block = codeLines.join('\n');
            // 拆成单条
            const items = splitCodeBlock(block);
            for (const en of items) {
                if (!en || en.length < 3) continue;
                const tag = buildTag(moduleMeta, en, currentSection, currentSubSection, null);
                if (tag) tags.push(tag);
            }
        }
    }

    return tags;
}

function buildTag(moduleMeta, en, section, subSection, descCell) {
    if (!en) return null;
    // 清理 en：去 markdown 粗体/反引号、首尾标点
    en = en.replace(/\*\*/g, '')
           .replace(/^[`"'*\s,]+|[`"'*\s,]+$/g, '')
           .trim();
    if (!en || en.length < 3) return null;
    // 至少 60% 是英文字母（防止抓到"01-场景主题.md"或纯中文行）
    if (!isMostlyEnglish(en)) return null;

    // 中文描述：去 markdown 加粗、emoji
    const descZhRaw = descCell ? descCell : (subSection || section || '');
    const descZh = stripMdBold(stripEmoji(descZhRaw)).trim();
    // name：优先 descZh，否则从 en 抽第一个英文短语
    const name = descZh || en.split(',')[0].trim().slice(0, 20);

    return {
        id: makeId(moduleMeta.id, en),
        module: moduleMeta.id,
        name: stripMdBold(name),
        en: en,
        weight: moduleMeta.weight,
        section: stripMdBold(section || ''),
        subSection: stripMdBold(subSection || ''),
        desc: descZh,
    };
}

function stripMdBold(s) {
    if (!s) return '';
    return s.replace(/\*\*/g, '').trim();
}

function isMostlyEnglish(s) {
    if (!s) return false;
    // 统计英文字母数量
    const letters = (s.match(/[a-zA-Z]/g) || []).length;
    return letters >= 3 && letters / s.length >= 0.4;
}

function makeId(moduleId, en) {
    // 用 en 前 30 字符做 id 基础，保证稳定
    const base = en.toLowerCase()
        .replace(/[^a-z0-9, ]/g, '')
        .replace(/[\s,]+/g, '_')
        .slice(0, 30)
        .replace(/^_+|_+$/g, '');
    return `${moduleId}__${base || Math.random().toString(36).slice(2, 8)}`;
}

function stripEmoji(s) {
    if (!s) return '';
    // 去掉所有 BMP 外的 emoji + 常见符号
    return s.replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
            .replace(/[\u2600-\u27BF]/g, '')
            .replace(/[?⚡]/g, '')
            .trim();
}

function splitTableRow(line) {
    // 去掉首尾 | 然后按 | 切
    return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function extractCodeFragments(cell) {
    // 提取 `` `xxx, yyy` `` 里的内容
    const out = [];
    const re = /`([^`]+)`/g;
    let m;
    while ((m = re.exec(cell)) !== null) {
        out.push(m[1]);
    }
    return out;
}

function splitCodeBlock(block) {
    // 拆 code block：每行一条，逗号分隔
    const out = [];
    for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
        // 逗号分隔多个
        const parts = trimmed.split(/,\s*/).map(p => p.trim()).filter(p => p.length > 0);
        out.push(...parts);
    }
    return out;
}

// ============ 解析整个目录 ============
function parseDirectory(dirPath) {
    const result = {
        modules: [],
        tags: [],
        stats: { totalTags: 0, totalModules: 0, byModule: {} },
    };

    for (const meta of MODULE_META) {
        const filePath = path.join(dirPath, meta.file);
        if (!fs.existsSync(filePath)) {
            console.warn(`[nsfw-parser] missing: ${meta.file}`);
            continue;
        }
        const tags = parseFile(filePath, meta);
        // 去重（按 en）
        const seen = new Set();
        const deduped = tags.filter(t => {
            if (seen.has(t.en)) return false;
            seen.add(t.en);
            return true;
        });
        result.modules.push({
            id: meta.id,
            name: meta.name,
            order: meta.order,
            mustHave: meta.mustHave,
            canSkip: meta.canSkip,
            weight: meta.weight,
            desc: meta.desc,
            file: meta.file,
            tagCount: deduped.length,
        });
        result.tags.push(...deduped);
        result.stats.byModule[meta.id] = deduped.length;
        console.log(`[nsfw-parser] ${meta.file}: ${deduped.length} tags`);
    }

    result.stats.totalModules = result.modules.length;
    result.stats.totalTags = result.tags.length;
    return result;
}

module.exports = { MODULE_META, parseFile, parseDirectory };
