// scripts/parse-nsfw-asian/modules.js
// 14 个模块的 parser（导出 parseModule(moduleKey, parsed)）
//
// 输入：parseMd() 结果
// 输出：{
//   moduleCode, modulePath, description,
//   sections,           // Section[]（与 parsed.rootSections 相同）
//   items,              // 候选 item[]
//   categories,         // 候选 category[]
//   associations,       // 关联 / 互斥规则
//   examples,           // 00-范例用
// }

'use strict';

const {
  splitPhrases, pickPhraseColumn, pickDescriptionColumn,
  sectionIsLinkageContext, looksLikeEnglishPhrase,
} = require('./lib/markdown');

// ============ 通用：把所有 section 的 phrases 收集成 item 候选 ============

function collectItemsFromSections(rootSections, modulePath, cb) {
  const items = [];
  function walk(secs, parentChain, inLinkage) {
    const linkage = inLinkage || false;
    for (const s of secs) {
      const chain = parentChain.concat([s.title]);
      const sectionLinkage = linkage || sectionIsLinkageContext(s.title);
      const category_path = chain.join(' / ');

      if (!sectionLinkage) {
        for (const p of s.codeList) {
          items.push({
            phrase: p,
            category_path,
            category_full_name: category_path,
            category_code: null,
            module: modulePath,
            source_module: modulePath,
            source_section: s.title,
            source_kind: 'code',
            description: '',
            sensitivity: 'nsfw',
            is_required: cb ? cb(s) : false,
          });
        }
        for (const t of s.tables) {
          const headers = t.headers || [];
          if (headers.length < 2) continue;
          if (isLinkageTable(headers)) continue;
          const phraseCol = pickPhraseColumn(headers);
          if (phraseCol < 0) continue;
          const descCol = pickDescriptionColumn(headers, phraseCol);
          for (const row of t.rows) {
            const raw = row[phraseCol] || '';
            if (!looksLikeEnglishPhrase(raw)) continue;  // 只抽英文短语列表
            for (const p of splitPhrases(raw)) {
              items.push({
                phrase: p,
                category_path,
                category_full_name: category_path,
                category_code: null,
                module: modulePath,
                source_module: modulePath,
                source_section: s.title,
                source_kind: 'table',
                description: descCol >= 0 ? (row[descCol] || '') : '',
                sensitivity: 'nsfw',
                is_required: false,
              });
            }
          }
        }
      }
      walk(s.children, chain, sectionLinkage);
    }
  }
  walk(rootSections, [modulePath], false);
  return items;
}

function isLinkageTable(headers) {
  const j = headers.join('|');
  return /推荐|禁忌|禁止|必选|可选|联动|速查|匹配|脱法|对应|补充词|必\b|选\b|适用|适合/.test(j);
}

// ============ 通用：从「禁止组合」「联动速查」类表抽取 association ============

function collectAssociationsFromTables(rootSections, modulePath, sourceTag) {
  const out = [];
  const seen = new Set();
  function add(a) {
    const k = a.type + '|' + a.source + '|' + a.a + '||' + a.b;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a);
  }
  function walk(secs) {
    for (const s of secs) {
      // 标题级禁止段（03 附录 C 等）—— 已由特定模块的 parser 处理；这里只处理通用表格
      for (const t of s.tables) {
        const headers = t.headers || [];
        if (!isLinkageTable(headers)) continue;
        const j = headers.join('|');
        const isForbidden = /禁忌|禁止|必禁|禁用|不许|不可|不能/.test(j);
        if (!isForbidden) continue;
        for (let c = 1; c < headers.length; c++) {
          const h = headers[c];
          if (!/禁忌|禁止|必禁|禁用|不许|不可|不能|wrong|bad|never|冲突|fall|conflict/i.test(h)) continue;
          for (const row of t.rows) {
            const leftCells = splitPhrases(row[0] || '');
            const rightCells = splitPhrases(row[c] || '');
            for (const l of leftCells) for (const r of rightCells) {
              if (l && r && l !== r) {
                add({
                  type: 'exclusive', scope: 'item',
                  a: l, b: r,
                  weight: 100, reason: s.title + ' / ' + h,
                  source: sourceTag,
                  source_module: modulePath,
                  association_kind: 'forbidden',
                });
              }
            }
          }
        }
      }
      walk(s.children);
    }
  }
  walk(rootSections);
  return out;
}

// ============ 5 个深度定制模块 ============

