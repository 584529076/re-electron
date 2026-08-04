// scripts/parse-nsfw-asian/lib/categories.js
// 把 section tree 展平 → category 列表（带唯一 hierarchical code）

'use strict';

const { cleanTitle } = require('./markdown');

/**
 * 输入：modulesData = [{ moduleCode, modulePath, sections: Section[], ... }]
 * 输出：categories[]（每个含 code=unique hierarchical, path=display path）
 */
function buildCategories(modulesData) {
  const all = [];
  let moduleIdx = 0;

  for (const mod of modulesData) {
    const moduleCode = String(mod.moduleCode || '').padStart(2, '0');
    const modulePath = mod.modulePath || (moduleCode + '-');
    const moduleDesc = mod.description || '';
    const moduleRequired = !!mod.is_required;

    // 模块根 category
    const root = {
      code: moduleCode,
      path: modulePath,
      name: cleanTitle(modulePath),
      title: modulePath,
      description: moduleDesc,
      parent_code: null,
      level: 1,
      module: modulePath,
      module_code: moduleCode,
      is_required: moduleRequired,
      exclusive_group: null,
    };
    all.push(root);

    // 递归给每个子 section 一个 hierarchical code
    let counter = 0;
    function walk(secs, parent) {
      for (const s of secs) {
        counter++;
        // 编码：根代码 + "." + 全局序号（保证唯一，hierarchical 显示）
        const subCode = parent.code + '.' + String(counter).padStart(3, '0');
        const fullPath = parent.path + '/' + s.title;
        const cat = {
          code: subCode,
          path: fullPath,
          name: s.title,
          title: s.heading || s.title,
          description: deriveDescription(s),
          parent_code: parent.code,
          level: parent.level + 1,
          module: modulePath,
          module_code: moduleCode,
          is_required: false,
          exclusive_group: null,
        };
        all.push(cat);
        walk(s.children, cat);
      }
    }
    walk(mod.sections || [], root);
    moduleIdx++;
  }
  return all;
}

function deriveDescription(section) {
  for (const b of (section.blocks || [])) {
    if (b.type === 'para') return truncate(b.text, 200);
    if (b.type === 'quote') return truncate(b.text.replace(/\n/g, ' '), 200);
  }
  return '';
}

function truncate(s, n) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = { buildCategories };
