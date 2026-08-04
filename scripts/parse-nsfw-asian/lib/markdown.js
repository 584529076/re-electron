// scripts/parse-nsfw-asian/lib/markdown.js
// 把 .md 解析成线性 section 列表 + tree。
// 设计：扫一遍，用栈维护当前 heading 链；遇到 block 就 push 到当前叶子。
// 这样每个 section 已自然携带它的 content（content 字段是 block 数组）。

'use strict';

/**
 * @param {string} text
 * @returns {{
 *   title: string,
 *   blocks: Array<{type, ...}>,
 *   rootSections: Array<Section>,
 * }}
 *
 * Section = {
 *   level, heading, title, code,
 *   blocks: Block[],       // 直接归属此 section 的 block（不含子 section 的）
 *   tables: Array,         // 从 blocks 里过滤出 type==='table'
 *   codeList: string[],    // 从 blocks 里过滤出 type==='code' 且去反引号合并 + 按分隔符切
 *   rawCodeText: string,   // 把所有 code block 合并，按分隔符切前的大文本
 *   children: Section[],
 * }
 */
function parseMd(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let inCode = false;
  let codeBuf = [];
  let codeLang = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      if (!inCode) {
        inCode = true;
        codeLang = trimmed.replace(/^```/, '').trim();
        codeBuf = [];
      } else {
        inCode = false;
        blocks.push({ type: 'code', lang: codeLang, text: codeBuf.join('\n') });
        codeBuf = [];
        codeLang = '';
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    const hMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (hMatch) {
      blocks.push({ type: 'heading', level: hMatch[1].length, heading: hMatch[2].trim() });
      i++;
      continue;
    }

    if (/^\|/.test(trimmed)) {
      const tblLines = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        tblLines.push(lines[i]);
        i++;
      }
      const t = parseTable(tblLines);
      if (t) blocks.push({ type: 'table', ...t });
      else blocks.push({ type: 'para', text: tblLines.join('\n') });
      continue;
    }

    if (/^>/.test(trimmed)) {
      const qLines = [];
      while (i < lines.length && /^>/.test(lines[i].trim())) {
        qLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: qLines.join('\n') });
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (trimmed) {
      const pLines = [line];
      i++;
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next || /^#{1,6}\s/.test(next) || /^```/.test(next) || /^\|/.test(next) || /^>/.test(next) || /^---+$/.test(next) || /^\*\*\*+$/.test(next)) break;
        pLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'para', text: pLines.join('\n').trim() });
      continue;
    }
    i++;
  }

  // 构造 sections
  const flat = [];
  const stack = [];
  for (const b of blocks) {
    if (b.type === 'heading') {
      const sec = {
        level: b.level,
        heading: b.heading,
        title: cleanTitle(b.heading),
        code: extractCode(b.heading),
        blocks: [],
        tables: [],
        codeList: [],
        rawCodeText: '',
        children: [],
        _block: b,
      };
      while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) stack.pop();
      if (stack.length === 0) {
        flat.push({ section: sec, isRoot: true });
      } else {
        stack[stack.length - 1].section.children.push(sec);
      }
      stack.push({ section: sec, level: sec.level });
    } else {
      // 归属到当前栈顶 section
      if (stack.length > 0) {
        stack[stack.length - 1].section.blocks.push(b);
      }
    }
  }

  // 计算每个 section 的 tables / codeList / rawCodeText / inlineBackticks
  const allSections = collectAll(flat.filter(f => f.isRoot).map(f => f.section));
  for (const s of allSections) {
    for (const b of s.blocks) {
      if (b.type === 'table') s.tables.push(b);
      if (b.type === 'code') {
        s.codeList.push(...splitPhrases(b.text));
        s.rawCodeText += (s.rawCodeText ? '\n' : '') + b.text;
      }
      // para / quote / table 单元格：inline backtick 短语（如 `xxx, yyy, zzz`）
      const txt = (b.type === 'para' || b.type === 'quote') ? b.text
                : (b.type === 'table') ? b.rows.map(r => r.join(' ')).join('\n')
                : '';
      if (txt) {
        const inlineList = extractInlineBackticks(txt);
        if (inlineList.length) s.codeList.push(...inlineList);
      }
    }
    // 清掉 _block（不序列化）
    delete s._block;
  }

  const title = extractTitle(blocks);
  return {
    title,
    blocks,
    rootSections: flat.filter(f => f.isRoot).map(f => f.section),
    allSections,
  };
}

function parseTable(lines) {
  if (lines.length < 2) return null;
  const splitter = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[1].trim());
  if (!splitter) return null;
  const headers = splitRow(lines[0]);
  const rows = [];
  for (let k = 2; k < lines.length; k++) {
    const cells = splitRow(lines[k]);
    while (cells.length < headers.length) cells.push('');
    if (cells.length > headers.length) cells.length = headers.length;
    rows.push(cells);
  }
  return { headers, rows };
}