function parse00Examples(parsed, modulePath) {
  // 00-范例.md：每条 /draw [英文] | [中文]
  const examples = [];
  const items = [];
  const associations = [];
  for (const sec of parsed.allSections) {
    for (const b of sec.blocks) {
      const text = (b.type === 'para' || b.type === 'quote' || b.type === 'code') ? b.text : '';
      if (!text) continue;
      const lines = text.split(/\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        const m1 = /^\/?draw\s+(.+?)\s*\|\s*(.+)$/.exec(t);
        if (m1) {
          examples.push({
            title: m1[2].trim(),
            english_content: m1[1].trim(),
            chinese_description: m1[2].trim(),
            style: '',
            keywords: m1[1].toLowerCase().split(/[,,，\s]+/).filter(Boolean).slice(0, 30),
            category: sec.title || '通用',
          });
        }
      }
    }
  }
  return { items, categories: [], associations, examples, sections: parsed.rootSections };
}

function parse01Scenes(parsed, modulePath) {
  // 综合：通用（codeList = inline backticks）+ 表格
  // 通用：用 row[0] 作为细化分类前缀（仅当 row[0] 看起来像具体场景名）
  const items = [];
  // 把 leaf sec 还原为 modulePath-prefixed category_path；
  // 保留所有中间 rootSection.title；若首项 (rootSection.title) ≠ modulePath，
  // 在前面 prepend modulePath（categories 的根是 modulePath 自身）。
  const chainCache = new WeakMap();
  function chainOf(sec) {
    if (chainCache.has(sec)) return chainCache.get(sec);
    const titles = [];
    let cur = sec;
    while (cur) {
      titles.unshift(cur.title);
      cur = cur.parent || null;
    }
    if (titles.length === 0) titles.push(modulePath);
    else if (titles[0] !== modulePath) titles.unshift(modulePath);
    chainCache.set(sec, titles.join('/'));
    return titles.join('/');
  }
  for (const sec of parsed.allSections) {
    const basePath = chainOf(sec);
    for (const t of sec.tables) {
      const hdrs = t.headers || [];
      if (!hdrs.length) continue;
      if (isLinkageTable(hdrs)) continue;
      const phraseCol = pickPhraseColumn(hdrs);
      if (phraseCol < 0) continue;
      const descCol = pickDescriptionColumn(hdrs, phraseCol);
      const catCell = (row) => row[0] || '';
      for (const row of t.rows) {
        const cat = catCell(row).replace(/^[*\s*]+|[*\s*]+$/g, '').trim();
        const phrase = row[phraseCol] || '';
        if (!looksLikeEnglishPhrase(phrase)) continue;
        // 细分分类：row[0] 是具体场景名 → 加到 basePath 之后
        const category_path = cat && cat !== sec.title
          ? basePath + '/' + cat
          : basePath;
        for (const p of splitPhrases(phrase)) {
          items.push({
            phrase: p,
            category_path,
            category_full_name: category_path,
            category_code: null,
            module: modulePath,
            source_module: modulePath,
            source_section: sec.title,
            source_kind: 'table',
            description: descCol >= 0 ? (row[descCol] || '') : '',
            sensitivity: 'nsfw',
            is_required: false,
          });
        }
      }
    }
    // 也合并 codeList（section.codeList 包含 inline backticks 提取出的短语）
    for (const p of sec.codeList) {
      items.push({
        phrase: p,
        category_path: basePath,
        category_full_name: basePath,
        category_code: null,
        module: modulePath,
        source_module: modulePath,
        source_section: sec.title,
        source_kind: 'code',
        description: '',
        sensitivity: 'nsfw',
        is_required: false,
      });
    }
  }
  const associations = collectAssociationsFromTables(parsed.rootSections, modulePath, 'md-import-01-场景×感官');
  return { items, categories: [], associations, sections: parsed.rootSections };
}

function parse02Framing(parsed, modulePath) {
  const items = collectItemsFromSections(parsed.rootSections, modulePath, () => false);
  // 02 末尾「禁止组合」段：手工登记 8 条硬互斥
  const associations = FORBIDDEN_02.map(f => ({
    type: 'exclusive', scope: 'item',
    a: f.a, b: f.b,
    weight: 100, reason: '02-景别构图 末尾禁止组合',
    source: 'md-import-02末尾禁止组合',
    source_module: modulePath,
    association_kind: 'forbidden',
  }));
  return { items, categories: [], associations, sections: parsed.rootSections };
}

