// scripts/parse-nsfw-asian/lib/dedup.js
// 全局短语去重 + 输出 JSON

'use strict';

const { normalizePhrase } = require('./markdown');

/**
 * 把 rawItems 数组去重后输出：
 *   - items: 去重后的 item 列表（首入主分类 + aliases）
 *   - dupReport: 重复短语的（分类对）矩阵
 */
function dedupItems(rawItems) {
  const seen = new Map();   // normalizedKey → { idx, primaryCategoryPath, alsoSeenIn: [] }
  const items = [];
  const dupPairs = [];

  for (const it of rawItems) {
    const key = normalizePhrase(it.phrase);
    if (!key) continue;
    const catPath = it.category_path || '';
    if (seen.has(key)) {
      const entry = seen.get(key);
      if (!entry.alsoSeenIn.includes(catPath)) {
        entry.alsoSeenIn.push(catPath);
        // 记录两两配对的 dup（每对最多记一次）
        for (const other of uniqueOtherCategories(entry.primaryCategoryPath, catPath, entry.alsoSeenIn)) {
          dupPairs.push({
            phrase: it.phrase,
            category_a: entry.primaryCategoryPath,
            category_b: other,
          });
        }
      }
      continue;
    }
    // 新短语
    const idx = items.length;
    items.push({
      phrase: it.phrase,
      category_path: catPath,
      category_full_name: it.category_full_name || catPath,
      category_code: it.category_code || null,
      module: it.module,
      source_module: it.source_module || it.module,
      source_section: it.source_section || null,
      source_kind: it.source_kind || 'code',
      description: it.description || '',
      aliases: [],
      sensitivity: it.sensitivity || 'nsfw',
      is_required: !!it.is_required,
    });
    seen.set(key, { idx, primaryCategoryPath: catPath, alsoSeenIn: [] });
  }

  // 把 aliases 回填到 items（截断前 20 个最常出现章节）
  for (const [, entry] of seen) {
    const item = items[entry.idx];
    item.aliases = entry.alsoSeenIn.slice(0, 20);
  }

  // 构造 dup-report.json：相同短语在不同分类下的分布
  const phraseMap = new Map();   // normalized → { phrase, occurrences: [{cat, module, source_kind}] }
  for (const it of rawItems) {
    const k = normalizePhrase(it.phrase);
    if (!k) continue;
    if (!phraseMap.has(k)) phraseMap.set(k, { phrase: it.phrase, occurrences: [] });
    phraseMap.get(k).occurrences.push({
      category: it.category_path || '',
      module: it.module || '',
      source_kind: it.source_kind || 'code',
    });
  }
  const dupReport = {
    total_unique_phrases: phraseMap.size,
    duplicated_phrases: 0,
    repetitions: 0,
    top_repetitions: [],
  };
  const dups = [];
  for (const [k, v] of phraseMap) {
    if (v.occurrences.length > 1) {
      dupReport.duplicated_phrases++;
      dupReport.repetitions += v.occurrences.length - 1;
      dups.push({ normalized: k, phrase: v.phrase, count: v.occurrences.length, occurrences: v.occurrences });
    }
  }
  dups.sort((a, b) => b.count - a.count);
  dupReport.top_repetitions = dups.slice(0, 100);

  return { items, dupReport, dupPairs };
}

function uniqueOtherCategories(primary, current, alsoSeen) {
  // 返回本次新增的不同分类路径集合（避免重复记）
  const out = new Set();
  if (primary !== current) out.add(primary);
  for (const a of alsoSeen) if (a !== current) out.add(a);
  return [...out];
}

module.exports = { dedupItems };