function splitRow(line) {
  const trimmed = line.trim();
  const noOuter = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const noOuter2 = noOuter.endsWith('|') ? noOuter.slice(0, -1) : noOuter;
  return noOuter2.split('|').map(s => s.trim());
}

/**
 * 把一段文本按 , / ， / \n / | / + 切成短语；并清掉纯标点 / 全空 / 单字符的垃圾项。
 * 也兼容 inline backticks 的包围（去掉外层 ` 后再切）。
 */
function splitPhrases(text) {
  if (!text) return [];
  let t = String(text).trim();
  // 去外层围栏（``` → 已在外层去；inline ` → 同样去掉首尾单引号）
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z0-9]*\n?/, '').replace(/\n?```\s*$/, '');
  if ((t.startsWith('`') && t.endsWith('`')) && t.length > 2) t = t.slice(1, -1);
  // 多个连续反引号围绕的多行 → 全文按反引号围外 / 围内取
  const out = [];
  for (const seg of t.split(/[,,，\n/|+]+/)) {
    const s = seg.trim();
    if (!s) continue;
    if (/^[\s\-─]+$/.test(s)) continue;
    if (/^[.。;;:!?]+$/.test(s)) continue;
    // 跳过看起来像 markdown 链接/图片的残段
    if (/^!?\[[^\]]+\]\([^\)]+\)$/.test(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * 短语归一化（用于 dedup）：lower + 折叠标点 + 折叠多空白。
 * 注意不去掉英文里的撇号等，保留可读性。
 */
function normalizePhrase(phrase) {
  if (!phrase) return '';
  return String(phrase)
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/^[\s,，、;:；]+|[\s,，、;:；]+$/g, '')
    .trim();
}

function cleanTitle(heading) {
  let s = heading;
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  s = s.replace(/^[\s]*[①②③④⑤⑥⑦⑧⑨]\s*/, '');
  s = s.replace(/^[\s]*[0-9]+\.\s+/, '');
  s = s.replace(/^[\s]*Part\s+\d+\s*[:：]?\s*/i, '');
  s = s.replace(/（.*?）/g, '').replace(/\(.*?\)/g, '');
  return s.trim();
}

function extractCode(heading) {
  const m = /[①②③④⑤⑥⑦⑧⑨]/.exec(heading);
  if (m) return m[0];
  const m2 = /^[\s]*([0-9]+)\.\s+/.exec(heading);
  if (m2) return m2[1];
  return null;
}

function extractTitle(blocks) {
  for (const b of blocks) {
    if (b.type === 'heading' && b.level === 1) return cleanTitle(b.heading);
  }
  return '';
}

function collectAll(secs) {
  const out = [];
  (function walk(ss, parent) {
    for (const s of ss) {
      if (parent) s.parent = parent;
      out.push(s);
      walk(s.children, s);
    }
  })(secs, null);
  return out;
}

/**
 * 判断一张表是不是「联动速查 / 禁忌 / 必禁」类表（启发式：表头含特定关键词）
 */
function isLinkageTable(headers) {
  if (!headers || headers.length === 0) return false;
  const joined = headers.join('|').toLowerCase();
  return /推荐|禁忌|禁止|必选|可选|联动|速查|匹配|对应|关联|组合|对应关系|脱法|必\b|选\b|适用|适合|wrong|never|forbid|场景/.test(joined);
}

/**
 * 是否在某 section 下属于联动 / 禁忌 / 速查的子树（用 section 标题启发式）
 */
function sectionIsLinkageContext(sectionTitle) {
  return /联动|速查|禁止|禁用|禁忌|配套|对|搭配|组合/.test(sectionTitle);
}

/**
 * 提取 inline backtick 短语：匹配 `` `xxx, yyy, zzz` `` 多行（反引号围栏）
 * 每个反引号对里的内容按分隔符切。
 */
function extractInlineBackticks(text) {
  if (!text) return [];
  const out = [];
  // 匹配 `` ` ... ` ``（单反引号围栏，最短优先 + 允许长内容）
  // 注意：贪婪最小匹配，避免贪婪匹配跨多个 backtick 块
  const re = /`([^`\n]{4,4000})`/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let inner = m[1].trim();
    // 去 markdown 加粗标记 `**xxx**` 等
    inner = inner.replace(/^\*\*|\*\*$/g, '');
    // 必须看起来像短语列表（至少含一个 , 或至少 2 个英文单词）
    const wordCount = inner.split(/\s+/).filter(Boolean).length;
    const hasLatin = /[a-zA-Z]/.test(inner);
    if (!hasLatin) continue;        // 跳过纯中文 backtick 块
    if (inner.includes(',') || inner.includes('/') || inner.includes('+') || wordCount >= 2) {
      for (const p of splitPhrases(inner)) out.push(p);
    }
  }
  return out;
}

/**
 * 通用：从 section 列表提取 vocabulary phrases
 * - 反引号代码块中按分隔符切 → 每个切出来的 phrase = 1 item
 * - 表格里如果某一列就是信号词（不是数字、不是英文标点串）→ 也提取
 * 判定表里「哪一列是短语」：若列内容是英文逗号分隔短语 OR 多短语，行单元格作为 1 个 item 的 content。
 */
function extractPhrases(section) {
  const phrases = [];
  // 反引号文本 → 已 splitPhrases 切过
  for (const p of section.codeList) phrases.push({ phrase: p, source: 'code' });
  // 表格行：如果某列像是描述，短语就在其它列
  for (const t of section.tables) {
    const hdrsLower = t.headers.map(h => String(h || '').toLowerCase());
    // 启发：若包含 `信号词` / `关键词` / `英文` / `提示词` / `content` / `name` → 该列为短语
    // 或者首列就是短语（不含大量中文）
    const phraseColIdx = pickPhraseColumn(t.headers);
    if (phraseColIdx < 0) continue;
    const descColIdx = pickDescriptionColumn(t.headers, phraseColIdx);
    for (const row of t.rows) {
      const raw = row[phraseColIdx] || '';
      for (const p of splitPhrases(raw)) {
        phrases.push({
          phrase: p,
          source: 'table',
          description: descColIdx >= 0 ? (row[descColIdx] || '') : '',
          tableHeaders: t.headers,
          tableRow: row,
        });
      }
    }
  }
  return phrases;
}

function pickPhraseColumn(headers) {
  if (!headers.length) return -1;
  const keys = [
    /信号词/, /关键词/, /场景词/, /具体场景/, /英文/, /提示词/, /短语/, /词汇/,
    /^content$/i, /^name$/i, /^term/i, /^code$/i, /英文提示词/, /词汇库/, /词\s*$/i,
    /prompt/i, /token/i,
  ];
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').trim();
    for (const k of keys) if (k.test(h)) return i;
  }
  // 默认第一列
  return 0;
}