const FORBIDDEN_02 = [
  { a: 'CCTV footage, security camera footage', b: 'masterpiece, best quality, 8k, ultra detailed' },
  { a: 'CCTV footage, security camera footage', b: '8k, ultra detailed, ultra high res' },
  { a: 'iPhone photo', b: 'masterpiece, best quality, 8k' },
  { a: 'polaroid photo, polaroid style', b: 'sharp focus, high resolution' },
  { a: 'surveillance camera, hidden camera', b: 'cinematic film, cinematic lighting' },
  { a: 'fisheye lens, ultra-wide distortion', b: 'natural perspective, realistic proportions' },
  { a: 'CCTV, surveillance footage, security camera', b: 'high quality, sharp, detailed' },
  { a: 'amateur photo, candid shot', b: 'professional studio lighting, advertising photography' },
];

function parse03Nudity(parsed, modulePath) {
  const items = collectItemsFromSections(parsed.rootSections, modulePath, () => false);
  // 03 附录 C 手工登记 10 条
  const associations = FORBIDDEN_03.map(f => ({
    type: 'exclusive', scope: 'item',
    a: f.a, b: f.b,
    weight: 100, reason: '03-裸露液体 附录C',
    source: 'md-import-03附录C',
    source_module: modulePath,
    association_kind: 'forbidden',
  }));
  return { items, categories: [], associations, sections: parsed.rootSections };
}

const FORBIDDEN_03 = [
  { a: 'spread pussy, legs spread wide', b: 'panties showing, panties visible' },
  { a: 'nude', b: 'panties showing' },
  { a: 'completely naked', b: 'wearing clothes' },
  { a: 'wet clothes clinging, soaked clothing', b: 'dry fabric, neatly dressed' },
  { a: 'sheer fabric, see-through, transparent clothing', b: 'opaque thick fabric, fully covered' },
  { a: 'sweat dripping, wet skin', b: 'dry skin, no moisture' },
  { a: 'cum on body, semen visible', b: 'clean body, no fluids' },
  { a: 'vagina fully visible, pussy spread', b: 'closed legs, knees together' },
  { a: 'cum dripping, dripping cum', b: 'clean body, fresh' },
  { a: 'semen on face, facial cum', b: 'clean face, no fluid' },
];

function parse07Expression(parsed, modulePath) {
  const items = collectItemsFromSections(parsed.rootSections, modulePath, () => false);
  // 07 「镜头角度 × 眼神方向」铁律表 — 5 条硬互斥
  const associations = FORBIDDEN_07.map(f => ({
    type: 'exclusive', scope: 'item',
    a: f.a, b: f.b,
    weight: 100, reason: '07-表情眼神 镜头角度铁律',
    source: 'md-import-07-镜头角度',
    source_module: modulePath,
    association_kind: 'forbidden',
  }));
  return { items, categories: [], associations, sections: parsed.rootSections };
}

const FORBIDDEN_07 = [
  { a: 'high angle shot, overhead angle, bird eye view', b: 'downcast eyes, looking down, eyes cast down' },
  { a: 'low angle shot, up shot, upward angle', b: 'looking up, upward gaze, upturned eyes' },
  { a: 'POV from below, low angle POV', b: 'eyes looking up to camera, upward gaze' },
  { a: 'overhead shot, bird eye view', b: 'downward gaze, looking at ground' },
  { a: 'eye level shot', b: 'extreme upward gaze, extreme downward gaze' },
];

