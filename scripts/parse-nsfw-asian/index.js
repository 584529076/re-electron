// scripts/parse-nsfw-asian/index.js
// 主入口：扫 14 个 .md → 4 个 JSON 输出
//
// 用法：  node scripts/parse-nsfw-asian/index.js [src_dir] [out_dir]
//   src_dir 默认： D:/nsfw-prompt-templates-asian
//   out_dir  默认： D:/re-electron/scripts/parsed-nsfw-asian
//
// 输出：
//   categories.json                 分类树
//   items.json                      词汇短语列表（已去重 + 带 aliases）
//   associations-preview.json       关联 / 互斥规则（item-level）
//   examples.json                   完整范例（00-范例 用）
//   dup-report.json                 重复短语报告
//   summary.json                    总体统计 + 覆盖率

'use strict';

const fs = require('fs');
const path = require('path');
const { parseMd } = require('./lib/markdown');
const { dedupItems } = require('./lib/dedup');
const { buildCategories } = require('./lib/categories');
const { parseModule, listModules } = require('./modules');

const SRC_DIR = process.argv[2] || path.join('D:', 'nsfw-prompt-templates-asian');
const OUT_DIR = process.argv[3] || path.join(__dirname, '..', 'parsed-nsfw-asian');

function main() {
  console.log('▶ parse-nsfw-asian');
  console.log('  src: ' + SRC_DIR);
  console.log('  out: ' + OUT_DIR);
  console.log('');

  if (!fs.existsSync(SRC_DIR)) {
    console.error('!! src_dir 不存在: ' + SRC_DIR);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const allItems = [];
  const allCategoriesData = [];   // for categories builder
  const allAssociations = [];
  const allExamples = [];
  const moduleStats = [];

  for (const moduleKey of listModules()) {
    const filePath = path.join(SRC_DIR, moduleKey + '.md');
    if (!fs.existsSync(filePath)) {
      console.log('  ⚠ 缺文件: ' + moduleKey + '.md');
      moduleStats.push({ module: moduleKey, status: 'missing' });
      continue;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = parseMd(text);
    const r = parseModule(moduleKey, parsed);

    console.log('  ✓ ' + moduleKey + '  ' +
      'items=' + r.items.length +
      ' assoc=' + r.associations.length +
      (r.examples ? ' examples=' + r.examples.length : ''));

    allItems.push(...r.items);
    allAssociations.push(...r.associations);
    if (r.examples && r.examples.length) allExamples.push(...r.examples);
    moduleStats.push({
      module: moduleKey,
      moduleCode: r.moduleCode,
      items_raw: r.items.length,
      assoc_raw: r.associations.length,
      examples: r.examples ? r.examples.length : 0,
      sections: (r.sections || []).length,
    });

    allCategoriesData.push({
      moduleCode: r.moduleCode,
      modulePath: moduleKey,
      description: '',
      is_required: false,
      sections: r.sections || [],
    });
  }

  // 构造 categories
  const categories = buildCategories(allCategoriesData);

  // 去重
  console.log('');
  console.log('▶ dedup phrases');
  const { items, dupReport } = dedupItems(allItems);

  // 计算统计
  const summary = {
    generated_at: new Date().toISOString(),
    src_dir: SRC_DIR,
    module_stats: moduleStats,
    counts: {
      categories: categories.length,
      items_unique: items.length,
      items_raw: allItems.length,
      items_skipped_dup: allItems.length - items.length,
      associations: allAssociations.length,
      associations_unique: uniqAssoc(allAssociations).length,
      examples: allExamples.length,
      duplicate_phrases: dupReport.duplicated_phrases,
      repetition_count: dupReport.repetitions,
    },
    top_aliases: items.filter(i => i.aliases && i.aliases.length > 0)
      .sort((a, b) => b.aliases.length - a.aliases.length)
      .slice(0, 30)
      .map(i => ({ phrase: i.phrase, primary: i.category_path, alias_count: i.aliases.length, aliases: i.aliases })),
  };

  console.log('  raw items      : ' + allItems.length);
  console.log('  unique items   : ' + items.length);
  console.log('  skipped (dup)  : ' + (allItems.length - items.length));
  console.log('  associations   : ' + allAssociations.length);
  console.log('  duplicate phrases: ' + dupReport.duplicated_phrases);
  console.log('  examples (00)  : ' + allExamples.length);
  console.log('  categories     : ' + categories.length);
  console.log('');

  // 输出
  writeJson(path.join(OUT_DIR, 'categories.json'), categories);
  writeJson(path.join(OUT_DIR, 'items.json'), items);
  writeJson(path.join(OUT_DIR, 'associations-preview.json'), uniqAssoc(allAssociations));
  writeJson(path.join(OUT_DIR, 'examples.json'), allExamples);
  writeJson(path.join(OUT_DIR, 'dup-report.json'), dupReport);
  writeJson(path.join(OUT_DIR, 'summary.json'), summary);

  console.log('▶ out files in ' + OUT_DIR);
  for (const f of ['categories.json', 'items.json', 'associations-preview.json', 'examples.json', 'dup-report.json', 'summary.json']) {
    const p = path.join(OUT_DIR, f);
    if (fs.existsSync(p)) {
      const size = (fs.statSync(p).size / 1024).toFixed(1);
      console.log('  ✓ ' + f + ' (' + size + ' KB)');
    }
  }
}

function uniqAssoc(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const k = (a.type || '') + '|' + (a.source || '') + '|' + (a.a || '') + '||' + (a.b || '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

main();