function pickDescriptionColumn(headers, phraseIdx) {
  if (!headers.length) return -1;
  const keys = [
    /视觉特征/, /中文含义/, /中文/, /描述/, /说明/, /定义/, /解释/, /含义/,
    /^description$/i, /^meaning$/i, /^definition$/i, /注解/, /氛围/, /特点/,
    /感官锚定/, /适用/, /场景/,
  ];
  for (let i = 0; i < headers.length; i++) {
    if (i === phraseIdx) continue;
    const h = String(headers[i] || '').trim();
    for (const k of keys) if (k.test(h)) return i;
  }
  // 默认最后一个
  return headers.length - 1;
}

/**
 * 判定单元格里是否像英文短语列表：
 * - 必须含至少一个 latin 字符
 * - 且（逗号 OR ≥ 2 个英文词 OR 长度 ≥ 8 且全 ASCII）
 * - 不允许纯中文 / emoji 串走 ✓
 *
 * 算法：
 *   1. 提取其中的「拉丁词」列表（按空白 / 标点切 + 保留带逗号的整体）
 *   2. 若拉丁词数量 ≥ 2 → 像英文短语
 *   3. 若单串拉丁字符 ≥ 8 → 也算
 *   4. 多个拉丁词但都在中文 / emoji 混杂中 → 返回 false
 */
function looksLikeEnglishPhrase(cellText) {
  if (!cellText) return false;
  const t = String(cellText);
  // 1. 整体拉丁字母数 ≥ 8 （如 "bedroom, hotel room"） → 直接通过
  const overallLatin = t.replace(/[^a-zA-Z]/g, '');
  if (overallLatin.length >= 8 && (t.includes(',') || t.includes('/') || /\s+/.test(t))) return true;
  // 2. 拆出独立的拉丁 token（≥2 字符）
  const latinTokens = (t.match(/[a-zA-Z][a-zA-Z\s\-]*[a-zA-Z]/g) || []).filter(Boolean);
  if (latinTokens.length >= 2) return true;
  return false;
}

module.exports = {
  parseMd,
  parseTable,
  splitRow,
  splitPhrases,
  normalizePhrase,
  cleanTitle,
  extractCode,
  isLinkageTable,
  sectionIsLinkageContext,
  extractInlineBackticks,
  extractPhrases,
  pickPhraseColumn,
  pickDescriptionColumn,
  looksLikeEnglishPhrase,
};