function parse14Persona(parsed, modulePath) {
  // 14-人格卡片.md：单张大表（100 行）
  const items = [];
  const examples = [];
  const associations = [];
  const seen = new Set();
  // 把 sec 路径还原为 modulePath-prefixed category_path；
  // 保留所有中间 rootSection.title；若首项 (rootSection.title) ≠ modulePath，
  // 在前面 prepend modulePath（categories 的根是 modulePath 自身）。
  const chainCache = new WeakMap();
  function chainOf(sec) {
    if (chainCache.has(sec)) return chainCache.get(sec);
    const titles = [];
    let cur = sec;
    while (cur) {
      titles.unshift(cur.title);
      cur = cur.parent || null;
    }
    if (titles.length === 0) titles.push(modulePath);
    else if (titles[0] !== modulePath) titles.unshift(modulePath);
    chainCache.set(sec, titles.join('/'));
    return titles.join('/');
  }

  function processTable(t, sec, secChainPath) {
    if (!t.headers || t.headers.length < 5) return;
    const j = t.headers.join('|');
    if (!(/身份|人格|职业/.test(j) && /(权力|行为|制服|场景)/.test(j))) return;
    const fullBasePath = secChainPath || (sec ? chainOf(sec) : modulePath);
    for (const row of t.rows) {
      if (row.length < t.headers.length) continue;
      const title = row[0] || '';
      const english = row[t.headers.length - 1] || '';
      if (!english.trim()) continue;
      const k = (title + '|' + english).trim();
      if (seen.has(k)) continue;
      seen.add(k);
      const content = english.trim();
      const descZh = row.slice(0, -1).filter(Boolean).join(' | ');
      items.push({
        phrase: content,
        category_path: fullBasePath,  // 不再附加 row[0]（那是序号，不是分类名）
        category_full_name: fullBasePath,
        category_code: null,
        module: modulePath,
        source_module: modulePath,
        source_section: sec ? sec.title : '人格卡片',
        source_kind: 'persona',
        description: descZh,
        sensitivity: 'nsfw',
        is_required: false,
      });
    }
  }

  for (const sec of parsed.allSections) {
    const secChain = chainOf(sec);
    for (const t of sec.tables) processTable(t, sec, secChain);
  }

  return { items, categories: [], associations, examples, sections: parsed.rootSections };
}

// ============ 9 个通用模块 ============

function makeGenericParser(_moduleKey, _moduleCode, modulePath, sourceTag) {
  return function (parsed) {
    const items = collectItemsFromSections(parsed.rootSections, modulePath, () => false);
    const associations = collectAssociationsFromTables(parsed.rootSections, modulePath, sourceTag);
    return { items, categories: [], associations, sections: parsed.rootSections };
  };
}

// ============ 调度 ============

function moduleCodeOf(moduleKey) {
  return moduleKey.slice(0, 2);
}

const PARSERS = {
  '00-范例':     (parsed, mp) => Object.assign(parse00Examples(parsed, mp), { moduleCode: moduleCodeOf(mp) }),
  '01-场景主题': (parsed, mp) => Object.assign(parse01Scenes(parsed, mp), { moduleCode: moduleCodeOf(mp) }),
  '02-景别构图': (parsed, mp) => Object.assign(parse02Framing(parsed, mp), { moduleCode: moduleCodeOf(mp) }),
  '03-裸露液体': (parsed, mp) => Object.assign(parse03Nudity(parsed, mp), { moduleCode: moduleCodeOf(mp) }),
  '04-服装专项': makeGenericParser('04', '04', '04-服装专项', 'md-import-04-服装×裸露'),
  '05-光影氛围': makeGenericParser('05', '05', '05-光影氛围', 'md-import-05-场景×光影'),
  '06-姿势动作': makeGenericParser('06', '06', '06-姿势动作', 'md-import-06-姿势'),
  '07-表情眼神': (parsed, mp) => Object.assign(parse07Expression(parsed, mp), { moduleCode: moduleCodeOf(mp) }),
  '08-风格胶片': makeGenericParser('08', '08', '08-风格胶片', 'md-import-08-胶片×场景'),
  '09-妆容专项': makeGenericParser('09', '09', '09-妆容专项', 'md-import-09'),
  '10-发型饰品': makeGenericParser('10', '10', '10-发型饰品', 'md-import-10'),
  '11-瑕疵细节': makeGenericParser('11', '11', '11-瑕疵细节', 'md-import-11'),
  '12-纹身标记': makeGenericParser('12', '12', '12-纹身标记', 'md-import-12'),
  '13-道具宠物': makeGenericParser('13', '13', '13-道具宠物', 'md-import-13-道具×场景'),
  '14-人格卡片': (parsed, mp) => Object.assign(parse14Persona(parsed, mp), { moduleCode: moduleCodeOf(mp) }),
};

function listModules() { return Object.keys(PARSERS); }

function parseModule(moduleKey, parsed) {
  const fn = PARSERS[moduleKey];
  const fallback = { moduleCode: moduleCodeOf(moduleKey), modulePath: moduleKey, sections: parsed.rootSections, items: [], categories: [], associations: [], examples: [] };
  if (!fn) return fallback;
  const result = fn(parsed, moduleKey) || fallback;
  // 强制补 moduleCode / modulePath（generic parser 不带）
  if (!result.moduleCode) result.moduleCode = moduleCodeOf(moduleKey);
  if (!result.modulePath) result.modulePath = moduleKey;
  return result;
}

module.exports = { PARSERS, listModules, parseModule };
