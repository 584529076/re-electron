// prompt-gen.js — D-27 提示词自动生成器 UI
//
// 布局（3 列）：
//   [1] 模块列表          [2] 标签选择器            [3] 生成结果
//   - 12 个模块（左边）    - 当前模块的标签（芯片）   - 完整提示词
//   - 选模块 → 显示标签    - 多选                     - 复制/保存/重新生成
//                                                  - 取消按钮
//                                                  - 历史抽屉
//
// 入口：window.promptGen.open()  —— 由 config-ui.js 的「提示词生成」按钮调用
'use strict';

// =================================================================
// D-39 性能优化: 客户端关联规则缓存
// =================================================================
// 之前每次点 chip 都要走 IPC（Renderer → Main → SQLite → IPC），单次 5-20ms
// 优化：启动时一次性把全量关联规则拉到客户端，建 O(1) 索引
// 后续 chip 点击 → 纯 JS Map 查表，< 1ms
let _assocState = {
    loaded: false,
    loading: false,
    loadPromise: null,
    byPair: new Map(),    // "minId-maxId" → {aId, bId, relation, weight, reason, source}
    byItem: new Map(),    // itemId → [{otherId, relation, weight, reason, source}]
    nameById: new Map(),  // itemId → name（出现在关联规则里的项）
    // D-40: item meta 缓存 — 后端 item 查询已 JOIN prompt_menu 带回分类级约束
    // 用于 (a) group 互斥校验  (b) 数量规则校验  (c) UI 渲染分类标题时的 tag_required 徽标
    itemMeta: new Map(),  // itemId → {categoryId, categoryName, tagRequired, tagExclusiveGroup}
    lastLoadMs: 0,        // 上次加载耗时（ms）
};

async function ensureAssocCache(force = false) {
    if (_assocState.loaded && !force) return _assocState;
    if (_assocState.loading) return _assocState.loadPromise;
    _assocState.loading = true;
    _assocState.loadPromise = (async () => {
        try {
            const t0 = performance.now();
            const r = await window.api.promptAssociationListAll();
            if (r && r.ok) {
                _assocState.byPair.clear();
                _assocState.byItem.clear();
                _assocState.nameById.clear();
                for (const row of (r.rows || [])) {
                    const aId = Number(row.prompt_a_id);
                    const bId = Number(row.prompt_b_id);
                    if (!aId || !bId) continue;
                    const a = Math.min(aId, bId);
                    const b = Math.max(aId, bId);
                    const entry = {
                        aId: a, bId: b,
                        relation: row.relation,
                        weight: Number(row.weight) || 50,
                        reason: row.reason || '',
                        source: row.source || 'manual',
                    };
                    _assocState.byPair.set(a + '-' + b, entry);
                    if (!_assocState.byItem.has(aId)) _assocState.byItem.set(aId, []);
                    if (!_assocState.byItem.has(bId)) _assocState.byItem.set(bId, []);
                    _assocState.byItem.get(aId).push({ otherId: bId, ...entry });
                    _assocState.byItem.get(bId).push({ otherId: aId, ...entry });
                    if (row.a_name) _assocState.nameById.set(aId, row.a_name);
                    if (row.b_name) _assocState.nameById.set(bId, row.b_name);
                }
                _assocState.loaded = true;
                _assocState.lastLoadMs = performance.now() - t0;
                console.log(`[assocCache] loaded ${_assocState.byPair.size} rules in ${_assocState.lastLoadMs.toFixed(1)}ms`);
            }
        } catch (e) {
            console.warn('[assocCache] load failed:', e);
        } finally {
            _assocState.loading = false;
        }
        return _assocState;
    })();
    return _assocState.loadPromise;
}

function invalidateAssocCache() {
    _assocState.loaded = false;
    _assocState.byPair.clear();
    _assocState.byItem.clear();
    _assocState.nameById.clear();
    _assocState.itemMeta.clear();
}

// D-40: 把后端 JOIN 回来的分类级约束 (tag_required / exclusive_with) 灌入缓存
// 调用方：loadAndRenderContent 拉完 item 后
// 设计为合并语义（不清空旧值）—— 不同分类页 item 集合可能重叠/分批到达
// D-42: 用 exclusive_with（直接配对的菜单 id 集）替换 tag_exclusive_group 概念
//   走祖先链：item.category_id → 父 → 爷 → ...，把路径上每个分类的 exclusive_with 合并
// D-44: 加 exclusive_group（同组名互斥）；组名不继承祖先，只取本分类的
function absorbItemMeta(items, menuById) {
    if (!Array.isArray(items)) return;
    for (const it of items) {
        if (!it || it.id == null) continue;
        const id = Number(it.id);
        const cid = it.category_id != null ? Number(it.category_id) : null;
        // 收集 ancestor 链上所有分类的 exclusive_with（用 Set 去重）
        const allExclWith = new Set();
        // D-44: 组名不继承祖先（每个分类自填，组内互斥更可控）
        let exclusiveGroup = '';
        if (menuById && cid) {
            const selfCat = menuById.get(cid);
            if (selfCat) {
                parseExclusiveWith(selfCat.exclusive_with).forEach(x => allExclWith.add(x));
                exclusiveGroup = parseExclusiveGroup(selfCat.exclusive_group);
                // 走祖先链只补 exclusive_with（不补 exclusive_group）
                let cur = selfCat.parent_id ? menuById.get(selfCat.parent_id) : null;
                while (cur) {
                    parseExclusiveWith(cur.exclusive_with).forEach(x => allExclWith.add(x));
                    cur = cur.parent_id ? menuById.get(cur.parent_id) : null;
                }
            }
        }
        _assocState.itemMeta.set(id, {
            categoryId: cid,
            categoryName: it.category_name || '',
            tagRequired: it.tag_required || '',
            exclusiveWith: allExclWith,  // Set<number>：本 item 与这些分类 id 互斥（含继承）
            exclusiveGroup: exclusiveGroup,  // string：本 item 所在组（不含继承）
        });
    }
}

// 纯本地校验（O(n²) 配对 + O(n×k) 推荐，n=选中项数 ≤ 几十，k=单项关联数 ≤ 几）
// 典型 10 项 × 平均 3 关联 = 30 次 Map.get + 45 次配对 = < 0.5ms
function nsfwValidateLocal(itemIds) {
    const conflicts = [];
    const recsMap = new Map();
    const n = itemIds.length;

    // 1) 互斥冲突：双重 for 枚举所有配对
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const a = Math.min(itemIds[i], itemIds[j]);
            const b = Math.max(itemIds[i], itemIds[j]);
            const entry = _assocState.byPair.get(a + '-' + b);
            if (entry && entry.relation === 'exclusive') {
                conflicts.push({
                    id: entry.aId + '-' + entry.bId,
                    a_id: a, b_id: b,
                    a_name: _assocState.nameById.get(a) || ('#' + a),
                    b_name: _assocState.nameById.get(b) || ('#' + b),
                    reason: entry.reason,
                });
            }
        }
    }

    // 2) 强联动推荐：每个已选项查反向索引
    const idSet = new Set(itemIds);
    for (let i = 0; i < n; i++) {
        const id = itemIds[i];
        const related = _assocState.byItem.get(id);
        if (!related) continue;
        for (let k = 0; k < related.length; k++) {
            const r = related[k];
            if (r.relation !== 'strong') continue;
            if (idSet.has(r.otherId)) continue;  // 已选中，不推
            const existing = recsMap.get(r.otherId);
            if (existing) {
                if (r.weight > existing.weight) {
                    existing.weight = r.weight;
                    existing.reason = r.reason;
                }
            } else {
                recsMap.set(r.otherId, {
                    id: r.otherId,
                    name: _assocState.nameById.get(r.otherId) || ('#' + r.otherId),
                    weight: r.weight,
                    reason: r.reason,
                });
            }
        }
    }

    const recommendations = Array.from(recsMap.values())
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 10);

    return { conflicts, recommendations };
}

// D-40: 互斥分类冲突 — D-42 改用 exclusive_with 直接配对（两两比对）
//   规则：若 A.exclusive_with 包含 B 的分类 id，或 B.exclusive_with 包含 A 的分类 id → 冲突
//   单向即可：用户在 A 那边把 B 加上，那 A→B 视为冲突；A 的项与 B 的项互斥
//   注意：itemMeta.exclusiveWith 已经是「自身+祖先」合并后的全集 Set
// D-44: 加 exclusive_group 互斥（同组名 = 全员互斥；不继承祖先）
//   冲突原因会标 'group' / 'direct' / 'both'，UI 区分显示
function nsfwValidateExclusive(itemIds) {
    const conflicts = [];
    const n = itemIds.length;
    if (n < 2) return conflicts;
    // 1) 收集每个 item 的 meta（有 exclusiveWith 或 exclusiveGroup 的都收）
    const metas = new Map();  // itemId → meta
    for (const id of itemIds) {
        const m = _assocState.itemMeta.get(Number(id));
        if (!m) continue;
        const hasWith = m.exclusiveWith instanceof Set && m.exclusiveWith.size > 0;
        const hasGroup = !!m.exclusiveGroup;
        if (!hasWith && !hasGroup) continue;
        metas.set(Number(id), m);
    }
    if (metas.size < 2) return conflicts;
    // 2) 两两比对：direct 命中 / group 命中 都算冲突；记录原因
    const conflictPairs = new Set();      // 'a-b' (a<b)
    const conflictReasons = new Map();    // 'a-b' → 'group' | 'direct' | 'both'
    const arr = Array.from(metas.keys());
    for (let i = 0; i < arr.length; i++) {
        const aId = arr[i];
        const aMeta = metas.get(aId);
        for (let j = i + 1; j < arr.length; j++) {
            const bId = arr[j];
            const bMeta = metas.get(bId);
            const hitDirect = !!(aMeta.exclusiveWith instanceof Set && aMeta.exclusiveWith.has(bMeta.categoryId))
                || !!(bMeta.exclusiveWith instanceof Set && bMeta.exclusiveWith.has(aMeta.categoryId));
            const hitGroup = !!(aMeta.exclusiveGroup && aMeta.exclusiveGroup === bMeta.exclusiveGroup);
            if (hitDirect || hitGroup) {
                const k1 = Math.min(aId, bId), k2 = Math.max(aId, bId);
                const key = k1 + '-' + k2;
                conflictPairs.add(key);
                const prev = conflictReasons.get(key);
                const now = hitDirect && hitGroup ? 'both' : (hitGroup ? 'group' : 'direct');
                conflictReasons.set(key, prev === 'both' || now === 'both' ? 'both' : (prev || now));
            }
        }
    }
    if (!conflictPairs.size) return conflicts;
    // 3) 收集所有冲突项 + 关联分类名
    const allIds = new Set();
    for (const p of conflictPairs) {
        const [a, b] = p.split('-').map(Number);
        allIds.add(a); allIds.add(b);
    }
    const labeled = Array.from(allIds).map(i => {
        const m = _assocState.itemMeta.get(i) || {};
        return { id: i, name: m.categoryName ? `[${m.categoryName}]#${i}` : '#' + i };
    });
    // 4) 拆成 group / direct / both 三类计数，UI 显示更清楚
    let nGroup = 0, nDirect = 0, nBoth = 0;
    for (const r of conflictReasons.values()) {
        if (r === 'group') nGroup++;
        else if (r === 'direct') nDirect++;
        else if (r === 'both') nBoth++;
    }
    const reasonParts = [];
    if (nDirect) reasonParts.push(`直接配对 ${nDirect} 对`);
    if (nGroup) reasonParts.push(`同组 ${nGroup} 对`);
    if (nBoth) reasonParts.push(`同组+直接配对 ${nBoth} 对`);
    conflicts.push({
        source: 'excl',  // 区别于 item-pair ('pair') 和 quantity ('qty')
        ids: Array.from(allIds),
        items: labeled,
        pairs: Array.from(conflictPairs),
        pairReasons: Object.fromEntries(conflictReasons),  // 'a-b' → reason（给 UI 分组用）
        reason: `互斥分类之间不能同时选择（${reasonParts.join(' + ')}）`,
    });
    return conflicts;
}

// D-42: 兼容旧名（其它代码可能仍调 nsfwValidateGroup），alias 一下
//   —— 用 const 暴露
const nsfwValidateGroup = nsfwValidateExclusive;

// D-40: tag_required 数字范围 [min, max] 解析
function parseTagRequired(spec) {
    if (!spec) return null;
    const s = String(spec);
    const mRange = s.match(/(\d+)\s*[-~到至]\s*(\d+)/);
    if (mRange) return { min: Number(mRange[1]), max: Number(mRange[2]), source: s };
    const mSingle = s.match(/(\d+)\s*个/);
    if (mSingle) return { min: Number(mSingle[1]), max: Number(mSingle[1]), source: s };
    return null;
}

// D-40: 数量规则冲突 — 同一分类下选中数超出 tag_required 范围即警告
function nsfwValidateQuantity(itemIds) {
    const warnings = [];
    const catMap = new Map();  // categoryId → [itemId]
    for (const id of itemIds) {
        const meta = _assocState.itemMeta.get(Number(id));
        if (!meta || !meta.categoryId) continue;
        const rule = parseTagRequired(meta.tagRequired);
        if (!rule) continue;  // 没规则的分类不警告
        const cid = meta.categoryId;
        if (!catMap.has(cid)) catMap.set(cid, { name: meta.categoryName, rule, ids: [] });
        catMap.get(cid).ids.push(Number(id));
    }
    for (const [cid, info] of catMap) {
        const cnt = info.ids.length;
        if (cnt < info.rule.min || cnt > info.rule.max) {
            const labeled = info.ids.map(i => {
                const m = _assocState.itemMeta.get(i) || {};
                return { id: i, name: m.categoryName ? `[${m.categoryName}]#${i}` : '#' + i };
            });
            warnings.push({
                source: 'quantity',
                categoryId: cid,
                categoryName: info.name,
                ids: info.ids,
                items: labeled,
                count: cnt,
                rule: info.rule,
                reason: `分类「${info.name}」数量规则「${info.rule.source}」要求 ${info.rule.min}-${info.rule.max} 个，当前 ${cnt} 个`,
            });
        }
    }
    return warnings;
}

// 暴露给 DevTools 调试：window.__assocCache
window.__assocCache = {
    _assocState, ensureAssocCache, invalidateAssocCache, absorbItemMeta,
    nsfwValidateLocal, nsfwValidateGroup, nsfwValidateExclusive, nsfwValidateQuantity, parseTagRequired,
    parseExclusiveGroups, formatExclusiveGroups,
    parseExclusiveWith, formatExclusiveWith,
    parseExclusiveGroup, formatExclusiveGroup,
};

// D-41: 互斥分组多值（逗号分隔字符串）解析 / 格式化
//   D-42 保留以兼容后端（tag_exclusive_group 列还在），但前端不再写入
function parseExclusiveGroups(spec) {
    if (!spec) return [];
    return String(spec).split(',').map(s => s.trim()).filter(Boolean);
}
function formatExclusiveGroups(arr) {
    if (!Array.isArray(arr)) return '';
    return arr.map(s => String(s).trim()).filter(Boolean).join(',');
}

// D-42: exclusive_with（逗号分隔菜单 id 串）解析 / 格式化
//   解析后是 number 数组（与 parseExclusiveGroups 名字接近但语义不同，避免混用）
function parseExclusiveWith(spec) {
    if (!spec) return [];
    return String(spec).split(',')
        .map(s => Number(String(s).trim()))
        .filter(n => Number.isFinite(n) && n > 0);
}
function formatExclusiveWith(arr) {
    if (!Array.isArray(arr)) return '';
    return arr.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0).join(',');
}

// D-44: exclusive_group（组名字符串）解析 / 格式化
//   单值字符串：trim 后非空才算有组；空白 = 无组
function parseExclusiveGroup(spec) {
    if (spec === null || spec === undefined) return '';
    return String(spec).trim();
}
function formatExclusiveGroup(s) {
    if (s === null || s === undefined) return '';
    return String(s).trim();
}

// D-42: 全局「分类 id → 完整路径」工具（依赖调用方传入的 menuById Map）
//   形如「人物 > 姿势 > 站立」
function pathOfMenu(menuId, menuById) {
    if (!menuById || !menuId) return '';
    const m = menuById.get(Number(menuId));
    if (!m) return '';
    const segs = [];
    let cur = m;
    // 防自循环（pid_list 不一定更新到位，最多走 10 层）
    for (let i = 0; i < 10 && cur; i++) {
        segs.unshift(cur.category_name || ('#' + cur.id));
        cur = cur.parent_id ? menuById.get(Number(cur.parent_id)) : null;
    }
    return segs.join(' > ');
}

(function () {
    const api = window.api || {};
    if (!api.llm) {
        console.warn('[prompt-gen] window.api.llm 不可用，模块禁用');
        return;
    }

    // ========== 状态 ==========
    let _menuTree = [];              // prompt_menu 全部扁平 [{id,parent_id,category_name,pid_list,...}]
    let _menuById = new Map();       // D-33: id → node 快查表（替代 _menuTree.find）
    let _childrenMap = new Map();    // N 级通用: parentId → child[]（已按 sort_order + id 排序，0 → L1 根）
    let _nodeDepth = new Map();      // id → depth（1-based，L1=1）
    let _subtreeMaxDepth = new Map();// id → 该子树最大深度（叶子=1）
    let _selectedPath = [];          // [l1Id, l2Id, ..., lkId] 路径，长度 = 用户已点击层数
    let _selectedItems = new Map();  // itemId → item （选中项，原 _selectedTags 改名）
    let _llmConfig = null;           // { baseUrl, model, temperature, mode, systemPrompts }
    let _availableModels = [];       // Ollama 拉到的模型列表
    let _activeJobId = null;         // 当前生成任务的 jobId
    let _resultText = '';            // 当前生成结果
    let _lastGeneratedItems = [];    // 上次生成的项快照（用于历史）
    let _lastGeneratedTags = [];     // 上次生成的标签快照（保存到提示词库时用）
    let _assembleRule = null;        // D-35: 拼装规则 [{menuId, sortOrder}]，null = 未加载
    let _assembleRuleLoaded = false; // D-35: 是否已从主进程拉过（避免重复 IPC）
    let _pgLibAll = [];              // 提示词库全量（按 ts 倒序）
    let _pgLibPage = 1;              // 当前页（1-based）
    const _pgLibPageSize = 30;       // 每页条数

    // ========== ComfyUI 状态 ==========
    let _comfyConfig = null;         // { pythonPath, comfyDir, port, outputDir, jobTimeoutMs }
    let _comfyStatus = null;         // { running, pid, port, startedAt, lastError }
    let _currentImage = null;        // { dataUrl, filename, mime, meta } 或 null
    let _currentImageJobId = null;   // 当前图片对应的 jobId
    let _comfyUnsubscribe = [];      // [unsubProgress, unsubComplete, unsubError, unsubExit]
    let _comfyPollTimer = null;      // setInterval handle，open 时启、close 时清
    let _resultTab = 'prompt';       // 'prompt' | 'image'

    // ========== 入口 ==========
    async function open() {
        _injectPromptGenLightCss();
        if (!document.getElementById('promptGenPage')) {
            createPage();
        }
        // 预加载关联规则缓存（fire-and-forget，不阻塞 UI；首次约 10-50ms）
        ensureAssocCache().catch(() => {});
        // 拉数据
        await Promise.all([loadMenuTree(), loadLlmConfig(), loadAssembleRule(), loadComfyConfig(), loadT2iTools()]);
        showPage();
        // 默认沿第一支走到底，让用户进页面就看到最深层（N 级通用）
        navigateToDeepestFirstBranch();
        await refreshOllamaStatus();
        // ComfyUI：注册事件订阅 + 启 status 轮询
        subscribeComfyEvents();
        await refreshComfyStatus();
        if (!_comfyPollTimer) {
            _comfyPollTimer = setInterval(() => refreshComfyStatus().catch(() => {}), 3000);
        }
    }

    function close() {
        const page = document.getElementById('promptGenPage');
        if (page) page.style.display = 'none';
        // ComfyUI 清理：停 polling + 取消事件订阅 + 取消 in-flight job
        if (_comfyPollTimer) { clearInterval(_comfyPollTimer); _comfyPollTimer = null; }
        for (const u of _comfyUnsubscribe) { try { u && u(); } catch (e) {} }
        _comfyUnsubscribe = [];
        if (_currentImageJobId) {
            try { api.comfyui.cancel(_currentImageJobId); } catch (e) {}
            _currentImageJobId = null;
        }
        if (window.configUI && window.configUI.showGallery) {
            window.configUI.showGallery();
        }
    }

    // ========== DOM 创建 ==========
    function createPage() {
        const page = document.createElement('div');
        page.id = 'promptGenPage';
        page.style.cssText = 'position:fixed; inset:0; background:#f5f6f8; z-index:200; display:none; flex-direction:column; color:#1a1a1a; font-family:system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;';
        page.innerHTML = `
            <div id="pgHeaderBar" style="display:flex; align-items:center; padding:14px 20px; border-bottom:1px solid #e5e7eb; background:#ffffff; box-shadow:0 1px 2px rgba(0,0,0,0.04);">
                <button id="pgBtnBack" class="btn" title="返回瀑布流页" style="margin-right:14px;"><i class="fa-solid fa-arrow-left"></i> 返回</button>
                <h2 style="margin:0; flex:1; color:#1f2937; font-size:18px; font-weight:600;"><i class="fa-solid fa-wand-magic-sparkles" style="color:#6366f1;"></i> 提示词自动生成</h2>
                <span id="pgOllamaStatus" style="margin-right:12px; font-size:12px; color:#9ca3af;">● Ollama 未连接</span>
                <span id="pgComfyStatus" style="margin-right:12px; font-size:12px; color:#9ca3af;" title="ComfyUI 服务状态（在设置 → ComfyUI 服务配置）">● ComfyUI 未启动</span>
                <!-- D-29: SFW / NSFW 模式切换（class 切换：active-sfw / active-nsfw / inactive） -->
                <div id="pgModeTabs" style="display:inline-flex; background:#f3f4f6; border:1px solid #e5e7eb; border-radius:9px; padding:3px; margin-right:12px; gap:2px;">
                    <button data-mode="sfw" class="pgModeTab inactive" style="padding:6px 14px; font-size:12px; font-weight:600; border:none; border-radius:6px; cursor:pointer; transition:all 0.15s; display:inline-flex; align-items:center; gap:6px;"><i class="fa-solid fa-shield-halved"></i> SFW</button>
                    <button data-mode="nsfw" class="pgModeTab inactive" style="padding:6px 14px; font-size:12px; font-weight:600; border:none; border-radius:6px; cursor:pointer; transition:all 0.15s; display:inline-flex; align-items:center; gap:6px;"><i class="fa-solid fa-fire"></i> NSFW</button>
                </div>
                <button id="pgBtnHistory" class="btn" title="生成历史" style="margin-left:8px;"><i class="fa-solid fa-clock-rotate-left"></i> 历史</button>
                <button id="pgBtnLibrary" class="btn" title="已保存的提示词库" style="margin-left:6px;"><i class="fa-solid fa-bookmark"></i> 提示词库</button>
            </div>
            <div style="display:flex; flex:1; min-height:0;">
                <!-- N 级通用：L1 固定 + 动态列（L2..L_{N-1}）放左面板内，>4 列时左面板整体横向滚动；中间始终留作"末级"内容 -->
                <div id="pgLeftPanel" style="display:flex; flex:0 1 auto; overflow-x:auto; overflow-y:hidden; min-width:0; border-right:1px solid #e5e7eb; background:#ffffff;">
                    <div id="pgL1List" style="width:180px; flex-shrink:0; overflow-y:auto; padding:10px 0; background:#ffffff;"></div>
                    <div id="pgDynamicCols" style="display:flex; flex:0 1 auto; min-width:0;"></div>
                </div>
                <!-- 中间内容区：当前选中路径的末级节点 + 它下一级 sections（任意层级） -->
                <div style="flex:1; display:flex; flex-direction:column; min-width:0; background:#f9fafb;">
                    <div id="pgContentTitle" style="padding:12px 18px; font-size:13px; color:#374151; border-bottom:1px solid #e5e7eb; background:#ffffff; display:flex; align-items:center; gap:8px;">
                        <i class="fa-solid fa-folder-open" style="color:#6366f1;"></i>
                        <span id="pgContentBreadcrumb" style="flex:1;">请选择左侧分类</span>
                    </div>
                    <div id="pgContent" style="flex:1; overflow-y:auto; padding:14px 18px;"></div>
                    <div id="pgConflictBanner" style="display:none;"></div>
                    <div id="pgRecPanel" style="display:none;"></div>
                    <div style="padding:10px 18px; border-top:1px solid #e5e7eb; display:flex; gap:8px; align-items:center; flex-wrap:wrap; background:#ffffff;">
                        <span id="pgSelectedCount" style="font-size:12px; color:#6b7280;">已选 0 个项</span>
                        <button id="pgBtnClear" class="btn btn-sm">清空选择</button>
                        <span style="flex:1"></span>
                        <button id="pgBtnGenerate" class="btn btn-sm btn-primary"><i class="fa-solid fa-wand-magic-sparkles"></i> 生成提示词</button>
                        <button id="pgBtnRefine" class="btn btn-sm" disabled style="background:#8b5cf6; color:#ffffff; border:1px solid #7c3aed;" title="把当前拼装结果发给 LLM 润色"><i class="fa-solid fa-wand-magic"></i> 优化提示词</button>
                        <button id="pgBtnCancel" class="btn" style="background:#fef2f2; color:#dc2626; border:1px solid #fecaca; display:none;"><i class="fa-solid fa-xmark"></i> 取消</button>
                    </div>
                </div>
                <!-- 3. 生成结果 -->
                <div style="width:420px; border-left:1px solid #e5e7eb; display:flex; flex-direction:column; background:#ffffff;">
                    <div style="padding:12px 16px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:8px;">
                        <span style="font-size:14px; color:#374151; font-weight:500;">生成结果</span>
                        <span id="pgResultMeta" style="flex:1; text-align:right; font-size:11px; color:#9ca3af; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></span>
                        <div style="display:flex; align-items:center; gap:4px;">
                            <input id="pgGenWidth" type="number" min="64" max="4096" step="8"
                                   style="width:56px; padding:4px 6px; font-size:11px; border:1px solid #d1d5db; border-radius:4px;"
                                   title="图片宽度（当前工具不支持时此输入被忽略）" />
                            <span style="color:#9ca3af; font-size:11px;">×</span>
                            <input id="pgGenHeight" type="number" min="64" max="4096" step="8"
                                   style="width:56px; padding:4px 6px; font-size:11px; border:1px solid #d1d5db; border-radius:4px;"
                                   title="图片高度（当前工具不支持时此输入被忽略）" />
                        </div>
                    </div>
                    <!-- tab 切换：提示词 / 图片 -->
                    <div id="pgResultTabs" style="display:flex; border-bottom:1px solid #e5e7eb; background:#fafafa;">
                        <button data-tab="prompt" class="pg-result-tab" style="flex:1; padding:8px 0; border:none; background:#ffffff; border-bottom:2px solid #6366f1; color:#1f2937; font-size:12px; font-weight:500; cursor:pointer;"><i class="fa-solid fa-comment-dots"></i> 提示词</button>
                        <button data-tab="image"  class="pg-result-tab" style="flex:1; padding:8px 0; border:none; background:transparent; border-bottom:2px solid transparent; color:#6b7280; font-size:12px; font-weight:500; cursor:pointer;"><i class="fa-solid fa-image"></i> 图片</button>
                    </div>
                    <!-- 提示词面板 -->
                    <textarea id="pgResult" data-pane="prompt" style="flex:1; padding:14px 16px; background:#fafafa; color:#1f2937; border:none; resize:none; font-size:14px; line-height:1.7; font-family:inherit;" placeholder="点击「生成提示词」开始..."></textarea>
                    <!-- 图片面板 -->
                    <div id="pgResultImage" data-pane="image" style="flex:1; display:none; flex-direction:column; padding:14px; background:#fafafa; min-height:0;">
                        <div id="pgResultImageEmpty" style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#9ca3af; font-size:12px;">
                            <i class="fa-solid fa-image" style="font-size:48px; color:#e5e7eb; margin-bottom:12px;"></i>
                            <div>点底部「AI 生图」按钮调用本地 ComfyUI 出图</div>
                            <div style="font-size:11px; color:#d1d5db; margin-top:6px;">需先在「模型」配置 ComfyUI 并启动</div>
                        </div>
                        <div id="pgResultImageLoaded" style="flex:1; display:none; flex-direction:column; min-height:0;">
                            <div id="pgResultMediaHost" style="flex:1; display:flex; align-items:center; justify-content:center; background:#1f2937; border-radius:6px; overflow:hidden; min-height:0;">
                                <img id="pgResultMediaImg" style="max-width:100%; max-height:100%; object-fit:contain; display:block;" />
                                <video id="pgResultMediaVideo" controls style="max-width:100%; max-height:100%; object-fit:contain; display:none;"></video>
                            </div>
                            <div id="pgResultImageMeta" style="font-size:11px; color:#6b7280; padding:6px 0;"></div>
                            <div style="display:flex; gap:6px; padding-top:6px;">
                                <button id="pgBtnSaveImageToLib" class="btn btn-sm" disabled title="保存到提示词库（关联当前提示词）"><i class="fa-solid fa-floppy-disk"></i> 保存到库</button>
                                <button id="pgBtnSaveImageAs" class="btn btn-sm" disabled><i class="fa-solid fa-download"></i> 另存为</button>
                                <button id="pgBtnSetAsPreview" class="btn btn-sm" disabled title="把当前生图设为选中提示词的预览图（多选时弹出选择框）"><i class="fa-solid fa-image"></i> 设为预览图</button>
                            </div>
                        </div>
                    </div>
                    <div style="padding:10px 14px; border-top:1px solid #e5e7eb; display:flex; gap:6px; flex-wrap:wrap; align-items:center; background:#ffffff;">
                        <button id="pgBtnCopy" class="btn btn-sm"><i class="fa-solid fa-copy"></i> 复制</button>
                        <button id="pgBtnSave" class="btn btn-sm btn-primary" disabled><i class="fa-solid fa-floppy-disk"></i> 保存提示词</button>
                        <!-- 文生图 split-button：左侧点击生图、右侧 ▼ 弹菜单换工具 -->
                        <div class="pg-gen-split" id="pgGenSplit" disabled>
                            <button id="pgBtnGenImage" class="pg-gen-main" disabled title="用选中工作流生图">
                                <i class="fa-solid fa-image" id="pgGenIcon"></i>
                                <span id="pgGenLabel">AI 生图</span>
                            </button>
                            <button id="pgBtnGenArrow" class="pg-gen-arrow" disabled title="切换文生图工具" aria-label="切换文生图工具"><i class="fa-solid fa-caret-down"></i></button>
                        </div>
                        <select id="pgSelectT2iTool" hidden>
                            <option value="">(加载中…)</option>
                        </select>
                        <button id="pgBtnRegen" class="btn btn-sm" disabled><i class="fa-solid fa-rotate"></i> 重新生成</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(page);

        // 绑定
        page.querySelector('#pgBtnBack').addEventListener('click', close);
        page.querySelector('#pgBtnGenerate').addEventListener('click', doGenerate);
        page.querySelector('#pgBtnCancel').addEventListener('click', doCancel);
        page.querySelector('#pgBtnCopy').addEventListener('click', doCopy);
        page.querySelector('#pgBtnSave').addEventListener('click', doSave);
        page.querySelector('#pgBtnRegen').addEventListener('click', doGenImage);
        page.querySelector('#pgBtnRefine').addEventListener('click', doRefine);
        page.querySelector('#pgBtnClear').addEventListener('click', doClear);
        page.querySelector('#pgBtnHistory').addEventListener('click', openHistoryDrawer);
        page.querySelector('#pgBtnLibrary').addEventListener('click', openPromptLibrary);
        // textarea 内容变化 → 实时同步「保存提示词」按钮可用状态
        page.querySelector('#pgResult').addEventListener('input', updateSaveButtonState);
        // ComfyUI：tab 切换 + AI 生图按钮 + 图片保存
        page.querySelectorAll('.pg-result-tab').forEach(b => {
            b.addEventListener('click', () => switchResultTab(b.dataset.tab));
        });
        page.querySelector('#pgBtnGenImage').addEventListener('click', doGenImage);
        page.querySelector('#pgBtnGenArrow').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleGenMenu();
        });
        // 点菜单外部关闭（菜单已挂到 body，点击 split 内或菜单内都不关；只有两者之外才关）
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('pgGenMenu');
            const split = document.getElementById('pgGenSplit');
            if (!menu || !split) return;
            if (!split.contains(e.target) && !menu.contains(e.target)) closeGenMenu();
        });
        page.querySelector('#pgBtnSaveImageToLib').addEventListener('click', saveCurrentImageToLibrary);
        page.querySelector('#pgBtnSaveImageAs').addEventListener('click', saveCurrentImageAs);
        page.querySelector('#pgBtnSetAsPreview').addEventListener('click', setCurrentImageAsPreview);
        // 点击生图结果图片/视频 → 放大查看
        const pgResultImgEl = page.querySelector('#pgResultMediaImg');
        if (pgResultImgEl) {
            pgResultImgEl.style.cursor = 'zoom-in';
            pgResultImgEl.addEventListener('click', () => {
                if (pgResultImgEl.src) openMediaZoomModal(pgResultImgEl.src, 'image/*');
            });
        }
        const pgResultVidEl = page.querySelector('#pgResultMediaVideo');
        if (pgResultVidEl) {
            pgResultVidEl.style.cursor = 'zoom-in';
            pgResultVidEl.addEventListener('click', () => {
                if (pgResultVidEl.src) openMediaZoomModal(pgResultVidEl.src, pgResultVidEl.currentSrc || 'video/mp4');
            });
        }
        // 用户手敲/粘贴到提示词区：即时同步按钮 enable 状态
        const pgResultEl = page.querySelector('#pgResult');
        if (pgResultEl) {
            pgResultEl.addEventListener('input', () => {
                _resultText = pgResultEl.value;
                syncResultActions();
            });
        }
        // D-29: mode 切换
        page.querySelectorAll('.pgModeTab').forEach(btn => {
            btn.addEventListener('click', async () => {
                const mode = btn.dataset.mode;
                await api.llm.configSet({ mode });
                _llmConfig = _llmConfig ? { ..._llmConfig, mode } : { mode };
                updateModeUI();
                // D-31: 模式切换后重新加载中间内容区，让 chip 按 sensitivity 过滤
                loadAndRenderContent();
                showToast(`已切换到 ${mode.toUpperCase()} 模式`, 'success');
            });
        });
        // 预览图浮层：事件委托（pgContent 是稳定父元素，chip 重建也不影响）
        const pgContentEl = page.querySelector('#pgContent');
        if (pgContentEl && !pgContentEl._pvDelegated) {
            pgContentEl._pvDelegated = true;
            pgContentEl.addEventListener('mouseenter', (e) => {
                const chip = e.target.closest && e.target.closest('[data-item-id]');
                if (!chip) return;
                _cancelHidePvTip();
                const id = Number(chip.dataset.itemId);
                const item = _chipItemCache.get(id);
                if (item) _showPvTip(item, chip);
            }, true);
            pgContentEl.addEventListener('mouseleave', (e) => {
                const chip = e.target.closest && e.target.closest('[data-item-id]');
                if (!chip) return;
                _hidePvTipDelayed();
            }, true);
        }
    }

    // D-29: 模式 UI 同步（用 class 切换，CSS 控制样式，含 hover 行为）
    function updateModeUI() {
        const mode = (_llmConfig && _llmConfig.mode) || 'sfw';
        document.querySelectorAll('.pgModeTab').forEach(b => {
            const active = b.dataset.mode === mode;
            // 三个互斥 class：active-sfw / active-nsfw / inactive
            b.classList.remove('active-sfw', 'active-nsfw', 'inactive');
            if (active) {
                b.classList.add(mode === 'nsfw' ? 'active-nsfw' : 'active-sfw');
            } else {
                b.classList.add('inactive');
            }
        });
        // 头部 bar 颜色提示
        const bar = document.getElementById('pgHeaderBar');
        if (bar) {
            if (mode === 'nsfw') {
                bar.style.background = 'linear-gradient(to right, #fff5f5, #ffffff)';
                bar.style.borderBottom = '1px solid #fecaca';
            } else {
                bar.style.background = '#ffffff';
                bar.style.borderBottom = '1px solid #e5e7eb';
            }
        }
        // 结果区 placeholder 文字调整
        const result = document.getElementById('pgResult');
        if (result) {
            result.placeholder = mode === 'nsfw'
                ? 'NSFW 模式已启动\n选择 2-3 个标签 → 「生成提示词」 → 输出 JAV 风格英文 prompt'
                : '点击「生成提示词」开始...';
        }
    }

    function showPage() {
        const page = document.getElementById('promptGenPage');
        if (page) page.style.display = 'flex';
        // 隐藏瀑布流
        const main = document.querySelector('main');
        const header = document.querySelector('header');
        if (main) main.style.display = 'none';
        if (header) header.style.display = 'none';
    }

    // ========== ComfyUI：配置 / 状态 / 事件订阅 / 生图 / 保存 ==========
    async function loadComfyConfig() {
        try {
            const r = await api.comfyui.configGet();
            _comfyConfig = r && r.ok ? r.config : null;
        } catch (e) {
            _comfyConfig = null;
        }
    }

    async function refreshComfyStatus() {
        const el = document.getElementById('pgComfyStatus');
        if (!el) return;
        let r = null;
        try { r = await api.comfyui.status(); } catch (e) {}
        if (!r) {
            _comfyStatus = null;
            el.style.color = '#9ca3af';
            el.textContent = '● ComfyUI 未启动';
            syncResultActions();
            return;
        }
        _comfyStatus = r;
        if (r.running) {
            el.style.color = '#059669';
            el.textContent = `● ComfyUI 运行中 (${r.port || '?'})`;
        } else if (r.lastError) {
            el.style.color = '#dc2626';
            el.textContent = `● ComfyUI 启动失败: ${r.lastError}`;
        } else {
            el.style.color = '#9ca3af';
            el.textContent = '● ComfyUI 未启动';
        }
        syncResultActions();
    }

    function subscribeComfyEvents() {
        // 已经订阅过就先解绑
        for (const u of _comfyUnsubscribe) { try { u && u(); } catch (e) {} }
        _comfyUnsubscribe = [];
        if (!api.comfyui || typeof api.comfyui.onProgress !== 'function') return;
        _comfyUnsubscribe.push(api.comfyui.onProgress(onComfyProgress));
        _comfyUnsubscribe.push(api.comfyui.onComplete(onComfyComplete));
        _comfyUnsubscribe.push(api.comfyui.onError(onComfyError));
        _comfyUnsubscribe.push(api.comfyui.onExit(onComfyExit));
    }

    function switchResultTab(tab) {
        _resultTab = tab;
        const tabs = document.querySelectorAll('.pg-result-tab');
        tabs.forEach(b => {
            const active = b.dataset.tab === tab;
            b.style.background = active ? '#ffffff' : 'transparent';
            b.style.color = active ? '#1f2937' : '#6b7280';
            b.style.borderBottom = active ? '2px solid #6366f1' : '2px solid transparent';
        });
        const promptPane = document.getElementById('pgResult');
        const imagePane = document.getElementById('pgResultImage');
        if (promptPane) promptPane.style.display = tab === 'prompt' ? 'block' : 'none';
        if (imagePane) imagePane.style.display = tab === 'image' ? 'flex' : 'none';
    }

    async function doGenImage() {
        const btn = document.getElementById('pgBtnGenImage');
        const sel = document.getElementById('pgSelectT2iTool');
        const meta = document.getElementById('pgResultMeta');
        // 立即给视觉反馈（不等任何 await），保证即便后续异常被吞用户也能看到
        // 「点了有响应」的明确信号
        try {
            setGenBtnState('loading', '准备中...');
            if (meta) { meta.textContent = '准备提交生图...'; meta.style.color = '#0ea5e9'; }
        } catch (_) {}
        // 兜底：捕获所有未预期异常（IPC reject / sync throw 等），避免 click handler
        // fire-and-forget 把异常吞掉导致「按钮能点无任何反馈」。
        try {
            return await _doGenImageInner(btn, sel, meta);
        } catch (e) {
            try { setGenBtnState('idle'); } catch (_) {}
            const msg = (e && e.message) || String(e);
            showToast('生图请求失败: ' + msg, 'error');
            if (meta) { meta.textContent = '生图异常: ' + msg; meta.style.color = '#dc2626'; }
            console.error('[doGenImage] 未捕获异常:', e);
        }
    }

    async function _doGenImageInner(btn, sel, meta) {
        // submitted = true 表示已经把 job 提交到 ComfyUI，需要等 onComfyComplete 来恢复按钮；
        // 其它任何提前 return / 抛异常都要恢复按钮 idle（doGenImage 外层也会做一次兜底）
        let submitted = false;
        try {
            // 1) 以 textarea 当前值为准（用户手敲/粘贴可能没同步到 _resultText）
            const resultEl = document.getElementById('pgResult');
            const promptText = ((resultEl && resultEl.value) || _resultText || '').trim();
            if (!promptText) {
                showToast('没有可用的提示词，请先生成或拼装', 'error');
                return;
            }
            // 2) 从 select 拿选中的文生图工具
            const toolId = sel && sel.value;
            if (!toolId) {
                showToast('请先选择一个文生图工具', 'error');
                return;
            }
            // 3) 取工具 schema，拼 formValues（prompt + 其他 default）
            const toolRes = await api.tools.get(toolId);
            if (!toolRes || !toolRes.ok || !toolRes.tool) {
                showToast('加载工具失败: ' + ((toolRes && toolRes.error) || '未知'), 'error');
                return;
            }
            const tool = toolRes.tool;
            // 读「宽×高」输入（仅当 input 可用 + 有值时才作为 override）
            const sizeOverride = {};
            const wEl = document.getElementById('pgGenWidth');
            const hEl = document.getElementById('pgGenHeight');
            if (wEl && !wEl.disabled && wEl.value.trim() !== '') {
                const n = parseInt(wEl.value, 10);
                if (!Number.isNaN(n)) sizeOverride.width = n;
            }
            if (hEl && !hEl.disabled && hEl.value.trim() !== '') {
                const n = parseInt(hEl.value, 10);
                if (!Number.isNaN(n)) sizeOverride.height = n;
            }
            const { values: formValues, promptFieldId } = buildT2iFormValues(tool, promptText, sizeOverride);
            if (!promptFieldId) {
                showToast('该工具没有文本输入字段', 'error');
                return;
            }
            // 4) 拿最新 comfyui 状态（防 polling 滞后）
            await refreshComfyStatus();
            // 5) 没跑就自动启动（tools.run 也会自动启，但提前启动可以早一点把 UI 状态切对）
            if (!_comfyStatus || !_comfyStatus.running) {
                const cfg = _comfyConfig;
                if (!cfg || !cfg.pythonPath || !cfg.comfyDir) {
                    showToast('未配置 ComfyUI 路径，请先在「模型」里设置', 'error');
                    return;
                }
                if (btn) { setGenBtnState('loading', '启动 ComfyUI...'); }
                if (meta) { meta.textContent = 'ComfyUI 未启动，正在自动启动（大模型冷启可能需 30-120s）...'; meta.style.color = '#0ea5e9'; }
                const sr = await api.comfyui.start(cfg);
                if (!sr || !sr.ok) {
                    if (meta) { meta.textContent = 'ComfyUI 启动失败: ' + ((sr && sr.error) || '未知'); meta.style.color = '#dc2626'; }
                    showToast('ComfyUI 启动失败: ' + ((sr && sr.error) || '未知'), 'error');
                    await refreshComfyStatus();
                    return;
                }
                // 启动成功，刷新状态
                await refreshComfyStatus();
                if (meta) { meta.textContent = 'ComfyUI 已启动，准备生图...'; meta.style.color = '#059669'; }
            }
            // 6) 提交生图（走 tools.run：动态工具 + formValues）
            if (btn) { setGenBtnState('loading', '生成中...'); }
            const mode = (tool && tool.mode) || (_llmConfig && _llmConfig.mode) || 'sfw';
            if (meta) { meta.textContent = `${tool.name || toolId} | ${mode.toUpperCase()} | 提交中...`; meta.style.color = '#0ea5e9'; }
            const r = await api.tools.run({ toolId, formValues });
            if (!r || !r.ok) {
                if (meta) { meta.textContent = `生图失败: ${(r && r.error) || '未知错误'}`; meta.style.color = '#dc2626'; }
                showToast('生图失败: ' + ((r && r.error) || '未知错误'), 'error');
                return;
            }
            submitted = true;  // 已提交，交给 onComfyComplete 恢复按钮
            _currentImageJobId = r.jobId;
            if (meta) meta.textContent = `${tool.name || toolId} | ${mode.toUpperCase()} | jobId=${r.jobId} | 等待结果...`;
            // 自动切到图片 tab（无图占位 + spinner）
            showImageWaiting();
            switchResultTab('image');
        } finally {
            // 任何提前 return / 异常（非成功提交）都恢复按钮 idle
            if (!submitted) {
                try { setGenBtnState('idle'); } catch (_) {}
            }
        }
    }

    function showImageWaiting() {
        const empty = document.getElementById('pgResultImageEmpty');
        const loaded = document.getElementById('pgResultImageLoaded');
        if (empty) empty.style.display = 'flex';
        if (loaded) loaded.style.display = 'none';
        // 清掉旧的 img/video src，避免下次同类型时显示上一次的产物
        const img = document.getElementById('pgResultMediaImg');
        const vid = document.getElementById('pgResultMediaVideo');
        if (img) img.removeAttribute('src');
        if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); }
    }

    function showImageLoaded() {
        const empty = document.getElementById('pgResultImageEmpty');
        const loaded = document.getElementById('pgResultImageLoaded');
        if (empty) empty.style.display = 'none';
        if (loaded) loaded.style.display = 'flex';
    }

    // 同步结果区操作按钮（含 AI 生图）的 enable 状态
    // 调用时机：_resultText 改变后（doGenerate / doAssemble / doRefine / history 载入）
    // 也由 textarea 的 input 事件触发（手敲 / 粘贴也支持）
    // 注意：AI 生图按钮**只在「没选中工作流」时禁用**——其他状态（无提示词 / 未配 ComfyUI）
    // 故意不禁用，让用户点了之后走 doGenImage → showToast 的明确反馈路径，
    // 避免「下拉选完后按钮看似有响应其实被静默禁用」的体验断裂。
    function syncResultActions() {
        const btnGen = document.getElementById('pgBtnGenImage');
        const btnRegen = document.getElementById('pgBtnRegen');
        if (!btnGen) return;
        const sel = document.getElementById('pgSelectT2iTool');
        const hasTool = !!(sel && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex].value && !sel.options[sel.selectedIndex].text.startsWith('('));
        btnGen.disabled = !hasTool;
        // 旁边的「重新生成」按钮跟 AI 生图走同一套判断（有工具就可点），
        // 但语义是「用现有 prompt 再跑一次 ComfyUI」，所以 click handler 走 doGenImage
        if (btnRegen) btnRegen.disabled = !hasTool;
        // tooltip：提示当前可点 / 不可点的理由（hover 可见）
        const resultEl = document.getElementById('pgResult');
        const liveText = (resultEl && resultEl.value) || _resultText || '';
        const hasConfig = !!(_comfyConfig && _comfyConfig.pythonPath && _comfyConfig.comfyDir);
        const running = !!(_comfyStatus && _comfyStatus.running);
        if (!hasTool) {
            btnGen.title = '先在右上 ▼ 选一个文生图工作流';
        } else if (!liveText.trim()) {
            btnGen.title = '先生成或拼装一段提示词（也可点我看提示）';
        } else if (!hasConfig && !running) {
            btnGen.title = '请先在「模型」里配置 ComfyUI 路径（也可点我自动启动）';
        } else if (!running) {
            btnGen.title = '点一下自动启动 ComfyUI 并生图';
        } else {
            btnGen.title = '调本地 ComfyUI 出图';
        }
    }

    function onComfyProgress(payload) {
        if (!payload || payload.jobId !== _currentImageJobId) return;
        const meta = document.getElementById('pgResultMeta');
        if (meta && payload.value && payload.max) {
            meta.textContent = `ComfyUI: ${payload.value}/${payload.max}${payload.node ? ' (' + payload.node + ')' : ''}`;
        } else if (meta) {
            meta.textContent = `ComfyUI: 处理中...`;
        }
    }

    // 放大查看生图结果（点击图片/视频打开全屏 modal）
    function openMediaZoomModal(src, mime) {
        if (!src) return;
        const isVideo = (mime || '').startsWith('video/');
        let overlay = document.getElementById('pgImgZoomOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'pgImgZoomOverlay';
            overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:100000; display:flex; align-items:center; justify-content:center; cursor:zoom-out;';
            overlay.innerHTML = `
                <img id="pgImgZoomImg" style="max-width:95vw; max-height:95vh; object-fit:contain; box-shadow:0 8px 32px rgba(0,0,0,0.5); border-radius:6px; background:#111827;" />
                <video id="pgImgZoomVideo" controls style="max-width:95vw; max-height:95vh; object-fit:contain; box-shadow:0 8px 32px rgba(0,0,0,0.5); border-radius:6px; background:#111827; display:none;"></video>
                <button id="pgImgZoomClose" title="关闭 (Esc)" style="position:absolute; top:18px; right:22px; width:40px; height:40px; border-radius:50%; border:1px solid rgba(255,255,255,0.25); background:rgba(0,0,0,0.5); color:#ffffff; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-xmark"></i></button>
            `;
            document.body.appendChild(overlay);

            const close = () => {
                overlay.style.display = 'none';
                const v = overlay.querySelector('#pgImgZoomVideo');
                if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
            };
            overlay.addEventListener('click', (e) => {
                if (e.target.closest('#pgImgZoomClose') || e.target.id === 'pgImgZoomImg' || e.target.id === 'pgImgZoomVideo' || e.target === overlay) {
                    close();
                }
            });
            overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
            overlay.tabIndex = -1;
        }
        const img = overlay.querySelector('#pgImgZoomImg');
        const vid = overlay.querySelector('#pgImgZoomVideo');
        if (isVideo) {
            if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
            if (vid) { vid.src = src; vid.style.display = 'block'; }
        } else {
            if (vid) { vid.pause(); vid.removeAttribute('src'); vid.style.display = 'none'; vid.load(); }
            if (img) { img.src = src; img.style.display = 'block'; }
        }
        overlay.style.display = 'flex';
        overlay.focus();
    }

    // 渲染生图/视频结果到结果区（按 mime 自动切换 img/video）
    function renderMediaFromPayload(payload) {
        const mime = (payload && payload.mime) || '';
        const dataUrl = (payload && payload.dataUrl) || '';
        const img = document.getElementById('pgResultMediaImg');
        const vid = document.getElementById('pgResultMediaVideo');
        if (mime.startsWith('video/')) {
            if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
            if (vid) { vid.src = dataUrl; vid.style.display = 'block'; vid.load(); }
        } else {
            if (vid) { vid.pause(); vid.removeAttribute('src'); vid.style.display = 'none'; vid.load(); }
            if (img) { img.src = dataUrl; img.style.display = 'block'; }
        }
    }

    function onComfyComplete(payload) {
        if (!payload || payload.jobId !== _currentImageJobId) return;
        _currentImage = {
            dataUrl: payload.dataUrl,
            filename: payload.filename,
            mime: payload.mime,
            meta: payload.meta || {},
        };
        _currentImageJobId = null;
        const metaEl = document.getElementById('pgResultImageMeta');
        renderMediaFromPayload(payload);
        if (metaEl) {
            const sizeKB = Math.round((payload.meta && payload.meta.fileSize ? payload.meta.fileSize : 0) / 1024);
            const mode = (payload.meta && payload.meta.mode) ? payload.meta.mode.toUpperCase() : '-';
            const kind = (payload.mime || '').startsWith('video/') ? '视频' : '图片';
            metaEl.textContent = `${payload.filename} | ${sizeKB} KB | ${mode} | ${kind}`;
        }
        showImageLoaded();
        document.getElementById('pgBtnSaveImageToLib').disabled = false;
        document.getElementById('pgBtnSaveImageAs').disabled = false;
        document.getElementById('pgBtnSetAsPreview').disabled = false;
        const meta = document.getElementById('pgResultMeta');
        if (meta) { meta.textContent = `ComfyUI: 完成`; meta.style.color = '#059669'; }
        const btn = document.getElementById('pgBtnGenImage');
        if (btn) { setGenBtnState('idle'); }
        refreshComfyStatus().catch(() => {});
        showToast('生图完成', 'success');
    }

    function onComfyError(payload) {
        if (!payload) return;
        if (payload.jobId && payload.jobId !== _currentImageJobId) return;
        _currentImageJobId = null;
        const meta = document.getElementById('pgResultMeta');
        if (meta) { meta.textContent = `ComfyUI 错误: ${payload.message || payload.code || '未知'}`; meta.style.color = '#dc2626'; }
        const btn = document.getElementById('pgBtnGenImage');
        if (btn) { setGenBtnState('idle'); }
        showToast('ComfyUI: ' + (payload.message || '失败'), 'error');
    }

    function onComfyExit(payload) {
        const el = document.getElementById('pgComfyStatus');
        if (el) { el.style.color = '#dc2626'; el.textContent = `● ComfyUI 已退出 (code ${payload && payload.code != null ? payload.code : '?'})`; }
        _comfyStatus = { running: false };
        const btn = document.getElementById('pgBtnGenImage');
        if (btn) { setGenBtnState('disabled'); btn.title = 'ComfyUI 已退出'; }
    }

    // 解析 data URL 成 { mime, base64, byteLength }
    // 注意：renderer 进程没有 Buffer，所以**不**在这里 decode，直接把 base64 字符串传给主进程
    // 主进程的 comfyui:saveMedia / comfyui:saveAs 接受 { bytes: 'base64字符串' }
    function dataUrlToBuffer(dataUrl) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
        if (!m) throw new Error('dataUrl 格式不合法');
        const base64 = m[2];
        // atob 在 renderer 可用；返回 latin-1 binary string，每个字符 = 1 字节
        let byteLength;
        try { byteLength = atob(base64).length; }
        catch (e) { throw new Error('dataUrl base64 非法: ' + e.message); }
        return { mime: m[1], base64, byteLength };
    }

    function extFromMime(mime) {
        if (mime === 'image/png') return 'png';
        if (mime === 'image/jpeg') return 'jpg';
        if (mime === 'image/webp') return 'webp';
        if (mime === 'image/gif') return 'gif';
        return 'bin';
    }

    async function saveCurrentImageToLibrary() {
        if (!_currentImage) return;
        const resultEl = document.getElementById('pgResult');
        const promptText = (resultEl && resultEl.value) || _resultText || '';
        if (!promptText) {
            showToast('当前结果区无提示词文本，无法关联到库', 'error');
            return;
        }
        // 先把图片写到 media/<tmp>.<ext>，拿到 mediaPath/mime/size
        const tmpId = 'img-' + Date.now();
        const { mime, base64, byteLength } = dataUrlToBuffer(_currentImage.dataUrl);
        // 走主进程 saveMedia 写到 promptsDir/media/<id>.<ext>
        // 主进程期望的 payload 形状：{ id, mime, dataBase64 }
        const wr = await api.comfyui.saveMedia({
            id: tmpId,
            mime,
            dataBase64: base64,
        });
        if (!wr || !wr.ok) {
            showToast('写图片失败: ' + ((wr && wr.error) || '未知'), 'error');
            return;
        }
        // 把 prompt 写入库（带 media_* 字段）
        const tags = Array.from(_selectedItems.values()).map(x => x.name || x.category_name || '').filter(Boolean);
        const wr2 = await api.prompts.writeOneWithMedia(tmpId, promptText, tags, wr.mediaPath, mime, byteLength);
        if (!wr2 || !wr2.ok) {
            showToast('写提示词失败: ' + ((wr2 && wr2.error) || '未知'), 'error');
            return;
        }
        showToast(`已保存到库 (id=${tmpId})`, 'success');
    }

    async function saveCurrentImageAs() {
        if (!_currentImage) return;
        const { mime, base64, byteLength } = dataUrlToBuffer(_currentImage.dataUrl);
        const ext = extFromMime(mime);
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const defaultName = `comfyui-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.${ext}`;
        const r = await api.comfyui.saveAs({
            defaultName,
            mime,
            dataBase64: base64,
            byteLength,
        });
        if (!r || !r.ok) {
            showToast('另存为失败: ' + ((r && r.error) || '未知'), 'error');
            return;
        }
        showToast('已保存到 ' + (r.path || '本地'), 'success');
    }

    // 把当前生成的图设为选中提示词的预览图
    // 单选：直接走；多选：弹 modal 让用户勾选要赋给哪些提示词
    async function setCurrentImageAsPreview() {
        if (!_currentImage) return;
        const items = Array.from(_selectedItems.values());
        if (items.length === 0) {
            showToast('请先选择提示词', 'error');
            return;
        }
        // 1. 取图 + 必要压缩（preview IPC 上限 2MB，ComfyUI 输出经常超）
        let mime, base64;
        try {
            ({ mime, base64 } = dataUrlToBuffer(_currentImage.dataUrl));
        } catch (e) {
            showToast('图片数据异常: ' + e.message, 'error');
            return;
        }
        let byteLen = 0;
        try { byteLen = atob(base64).length; } catch (_) {}
        if (byteLen > 2 * 1024 * 1024) {
            try {
                const blob = await (await fetch(_currentImage.dataUrl)).blob();
                const c = await window._compressImageToBase64(blob, 100 * 1024);
                mime = c.mime; base64 = c.dataBase64;
            } catch (e) {
                showToast('压缩失败: ' + (e && e.message || e), 'error');
                return;
            }
        }
        // 2. 选 1 个：直接走；>=2 个：弹 modal
        let targetIds;
        if (items.length === 1) {
            targetIds = new Set([items[0].id]);
        } else {
            targetIds = await openPreviewAssignModal(items, _currentImage.dataUrl);
            if (!targetIds || targetIds.size === 0) return;
        }
        // 3. 上传一次 → 共享 fileName（多 item 共一份物理文件，避免重复 copy；主进程 update 会自动删旧 preview_file）
        const up = await api.promptPreview.upload({
            itemId: `gen-${Date.now()}`,
            mime,
            dataBase64: base64,
        });
        if (!up || !up.ok) {
            showToast('上传失败: ' + ((up && up.error) || '未知'), 'error');
            return;
        }
        // 4. 逐条 update；_chipItemCache 也要就地刷，保证 hover 立刻看到新预览
        let ok = 0, fail = 0;
        for (const id of targetIds) {
            const r = await api.promptItems.update({ id, preview_file: up.fileName });
            if (r && r.ok) {
                const cached = _chipItemCache.get(id);
                if (cached) cached.preview_image = up.fileName;
                ok++;
            } else {
                fail++;
            }
        }
        if (fail) showToast(`已设为 ${ok} 个，失败 ${fail}`, 'error');
        else showToast(`已设为 ${ok} 个提示词的预览图`, 'success');
    }

    // 多选 modal：让用户选哪些提示词要赋当前生图为预览图
    // 返回 Promise<Set<itemId> | null>
    function openPreviewAssignModal(items, thumbDataUrl) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay pg-assign-preview-modal active';
            overlay.style.cssText = 'z-index:2200;';
            overlay.innerHTML = `
                <div class="modal" style="max-width:460px; padding:18px 20px;">
                    <div style="display:flex; align-items:center; gap:12px; padding-bottom:12px; border-bottom:1px solid #e5e7eb; margin-bottom:12px;">
                        <img src="${thumbDataUrl}" style="width:80px; height:60px; object-fit:cover; border-radius:4px; border:1px solid #e5e7eb;" />
                        <div style="flex:1; font-size:13px; color:#374151;">把当前生成的图设为下方勾选提示词的预览图（已有的预览将被替换）</div>
                    </div>
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                        <span style="font-size:12px; color:#6b7280;">已选 ${items.length} 个</span>
                        <button type="button" class="pg-assign-toggle-all" style="background:transparent;border:none;color:#6366f1;font-size:12px;cursor:pointer;padding:2px 6px;">全选/全不选</button>
                    </div>
                    <div class="pg-assign-list" style="border:1px solid #e5e7eb; border-radius:6px; padding:6px;">
                        ${items.map(it => `
                            <label data-id="${it.id}">
                                <input type="checkbox" class="pg-assign-chk" data-id="${it.id}" checked />
                                <span style="flex:1;">${escHtml(it.name || '(未命名)')}</span>
                                ${it.preview_image ? '<span style="font-size:10px;color:#f59e0b;" title="该提示词已有预览图，将被替换">已有图</span>' : ''}
                            </label>
                        `).join('')}
                    </div>
                    <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;">
                        <button type="button" class="btn btn-sm pg-assign-cancel">取消</button>
                        <button type="button" class="btn btn-sm btn-primary pg-assign-ok" style="background:#6366f1;color:#fff;border-color:#4f46e5;">设为 <span class="pg-assign-count">${items.length}</span> 个预览图</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const chkEls = overlay.querySelectorAll('.pg-assign-chk');
            const countEl = overlay.querySelector('.pg-assign-count');
            const okBtn = overlay.querySelector('.pg-assign-ok');
            const updateCount = () => {
                const n = Array.from(chkEls).filter(c => c.checked).length;
                countEl.textContent = String(n);
                okBtn.disabled = n === 0;
                okBtn.style.opacity = n === 0 ? '0.5' : '1';
                okBtn.style.cursor = n === 0 ? 'not-allowed' : 'pointer';
            };
            updateCount();
            chkEls.forEach(c => c.addEventListener('change', updateCount));

            // 全选切换
            overlay.querySelector('.pg-assign-toggle-all').addEventListener('click', () => {
                const allChecked = Array.from(chkEls).every(c => c.checked);
                chkEls.forEach(c => { c.checked = !allChecked; });
                updateCount();
            });

            const cleanup = () => {
                document.removeEventListener('keydown', onKey);
                overlay.remove();
            };
            const onKey = (e) => { if (e.key === 'Escape') { cleanup(); resolve(null); } };
            document.addEventListener('keydown', onKey);

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) { cleanup(); resolve(null); }
            });
            overlay.querySelector('.pg-assign-cancel').addEventListener('click', () => {
                cleanup(); resolve(null);
            });
            okBtn.addEventListener('click', () => {
                const ids = new Set();
                chkEls.forEach(c => { if (c.checked) ids.add(Number(c.dataset.id)); });
                cleanup();
                resolve(ids);
            });
        });
    }

    // ========== 文生图（t2i）工具：动态选择 AI 工具替换写死的工作流 ==========

    // 「文生图」工具判定：
    //   1) 没有 image 类型字段（不依赖图片上传）
    //   2) 有 textarea / text 字段（可输入 prompt）
    //   3) 输出节点含 image 类型（产物是图片，不是视频/文本）
    //   4) 未 broken（schema 或 workflow 文件损坏的直接跳过）
    // 与 ai-tools.js:447 同款逻辑，保持同步。
    function isT2iTool(t) {
        if (!t) return false;
        if (t.broken) return false;        // schema 或 workflow 损坏
        if (t.error) return false;         // 有错误信息
        const fields = Array.isArray(t.fieldTypes) ? t.fieldTypes : [];
        let hasPromptField = false;
        for (const f of fields) {
            if (!f) continue;
            if (f.type === 'image') return false;
            if (f.type === 'textarea' || f.type === 'text') hasPromptField = true;
        }
        if (!hasPromptField) return false;
        const outs = Array.isArray(t.outputNodeTypes) ? t.outputNodeTypes : [];
        return outs.some(o => o && o.type === 'image');
    }

    // 页面打开时拉一次工具列表，填进 #pgSelectT2iTool（隐藏 state）+ 自定义下拉菜单
    async function loadT2iTools() {
        const sel = document.getElementById('pgSelectT2iTool');
        const mainBtn = document.getElementById('pgBtnGenImage');
        const arrowBtn = document.getElementById('pgBtnGenArrow');
        const split = document.getElementById('pgGenSplit');
        const labelEl = document.getElementById('pgGenLabel');
        if (!sel || !mainBtn || !arrowBtn || !split) return;
        let tools = [];
        try {
            const r = await api.tools.list();
            if (r && r.ok && Array.isArray(r.tools)) tools = r.tools;
        } catch (e) {
            sel.innerHTML = '<option value="">(加载失败)</option>';
            labelEl.textContent = 'AI 生图（加载失败）';
            return;
        }
        const t2i = tools.filter(isT2iTool);
        if (!t2i.length) {
            sel.innerHTML = '<option value="">(无文生图工具)</option>';
            labelEl.textContent = 'AI 生图（无工具）';
            return;
        }
        // 1) 隐藏 select 仍作为数据源（doGenImage 通过 sel.value 拿当前 toolId）
        sel.innerHTML = t2i.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)}</option>`).join('');
        sel.value = t2i[0].id;
        // 1.5) 同步「宽×高」输入框状态（依据第一个 tool 的 schema）
        // 需要先 fetch 拿到完整 schema（含 formFields），因为 list() 只返回摘要
        api.tools.get(t2i[0].id).then((res) => {
            if (res && res.ok && res.tool) syncGenSizeInputs(res.tool);
        }).catch(() => {});
        // 2) 主按钮显示当前工具名
        const fmtLabel = (name) => `AI 生图 · ${name}`;
        labelEl.textContent = fmtLabel(t2i[0].name);
        // 3) 解禁按钮
        mainBtn.disabled = false;
        arrowBtn.disabled = false;
        split.removeAttribute('disabled');
        // 旁边的「重新生成」按钮也解禁（语义跟 AI 生图一致：有可用工具就能跑）
        const regenBtn = document.getElementById('pgBtnRegen');
        if (regenBtn) regenBtn.disabled = false;
        // 4) 构建/刷新自定义下拉菜单（每次刷新工具列表都重建）
        let menu = document.getElementById('pgGenMenu');
        if (menu) menu.remove();
        menu = document.createElement('div');
        menu.id = 'pgGenMenu';
        menu.className = 'pg-gen-menu';
        menu.innerHTML = t2i.map(t => `
            <div class="pg-gen-menu-item${t.id === t2i[0].id ? ' selected' : ''}" data-tool-id="${escHtml(t.id)}">
                <i class="fa-solid fa-check pg-gen-check"${t.id === t2i[0].id ? '' : ' style="visibility:hidden;"'}></i>
                <span style="flex:1;">${escHtml(t.name)}</span>
            </div>
        `).join('');
        // 菜单挂到 document.body 上，避免被父级 overflow / 层级裁剪影响可见性
        // 用 position:fixed + getBoundingClientRect 计算位置（防被页面边缘遮挡）
        document.body.appendChild(menu);
        // 菜单项点击：切工具 + 刷新选中态 + 关闭菜单
        menu.querySelectorAll('.pg-gen-menu-item').forEach(item => {
            item.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const newId = item.dataset.toolId;
                const newTool = t2i.find(x => x.id === newId);
                if (!newTool) return;
                sel.value = newId;
                labelEl.textContent = fmtLabel(newTool.name);
                menu.querySelectorAll('.pg-gen-menu-item').forEach(m => {
                    m.classList.remove('selected');
                    const ck = m.querySelector('.pg-gen-check');
                    if (ck) ck.style.visibility = 'hidden';
                });
                item.classList.add('selected');
                const ck2 = item.querySelector('.pg-gen-check');
                if (ck2) ck2.style.visibility = '';
                closeGenMenu();
                // 切工具后立即刷一次按钮 enable/title（依赖 #pgSelectT2iTool 状态）
                if (typeof syncResultActions === 'function') syncResultActions();
                // 同步「宽×高」输入框（fetch 新 tool 的 schema）
                api.tools.get(newId).then((res) => {
                    if (res && res.ok && res.tool) syncGenSizeInputs(res.tool);
                }).catch(() => {});
            });
        });
    }

    // 根据 split 的实际屏幕坐标定位菜单（fixed 坐标系）
    // 优先往下放；视口下方空间不够则往上放
    function positionGenMenu() {
        const split = document.getElementById('pgGenSplit');
        const menu = document.getElementById('pgGenMenu');
        if (!split || !menu) return;
        const r = split.getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const desiredGap = 4;
        // 先渲染测量一下尺寸（用 visibility:hidden 而不是 display:block，避免污染 display 内联样式）
        menu.style.visibility = 'hidden';
        menu.style.display = 'block';
        const mh = menu.offsetHeight;
        const mw = menu.offsetWidth;
        const spaceBelow = vh - r.bottom - desiredGap;
        const spaceAbove = r.top - desiredGap;
        // 默认往下；下方不够则往上
        let topPx;
        if (spaceBelow >= Math.min(mh, 200) || spaceBelow >= spaceAbove) {
            topPx = r.bottom + desiredGap;
        } else {
            topPx = r.top - desiredGap - mh;
            if (topPx < 0) topPx = 0;
        }
        // 右对齐 split 的右边缘；同时保证不超出左边界
        let leftPx = r.right - mw;
        if (leftPx < 4) leftPx = 4;
        menu.style.top = `${topPx}px`;
        menu.style.left = `${leftPx}px`;
        menu.style.right = 'auto';
        menu.style.visibility = '';
    }

    function toggleGenMenu() {
        const arrowBtn = document.getElementById('pgBtnGenArrow');
        const menu = document.getElementById('pgGenMenu');
        if (!arrowBtn || !menu) return;
        // 用 inline style._genMenuOpen 作 single source of truth（避免 .open class 在某些场景未同步）
        const isOpen = menu._genMenuOpen === true;
        if (isOpen) closeGenMenu();
        else {
            positionGenMenu();
            menu._genMenuOpen = true;
            menu.classList.add('open');
            arrowBtn.classList.add('active');
        }
    }
    function closeGenMenu() {
        const arrowBtn = document.getElementById('pgBtnGenArrow');
        const menu = document.getElementById('pgGenMenu');
        if (menu) {
            menu._genMenuOpen = false;
            menu.classList.remove('open');
            // 清掉 positionGenMenu 设置的 inline display:block / visibility，否则 CSS .pg-gen-menu{display:none} 被 inline 覆盖，菜单关不掉
            menu.style.removeProperty('display');
            menu.style.removeProperty('visibility');
        }
        if (arrowBtn) arrowBtn.classList.remove('active');
    }

    // 生图按钮状态切换（替代直接改 innerHTML，避免破坏 split-button 结构）
    // state: 'loading' = 转圈+禁用；'idle' = 恢复 idle（标签 = "AI 生图 · 工具名"）；'disabled' = 禁用（标签自定）
    function setGenBtnState(state, labelText) {
        const btn = document.getElementById('pgBtnGenImage');
        const arrow = document.getElementById('pgBtnGenArrow');
        const icon = document.getElementById('pgGenIcon');
        const label = document.getElementById('pgGenLabel');
        const regen = document.getElementById('pgBtnRegen');
        const sel = document.getElementById('pgSelectT2iTool');
        if (!btn || !icon || !label) return;
        const toolName = (sel && sel.selectedIndex >= 0) ? sel.options[sel.selectedIndex].text : '';
        const hasTool = toolName && !toolName.startsWith('(');
        // FA 7.x 默认用 SVG 替换 <i class="fa-...">，SVGElement 的 className 是只读的 SVGAnimatedString
        // 用 setAttribute('class', ...) 才能在 <i> / <svg> 两种情况下都生效
        if (state === 'loading') {
            btn.disabled = true;
            if (arrow) arrow.disabled = true;
            if (regen) regen.disabled = true;
            icon.setAttribute('class', 'fa-solid fa-spinner fa-spin');
            if (labelText !== undefined) label.textContent = labelText;
        } else if (state === 'disabled') {
            btn.disabled = true;
            if (arrow) arrow.disabled = true;
            if (regen) regen.disabled = true;
            icon.setAttribute('class', 'fa-solid fa-image');
            label.textContent = labelText !== undefined ? labelText : (hasTool ? `AI 生图 · ${toolName}` : 'AI 生图');
        } else {  // 'idle'
            btn.disabled = !hasTool;
            if (arrow) arrow.disabled = !hasTool;
            if (regen) regen.disabled = !hasTool;
            icon.setAttribute('class', 'fa-solid fa-image');
            label.textContent = labelText !== undefined ? labelText : (hasTool ? `AI 生图 · ${toolName}` : 'AI 生图');
        }
    }

    // 根据当前选中工具的 schema 同步「宽×高」输入框状态：
    //   - schema 有 width/height 字段 → 启用 + placeholder 显示 default
    //   - schema 没有该字段 → 禁用 + 灰显 + placeholder "—"
    //   - 用户已手敲的值不会被覆盖（保留用户输入）
    // 通过 dataset.supportsWidth/Height 让 doGenImage 知道哪些 input 可信（即使没读 disabled 也兜底）
    function syncGenSizeInputs(tool) {
        const wEl = document.getElementById('pgGenWidth');
        const hEl = document.getElementById('pgGenHeight');
        if (!wEl || !hEl) return;
        const fields = (tool && tool.formFields) || [];
        const wField = fields.find(f => f && f.id === 'width' && f.type === 'number');
        const hField = fields.find(f => f && f.id === 'height' && f.type === 'number');
        const apply = (el, field) => {
            if (field && field.default !== undefined) {
                el.disabled = false;
                el.style.opacity = '1';
                el.style.background = '#ffffff';
                el.style.cursor = 'text';
                el.placeholder = String(field.default);
                el.dataset.supportsSize = '1';
                el.dataset.toolDefault = String(field.default);
            } else {
                el.disabled = true;
                el.style.opacity = '0.4';
                el.style.background = '#f3f4f6';
                el.style.cursor = 'not-allowed';
                el.placeholder = '—';
                el.dataset.supportsSize = '0';
                delete el.dataset.toolDefault;
            }
        };
        apply(wEl, wField);
        apply(hEl, hField);
    }

    // 把结果区文本塞进工具的 prompt 字段；其他字段取 schema default
    // sizeOverride: 可选 { width, height } —— 用户在右侧面板输入的尺寸，覆盖 schema default；
    //   仅对 formField.id === 'width' / 'height' 且 type === 'number' 的字段生效
    // 返回 { values, promptFieldId }
    function buildT2iFormValues(tool, promptText, sizeOverride) {
        const values = {};
        const fields = (tool && tool.formFields) || [];
        // 与 ai-tools.js:799 约定一致：第一个 textarea 字段是 prompt 字段；
        // text 类型字段（如 filename_prefix）走 default，不当作 prompt。
        let promptFieldId = null;
        for (const f of fields) {
            if (!f || !f.id) continue;
            if (f.type === 'textarea' && !promptFieldId) {
                promptFieldId = f.id;
                values[f.id] = promptText;
            } else if (f.type === 'number' && (f.id === 'width' || f.id === 'height') && sizeOverride) {
                // 尺寸字段：用户输入 > schema default；空值/NaN 回退到 default
                const ov = sizeOverride[f.id];
                const v = (ov !== undefined && ov !== null && !Number.isNaN(ov)) ? ov : f.default;
                if (v !== undefined) values[f.id] = v;
            } else if (f.default !== undefined) {
                values[f.id] = f.default;
            }
        }
        return { values, promptFieldId };
    }

    // ========== 数据加载 ==========
    async function loadMenuTree() {
        const r = await api.promptMenu.list();
        if (!r.ok) {
            _menuTree = []; _menuById = new Map(); _childrenMap = new Map();
            _nodeDepth = new Map(); _subtreeMaxDepth = new Map(); return;
        }
        _menuTree = r.items || [];
        // D-33: 一次性建好 byId Map，后面 _menuTree.find 改 _menuById.get（O(1)）
        _menuById = new Map(_menuTree.map(x => [x.id, x]));
        // N 级通用: 按 parent_id 桶装每个节点的直接子节点
        _childrenMap = new Map();
        for (const n of _menuTree) {
            const p = n.parent_id || 0;
            if (!_childrenMap.has(p)) _childrenMap.set(p, []);
            _childrenMap.get(p).push(n);
        }
        const sortFn = (a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
        for (const [, arr] of _childrenMap) arr.sort(sortFn);
        // DFS 一次算出 _nodeDepth + _subtreeMaxDepth（后续 selectAtDepth / 渲染时直接查）
        _nodeDepth = new Map();
        _subtreeMaxDepth = new Map();
        function dfs(id, depth) {
            _nodeDepth.set(id, depth);
            const ch = _childrenMap.get(id) || [];
            if (!ch.length) { _subtreeMaxDepth.set(id, 1); return 1; }
            let m = 0;
            for (const c of ch) m = Math.max(m, dfs(c.id, depth + 1));
            const myMax = m + 1;
            _subtreeMaxDepth.set(id, myMax);
            return myMax;
        }
        for (const root of _childrenMap.get(0) || []) dfs(root.id, 1);
    }

    async function loadLlmConfig() {
        const r = await api.llm.configGet();
        if (r.ok) _llmConfig = r.config;
        updateModeUI();
    }

    async function refreshOllamaStatus() {
        const r = await api.llm.listModels();
        const status = document.getElementById('pgOllamaStatus');
        if (r.ok) {
            _availableModels = r.models;
            status.style.color = '#7c7';
            status.textContent = `● Ollama 在线 | ${r.models.length} 个模型`;
            if (!_llmConfig.model && r.models.length > 0) {
                // 自动选第一个
                _llmConfig.model = r.models[0].name;
                await api.llm.configSet({ model: r.models[0].name });
                status.textContent += ` (已选: ${r.models[0].name})`;
            }
        } else {
            status.style.color = '#f88';
            status.textContent = `● Ollama 未连接: ${r.error}`;
        }
    }

 

    // ========== 渲染：N 级通用 ==========
    // 通用：渲染第 depth 层（depth=1 → L1 用 pgL1List；depth>=2 → 动态列 pgLevCol_{depth}）
    function renderColumn(depth) {
        let container;
        if (depth === 1) {
            container = document.getElementById('pgL1List');
        } else {
            const dynWrap = document.getElementById('pgDynamicCols');
            if (!dynWrap) return;
            let col = document.getElementById('pgLevCol_' + depth);
            if (!col) {
                col = document.createElement('div');
                col.id = 'pgLevCol_' + depth;
                // 奇偶层用不同灰底，区分层级感
                const bg = depth % 2 === 0 ? '#fafafa' : '#f5f6f8';
                col.style.cssText = 'width:180px; flex-shrink:0; border-right:1px solid #e5e7eb; overflow-y:auto; padding:10px 0; background:' + bg + ';';
                dynWrap.appendChild(col);
            }
            container = col;
        }
        if (!container) return;
        container.innerHTML = '';

        // 数据源：depth=1 用根；depth>=2 用 _selectedPath[depth-2] 的子节点
        const parentId = depth === 1 ? 0 : _selectedPath[depth - 2];
        const children = _childrenMap.get(parentId) || [];
        if (!children.length) {
            if (depth > 1) container.style.display = 'none';
            container.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:8px 10px;">（无下级）</div>';
            return;
        }
        container.style.display = 'block';

        const selId = depth <= _selectedPath.length ? _selectedPath[depth - 1] : null;
        // D-33: documentFragment 批建
        const frag = document.createDocumentFragment();
        for (const c of children) {
            const sel = c.id === selId;
            const req = c.is_required ? 1 : 0;
            const isL1 = depth === 1;
            const row = document.createElement('div');
            row.style.cssText = 'padding:' + (isL1 ? '7px' : '6px') + ' 10px;border-radius:6px;margin-bottom:2px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:6px;' + (sel ? (isL1 ? 'background:#eef2ff;color:#4338ca;font-weight:500;' : 'background:#ede9fe;color:#6d28d9;font-weight:500;') : 'color:#374151;');
            const iconClass = isL1 ? 'fa-layer-group' : ('fa-folder' + (sel ? '-open' : ''));
            const iconColor = sel ? (isL1 ? '#6366f1' : '#7c3aed') : (isL1 ? '#9ca3af' : '#f59e0b');
            row.innerHTML = '<i class="fa-solid ' + iconClass + '" style="color:' + iconColor + ';font-size:11px;"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(c.category_name) + '</span>' + (req ? '<span title="必选" style="flex-shrink:0;width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;"></span>' : '');
            row.addEventListener('click', () => selectAtDepth(c.id, depth));
            frag.appendChild(row);
        }
        container.appendChild(frag);
    }

    // 重渲所有列：先清掉 _selectedPath 长度之后多余的动态列（用户回退/换 L1 时右侧收起）
    function renderColumns() {
        const dynWrap = document.getElementById('pgDynamicCols');
        if (dynWrap) {
            const keep = _selectedPath.length; // <= keep 的列保留
            Array.from(dynWrap.children).forEach(el => {
                const d = Number(String(el.id).replace('pgLevCol_', ''));
                if (d > keep) el.remove();
            });
        }
        renderColumn(1);
        for (let d = 2; d <= _selectedPath.length; d++) renderColumn(d);
    }

    // 选中第 depth 层节点：截断路径到 length=depth，写新 id
    // —— 沿第一支子节点链下钻到"再下一级就是叶子"的那级（max depth - 1 层）
    // 这样 L1~L(n-1) 用列展示，末位(L_n-1)的子级(L_n)作为 sections 展示在中间内容区
    function selectAtDepth(id, depth) {
        // 截断到 depth（如果用户点的是上层，丢掉更深层的记录）
        if (_selectedPath.length > depth - 1) _selectedPath.length = depth - 1;
        // 正常情况下 depth == _selectedPath.length + 1；如异常（depth 远大于当前），按 depth 补
        while (_selectedPath.length < depth - 1) _selectedPath.push(0);
        _selectedPath[depth - 1] = id;
        // 沿第一支下钻到"下一级是叶子"的那级 —— 让最深一级在中间内容区展示
        while (true) {
            const ch = _childrenMap.get(_selectedPath[_selectedPath.length - 1]) || [];
            if (!ch.length) break; // 末位已是叶子
            const grandCh = _childrenMap.get(ch[0].id) || [];
            if (!grandCh.length) break; // 下一级是叶子，停在当前
            _selectedPath.push(ch[0].id);
        }
        renderColumns();
        loadAndRenderContent();
    }

    // 默认：沿第一支下钻到"再下钻一级就是叶子"的那级（max depth - 1 层）
    // —— 这样末位是父级，子级由 loadAndRenderContent 作为 sections 展示在中间
    function navigateToDeepestFirstBranch() {
        const roots = _childrenMap.get(0) || [];
        if (!roots.length) return;
        const path = [roots[0].id];
        while (true) {
            const ch = _childrenMap.get(path[path.length - 1]) || [];
            if (!ch.length) break; // 末位已是叶子
            const grandCh = _childrenMap.get(ch[0].id) || [];
            if (!grandCh.length) break; // 下一级是叶子，停在当前
            path.push(ch[0].id);
        }
        _selectedPath = path;
        renderColumns();
        loadAndRenderContent();
    }

    async function loadAndRenderContent() {
        // 面包屑：_selectedPath 全链（任意深度）
        const breadcrumb = _selectedPath.map(id => ((_menuById.get(id) || {}).category_name || '')).filter(Boolean).join(' > ');
        document.getElementById('pgContentBreadcrumb').textContent = breadcrumb || '请选择左侧分类';

        // N 级通用：当前节点 = _selectedPath 末位
        const currentNodeId = _selectedPath.length ? _selectedPath[_selectedPath.length - 1] : null;
        if (!currentNodeId) {
            document.getElementById('pgContent').innerHTML = '<div style=”color:#9ca3af;text-align:center;padding:80px 0;font-size:13px;”>请选择左侧分类</div>';
            return;
        }

        // 拉当前节点 + 它下一级的所有子节点 items（任意层通用，_childrenMap.get(currentNodeId) 即它的直接子）
        const childList = _childrenMap.get(currentNodeId) || [];
        const childIds = childList.map(x => x.id);
        const r = await api.promptItems.listByCategories([currentNodeId, ...childIds]);
        const itemMap = r.ok ? r.map : {};

        // D-40: 把分类级约束（tag_required / tag_exclusive_group）灌入客户端 cache
        // 后端 item 查询已 LEFT JOIN prompt_menu 带回这些字段
        // D-41: 传 _menuById 让 absorbItemMeta 走祖先链继承分组
        const allItems = Object.values(itemMap).flat();
        absorbItemMeta(allItems, _menuById);

        const content = document.getElementById('pgContent');
        content.innerHTML = '';

        // 中间内容区 = 末位节点(_selectedPath[-1])的子节点 sections
        //   有子级 → 子级作为 sections 竖向展示（每个子一个 section，含该子的 prompts）
        //   末位是叶子 → 把末位自己作为 section 展示（section 标题就是末位分类名）
        if (childList.length) {
            for (const c of childList) {
                const items = itemMap[c.id] || [];
                renderItemSection(content, c.category_name, items);
            }
        } else {
            const node = _menuById.get(currentNodeId);
            if (node) {
                const items = itemMap[currentNodeId] || [];
                renderItemSection(content, node.category_name, items);
            } else {
                content.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:50px 0;font-size:13px;"><i class="fa-solid fa-inbox" style="font-size:28px;display:block;margin-bottom:8px;color:#e5e7eb;"></i>此分类下暂无数据</div>';
                return;
            }
        }
        updateSelectedCount();
    }

    // ========== 提示词预览图 hover 浮层（singleton）==========
    let _pvTipEl = null;
    let _chipItemCache = new Map();  // id → item（事件委托用：chip 重建后仍能找到对应 item）
    function _ensurePvTip() {
        if (_pvTipEl) return _pvTipEl;
        _pvTipEl = document.createElement('div');
        _pvTipEl.className = 'pg-item-preview-tip';
        _pvTipEl.style.display = 'none';
        document.body.appendChild(_pvTipEl);
        return _pvTipEl;
    }
    async function _showPvTip(item, anchorEl) {
        const tip = _ensurePvTip();
        const hasPreview = !!item.preview_image;
        if (hasPreview) {
            tip.innerHTML = '<div class="pg-item-preview-tip-img" data-empty="1"></div>'
                + '<div class="pg-item-preview-tip-text"></div>';
        } else {
            tip.innerHTML = '<div class="pg-item-preview-tip-text"></div>';
        }
        const imgEl = tip.querySelector('.pg-item-preview-tip-img');
        const txtEl = tip.querySelector('.pg-item-preview-tip-text');
        txtEl.textContent = item.content || '(无内容)';
        // 先定位并显示，再异步加载图（避免 IPC 失败时整个 tooltip 不出现）
        const rect = anchorEl.getBoundingClientRect();
        const TIP_W = 340, TIP_H = hasPreview ? 230 : 70;
        let left = rect.right + 10;
        let top = rect.top;
        if (left + TIP_W > window.innerWidth) {
            left = rect.left - TIP_W - 10;
        }
        if (left < 8) left = 8;
        if (top + TIP_H > window.innerHeight) {
            top = window.innerHeight - TIP_H - 8;
        }
        if (top < 8) top = 8;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
        tip.style.display = 'block';
        if (item.preview_image) {
            try {
                const r = await window.api.promptPreview.read({ fileName: item.preview_image });
                if (r && r.ok) {
                    imgEl.style.backgroundImage = 'url(' + r.dataUrl + ')';
                    imgEl.removeAttribute('data-empty');
                    imgEl.textContent = '';
                } else if (r && r.error) {
                    imgEl.textContent = '加载失败: ' + r.error;
                }
            } catch (e) {
                imgEl.textContent = '加载异常: ' + (e && e.message || e);
            }
        }
    }
    function _hidePvTip() { if (_pvTipEl) _pvTipEl.style.display = 'none'; }
    // 延迟隐藏（IPC 异步加载期间，鼠标快速移动会被误关）
    let _hideTimer = null;
    function _hidePvTipDelayed() {
        if (_hideTimer) clearTimeout(_hideTimer);
        _hideTimer = setTimeout(() => { _hidePvTip(); _hideTimer = null; }, 300);
    }
    function _cancelHidePvTip() {
        if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    }

    function renderItemSection(container, title, items) {
        // D-31: 按当前模式（SFW/NSFW）过滤 sensitivity
        const mode = (_llmConfig && _llmConfig.mode) || 'sfw';
        items = items.filter(it => (it.sensitivity || 'nsfw') === mode);
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:20px;';
        // D-40 + D-42: 从 items 推导分类级 tag_required / exclusive_with 徽标
        // 同一 section 的所有 items 共享 category_id → 取首个非空即可
        // 后端 JOIN 已把这两个字段直接挂在 item 上
        const firstIt = items[0] || {};
        const tagRequired = firstIt.tag_required || '';
        const exclWithIds = parseExclusiveWith(firstIt.exclusive_with);
        let badges = '';
        if (tagRequired) {
            badges += '<span title="分类级数量规则" style="font-size:10px;color:#92400e;background:#fef3c7;padding:2px 6px;border-radius:3px;margin-left:4px;border:1px solid #fde68a;">' + escHtml(tagRequired) + '</span>';
        }
        if (exclWithIds.length > 0) {
            // 展示「与 N 个分类互斥」+ 鼠标悬浮时显示具体路径列表
            const pathList = exclWithIds.map(eid => pathOfMenu(eid, _menuById)).filter(Boolean).join('\n');
            const titleText = pathList
                ? '与以下分类互斥（不可同时选）：\n' + pathList
                : '与 ' + exclWithIds.length + ' 个分类互斥';
            badges += '<span title="' + escHtml(titleText) + '" style="font-size:10px;color:#7c2d12;background:#fed7aa;padding:2px 6px;border-radius:3px;margin-left:4px;border:1px solid #fdba74;">互斥: ' + exclWithIds.length + ' 个分类</span>';
        }
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0 8px;border-bottom:1px solid #e5e7eb;margin-bottom:8px;';
        header.innerHTML = '<i class="fa-solid fa-tag" style="color:#6366f1;font-size:11px;"></i><span style="font-size:13px;font-weight:600;color:#374151;">' + escHtml(title) + '</span>' + badges + '<span style="font-size:11px;color:#9ca3af;margin-left:4px;">(' + items.length + '项)</span>';
        section.appendChild(header);
        const chips = document.createElement('div');
        chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
        if (!items.length) {
            chips.innerHTML = '<span style="font-size:12px;color:#d1d5db;">（暂无数据）</span>';
        }
        for (const it of items) {
            const sel = _selectedItems.has(it.id);
            const chip = document.createElement('div');
            chip.dataset.itemId = String(it.id);  // D-33: 让 toggleItem 能定位这个 chip 改样式
            _chipItemCache.set(it.id, it);  // 事件委托用
            chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 12px 6px 13px;border-radius:5px;cursor:pointer;user-select:none;font-size:12px;border:1px solid ' + (sel ? '#6366f1' : '#d1d5db') + ';background:' + (sel ? '#6366f1' : '#fff') + ';color:' + (sel ? '#ffffff' : '#374151') + ';box-shadow:' + (sel ? '0 2px 4px rgba(99,102,241,0.3)' : '0 1px 1px rgba(0,0,0,0.04)') + ';transition:all 0.1s;';
            // hover 样式：未选中 → 浅灰底；已选中 → 不变（保留紫底）
            // 修复：原代码选中的 chip mouseenter 也会被覆盖成浅灰 → 白底白字
            chip.addEventListener('mouseenter', () => {
                if (!_selectedItems.has(it.id)) {
                    chip.style.background = '#f3f4f6';
                    chip.style.borderColor = '#9ca3af';
                }
            });
            chip.addEventListener('mouseleave', () => {
                if (!_selectedItems.has(it.id)) {
                    chip.style.background = '#fff';
                    chip.style.borderColor = '#d1d5db';
                }
            });
            chip.innerHTML = '<span style="font-weight:500;">' + escHtml(it.name) + '</span>';
            chip.addEventListener('mouseenter', () => { _cancelHidePvTip(); _showPvTip(it, chip); });
            chip.addEventListener('mouseleave', _hidePvTipDelayed);
            chip.addEventListener('click', () => toggleItem(it));
            chips.appendChild(chip);
        }
        section.appendChild(chips);
        container.appendChild(section);
    }

    function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function toggleItem(it) {
        const wasSel = _selectedItems.has(it.id);
        if (wasSel) _selectedItems.delete(it.id);
        else _selectedItems.set(it.id, it);
        // D-33: 增量更新 — 只改 1 个 chip 样式 + 计数，不重建 content、也不调 IPC
        // 原实现：loadAndRenderContent() — 会重建所有 chip、重绑事件、多一次 IPC
        //       70+ 项的分类页里点一下能看到 50-100ms 卡顿
        const chip = document.querySelector(`#pgContent [data-item-id="${it.id}"]`);
        if (chip) applyChipSelectedStyle(chip, !wasSel);
        updateSelectedCount();
        // D-35: 实时拼装到右侧生成结果
        liveAssembleAndUpdate();
        // D-39: 实时冲突校验 + 强联动推荐
        triggerNsfwValidate();
    }

    // ========== D-39: 实时冲突校验 + 推荐（本地 Map 查表，< 1ms）==========
    // 之前走 IPC（5-20ms/次），现在靠顶层 _assocState 客户端缓存
    // 选 1 个时也要查推荐（n=1 时冲突循环空跑、推荐循环正常）
    // dismissed 状态：用户点 × 后，本次选择内不再显示；选择集变化时重置
    let _dismissedConflict = false;
    let _dismissedRec = false;
    let _lastSelectionKey = '';

    function getSelectionKey() {
        return Array.from(_selectedItems.keys()).sort((a, b) => a - b).join(',');
    }

    async function triggerNsfwValidate() {
        if (_selectedItems.size === 0) {
            clearConflictBanner();
            clearRecommendationPanel();
            _dismissedConflict = false;
            _dismissedRec = false;
            _lastSelectionKey = '';
            return;
        }
        // 选择集变化 → 重置 dismissed 状态（新选择可能有新冲突/新推荐）
        const curKey = getSelectionKey();
        if (curKey !== _lastSelectionKey) {
            _dismissedConflict = false;
            _dismissedRec = false;
            _lastSelectionKey = curKey;
        }
        // 确保缓存已加载（首次需要 IPC；之后命中缓存直接返回）
        await ensureAssocCache();
        const ids = Array.from(_selectedItems.keys());
        const t0 = performance.now();
        // 来源 1：item-pair 互斥（来自 prompt_associations 表）
        const { conflicts: pairConflicts, recommendations } = nsfwValidateLocal(ids);
        // 来源 2：互斥分类冲突（D-42 直接配对，来自 prompt_menu.exclusive_with）
        const exclConflicts = nsfwValidateExclusive(ids);
        // 来源 3：数量规则警告（来自分类的 tag_required）
        const quantityWarnings = nsfwValidateQuantity(ids);
        const conflicts = pairConflicts.concat(exclConflicts, quantityWarnings);
        const ms = performance.now() - t0;
        if (window.__assocPerfLog) console.log(`[nsfwValidate] ${ms.toFixed(2)}ms, ${ids.length} items, ${conflicts.length} conflicts(${pairConflicts.length} pair + ${exclConflicts.length} excl + ${quantityWarnings.length} qty), ${recommendations.length} recs`);
        // dismissed 或 数据为空 → 不显示
        if (_dismissedConflict || conflicts.length === 0) clearConflictBanner();
        else renderConflictBanner(conflicts);
        if (_dismissedRec || recommendations.length === 0) clearRecommendationPanel();
        else renderRecommendationPanel(recommendations);
    }

    function renderConflictBanner(conflicts) {
        const banner = document.getElementById('pgConflictBanner');
        if (!banner) return;
        if (!conflicts || conflicts.length === 0) {
            banner.style.display = 'none';
            return;
        }
        banner.style.display = 'flex';
        banner.style.alignItems = 'flex-start';
        banner.style.justifyContent = 'space-between';
        banner.style.gap = '12px';
        banner.style.padding = '10px 18px';
        banner.style.fontSize = '12px';
        banner.style.color = '#92400e';
        banner.style.background = '#fef3c7';
        banner.style.borderTop = '1px solid #fde68a';
        banner.style.lineHeight = '1.6';
        // D-40 + D-42: 3 种冲突来源不同渲染格式
        //   - pair:     {a_name, b_name, reason}    → "【A】+【B】(reason)"
        //   - excl:     {items:[{id,name}], reason} → "[互斥分类]【A】【B】(reason)"
        //   - quantity: {items:[{id,name}], reason} → "[数量]【A】【B】(reason)"
        const items = conflicts.map(c => {
            if (c.source === 'pair') {
                return `【${c.a_name}】+【${c.b_name}】${c.reason ? '(' + c.reason + ')' : ''}`;
            }
            const names = (c.items || []).map(x => `【${x.name}】`).join('、');
            const tag = c.source === 'excl' ? '[互斥分类]' : (c.source === 'group' ? '[互斥组]' : '[数量]');
            return `${tag}${names}${c.reason ? '(' + c.reason + ')' : ''}`;
        }).join('；');
        banner.innerHTML = `
            <div style="flex:1;">⚠️ 检测到 ${conflicts.length} 个潜在冲突（提示模式，不阻止保存）：<br>${items}</div>
            <button class="pgConflictClose" title="关闭（本次选择内不再显示）" style="background:transparent; border:none; color:#92400e; cursor:pointer; padding:0 4px; font-size:14px; line-height:1; flex-shrink:0; margin-top:2px; border-radius:4px; width:22px; height:22px; display:flex; align-items:center; justify-content:center;">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;
        const closeBtn = banner.querySelector('.pgConflictClose');
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#fde68a'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'transparent'; });
        closeBtn.addEventListener('click', () => {
            _dismissedConflict = true;
            clearConflictBanner();
        });
    }

    function clearConflictBanner() {
        const banner = document.getElementById('pgConflictBanner');
        if (banner) {
            banner.style.display = 'none';
            banner.innerHTML = '';
        }
    }

    function renderRecommendationPanel(recs) {
        const panel = document.getElementById('pgRecPanel');
        if (!panel) return;
        if (!recs || recs.length === 0) {
            panel.style.display = 'none';
            return;
        }
        panel.style.display = 'flex';
        panel.style.alignItems = 'flex-start';
        panel.style.justifyContent = 'space-between';
        panel.style.gap = '12px';
        panel.style.padding = '8px 18px';
        panel.style.fontSize = '11px';
        panel.style.color = '#065f46';
        panel.style.background = '#ecfdf5';
        panel.style.borderTop = '1px solid #a7f3d0';
        const top5 = recs.slice(0, 5);
        const chipsHtml = top5.map(r => {
            const alreadySel = _selectedItems.has(r.id);
            const nameAttr = escHtml(r.name);
            if (alreadySel) {
                return `<span class="pg-chip pg-rec-chip pg-rec-chip--sel" data-id="${r.id}" data-name="${nameAttr}" title="已添加，点击可移除" style="margin:3px; padding:3px 10px; background:#d1fae5; border:1px solid #10b981; border-radius:12px; cursor:pointer; display:inline-flex; align-items:center; font-size:11px; color:#065f46;"><i class="fa-solid fa-check" style="margin-right:4px; font-size:10px;"></i>${nameAttr}</span>`;
            }
            return `<span class="pg-chip pg-rec-chip" data-id="${r.id}" data-name="${nameAttr}" title="点击添加" style="margin:3px; padding:3px 10px; background:#ffffff; border:1px solid #6ee7b7; border-radius:12px; cursor:pointer; display:inline-block; font-size:11px; color:#065f46;">+ ${nameAttr}</span>`;
        }).join('');
        panel.innerHTML = `
            <div style="flex:1;">💡 推荐补充（基于已选项的强联动，点击切换选中）：<br>${chipsHtml}</div>
            <button class="pgRecClose" title="关闭（本次选择内不再显示）" style="background:transparent; border:none; color:#065f46; cursor:pointer; padding:0 4px; font-size:14px; line-height:1; flex-shrink:0; margin-top:2px; border-radius:4px; width:22px; height:22px; display:flex; align-items:center; justify-content:center;">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;
        // 绑定推荐 chip 点击 → toggle 选中/取消（同步两侧视觉）
        panel.querySelectorAll('.pg-rec-chip').forEach(el => {
            // hover 效果
            el.addEventListener('mouseenter', () => {
                if (el.classList.contains('pg-rec-chip--sel')) {
                    el.style.background = '#a7f3d0';
                } else {
                    el.style.background = '#f0fdf4';
                    el.style.borderColor = '#34d399';
                }
            });
            el.addEventListener('mouseleave', () => {
                if (el.classList.contains('pg-rec-chip--sel')) {
                    el.style.background = '#d1fae5';
                } else {
                    el.style.background = '#ffffff';
                    el.style.borderColor = '#6ee7b7';
                }
            });
            el.addEventListener('click', async () => {
                const id = parseInt(el.dataset.id);
                const name = el.dataset.name || '';
                const r = await api.promptItems.get(id);
                if (!r || !r.ok || !r.item) {
                    showToast('获取提示词详情失败', 'error');
                    return;
                }
                const wasSel = _selectedItems.has(id);
                if (wasSel) {
                    _selectedItems.delete(id);
                    showToast(`已移除：${name}`);
                } else {
                    _selectedItems.set(id, r.item);
                    showToast(`已添加：${name}`, 'success');
                }
                // 同步左侧分类 chip 视觉（紫色选中态）
                const catChip = document.querySelector(`#pgContent [data-item-id="${id}"]`);
                if (catChip) applyChipSelectedStyle(catChip, !wasSel);
                // 同步推荐 chip 自身视觉
                applyRecChipStyle(el, !wasSel);
                updateSelectedCount();
                liveAssembleAndUpdate();
                triggerNsfwValidate();
            });
        });
        // × 关闭按钮
        const closeBtn = panel.querySelector('.pgRecClose');
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#a7f3d0'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'transparent'; });
        closeBtn.addEventListener('click', () => {
            _dismissedRec = true;
            clearRecommendationPanel();
        });
    }

    function clearRecommendationPanel() {
        const panel = document.getElementById('pgRecPanel');
        if (panel) {
            panel.style.display = 'none';
            panel.innerHTML = '';
        }
    }

    function applyChipSelectedStyle(chip, sel) {
        // 与 renderItemSection 里 chip.style.cssText 的初始样式保持同步
        if (sel) {
            chip.style.borderColor = '#6366f1';
            chip.style.background = '#6366f1';
            chip.style.color = '#ffffff';
            chip.style.boxShadow = '0 2px 4px rgba(99,102,241,0.3)';
        } else {
            chip.style.borderColor = '#d1d5db';
            chip.style.background = '#fff';
            chip.style.color = '#374151';
            chip.style.boxShadow = '0 1px 1px rgba(0,0,0,0.04)';
        }
    }

    function applyRecChipStyle(chip, sel) {
        // 推荐 chip 自身视觉切换（绿色主题，与面板配色一致）
        if (sel) {
            chip.classList.add('pg-rec-chip--sel');
            chip.style.background = '#d1fae5';
            chip.style.borderColor = '#10b981';
            chip.style.color = '#065f46';
            chip.title = '已添加，点击可移除';
            const name = chip.dataset.name || chip.textContent.replace(/^[\s+]+/, '');
            chip.innerHTML = '<i class="fa-solid fa-check" style="margin-right:4px; font-size:10px;"></i>' + name;
        } else {
            chip.classList.remove('pg-rec-chip--sel');
            chip.style.background = '#ffffff';
            chip.style.borderColor = '#6ee7b7';
            chip.style.color = '#065f46';
            chip.title = '点击添加';
            const name = chip.dataset.name || '';
            chip.innerHTML = '+ ' + name;
        }
    }

    function updateSelectedCount() {
        const c = document.getElementById('pgSelectedCount');
        if (c) c.textContent = '已选 ' + _selectedItems.size + ' 个项';
    }

    // ========== D-35: 实时拼装 ==========
    // 纯函数：给定 selectedItems + menuById + rule，返回拼接后的字符串
    // - selectedItems: Map<itemId, item>，插入顺序 = 点击顺序
    // - menuById:      Map<menuId, {id, parent_id, ...}>
    // - rule:          [{menuId, sortOrder}]，数组顺序 = 拼装顺序；null/[] = 无规则
    // 规则：
    //   1. 无规则 → 按 selectedItems 插入顺序
    //   2. 有规则 → 规则内 L1 按 rule 顺序，同 L1 内按点击顺序
    //   3. 规则外 item 追加在最后，按点击顺序
    //   4. 规则内某 L1 没选 → 跳过
    //   5. item.content 为空 → 回退到 name；都没 → 跳过该位
    function liveAssemble(selectedItems, menuById, rule) {
        const items = Array.from(selectedItems.values());
        if (items.length === 0) return '';
        // D-40: 改用祖先链匹配 — item.category_id 或其任一祖先 == rule.menuId 即归该组
        // 这样 9 个 L2 章节可独立排序；同时仍支持 L1 根的"通配"语义
        function findRuleMatch(item, ruleSet, menuById) {
            let cur = menuById.get(item.category_id);
            if (!cur) return null;
            while (cur) {
                if (ruleSet.has(cur.id)) return cur.id;
                if (!cur.parent_id || cur.parent_id === 0) break;
                cur = menuById.get(cur.parent_id);
            }
            return null;
        }
        const hasRule = Array.isArray(rule) && rule.length > 0;
        if (!hasRule) {
            return items.map(it => it.content || it.name || '').filter(Boolean).join(', ');
        }
        const ruleOrder = rule.map(r => r.menuId);
        const ruleSet = new Set(ruleOrder);
        const groups = new Map();
        const leftovers = [];
        for (const it of items) {
            const matched = findRuleMatch(it, ruleSet, menuById);
            if (matched != null) {
                if (!groups.has(matched)) groups.set(matched, []);
                groups.get(matched).push(it);
            } else {
                leftovers.push(it);
            }
        }
        const parts = [];
        for (const menuId of ruleOrder) {
            const g = groups.get(menuId);
            if (!g || g.length === 0) continue;
            for (const it of g) {
                const txt = it.content || it.name || '';
                if (txt) parts.push(txt);
            }
        }
        for (const it of leftovers) {
            const txt = it.content || it.name || '';
            if (txt) parts.push(txt);
        }
        return parts.join(', ');
    }

    // 从主进程拉拼装规则（带 module 级缓存，避免重复 IPC）
    async function loadAssembleRule(force = false) {
        if (_assembleRuleLoaded && !force) return _assembleRule || [];
        const r = await api.assembleRule.get();
        _assembleRuleLoaded = true;
        _assembleRule = (r && r.ok && Array.isArray(r.rule)) ? r.rule : [];
        return _assembleRule;
    }

    // 实时拼装并写 pgResult.value。selectedItems 变 → 调一下
    function liveAssembleAndUpdate() {
        const text = liveAssemble(_selectedItems, _menuById, _assembleRule);
        const result = document.getElementById('pgResult');
        if (result) result.value = text;
        // 同步 tags：当前选中的 items 就是「保存到库」时的标签
        _lastGeneratedTags = Array.from(_selectedItems.values());
        _resultText = text;
        updateSaveButtonState();
    }

    // 「保存提示词」按钮根据 textarea 内容动态启停
    function updateSaveButtonState() {
        const btn = document.getElementById('pgBtnSave');
        if (!btn) return;
        const result = document.getElementById('pgResult');
        const text = (result && result.value) || '';
        const hasContent = !!text.trim() && !text.trim().startsWith('正在生成');
        btn.disabled = !hasContent;
    }

    function doClear() {
        _selectedItems.clear();
        loadAndRenderContent();
        updateSelectedCount();
        liveAssembleAndUpdate();  // D-35: 清空后实时清右侧
        clearConflictBanner();  // D-39: 清空时清掉冲突提示
        clearRecommendationPanel();  // D-39: 清空时清掉推荐
    }

    // ========== 生成 ==========
    async function doGenerate() {
        if (_selectedItems.size === 0) {
            showToast('请至少选 1 个项', 'error');
            return;
        }
        if (!_llmConfig || !_llmConfig.model) {
            showToast('请先在「模型」里选一个 Ollama 模型', 'error');
            return;
        }
        _activeJobId = 'gen-' + Date.now();
        setGeneratingUI(true);
        const result = document.getElementById('pgResult');
        result.value = '正在生成...';
        const meta = document.getElementById('pgResultMeta');
        meta.textContent = '模型: ' + _llmConfig.model + ' | 项: ' + _selectedItems.size + ' 个';

        const items = Array.from(_selectedItems.values());
        const r = await api.llm.generate({
            tags: items,
            modules: _modules,
            jobId: _activeJobId,
        });

        setGeneratingUI(false);
        if (r.ok) {
            result.value = r.text;
            _resultText = r.text;
            _lastGeneratedItems = items;
            _lastGeneratedTags = items;
            updateSaveButtonState();
            syncResultActions();
            showToast('生成完成（已自动保存到历史）', 'success');
        } else if (r.cancelled) {
            result.value = '（已取消）';
            showToast('已取消', 'error');
        } else {
            result.value = '生成失败: ' + r.error;
            showToast('生成失败：' + r.error, 'error');
        }
    }

    async function doCancel() {
        if (!_activeJobId) return;
        await api.llm.cancel(_activeJobId);
        _activeJobId = null;
    }

    // ========== D-30: 本地拼装 / 拼装后 LLM 优化 ==========
    // D-30: 本地拼装 / 拼装后 LLM 优化
    //   - 拼装结果是按拼装规则 + 点击顺序拼接的 content 拼接串
    //   - 同步刷新结果区 + meta + history 准备
    async function doRefine() {
        const result = document.getElementById('pgResult');
        const meta = document.getElementById('pgResultMeta');
        const tagIds = Array.from(_selectedTags.keys());
        const btnRefine = document.getElementById('pgBtnRefine');
        if (!_llmConfig || !_llmConfig.model) {
            showToast('请先在「模型」里选一个 Ollama 模型', 'error');
            return;
        }
        if (btnRefine) btnRefine.disabled = true;
        setGeneratingUI(true);
        result.value = '正在拼装 + LLM 优化...';
        const r = await api.nsfw.assembleAndRefine({
            tagIds,
            mode: _mode || 'sfw',
        });
        setGeneratingUI(false);
        if (btnRefine) btnRefine.disabled = false;
        if (!r.ok) {
            const partialInfo = r.assembled ? `\n\n[拼装结果 ${r.assembled.wordCount} 词]\n${r.assembled.text}` : '';
            result.value = `拼装+优化失败: ${r.error}${partialInfo}`;
            showToast('优化失败：' + r.error, 'error');
            return;
        }
        result.value = r.refined.text;
        _resultText = r.refined.text;
        _lastGeneratedTags = Array.from(_selectedTags.values());
        updateSaveButtonState();
        syncResultActions();
        const a = r.assembled;
        meta.textContent = `拼装 ${a.wordCount} 词 + LLM(${r.refined.model})优化 | 原 ${r.refined.text.split(/\s+/).filter(Boolean).length} 词`;
        showToast('拼装+优化完成', 'success');
    }

    async function doImportTemplates(btn) {
        if (!btn) return;
        const oldHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 导入中...';
        try {
            const r = await api.nsfw.importTemplates('D:\\nsfw-prompt-templates-asian-main');
            if (!r.ok) {
                showToast('导入失败：' + r.error, 'error');
                btn.innerHTML = oldHtml;
                btn.disabled = false;
                return;
            }
            const summary = Object.entries(r.byModule)
                .map(([k, v]) => `${k}:${v}`).join(' / ');
            showToast(`已导入 ${r.count} 词条（${r.moduleCount} 模块）`, 'success');
            btn.innerHTML = `<i class="fa-solid fa-check"></i> 已导入 ${r.count}`;
        } catch (e) {
            showToast('导入异常：' + e.message, 'error');
            btn.innerHTML = oldHtml;
            btn.disabled = false;
        }
    }

    function setGeneratingUI(isGen) {
        const btnGen = document.getElementById('pgBtnGenerate');
        const btnCancel = document.getElementById('pgBtnCancel');
        if (isGen) {
            btnGen.disabled = true;
            btnCancel.style.display = '';
        } else {
            btnGen.disabled = false;
            btnCancel.style.display = 'none';
        }
    }

    // ========== 复制 / 保存 / 重生成 ==========
    async function doCopy() {
        const result = document.getElementById('pgResult');
        if (!result.value) {
            showToast('没有可复制的内容', 'error');
            return;
        }
        try {
            await navigator.clipboard.writeText(result.value);
            showToast('已复制到剪贴板', 'success');
        } catch {
            result.select();
            document.execCommand('copy');
            showToast('已复制（兼容模式）', 'success');
        }
    }

    async function doSave() {
        console.log('[doSave] click, _lastGeneratedTags:', _lastGeneratedTags);
        try {
            const result = document.getElementById('pgResult');
            const text = (result && result.value) || '';
            if (!text || text.startsWith('正在生成')) {
                showToast('没有可保存的内容', 'error');
                return;
            }
            const id = 'gen-' + Date.now().toString(36);
            const tags = (Array.isArray(_lastGeneratedTags) ? _lastGeneratedTags : []).map(t => (t && t.name) || '').filter(Boolean);
            console.log('[doSave] writing:', { id, len: text.length, tags });
            const r = await api.prompts.writeOne(id, text, tags);
            console.log('[doSave] result:', r);
            if (r && r.ok) {
                showToast('已保存到提示词库（id: ' + id + '）', 'success');
            } else {
                showToast('保存失败：' + ((r && r.error) || '返回为空'), 'error');
            }
        } catch (err) {
            console.error('[doSave] exception:', err);
            showToast('保存异常：' + (err && err.message ? err.message : err), 'error');
        }
    }

    // ========== 设置模态（模型选择） ==========
    function openSettingsModal() {
        let modal = document.getElementById('pgSettingsModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'pgSettingsModal';
            modal.className = 'modal-overlay';
            modal.style.cssText = 'background:rgba(15,23,42,0.4); backdrop-filter:blur(2px);';
            modal.innerHTML = `
                <div class="modal" style="max-width:520px; width:90%; background:#ffffff; color:#1f2937; border-radius:12px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);">
                    <div class="modal-header" style="background:#ffffff; color:#1f2937; border-bottom:1px solid #e5e7eb; font-weight:600;"><i class="fa-solid fa-gear" style="color:#6366f1;"></i> LLM 配置（Ollama 本地）</div>
                    <div class="modal-body" id="pgSettingsBody" style="padding:18px; background:#ffffff;"></div>
                    <div class="modal-footer" style="background:#f9fafb; border-top:1px solid #e5e7eb;">
                        <button id="pgBtnSettingsClose" class="btn">关闭</button>
                        <button id="pgBtnSettingsSave" class="btn btn-primary"><i class="fa-solid fa-check"></i> 保存</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            modal.querySelector('#pgBtnSettingsClose').addEventListener('click', () => modal.classList.remove('active'));
            modal.querySelector('#pgBtnSettingsSave').addEventListener('click', async () => {
                const baseUrl = modal.querySelector('#pgCfgBaseUrl').value.trim();
                const model = modal.querySelector('#pgCfgModel').value;
                const temperature = Number(modal.querySelector('#pgCfgTemp').value) || 0.7;
                await api.llm.configSet({ baseUrl, model, temperature });
                _llmConfig = { ..._llmConfig, baseUrl, model, temperature };
                showToast('已保存', 'success');
                modal.classList.remove('active');
                await refreshOllamaStatus();
            });
        }
        // 渲染
        const body = modal.querySelector('#pgSettingsBody');
        const models = _availableModels;
        body.innerHTML = `
            <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:14px; font-size:13px; color:#374151;">
                Ollama 地址
                <input id="pgCfgBaseUrl" type="text" value="${_llmConfig?.baseUrl || 'http://localhost:11434'}" style="padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:14px;">
            </label>
            <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:14px; font-size:13px; color:#374151;">
                模型（从 ${models.length} 个已下载模型中选）
                <select id="pgCfgModel" style="padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:14px;">
                    ${models.length === 0 ? '<option value="">(Ollama 未连接，请先启动 ollama serve)</option>' :
                        models.map(m => `<option value="${m.name}" ${_llmConfig?.model === m.name ? 'selected' : ''}>${m.name} (${(m.size/1e9).toFixed(1)}GB)</option>`).join('')
                    }
                </select>
            </label>
            <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:14px; font-size:13px; color:#aaa;">
                Temperature（0-1）
                <input id="pgCfgTemp" type="number" step="0.1" min="0" max="1" value="${_llmConfig?.temperature ?? 0.7}" style="padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:14px;">
            </label>
            <div style="font-size:11px; color:#6b7280; padding:8px 0; border-top:1px solid #e5e7eb; background:#f9fafb; margin:0 -18px -18px -18px; padding:12px 18px; border-radius:0 0 12px 12px;">
                <i class="fa-solid fa-circle-info"></i> 系统提示词已内置，模型未显示？检查 <code>ollama serve</code> 是否在跑。
                <div style="margin-top:8px; display:flex; gap:6px; align-items:center;">
                    <button id="pgBtnFetchReadme" class="btn btn-sm" type="button"><i class="fa-solid fa-cloud-arrow-down"></i> 同步 NSFW 仓库 README</button>
                    <button id="pgBtnImportTemplates" class="btn btn-sm" type="button" style="margin-left:6px;" title="从本地 D:\\nsfw-prompt-templates-asian-main 导入 NSFW 模板到数据库"><i class="fa-solid fa-database"></i> 导入本地 NSFW 模板</button>
                    <span id="pgReadmeStatus" style="font-size:11px; color:#9ca3af;"></span>
                </div>
            </div>
        `;
        modal.classList.add('active');
        // 刷新 README 状态
        api.nsfw.getSource().then((r) => {
            const status = modal.querySelector('#pgReadmeStatus');
            if (!status) return;
            if (r.ok && r.meta && r.meta.readmeCachedAt) {
                const t = new Date(r.meta.readmeCachedAt).toLocaleString('zh-CN');
                status.textContent = `上次同步: ${t} (${(r.meta.readmeCachedSize/1024).toFixed(1)}KB)`;
            } else {
                status.textContent = '未同步';
            }
        });
        // 绑定同步按钮
        const fetchBtn = modal.querySelector('#pgBtnFetchReadme');
        // 绑定导入本地模板按钮
        const importBtn = modal.querySelector('#pgBtnImportTemplates');
        if (importBtn) {
            importBtn.addEventListener('click', async () => {
                await doImportTemplates(importBtn);
            });
        }
        if (fetchBtn) {
            fetchBtn.addEventListener('click', async () => {
                fetchBtn.disabled = true;
                fetchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 同步中...';
                const fr = await api.nsfw.fetchReadme();
                fetchBtn.disabled = false;
                fetchBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> 同步 NSFW 仓库 README';
                if (fr.ok) {
                    showToast(fr.cached ? 'README 已是最新' : 'README 同步完成', 'success');
                    const status = modal.querySelector('#pgReadmeStatus');
                    if (status && fr.meta) {
                        const t = new Date(fr.meta.readmeCachedAt).toLocaleString('zh-CN');
                        status.textContent = `上次同步: ${t} (${(fr.meta.readmeCachedSize/1024).toFixed(1)}KB)`;
                    }
                } else {
                    showToast('同步失败：' + fr.error, 'error');
                }
            });
        }
    }

    // ========== 历史抽屉 ==========
    async function openHistoryDrawer() {
        let drawer = document.getElementById('pgHistoryDrawer');
        if (!drawer) {
            drawer = document.createElement('div');
            drawer.id = 'pgHistoryDrawer';
            drawer.style.cssText = 'position:fixed; right:0; top:0; bottom:0; width:440px; background:#ffffff; border-left:1px solid #e5e7eb; z-index:300; transform:translateX(100%); transition:transform 0.2s; display:flex; flex-direction:column; box-shadow:-4px 0 12px rgba(0,0,0,0.08);';
            drawer.innerHTML = `
                <div style="padding:14px 18px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; justify-content:space-between; background:#f9fafb;">
                    <span style="font-size:15px; color:#1f2937; font-weight:600;"><i class="fa-solid fa-clock-rotate-left" style="color:#6366f1;"></i> 生成历史</span>
                    <div>
                        <button id="pgBtnHistoryClear" class="btn btn-sm" style="margin-right:6px;">清空</button>
                        <button id="pgBtnHistoryClose" class="btn btn-sm">×</button>
                    </div>
                </div>
                <div id="pgHistoryList" style="flex:1; overflow-y:auto; padding:12px; background:#f5f6f8;"></div>
            `;
            document.body.appendChild(drawer);
            drawer.querySelector('#pgBtnHistoryClose').addEventListener('click', () => { drawer.style.transform = 'translateX(100%)'; });
            drawer.querySelector('#pgBtnHistoryClear').addEventListener('click', async () => {
                if (confirm('清空所有生成历史？')) {
                    await api.promptHistory.clear();
                    renderHistory();
                    showToast('已清空', 'success');
                }
            });
        }
        drawer.style.transform = 'translateX(0)';
        renderHistory();
    }

    async function renderHistory() {
        const list = document.getElementById('pgHistoryList');
        const r = await api.promptHistory.list();
        if (!r.ok || r.history.length === 0) {
            list.innerHTML = '<div style="color:#9ca3af; text-align:center; padding:40px;">还没有生成历史</div>';
            return;
        }
        list.innerHTML = '';
        for (const h of r.history) {
            const card = document.createElement('div');
            card.style.cssText = 'background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; padding:12px; margin-bottom:10px; box-shadow:0 1px 2px rgba(0,0,0,0.04);';
            const tagList = h.tags.map(t => t.name).join('、');
            const time = new Date(h.ts).toLocaleString('zh-CN');
            card.innerHTML = `
                <div style="font-size:11px; color:#9ca3af; margin-bottom:6px;">${time} · ${h.model || '?'}</div>
                <div style="font-size:12px; color:#4338ca; margin-bottom:8px; font-weight:500;">${tagList || '(无标签)'}</div>
                <div style="font-size:13px; color:#374151; line-height:1.5; max-height:80px; overflow:hidden;">${h.text.slice(0, 150)}${h.text.length > 150 ? '...' : ''}</div>
                <div style="margin-top:8px; display:flex; gap:6px;">
                    <button class="btn btn-sm pgHistLoad" data-id="${h.id}">载入</button>
                    <button class="btn btn-sm pgHistCopy" data-id="${h.id}">复制</button>
                    <button class="btn btn-sm pgHistSave" data-id="${h.id}">保存到库</button>
                </div>
            `;
            list.appendChild(card);
        }
        // 绑定按钮
        list.querySelectorAll('.pgHistLoad').forEach(b => b.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            const h = r.history.find(x => x.id === id);
            if (h) {
                document.getElementById('pgResult').value = h.text;
                _resultText = h.text;
                _lastGeneratedTags = h.tags;
                updateSaveButtonState();
                syncResultActions();
                showToast('已载入到生成结果', 'success');
            }
        }));
        list.querySelectorAll('.pgHistCopy').forEach(b => b.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            const h = r.history.find(x => x.id === id);
            if (h) {
                await navigator.clipboard.writeText(h.text);
                showToast('已复制', 'success');
            }
        }));
        list.querySelectorAll('.pgHistSave').forEach(b => b.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            const h = r.history.find(x => x.id === id);
            if (h) {
                const newId = 'gen-' + Date.now().toString(36);
                const tags = h.tags.map(t => t.name);
                const wr = await api.prompts.writeOne(newId, h.text, tags);
                if (wr.ok) showToast('已保存到提示词库', 'success');
                else showToast('保存失败：' + wr.error, 'error');
            }
        }));
    }

    // ========== 自定义确认弹窗（替代 window.confirm，Electron 下更稳） ==========
    function pgConfirm(message, opts = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:9999; display:flex; align-items:center; justify-content:center;';
            const okText = opts.okText || '确定';
            const cancelText = opts.cancelText || '取消';
            overlay.innerHTML = `
                <div style="background:#ffffff; border-radius:8px; padding:20px 24px; min-width:320px; max-width:480px; box-shadow:0 8px 24px rgba(0,0,0,0.15);">
                    <div style="font-size:14px; color:#1f2937; line-height:1.6; margin-bottom:16px; word-break:break-all;">${escapeHtml(message)}</div>
                    <div style="display:flex; gap:8px; justify-content:flex-end;">
                        <button class="btn btn-sm" data-act="cancel" style="min-width:64px;">${escapeHtml(cancelText)}</button>
                        <button class="btn btn-sm btn-primary" data-act="ok" style="min-width:64px; ${opts.danger ? 'background:#dc2626; border-color:#dc2626;' : ''}">${escapeHtml(okText)}</button>
                    </div>
                </div>
            `;
            function close(v) { overlay.remove(); resolve(v); }
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close(false);
                else if (e.target.dataset.act === 'ok') close(true);
                else if (e.target.dataset.act === 'cancel') close(false);
            });
            document.body.appendChild(overlay);
            const okBtn = overlay.querySelector('[data-act="ok"]');
            if (okBtn) okBtn.focus();
        });
    }

    // ========== 提示词库抽屉 ==========
    // 跟历史抽屉同款布局，但数据源是 api.prompts（已保存的库）
    async function openPromptLibrary() {
        let drawer = document.getElementById('pgLibraryDrawer');
        if (!drawer) {
            drawer = document.createElement('div');
            drawer.id = 'pgLibraryDrawer';
            drawer.style.cssText = 'position:fixed; right:0; top:0; bottom:0; width:520px; background:#ffffff; border-left:1px solid #e5e7eb; z-index:300; transform:translateX(100%); transition:transform 0.2s; display:flex; flex-direction:column; box-shadow:-4px 0 12px rgba(0,0,0,0.08);';
            drawer.innerHTML = `
                <div style="padding:14px 18px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; justify-content:space-between; background:#f9fafb;">
                    <span style="font-size:15px; color:#1f2937; font-weight:600;"><i class="fa-solid fa-bookmark" style="color:#6366f1;"></i> 提示词库</span>
                    <div>
                        <span id="pgLibraryCount" style="font-size:11px; color:#6b7280; margin-right:8px;"></span>
                        <button id="pgBtnLibraryClose" class="btn btn-sm">×</button>
                    </div>
                </div>
                <div id="pgLibraryList" style="flex:1; overflow-y:auto; padding:12px; background:#f5f6f8;"></div>
                <div id="pgLibraryPager" style="flex-shrink:0; padding:8px 12px; border-top:1px solid #e5e7eb; background:#ffffff; display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:38px; box-sizing:border-box;"></div>
            `;
            document.body.appendChild(drawer);
            drawer.querySelector('#pgBtnLibraryClose').addEventListener('click', () => { drawer.style.transform = 'translateX(100%)'; });
        }
        drawer.style.transform = 'translateX(0)';
        renderPromptLibrary();
    }

    async function renderPromptLibrary() {
        const list = document.getElementById('pgLibraryList');
        const pager = document.getElementById('pgLibraryPager');
        if (!list) return;
        list.innerHTML = '<div style="color:#9ca3af; text-align:center; padding:40px;">加载中...</div>';
        if (pager) pager.innerHTML = '';
        const r = await api.prompts.readAll();
        if (!r || !r.ok) {
            list.innerHTML = `<div style="color:#dc2626; text-align:center; padding:40px;">加载失败: ${escapeHtml((r && r.error) || '未知')}</div>`;
            return;
        }
        // 按 ts 倒序（最新在前）
        _pgLibAll = (r.records || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
        _pgLibPage = 1;
        renderLibraryList();
        renderLibraryPager();
    }

    // 渲染当前页卡片
    function renderLibraryList() {
        const list = document.getElementById('pgLibraryList');
        const count = document.getElementById('pgLibraryCount');
        if (!list) return;
        if (count) count.textContent = `${_pgLibAll.length} 条`;
        if (_pgLibAll.length === 0) {
            list.innerHTML = '<div style="color:#9ca3af; text-align:center; padding:40px; font-size:13px;">还没有保存的提示词<br><span style="font-size:11px; color:#d1d5db; margin-top:6px; display:block;">在底部点「保存提示词」即可入库</span></div>';
            return;
        }
        const start = (_pgLibPage - 1) * _pgLibPageSize;
        const pageRecords = _pgLibAll.slice(start, start + _pgLibPageSize);
        list.innerHTML = '';
        for (const rec of pageRecords) {
            const card = document.createElement('div');
            card.dataset.id = rec.id;
            card.style.cssText = 'background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; padding:12px; margin-bottom:10px; box-shadow:0 1px 2px rgba(0,0,0,0.04);';
            const tagList = (rec.tags || []).join('、') || '(无标签)';
            const time = rec.ts ? new Date(rec.ts).toLocaleString('zh-CN') : '?';
            const hasMedia = !!rec.mediaPath;
            card.innerHTML = `
                <div style="font-size:11px; color:#9ca3af; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                    <span>${time}</span>
                    ${hasMedia ? '<span style="background:#dbeafe; color:#1d4ed8; padding:1px 6px; border-radius:3px; font-size:10px;"><i class="fa-solid fa-image"></i> 含图</span>' : ''}
                </div>
                <div style="font-size:12px; color:#4338ca; margin-bottom:8px; font-weight:500;">${escapeHtml(tagList)}</div>
                <div style="font-size:13px; color:#374151; line-height:1.5; max-height:80px; overflow:hidden; word-break:break-all;">${escapeHtml((rec.prompt || '').slice(0, 200))}${(rec.prompt || '').length > 200 ? '...' : ''}</div>
                <div style="margin-top:8px; display:flex; gap:6px;">
                    <button class="btn btn-sm pgLibLoad" data-id="${escapeAttr(rec.id)}">载入</button>
                    <button class="btn btn-sm pgLibCopy" data-id="${escapeAttr(rec.id)}">复制</button>
                    <button class="btn btn-sm pgLibDelete" data-id="${escapeAttr(rec.id)}" style="color:#dc2626;"><i class="fa-solid fa-trash"></i> 删除</button>
                </div>
            `;
            list.appendChild(card);
        }
        bindLibraryButtons();
    }

    // 渲染分页器
    function renderLibraryPager() {
        const pager = document.getElementById('pgLibraryPager');
        if (!pager) return;
        const total = _pgLibAll.length;
        const totalPages = Math.max(1, Math.ceil(total / _pgLibPageSize));
        if (_pgLibPage > totalPages) _pgLibPage = totalPages;
        if (totalPages <= 1) { pager.innerHTML = `<span style="color:#9ca3af; font-size:11px;">共 ${total} 条</span><span></span>`; return; }
        const cur = _pgLibPage;
        const start = (cur - 1) * _pgLibPageSize + 1;
        const end = Math.min(cur * _pgLibPageSize, total);
        pager.innerHTML = `
            <span style="color:#6b7280; font-size:11px;">${start}-${end} / 共 ${total} 条</span>
            <div style="display:flex; gap:2px; align-items:center;">
                <button class="btn btn-sm" data-pg-act="prev" ${cur === 1 ? 'disabled' : ''} style="padding:2px 8px; min-width:28px;" title="上一页"><i class="fa-solid fa-chevron-left" style="font-size:10px;"></i></button>
                ${buildPagerNumbers(cur, totalPages)}
                <button class="btn btn-sm" data-pg-act="next" ${cur === totalPages ? 'disabled' : ''} style="padding:2px 8px; min-width:28px;" title="下一页"><i class="fa-solid fa-chevron-right" style="font-size:10px;"></i></button>
            </div>
        `;
        const prevBtn = pager.querySelector('[data-pg-act="prev"]');
        const nextBtn = pager.querySelector('[data-pg-act="next"]');
        if (prevBtn && !prevBtn.disabled) prevBtn.addEventListener('click', () => goLibraryPage(cur - 1));
        if (nextBtn && !nextBtn.disabled) nextBtn.addEventListener('click', () => goLibraryPage(cur + 1));
        pager.querySelectorAll('[data-pg-num]').forEach(b => {
            b.addEventListener('click', () => goLibraryPage(Number(b.dataset.pgNum)));
        });
    }

    // 智能页码：≤ 7 页全显示，否则首尾 + 当前 ±1 + …
    function buildPagerNumbers(cur, total) {
        const pages = new Set([1, total, cur, cur - 1, cur + 1]);
        const valid = Array.from(pages).filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
        let html = '';
        let prev = 0;
        for (const p of valid) {
            if (prev && p - prev > 1) html += '<span style="color:#9ca3af; padding:0 4px; font-size:11px;">…</span>';
            const sel = p === cur;
            html += `<button class="btn btn-sm" data-pg-num="${p}" style="padding:2px 8px; min-width:28px; font-size:11px; ${sel ? 'background:#4338ca; color:#ffffff; border-color:#4338ca;' : ''}">${p}</button>`;
            prev = p;
        }
        return html;
    }

    function goLibraryPage(p) {
        if (p < 1) return;
        const totalPages = Math.max(1, Math.ceil(_pgLibAll.length / _pgLibPageSize));
        if (p > totalPages) return;
        if (p === _pgLibPage) return;
        _pgLibPage = p;
        renderLibraryList();
        renderLibraryPager();
        const list = document.getElementById('pgLibraryList');
        if (list) list.scrollTop = 0;
    }

    // 绑定按钮（用 _pgLibAll 全量查表，pageRecords 只是当前页显示用）
    function bindLibraryButtons() {
        const list = document.getElementById('pgLibraryList');
        if (!list) return;
        list.querySelectorAll('.pgLibLoad').forEach(b => b.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            const rec = _pgLibAll.find(x => x.id === id);
            if (rec) {
                document.getElementById('pgResult').value = rec.prompt || '';
                _resultText = rec.prompt || '';
                _lastGeneratedTags = (rec.tags || []).map(n => ({ name: n }));
                updateSaveButtonState();
                syncResultActions();
                showToast('已载入到生成结果', 'success');
            }
        }));
        list.querySelectorAll('.pgLibCopy').forEach(b => b.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            const rec = _pgLibAll.find(x => x.id === id);
            if (rec && rec.prompt) {
                await navigator.clipboard.writeText(rec.prompt);
                showToast('已复制', 'success');
            }
        }));
        list.querySelectorAll('.pgLibDelete').forEach(b => b.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            const rec = _pgLibAll.find(x => x.id === id);
            if (!rec) { showToast('未找到该提示词记录', 'error'); return; }
            const tagText = (rec.tags || []).join('、') || rec.id;
            const ok = await pgConfirm(`删除提示词「${tagText}」？此操作不可恢复。`, { okText: '删除', danger: true });
            if (!ok) return;
            try {
                const dr = await api.prompts.deleteOne(id);
                if (dr && dr.ok) {
                    handleLibraryDelete(id);
                    showToast('已删除', 'success');
                } else {
                    showToast('删除失败：' + ((dr && dr.error) || '返回为空'), 'error');
                    console.error('[pgLibDelete] failed', dr);
                }
            } catch (err) {
                showToast('删除异常：' + (err && err.message ? err.message : err), 'error');
                console.error('[pgLibDelete] exception', err);
            }
        }));
    }

    // 局部更新：保留滚动位置 + 调整页码
    function handleLibraryDelete(id) {
        const list = document.getElementById('pgLibraryList');
        const count = document.getElementById('pgLibraryCount');
        const idx = _pgLibAll.findIndex(x => x.id === id);
        if (idx === -1) return;
        _pgLibAll.splice(idx, 1);
        if (count) count.textContent = `${_pgLibAll.length} 条`;
        // 当前页变空且不是第 1 页 → 步退一页
        const newTotalPages = Math.max(1, Math.ceil(_pgLibAll.length / _pgLibPageSize));
        if (_pgLibPage > newTotalPages) _pgLibPage = newTotalPages;
        // 保存滚动位置（list.innerHTML = '' 会把 scrollTop 归零）
        const savedScroll = list ? list.scrollTop : 0;
        renderLibraryList();
        renderLibraryPager();
        if (list) {
            // 恢复滚动位置（clamp 到合法范围）
            list.scrollTop = Math.min(savedScroll, Math.max(0, list.scrollHeight - list.clientHeight));
        }
    }

    // ========== D-28 浅色主题覆盖 ==========
function _injectPromptGenLightCss() {
    if (document.getElementById('pgLightCss')) return;
    const style = document.createElement('style');
    style.id = 'pgLightCss';
    style.textContent = `
        /* 顶部 header 按钮 */
        #promptGenPage #pgBtnBack,
        #promptGenPage #pgBtnSettings,
        #promptGenPage #pgBtnHistory,
        #promptGenPage #pgBtnLibrary,
        #promptGenPage #pgBtnGenerate,
        #promptGenPage #pgBtnCancel,
        #promptGenPage #pgBtnClear,
        #promptGenPage #pgBtnCopy,
        #promptGenPage #pgBtnSave,
        #promptGenPage #pgBtnRegen,
        #promptGenPage #pgBtnSettingsClose,
        #promptGenPage #pgBtnSettingsSave,
        #promptGenPage #pgBtnHistoryClear,
        #promptGenPage #pgBtnHistoryClose,
        #pgHistoryDrawer .pgHistLoad,
        #pgHistoryDrawer .pgHistCopy,
        #pgHistoryDrawer .pgHistSave {
            background: #ffffff !important;
            color: #374151 !important;
            border: 1px solid #d1d5db !important;
        }
        #promptGenPage #pgBtnGenerate,
        #promptGenPage #pgBtnSave {
            background: #6366f1 !important;
            color: #ffffff !important;
            border: 1px solid #4f46e5 !important;
        }
        #promptGenPage #pgBtnGenerate:hover,
        #promptGenPage #pgBtnSave:hover {
            background: #4f46e5 !important;
        }
        #promptGenPage #pgBtnSettingsSave {
            background: #6366f1 !important;
            color: #ffffff !important;
            border: 1px solid #4f46e5 !important;
        }
        #promptGenPage #pgBtnCancel {
            background: #fef2f2 !important;
            color: #dc2626 !important;
            border: 1px solid #fecaca !important;
        }
        #promptGenPage .btn:hover {
            background: #f3f4f6 !important;
        }
        /* SFW / NSFW 模式切换（三个互斥 class 由 updateModeUI 切换） */
        .pgModeTab.inactive {
            background: transparent !important;
            color: #9ca3af !important;
            border: 1px solid transparent !important;
        }
        .pgModeTab.inactive:hover { background: rgba(107,114,128,0.08) !important; color: #4b5563 !important; }
        .pgModeTab.active-sfw {
            background: #dbeafe !important;
            color: #1d4ed8 !important;
            border: 1px solid #93c5fd !important;
            box-shadow: 0 1px 3px rgba(29,78,216,0.18) !important;
        }
        .pgModeTab.active-nsfw {
            background: #fee2e2 !important;
            color: #dc2626 !important;
            border: 1px solid #fca5a5 !important;
            box-shadow: 0 1px 3px rgba(220,38,38,0.20) !important;
        }
        .pgModeTab.active-sfw i { color: #2563eb !important; }
        .pgModeTab.active-nsfw i { color: #dc2626 !important; }
        /* 兼容旧的 :hover 兜底（已经被 class 覆盖，可忽略） */
        .pgModeTab:hover { background: rgba(99,102,241,0.08) !important; }
        .pgModeTab[data-mode="nsfw"]:hover { background: rgba(220,38,38,0.08) !important; }
        #pgSettingsModal .modal {
            background: #ffffff !important;
        }
        #pgSettingsModal .modal-header,
        #pgSettingsModal .modal-body,
        #pgSettingsModal .modal-footer {
            background: inherit !important;
            color: inherit !important;
        }
    `;
    document.head.appendChild(style);
}

// ========== D-31 配置弹窗（分类配置 / 提示词配置） ==========
// opts.tab ∈ { 'menu', 'item', 'rule', 'scene' } —— 可选，默认 'menu'
async function openConfigModal(opts) {
    opts = opts || {};
    const initialTab = (opts.tab === 'item' || opts.tab === 'rule' || opts.tab === 'scene') ? opts.tab : 'menu';
    const overlay = document.createElement('div');
    overlay.id = 'cfgModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;';
    // 注入 hover CSS（避免 inline JS 在模板字符串里被 node 报语法错）
    if (!document.getElementById('cfgHoverStyle')) {
        const st = document.createElement('style');
        st.id = 'cfgHoverStyle';
        st.textContent = '.cfgHoverBtn{background:#f3f4f6;border:1px solid #d1d5db;color:#374151;cursor:pointer;padding:5px 12px;border-radius:6px;font-size:12px;transition:background 0.1s;}.cfgHoverBtn:hover{background:#e5e7eb;}';
        document.head.appendChild(st);
    }
    overlay.innerHTML = `
        <div id="cfgPanel" style="background:#fff;border-radius:12px;width:780px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:system-ui,-apple-system,sans-serif;overflow:hidden;">
            <div style="padding:12px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px;background:#f9fafb;">
                <span style="font-size:15px;font-weight:600;color:#1f2937;"><i class="fa-solid fa-folder-tree" style="color:#6366f1;"></i> 配置管理</span>
                <div style="display:inline-flex;background:#f3f4f6;border-radius:8px;padding:3px;gap:2px;">
                    <button id="cfgTabMenu" class="cfgTabBtn" style="padding:5px 14px;font-size:12px;font-weight:500;border:none;border-radius:6px;cursor:pointer;background:#fff;color:#1f2937;box-shadow:0 1px 2px rgba(0,0,0,0.08);"><i class="fa-solid fa-layer-group"></i> 分类配置</button>
                    <button id="cfgTabItem" class="cfgTabBtn" style="padding:5px 14px;font-size:12px;font-weight:500;border:none;border-radius:6px;cursor:pointer;background:transparent;color:#6b7280;"><i class="fa-solid fa-tags"></i> 提示词配置</button>
                    <button id="cfgTabRule" class="cfgTabBtn" style="padding:5px 14px;font-size:12px;font-weight:500;border:none;border-radius:6px;cursor:pointer;background:transparent;color:#6b7280;"><i class="fa-solid fa-arrow-down-1-9"></i> 拼装规则</button>
                    <button id="cfgTabScene" class="cfgTabBtn" style="padding:5px 14px;font-size:12px;font-weight:500;border:none;border-radius:6px;cursor:pointer;background:transparent;color:#6b7280;"><i class="fa-solid fa-image"></i> 场景模板</button>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;margin-left:auto;">
                    <button id="cfgAddBtn" class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-plus"></i> 新增</button>
                    <button id="cfgCloseBtn" class="btn btn-sm cfgHoverBtn" title="关闭">关闭</button>
                </div>
            </div>
            <div style="display:flex;flex:1;min-height:0;overflow:hidden;">
                <!-- ===== 分类配置内容 ===== -->
                <div id="cfgMenuPane" style="display:flex;flex:1;min-height:0;">
                    <div style="width:210px;border-right:1px solid #e5e7eb;overflow-y:auto;padding:10px 0;background:#fafafa;">
                        <div id="cfgMenuTree" style="font-size:13px;padding:0 8px;"></div>
                    </div>
                    <div style="flex:1;overflow-y:auto;padding:16px 18px;">
                        <div id="cfgMenuEmpty" style="text-align:center;color:#9ca3af;margin-top:60px;font-size:13px;">
                            <i class="fa-solid fa-folder-open" style="font-size:28px;margin-bottom:10px;display:block;color:#d1d5db;"></i>
                            选择左侧分类查看详情<br>或点击「新增」添加
                        </div>
                        <div id="cfgMenuForm" style="display:none;"></div>
                    </div>
                </div>
                <!-- ===== 提示词配置内容 ===== -->
                <div id="cfgItemPane" style="display:none;flex:1;min-height:0;flex-direction:column;">
                    <div style="display:flex;flex:1;min-height:0;overflow:hidden;">
                        <div style="width:210px;border-right:1px solid #e5e7eb;overflow-y:auto;padding:10px 0;background:#fafafa;">
                            <div id="cfgItemTree" style="font-size:13px;padding:0 8px;"></div>
                        </div>
                        <div style="flex:1;overflow-y:auto;padding:14px 18px;">
                            <div id="cfgItemToolbar" style="display:flex; gap:8px; align-items:center; margin-bottom:12px; padding-bottom:10px; border-bottom:1px dashed #e5e7eb;">
                                <button id="cfgItemImportTplBtn" class="cfgHoverBtn" type="button" title="下载 Excel 导入模板（含表头+示例+现有分类参考）">
                                    <i class="fa-solid fa-download"></i> 下载模板
                                </button>
                                <button id="cfgItemImportBtn" class="cfgHoverBtn" type="button" title="从 Excel/CSV 批量导入提示词" style="background:#6366f1;color:#fff;border-color:#6366f1;">
                                    <i class="fa-solid fa-file-import"></i> Excel 导入
                                </button>
                                <input type="file" id="cfgItemImportFile" accept=".xlsx,.xls,.csv" style="display:none;">
                                <span id="cfgItemImportStatus" style="margin-left:auto; font-size:11px; color:#6b7280; align-self:center;"></span>
                            </div>
                            <div id="cfgItemList" style="margin-bottom:14px;"></div>
                            <div id="cfgItemFormWrap" style="display:none;"></div>
                        </div>
                    </div>
                </div>
                <!-- ===== 拼装规则配置内容（D-35） ===== -->
                <div id="cfgRulePane" style="display:none;flex:1;min-height:0;flex-direction:column;background:#fff;">
                    <div style="padding:14px 18px;border-bottom:1px solid #e5e7eb;background:#fafafa;">
                        <div style="font-size:13px;color:#374151;line-height:1.6;">
                            <i class="fa-solid fa-circle-info" style="color:#6366f1;"></i>
                            拼装规则：选择要拼装的一级分类并设置顺序。右侧“生成结果”会按这个顺序拼接选中的提示词内容（同级按选择顺序拼接），未选中的规则项会自动跳过。
                        </div>
                    </div>
                    <div style="display:flex;flex:1;min-height:0;overflow:hidden;">
                        <div style="width:280px;border-right:1px solid #e5e7eb;overflow-y:auto;padding:14px 16px;background:#fff;">
                            <div style="font-size:12px;color:#6b7280;margin-bottom:8px;font-weight:500;">可选一级分类</div>
                            <div id="cfgRuleAvailable"></div>
                        </div>
                        <div style="flex:1;overflow-y:auto;padding:14px 18px;">
                            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                                <div style="font-size:12px;color:#6b7280;font-weight:500;">拼装顺序（从左到右拼接）</div>
                                <div>
                                    <button id="cfgRuleClearBtn" class="cfgHoverBtn" style="font-size:11px;">清空</button>
                                    <button id="cfgRuleSaveBtn" class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;font-size:11px;padding:4px 10px;"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
                                </div>
                            </div>
                            <div id="cfgRuleSelected"></div>
                        </div>
                    </div>
                </div>
                <!-- ===== 场景模板管理（D-40） ===== -->
                <div id="cfgScenePane" style="display:none;flex:1;min-height:0;flex-direction:column;background:#fff;">
                    <div style="padding:14px 18px;border-bottom:1px solid #e5e7eb;background:#fafafa;display:flex;align-items:center;justify-content:space-between;gap:12px;">
                        <div style="font-size:13px;color:#374151;line-height:1.6;flex:1;">
                            <i class="fa-solid fa-circle-info" style="color:#6366f1;"></i>
                            场景模板：md 导入的 <span id="cfgSceneCount" style="font-weight:600;color:#6366f1;">0</span> 个预设场景，可启用/禁用、编辑内容或删除
                        </div>
                        <div style="display:flex;align-items:center;gap:12px;">
                            <div style="font-size:12px;color:#6b7280;">
                                <span id="cfgSceneEnabledCount" style="color:#059669;font-weight:600;">0</span> 已启用
                            </div>
                            <button id="cfgSceneRefreshBtn" class="cfgHoverBtn" style="font-size:11px;padding:4px 10px;" title="强制从主进程重新拉取数据"><i class="fa-solid fa-rotate"></i> 刷新</button>
                        </div>
                    </div>
                    <div id="cfgSceneList" style="flex:1;overflow-y:auto;padding:14px 18px;"></div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    let menuItems = [];
    let menuEditingId = null;
    let _lastCreateParentId = 0;   // D-31-r2: 「连续新增」模式 — 保存后保留上次选的 parent，下一个自动 sort+1
    let itemEditingId = null;
    let _lastCreateItemCatId = 0;  // D-31-r3: 提示词「连续新增」 — 保存后保留上次选的 category_id
    let currentTab = 'menu';   // 'menu' | 'item'
    let currentItemCatId = null;

    // ---- helpers ----
    function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function findFirstLeaf(items, byParent) {
        if (!items.length) return null;
        // 找第一个有孩子的节点，递归到叶子
        function walk(pid) {
            const children = byParent[pid] || [];
            if (!children.length) return pid === 0 ? null : pid;
            return walk(children[0].id);
        }
        return walk(0);
    }

    // ---- Tab 切换 ----
    function switchTab(tab) {
        currentTab = tab;
        document.querySelectorAll('.cfgTabBtn').forEach(b => {
            const isActive = b.id === 'cfgTabMenu' ? tab === 'menu'
                          : b.id === 'cfgTabItem' ? tab === 'item'
                          : b.id === 'cfgTabRule' ? tab === 'rule'
                          : b.id === 'cfgTabScene' ? tab === 'scene' : false;
            b.style.background = isActive ? '#fff' : 'transparent';
            b.style.color = isActive ? '#1f2937' : '#6b7280';
            b.style.boxShadow = isActive ? '0 1px 2px rgba(0,0,0,0.08)' : 'none';
        });
        const menuPane = document.getElementById('cfgMenuPane');
        const itemPane = document.getElementById('cfgItemPane');
        const rulePane = document.getElementById('cfgRulePane');
        const scenePane = document.getElementById('cfgScenePane');
        if (menuPane) menuPane.style.display = tab === 'menu' ? 'flex' : 'none';
        if (itemPane) itemPane.style.display = tab === 'item' ? 'flex' : 'none';
        if (rulePane) rulePane.style.display = tab === 'rule' ? 'flex' : 'none';
        if (scenePane) scenePane.style.display = tab === 'scene' ? 'flex' : 'none';
        const addBtn = document.getElementById('cfgAddBtn');
        if (addBtn) {
            addBtn.style.display = (tab === 'rule' || tab === 'scene') ? 'none' : '';
            addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> ' + (tab === 'menu' ? '新增分类' : '新增提示词');
        }
        if (tab === 'item') {
            loadItemTree();
        } else if (tab === 'rule') {
            renderRulePane();  // D-35: 拼装规则面板渲染
        } else if (tab === 'scene') {
            renderScenePane(true);  // D-40: 场景模板面板（强制刷新以反映最新数据）
        }
    }

    document.getElementById('cfgTabMenu').addEventListener('click', () => switchTab('menu'));
    document.getElementById('cfgTabItem').addEventListener('click', () => switchTab('item'));
    document.getElementById('cfgTabRule').addEventListener('click', () => switchTab('rule'));  // D-35
    document.getElementById('cfgTabScene').addEventListener('click', () => switchTab('scene'));  // D-40

    // 刷新按钮：强制重拉数据（保留渲染函数引用，绑一次）
    const _sceneRefreshBtn = document.getElementById('cfgSceneRefreshBtn');
    if (_sceneRefreshBtn && _sceneRefreshBtn.dataset.bound !== '1') {
        _sceneRefreshBtn.dataset.bound = '1';
        _sceneRefreshBtn.addEventListener('click', () => {
            _sceneLoaded = false;  // 强制重新拉
            renderScenePane(true);
        });
    }

    // ---- 提示词配置：Excel 导入 / 下载模板 ----
    document.getElementById('cfgItemImportBtn').addEventListener('click', () => {
        document.getElementById('cfgItemImportFile').click();
    });
    document.getElementById('cfgItemImportFile').addEventListener('change', onCfgItemImportFileSelected);
    document.getElementById('cfgItemImportTplBtn').addEventListener('click', downloadCfgItemTemplate);

    function onCfgItemImportFileSelected(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const status = document.getElementById('cfgItemImportStatus');
        if (status) status.textContent = '正在解析 ' + file.name + ' ...';
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const data = new Uint8Array(ev.target.result);
                const wb = XLSX.read(data, { type: 'array' });
                const firstSheet = wb.SheetNames[0];
                if (!firstSheet) { showToast('Excel 没有可读的工作表', 'error'); if (status) status.textContent = ''; return; }
                const sheet = wb.Sheets[firstSheet];
                const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
                if (!rows.length) { showToast('Excel 没有任何数据行', 'error'); if (status) status.textContent = ''; return; }
                if (status) status.textContent = '正在导入 ' + rows.length + ' 行 ...';
                const r = await window.api.promptItems.import(rows);
                if (!r.ok) {
                    showToast('导入失败：' + r.error, 'error');
                    if (status) status.textContent = '';
                    return;
                }
                // 汇总提示
                const parts = [];
                if (r.imported) parts.push('新增 ' + r.imported);
                if (r.updated) parts.push('更新 ' + r.updated);
                if (r.catsCreated) parts.push('自动建分类 ' + r.catsCreated);
                if (r.skipped) parts.push('跳过 ' + r.skipped);
                showToast('导入完成：' + (parts.join('，') || '无变化'), 'success');
                if (status) status.textContent = parts.join('，') || '导入完成';
                if (r.skippedDetails && r.skippedDetails.length) {
                    console.warn('[item-import] 跳过详情：', r.skippedDetails);
                }
                // 刷新当前视图
                await loadMenu();
                if (currentItemCatId) {
                    await loadItemTree();
                    await loadItemList(currentItemCatId);
                }
            } catch (err) {
                console.error('[item-import] 解析异常：', err);
                showToast('解析失败：' + err.message, 'error');
                if (status) status.textContent = '';
            } finally {
                // 清空 file input，允许重新选同一文件
                e.target.value = '';
            }
        };
        reader.onerror = () => {
            showToast('读取文件失败', 'error');
            if (status) status.textContent = '';
            e.target.value = '';
        };
        reader.readAsArrayBuffer(file);
    }

    async function downloadCfgItemTemplate() {
        if (typeof XLSX === 'undefined') {
            showToast('SheetJS 未加载，无法生成模板', 'error');
            return;
        }
        try {
            // Sheet 1: 提示词（含表头 + 2 行示例）
            const headerRow = ['分类名称', '提示词名称', '提示词内容', '描述', '排序', '敏感度'];
            const exampleRows = [
                ['人物', '示例：年轻女性', 'a young woman, detailed face, natural lighting', '示例描述，可删除本行', 0, 'nsfw'],
                ['场景', '示例：咖啡厅', 'in a coffee shop, warm light, indoor', '示例描述，可删除本行', 0, 'sfw'],
            ];
            const ws1 = XLSX.utils.aoa_to_sheet([headerRow, ...exampleRows]);
            // 列宽
            ws1['!cols'] = [
                { wch: 18 }, { wch: 22 }, { wch: 50 }, { wch: 30 }, { wch: 8 }, { wch: 10 },
            ];

            // Sheet 2: 现有分类参考（避免用户瞎填分类名）
            const catResp = await window.api.promptMenu.list();
            const catRows = [['现有分类名（导入时若不存在会自动创建为根级分类）']];
            if (catResp && catResp.ok && Array.isArray(catResp.items)) {
                catResp.items
                    .slice()
                    .sort((a, b) => String(a.category_name).localeCompare(String(b.category_name), 'zh'))
                    .forEach(c => catRows.push([c.category_name]));
            }
            const ws2 = XLSX.utils.aoa_to_sheet(catRows);
            ws2['!cols'] = [{ wch: 40 }];

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws1, '提示词');
            XLSX.utils.book_append_sheet(wb, ws2, '分类参考');
            XLSX.writeFile(wb, 'prompt_items_template.xlsx');
            showToast('模板已下载', 'success');
        } catch (e) {
            console.error('[item-template] 生成失败：', e);
            showToast('生成模板失败：' + e.message, 'error');
        }
    }

    // ---- 全局按钮 ----
    document.getElementById('cfgCloseBtn').addEventListener('click', () => { overlay.remove(); _lastCreateParentId = 0; _lastCreateItemCatId = 0; menuEditingId = null; itemEditingId = null; });
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); _lastCreateParentId = 0; _lastCreateItemCatId = 0; menuEditingId = null; itemEditingId = null; } });
    // D-31-r2: 「新增分类」按钮 —— 跳出编辑态，进入「纯新增 / 连续新增」模式
    //   - 优先用 _lastCreateParentId（刚保存过新增的"上次 parent"）→ 连续新增模式
    //   - 退而用 menuEditingId（点左侧时设的"上次点过的节点"）→ 全新表单但 parent = 它
    //   - 都没有 → 全新根级表单
    //   - 点新增会清掉 menuEditingId（跳出编辑意图）
    document.getElementById('cfgAddBtn').addEventListener('click', () => {
        if (currentTab === 'menu') {
            // 优先顺序：连续新增记忆 > 左侧点选 > 根级
            const parentId = _lastCreateParentId || menuEditingId || 0;
            const keepCreating = _lastCreateParentId !== 0;
            // 跳出编辑意图
            menuEditingId = null;
            showMenuForm(null, { defaultParentId: parentId, keepCreating });
        } else {
            // D-31-r3: 提示词「连续新增」 —— 跳出编辑，优先用 _lastCreateItemCatId > currentItemCatId > 0
            const catId = _lastCreateItemCatId || currentItemCatId || 0;
            const keepCreating = _lastCreateItemCatId !== 0;
            itemEditingId = null;
            showItemForm(null, { defaultCatId: catId, keepCreating });
        }
    });

    // ===================== 分类配置 =====================
    async function loadMenu() {
        const r = await window.api.promptMenu.list();
        menuItems = r.ok ? r.items : [];
        renderMenuTree();
    }

    // D-43: 分类树折叠状态（默认全部收起，点 ▶ 展开；自动展开当前编辑项的路径）
    const _menuTreeExpanded = new Set();

    function expandPathTo(menuId) {
        // 从 menuId 沿 parent_id 链向上，把所有祖先都加入展开集合
        if (!menuId) return;
        const byId = new Map(menuItems.map(m => [m.id, m]));
        let cur = byId.get(Number(menuId));
        while (cur && cur.parent_id) {
            _menuTreeExpanded.add(Number(cur.parent_id));
            cur = byId.get(Number(cur.parent_id));
        }
    }

    function renderMenuTree() {
        const el = document.getElementById('cfgMenuTree');
        if (!el) return;
        el.innerHTML = '';
        if (!menuItems.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:6px 4px;">暂无分类</div>'; return; }
        // 每次渲染前，确保当前编辑项的祖先都展开（这样能看到高亮的那行在树里在哪）
        if (menuEditingId) expandPathTo(menuEditingId);
        const byParent = {};
        for (const it of menuItems) { const p = it.parent_id || 0; (byParent[p] = byParent[p] || []).push(it); }
        for (const k in byParent) byParent[k].sort((a,b) => (a.sort_order||0)-(b.sort_order||0)||a.id-b.id);
        function walk(pid, depth) {
            const children = byParent[pid] || [];
            for (const it of children) {
                const hasChildren = (byParent[it.id] || []).length > 0;
                const isExpanded = _menuTreeExpanded.has(it.id);
                const isSel = menuEditingId === it.id;
                const div = document.createElement('div');
                div.style.cssText = 'padding:5px 6px;border-radius:6px;cursor:pointer;margin-bottom:1px;display:flex;align-items:center;gap:5px;' + (isSel ? 'background:#eef2ff;color:#4338ca;font-weight:500;' : '');
                if (!isSel) {
                    div.addEventListener('mouseenter', () => { div.style.background = '#eef2ff'; });
                    div.addEventListener('mouseleave', () => { div.style.background = 'transparent'; });
                }
                // 缩进 + 折叠/展开按钮 + 文件夹图标 + 名称 + 互斥组徽章 + 必选点
                const indent = '<span style="flex-shrink:0;width:' + (depth*14) + 'px;"></span>';
                const chevron = hasChildren
                    ? '<span class="cfgMenuChevron" data-id="' + it.id + '" style="flex-shrink:0;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:#9ca3af;font-size:10px;cursor:pointer;user-select:none;">' + (isExpanded ? '▼' : '▶') + '</span>'
                    : '<span style="flex-shrink:0;width:14px;height:14px;display:inline-block;"></span>';
                const folder = '<i class="fa-solid fa-folder' + (it.parent_id ? '-open' : '') + '" style="color:' + (it.parent_id ? '#f59e0b' : '#6366f1') + ';font-size:11px;flex-shrink:0;"></i>';
                const name = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.category_name) + '</span>';
                // D-44: 互斥组徽章
                const grp = (it.exclusive_group || '').trim();
                const grpBadge = grp ? '<span title="互斥组：' + esc(grp) + '" style="flex-shrink:0;font-size:10px;line-height:1.4;padding:1px 6px;background:#ede9fe;color:#6d28d9;border-radius:8px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">#' + esc(grp) + '</span>' : '';
                const reqDot = it.is_required ? '<span title="必选" style="flex-shrink:0;width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;margin-left:2px;"></span>' : '';
                div.innerHTML = indent + chevron + folder + name + grpBadge + reqDot;
                div.title = it.description || it.category_name;
                // 点行 → 打开编辑表单
                div.addEventListener('click', (ev) => {
                    // 如果点的是 chevron 子元素，不打开表单（chevron 自己处理）
                    if (ev.target.closest('.cfgMenuChevron')) return;
                    showMenuForm(it.id);
                });
                el.appendChild(div);
                // 只在展开时递归子节点
                if (hasChildren && isExpanded) walk(it.id, depth+1);
            }
        }
        walk(0, 0);
        // 给所有 chevron 绑事件
        el.querySelectorAll('.cfgMenuChevron').forEach(span => {
            span.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const id = Number(span.getAttribute('data-id'));
                if (_menuTreeExpanded.has(id)) _menuTreeExpanded.delete(id);
                else _menuTreeExpanded.add(id);
                renderMenuTree();
            });
        });
    }

    // D-31: 树形下拉 + 默认上级 + 默认排序
    //   opts.defaultParentId —— 新增时希望默认选中的父节点（来自左侧树当前选中 / 上次保存）
    //   opts.keepCreating    —— 「连续新增」模式：清空 name/desc/reqCheck，但保留 parent + sort+1
    //                            （仅在 id=null 时生效）
    function showMenuForm(id, opts) {
        opts = opts || {};
        menuEditingId = id;
        // D-31-r2: 点左侧某个分类（进入编辑）会中断「连续新增」记忆
        if (id) _lastCreateParentId = 0;
        const it = id ? menuItems.find(x => x.id === id) : null;
        document.getElementById('cfgMenuEmpty').style.display = 'none';
        const form = document.getElementById('cfgMenuForm');

        // D-31-r2: 「连续新增」模式 —— 编辑模式忽略 keepCreating（编辑一定要带原值）
        const keepCreating = !id && !!opts.keepCreating;
        form.style.display = 'block';

        // ---- 1) 算"禁用集合"：编辑节点自己 + 它的所有后代（防自循环）----
        // 后端已有同款防护（main.js 里的 pid_list 起始判断），前端再防一次体验更好
        const disabledIds = new Set();
        if (id) {
            disabledIds.add(id);
            const selfPid = it.pid_list || '';
            for (const x of menuItems) {
                if (x.id !== id && (x.pid_list || '').startsWith(selfPid)) disabledIds.add(x.id);
            }
        }

        // ---- 2) 按 parent_id 分桶（每桶按 sort_order + id 排序） ----
        //   D-45: 旧 <select> 用到的 depthOf / siblingIdx / renderOption / dfs 那一套已删

        // 按 parent_id 分桶 + 每桶内按 sort_order 排序
        const byParent = {};
        for (const x of menuItems) { const p = x.parent_id || 0; (byParent[p] = byParent[p] || []).push(x); }
        for (const k in byParent) byParent[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);

        // ---- 3) 决定本次表单"上级分类"默认选中 ----
        // 编辑：用 item.parent_id
        // 新增：优先用 opts.defaultParentId（来自「新增」按钮 / 左侧选中），否则 0
        const defaultParentId = it
            ? (it.parent_id || 0)
            : (opts.defaultParentId || 0);
        // 如果 defaultParentId 指向一个被禁用的 id（不可能发生在新增，但可能发生在"编辑时改了 defaultParentId"等场景），回退到 0
        const finalDefaultParentId = disabledIds.has(Number(defaultParentId)) ? 0 : defaultParentId;

        // D-45-fix: 内联算初始显示文本。
        //   showMenuForm 后半段才声明 menuByIdForPath，在 D-45 块里同步调 updateParentDisplay 会触发 TDZ
        //   这里用本地 map 算一次，把结果直接塞进 input 的 value，避开 TDZ 也避免显示闪烁
        const _pathMapLocal = new Map(menuItems.map(m => [m.id, m]));
        function _pathOfLocal(mid) {
            if (!mid) return '';
            const segs = [];
            let cur = _pathMapLocal.get(Number(mid));
            while (cur) {
                segs.unshift(cur.category_name);
                cur = cur.parent_id ? _pathMapLocal.get(Number(cur.parent_id)) : null;
            }
            return segs.join(' > ');
        }
        const _initM = _pathMapLocal.get(finalDefaultParentId);
        const initialParentDisplayText = _initM ? (_pathOfLocal(finalDefaultParentId) + '  #' + finalDefaultParentId) : '（根级，无上级）';

        // ---- 4) 决定本次"排序权重"默认值 ----
        // 编辑：保留原值
        // 新增：当前父节点下所有兄弟的 max sort_order + 1；没有兄弟时 0
        function defaultSortFor(parentId) {
            // 根级 (parentId=0) 也要算根级下 L1 们的 max+1，不应短路返回 0
            const sibs = byParent[parentId] || [];
            if (!sibs.length) return 0;
            return Math.max(...sibs.map(s => s.sort_order || 0)) + 1;
        }
        const defaultSort = it
            ? (it.sort_order || 0)
            : defaultSortFor(finalDefaultParentId);

        // D-45: 上级分类下拉已从 <select> 改成自定义可折叠树形 picker（在 form.innerHTML 里）

        // D-44: 收集所有已存在的互斥组名（去重 + 排序），用于 datalist 自动补全
        const existingGroups = Array.from(new Set(
            menuItems.map(m => (m.exclusive_group || '').trim()).filter(Boolean)
        )).sort((a, b) => a.localeCompare(b, 'zh-CN'));
        const groupDatalistHtml = existingGroups.map(g => '<option value="' + esc(g) + '">').join('');

        form.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;"><span style="font-size:14px;font-weight:500;color:#374151;">' + (id ? '编辑分类' : (keepCreating ? '新增分类 <span style="font-size:11px;color:#059669;font-weight:400;margin-left:6px;">· 连续新增模式</span>' : '新增分类')) + '</span>' + (id ? '<button id="cfgMenuDelBtn" class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;margin-left:auto;"><i class="fa-solid fa-trash"></i> 删除</button>' : '') + '</div>' +
            '<div style="margin-bottom:10px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">分类名称 *</label><input id="cfgMenuNameInp" type="text" value="' + esc((id || !keepCreating) ? (it ? it.category_name : '') : '') + '" placeholder="如：人物、场景、风格' + (keepCreating ? '（保存后保持此位置，可连着输入下一个）' : '') + '" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;box-sizing:border-box;' + (keepCreating ? 'border-color:#10b981;' : '') + '"></div>' +
            // D-45: 上级分类 — 显示框 + 独立的「选择分类」按钮
            //   - hidden input #cfgMenuParentSel 存 id（兼容老代码 form.querySelector('#cfgMenuParentSel').value）
            //   - readonly input #cfgMenuParentDisplay 显示当前选中项的路径
            //   - 按钮 #cfgMenuPickBtn「选择分类」点击弹大模态框
            '<div style="margin-bottom:10px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">上级分类</label>' +
                '<div style="display:flex;gap:6px;align-items:stretch;">' +
                    '<input type="hidden" id="cfgMenuParentSel" value="' + (finalDefaultParentId || 0) + '">' +
                    '<input type="text" id="cfgMenuParentDisplay" value="' + esc(initialParentDisplayText) + '" readonly tabindex="-1" placeholder="（根级，无上级）" style="flex:1;min-width:0;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#f9fafb;color:#374151;box-sizing:border-box;font-family:inherit;cursor:default;">' +
                    '<button type="button" id="cfgMenuPickBtn" style="flex-shrink:0;padding:7px 14px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#fff;color:#374151;cursor:pointer;white-space:nowrap;font-family:inherit;transition:background 0.15s;">选择分类</button>' +
                '</div>' +
                (id ? '<div style="font-size:11px;color:#9ca3af;margin-top:3px;">编辑模式下"自己及后代"已自动置灰，避免循环引用</div>' : (keepCreating ? '<div style="font-size:11px;color:#059669;margin-top:3px;">· 保持上次选择的父；改这里会重算排序</div>' : '')) +
            '</div>' +
            '<div style="margin-bottom:10px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">分类描述</label><textarea id="cfgMenuDescInp" rows="2" placeholder="可选，用于说明此分类的用途" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc((id || !keepCreating) ? (it ? it.description : '') : '') + '</textarea></div>' +
            '<div style="margin-bottom:14px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">排序权重</label><input id="cfgMenuSortInp" type="number" value="' + defaultSort + '" min="0" style="width:120px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;' + (keepCreating ? 'border-color:#10b981;' : '') + '"><span style="font-size:11px;color:#9ca3af;margin-left:6px;">越小越靠前' + (id ? '' : ' · 新增自动取同级最大 +1') + '</span></div>' +
            '<div style="margin-bottom:14px;"><label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;cursor:pointer;user-select:none;"><input id="cfgMenuReqInp" type="checkbox" ' + ((id || !keepCreating) ? ((it && it.is_required) ? 'checked' : '') : '') + ' style="cursor:pointer;"><span>是否必选</span><span style="font-size:11px;color:#9ca3af;">勾选后该分类下的提示词为必选项</span></label></div>' +
            // D-40 + D-42: 数量规则 + 互斥分类（直接配对）
            '<div style="margin-bottom:10px;padding:10px 12px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;">' +
                '<div style="font-size:11px;font-weight:600;color:#92400e;margin-bottom:6px;display:flex;align-items:center;gap:4px;"><i class="fa-solid fa-shield-halved"></i> 校验规则（D-40 · 用于拼装时实时冲突检查）</div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">数量规则（tag_required）</label>' +
                    '<input id="cfgMenuTagReqInp" type="text" value="' + esc((id || !keepCreating) ? (it ? (it.tag_required || '') : '') : '') + '" placeholder="留空 = 不限制" list="cfgMenuTagReqPresets" style="width:100%;padding:6px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:5px;box-sizing:border-box;font-family:inherit;">' +
                    '<datalist id="cfgMenuTagReqPresets"><option value="必选 1 个"><option value="必选 1-2 个"><option value="必选 2-3 个"><option value="必选 3 个"><option value="选 1-3 个"><option value="选 2-3 个"><option value="选 2-4 个"></datalist>' +
                    '<div style="font-size:11px;color:#6b7280;margin-top:3px;">格式：「必选 N 个」或「选 N-M 个」。拼装时超出范围会警告。</div>' +
                '</div>' +
                // D-42: 互斥分类（直接配对，弃用 tag_exclusive_group 概念）
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">互斥分类（exclusive_with · 可多选）</label>' +
                    '<div id="cfgMenuExclBox" style="display:flex;flex-wrap:wrap;gap:5px;padding:5px 6px;border:1px solid #d1d5db;border-radius:5px;background:#fff;min-height:30px;align-items:center;box-sizing:border-box;">' +
                        '<span id="cfgMenuExclEmpty" style="font-size:12px;color:#d1d5db;">（无）</span>' +
                    '</div>' +
                    '<div id="cfgMenuExclTree" style="max-height:200px;overflow-y:auto;border:1px solid #d1d5db;border-radius:5px;background:#fafafa;padding:6px 8px;margin-top:5px;box-sizing:border-box;"></div>' +
                    '<div id="cfgMenuExclWarn" style="font-size:11px;color:#dc2626;margin-top:4px;display:none;"></div>' +
                    '<div style="font-size:11px;color:#6b7280;margin-top:4px;line-height:1.5;">' +
                        '选择本分类与哪些分类互斥（拼装时，本分类下的提示词与所选分类下的提示词不能同时出现）。<br>' +
                        '· 互斥关系对子分类同样生效（在 L1 上设互斥，则 L1 下所有子分类的提示词都受此约束）<br>' +
                        '· 不可与本分类或上级分类互斥' +
                    '</div>' +
                '</div>' +
                // D-44: 互斥组（同组名 = 全员互斥；不继承祖先，每个分类独立填）
                '<div style="margin-top:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">互斥组（exclusive_group · 同组内互斥）</label>' +
                    '<input id="cfgMenuExclGroupInp" type="text" value="' + esc(it ? (it.exclusive_group || '') : '') + '" placeholder="留空 = 不参与组互斥" list="cfgMenuExclGroupPresets" maxlength="32" style="width:100%;padding:6px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:5px;box-sizing:border-box;font-family:inherit;">' +
                    '<datalist id="cfgMenuExclGroupPresets">' + groupDatalistHtml + '</datalist>' +
                    '<div style="font-size:11px;color:#6b7280;margin-top:3px;line-height:1.5;">' +
                        '填写一个组名（如「体型」），所有同名的分类在拼装时互斥。比逐个配对更省事。<br>' +
                        '· 组名区分大小写<br>' +
                        '· 不继承祖先：要在子分类也设上组名才生效' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;"><button id="cfgMenuSaveBtn" class="btn btn-sm btn-primary"><i class="fa-solid fa-floppy-disk"></i> 保存' + (keepCreating ? '并继续' : '') + '</button><button id="cfgMenuCancelBtn" class="btn btn-sm cfgHoverBtn">取消</button></div>';

        // D-45: 上级分类 — 显示框 + 独立的「选择分类」按钮
        //   点按钮 → 弹大模态框（全屏半透明背景 + 居中大框）
        //   点行直接选中并关闭
        //   不挂任何 document/window/form 级监听（不污染全局）
        const parentSel = form.querySelector('#cfgMenuParentSel');           // hidden input（值）
        const parentDisplay = form.querySelector('#cfgMenuParentDisplay');   // 只读显示框
        const parentPickBtn = form.querySelector('#cfgMenuPickBtn');         // 「选择分类」按钮
        const _parentTreeExpanded = new Set();                               // 展开状态（每次打开重置 → 默认全收起）

        function getSelectedParentId() {
            return Number(parentSel.value) || 0;
        }
        // 路径工具：给一个分类 id 拼出「人物 > 姿势 > 站立」式完整路径
        function parentPathOf(mid) {
            if (!mid) return '';
            const segs = [];
            let cur = menuByIdForPath.get(Number(mid));
            while (cur) {
                segs.unshift(cur.category_name);
                cur = cur.parent_id ? menuByIdForPath.get(Number(cur.parent_id)) : null;
            }
            return segs.join(' > ');
        }
        function updateParentDisplay() {
            const selId = getSelectedParentId();
            if (!selId) {
                parentDisplay.value = '（根级，无上级）';
                return;
            }
            const m = menuByIdForPath.get(selId);
            parentDisplay.value = (m ? (parentPathOf(selId) + '  #' + selId) : '（根级，无上级）');
        }
        function triggerParentChange() {
            // D-31: 改 parent 时重算 sort_order（仅在新增模式下；编辑不动）
            if (!id) {
                const newPid = getSelectedParentId();
                form.querySelector('#cfgMenuSortInp').value = defaultSortFor(newPid);
            }
            checkAncestorConflict();
        }

        // 渲染树到指定容器（模态框打开时调用）
        function renderPickerTree(container) {
            container.innerHTML = '';
            if (!menuItems.length) {
                container.innerHTML = '<div style="font-size:14px;color:#9ca3af;padding:40px;text-align:center;">（暂无分类）</div>';
                return;
            }
            const selId = getSelectedParentId();
            // 默认展开：当前选中项的祖先链（让当前分类可见）
            if (selId) {
                const byIdAuto = new Map(menuItems.map(m => [m.id, m]));
                let cur = byIdAuto.get(selId);
                while (cur && cur.parent_id) {
                    _parentTreeExpanded.add(Number(cur.parent_id));
                    cur = byIdAuto.get(Number(cur.parent_id));
                }
            }
            // 按 parent_id 桶 + 每桶内按 sort_order + id 排序
            const childrenOf = {};
            for (const m of menuItems) {
                const p = m.parent_id || 0;
                (childrenOf[p] = childrenOf[p] || []).push(m);
            }
            for (const k in childrenOf) {
                childrenOf[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            }
            const hasChildrenSet = new Set();
            for (const k in childrenOf) {
                for (const ch of childrenOf[k]) hasChildrenSet.add(ch.id);
            }
            // 创建一行（根级 / 普通）
            function makeRow(id, name, depth, isSel, isDisabled, hasChildren, isExpanded, isRoot) {
                const wrap = document.createElement('div');
                wrap.dataset.catId = String(id);
                wrap.dataset.disabled = isDisabled ? '1' : '0';
                let bg = '';
                if (isSel) bg = 'background:#eef2ff;font-weight:600;';
                wrap.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 24px;font-size:14px;color:' + (isDisabled ? '#9ca3af' : '#374151') + ';cursor:' + (isDisabled ? 'not-allowed' : 'pointer') + ';' + bg;
                if (!isDisabled && !isSel) {
                    wrap.addEventListener('mouseenter', () => { wrap.style.background = '#f3f4f6'; });
                    wrap.addEventListener('mouseleave', () => { wrap.style.background = 'transparent'; });
                }
                wrap.style.paddingLeft = (depth * 20 + 24) + 'px';
                // chevron
                const chev = document.createElement('span');
                chev.dataset.chev = '1';
                chev.style.cssText = 'flex-shrink:0;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;color:#6b7280;font-size:11px;user-select:none;' + (hasChildren ? 'cursor:pointer;' : '');
                chev.textContent = hasChildren ? (isExpanded ? '▼' : '▶') : '';
                wrap.appendChild(chev);
                // 名字
                const lbl = document.createElement('span');
                lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                lbl.textContent = (depth === 0 ? '📁 ' : '') + name + '  #' + id;
                if (isDisabled) lbl.title = '不可选（自己或后代）';
                wrap.appendChild(lbl);
                // 当前标记
                if (isSel) {
                    const tag = document.createElement('span');
                    tag.style.cssText = 'font-size:11px;color:#4f46e5;font-weight:500;flex-shrink:0;';
                    tag.textContent = '✓ 当前';
                    wrap.appendChild(tag);
                }
                return wrap;
            }
            // 根级「（无上级）」
            container.appendChild(makeRow(0, '（根级，无上级）', 0, selId === 0, false, false, false, true));
            // DFS 前序遍历
            const ordered = [];
            (function dfs(pid, depth) {
                for (const ch of childrenOf[pid] || []) {
                    ordered.push({ m: ch, depth });
                    dfs(ch.id, depth + 1);
                }
            })(0, 0);
            for (const { m, depth } of ordered) {
                if (m.parent_id && !_parentTreeExpanded.has(Number(m.parent_id))) continue;
                container.appendChild(makeRow(
                    m.id, m.category_name, depth,
                    Number(m.id) === selId,
                    disabledIds.has(m.id),
                    hasChildrenSet.has(m.id),
                    _parentTreeExpanded.has(m.id),
                    false
                ));
            }
        }

        // 打开大模态框（每次新建、关闭即销毁，无残留监听）
        function openParentPickerModal() {
            // 半透明背景 + 居中大框
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
            const dialog = document.createElement('div');
            dialog.style.cssText = 'background:#fff;border-radius:10px;width:80%;max-width:720px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.35);overflow:hidden;';
            dialog.innerHTML =
                '<div style="padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">' +
                    '<div style="font-size:16px;font-weight:600;color:#111827;">选择上级分类</div>' +
                    '<button type="button" data-picker-close style="background:none;border:none;font-size:24px;cursor:pointer;color:#9ca3af;line-height:1;padding:0;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:4px;transition:background 0.15s;" onmouseover="this.style.background=\'#f3f4f6\'" onmouseout="this.style.background=\'transparent\'">×</button>' +
                '</div>' +
                '<div data-picker-body style="flex:1;overflow-y:auto;padding:8px 0;"></div>' +
                '<div style="padding:10px 20px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;background:#f9fafb;flex-shrink:0;">点击分类行直接选中并关闭 · 「自己及后代」置灰不可选</div>';
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            const body = dialog.querySelector('[data-picker-body]');
            renderPickerTree(body);
            // 单个委托：chevron 优先 → 行选中
            body.addEventListener('click', (ev) => {
                const chev = ev.target.closest('[data-chev="1"]');
                if (chev) {
                    const row = chev.closest('[data-cat-id]');
                    if (!row) return;
                    const id = Number(row.dataset.catId);
                    if (!id) return;
                    if (_parentTreeExpanded.has(id)) _parentTreeExpanded.delete(id);
                    else _parentTreeExpanded.add(id);
                    renderPickerTree(body);
                    return;
                }
                const row = ev.target.closest('[data-cat-id]');
                if (!row) return;
                if (row.dataset.disabled === '1') return;
                const id = Number(row.dataset.catId);
                parentSel.value = String(id);
                updateParentDisplay();
                triggerParentChange();
                overlay.remove();
            });
            // 关闭按钮 + 点背景关闭
            overlay.addEventListener('click', (ev) => {
                if (ev.target === overlay) overlay.remove();
                if (ev.target.closest('[data-picker-close]')) overlay.remove();
            });
        }

        // 唯一监听：点「选择分类」按钮 → 弹大模态框
        parentPickBtn.addEventListener('click', openParentPickerModal);
        // 初始显示文本已在表单 HTML 构建时内联算好（避开 menuByIdForPath 的 TDZ）
        // 后续用户从模态框里选中新分类时，updateParentDisplay() 在 click 回调里被调，那时 menuByIdForPath 已就绪

        // D-42: 互斥分类（直接配对）多选 picker
        //   - chips 区显示已选项（带分类路径 + ×）
        //   - 树状列表显示所有可选项（按 L1 分组，已选 + 自身 + 后代 不可点）
        //   - 切换父级时实时校验 ancestor 冲突
        const exclBox = form.querySelector('#cfgMenuExclBox');
        const exclEmpty = form.querySelector('#cfgMenuExclEmpty');
        const exclTree = form.querySelector('#cfgMenuExclTree');
        const exclWarn = form.querySelector('#cfgMenuExclWarn');
        let selectedExclIds = new Set(parseExclusiveWith(it ? it.exclusive_with : ''));

        // 拿到「本节点 + 所有祖先」id 集合（不可选 — 与本分类或上级分类互斥会产生循环）
        // 用户要求：除了本分类和本分类的上级分类，其他分类（包括后代）都允许选
        const selfAndAncestorIds = new Set();
        if (id) {
            const byIdTmp = new Map(menuItems.map(m => [m.id, m]));
            let cur = byIdTmp.get(Number(id));
            while (cur) {
                selfAndAncestorIds.add(Number(cur.id));
                cur = cur.parent_id ? byIdTmp.get(Number(cur.parent_id)) : null;
            }
        }

        // 分类路径工具：给一个分类，输出「人物 > 姿势 > 站立」这种完整路径
        const menuByIdForPath = new Map(menuItems.map(m => [m.id, m]));
        function pathOf(mid) {
            const m = menuByIdForPath.get(mid);
            if (!m) return '#' + mid;
            const segs = [];
            let cur = m;
            while (cur) {
                segs.unshift(cur.category_name);
                cur = cur.parent_id ? menuByIdForPath.get(cur.parent_id) : null;
            }
            return segs.join(' > ');
        }

        function renderExclChips() {
            Array.from(exclBox.querySelectorAll('.cfgExclChip')).forEach(n => n.remove());
            if (!selectedExclIds.size) { exclEmpty.style.display = ''; return; }
            exclEmpty.style.display = 'none';
            for (const eid of selectedExclIds) {
                const chip = document.createElement('span');
                chip.className = 'cfgExclChip';
                chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 9px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;font-size:12px;color:#4338ca;line-height:1.4;';
                const lbl = document.createElement('span');
                lbl.textContent = pathOf(eid) + ' #' + eid;
                lbl.title = '点击 × 移除';
                chip.appendChild(lbl);
                const x = document.createElement('span');
                x.textContent = '×';
                x.style.cssText = 'cursor:pointer;color:#6366f1;font-weight:700;font-size:14px;line-height:1;padding:0 4px;border-radius:50%;user-select:none;';
                x.addEventListener('mouseenter', () => { x.style.background = '#c7d2fe'; });
                x.addEventListener('mouseleave', () => { x.style.background = 'transparent'; });
                x.addEventListener('click', () => {
                    selectedExclIds.delete(eid);
                    renderExclChips();
                    renderExclTree();
                    checkAncestorConflict();
                });
                chip.appendChild(x);
                exclBox.appendChild(chip);
            }
        }

        // D-43: 互斥分类树的展开/收起状态（默认全部收起；自动展开到已选项的路径）
        const _exclTreeExpanded = new Set();

        function renderExclTree() {
            // 扁平列表 + 缩进（按 DFS 深度）
            // 父未展开就不渲染该行 —— 实现折叠效果
            // 顺序：每个 sibling 组内按 sort_order + id 排序，DFS 前序遍历
            exclTree.innerHTML = '';
            if (!menuItems.length) {
                exclTree.innerHTML = '<div style="font-size:12px;color:#9ca3af;padding:4px;">（暂无分类）</div>';
                return;
            }
            // 自动展开：所有已选项的祖先（让现有选中的分类可见可改）
            const byIdAuto = new Map(menuItems.map(m => [m.id, m]));
            for (const eid of selectedExclIds) {
                let cur = byIdAuto.get(Number(eid));
                while (cur && cur.parent_id) {
                    _exclTreeExpanded.add(Number(cur.parent_id));
                    cur = byIdAuto.get(Number(cur.parent_id));
                }
            }
            // 按 parent_id 桶 + 每桶内按 sort_order + id 排序
            const childrenOf = {};
            for (const m of menuItems) {
                const p = m.parent_id || 0;
                (childrenOf[p] = childrenOf[p] || []).push(m);
            }
            for (const k in childrenOf) {
                childrenOf[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            }
            // 按"是否有子"查表（用于决定是否画 chevron）
            const hasChildrenSet = new Set();
            for (const k in childrenOf) {
                if (k !== '0' || childrenOf[k].length) {
                    for (const ch of childrenOf[k]) hasChildrenSet.add(ch.id);
                }
            }
            // DFS 前序遍历，同时记录 depth
            const ordered = [];   // {m, depth}
            (function dfs(pid, depth) {
                for (const ch of childrenOf[pid] || []) {
                    ordered.push({ m: ch, depth });
                    dfs(ch.id, depth + 1);
                }
            })(0, 0);
            for (const { m, depth } of ordered) {
                // 父未展开就不显示（根级 parent_id=0 永远显示）
                if (m.parent_id && !_exclTreeExpanded.has(Number(m.parent_id))) continue;
                const hasChildren = hasChildrenSet.has(m.id);
                const isExpanded = _exclTreeExpanded.has(m.id);
                const isSelfOrAncestor = selfAndAncestorIds.has(m.id);
                const checked = selectedExclIds.has(m.id);
                const wrap = document.createElement('div');
                wrap.style.cssText = 'display:flex;align-items:center;gap:5px;padding:2px 0 2px ' + (depth * 14) + 'px;font-size:12px;';
                // chevron：有子节点就显示 ▶/▼ 切换
                const chevron = hasChildren
                    ? '<span class="cfgExclChevron" data-id="' + m.id + '" style="flex-shrink:0;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:#9ca3af;font-size:10px;cursor:pointer;user-select:none;">' + (isExpanded ? '▼' : '▶') + '</span>'
                    : '<span style="flex-shrink:0;width:14px;height:14px;display:inline-block;"></span>';
                wrap.innerHTML = chevron;
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.id = 'cfgExclCb_' + m.id;
                cb.value = m.id;
                cb.checked = checked;
                cb.disabled = isSelfOrAncestor;
                cb.style.cssText = 'cursor:' + (isSelfOrAncestor ? 'not-allowed' : 'pointer') + ';flex-shrink:0;';
                cb.addEventListener('change', () => {
                    if (cb.checked) selectedExclIds.add(m.id);
                    else selectedExclIds.delete(m.id);
                    renderExclChips();
                    checkAncestorConflict();
                });
                const lbl = document.createElement('label');
                lbl.htmlFor = 'cfgExclCb_' + m.id;
                const baseColor = isSelfOrAncestor ? '#d1d5db' : (depth === 0 ? '#374151' : '#6b7280');
                const fontWeight = depth === 0 ? ';font-weight:500;' : '';
                lbl.style.cssText = 'cursor:' + (isSelfOrAncestor ? 'not-allowed' : 'pointer') + ';color:' + baseColor + fontWeight + 'user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                lbl.textContent = (depth === 0 ? '📁 ' : (depth === 1 ? '├─ ' : '└─ ')) + m.category_name + '  #' + m.id;
                if (isSelfOrAncestor) lbl.title = '本分类或上级分类，不可互斥（会产生循环）';
                wrap.appendChild(cb);
                wrap.appendChild(lbl);
                exclTree.appendChild(wrap);
            }
            // chevron 点击切换展开
            exclTree.querySelectorAll('.cfgExclChevron').forEach(span => {
                span.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const id = Number(span.getAttribute('data-id'));
                    if (_exclTreeExpanded.has(id)) _exclTreeExpanded.delete(id);
                    else _exclTreeExpanded.add(id);
                    renderExclTree();
                });
            });
        }

        function checkAncestorConflict() {
            exclWarn.style.display = 'none';
            exclWarn.textContent = '';
            if (!selectedExclIds.size) return;
            const newParentId = Number(form.querySelector('#cfgMenuParentSel').value) || 0;
            if (!newParentId) return;
            const byId = new Map(menuItems.map(m => [m.id, m]));
            const conflicts = [];
            let cur = byId.get(newParentId);
            while (cur) {
                if (selectedExclIds.has(cur.id)) conflicts.push({ aid: cur.id, ancName: cur.category_name });
                cur = cur.parent_id ? byId.get(cur.parent_id) : null;
            }
            if (conflicts.length) {
                const msg = conflicts.map(c => '「' + c.ancName + '」(id=' + c.aid + ')').join('、');
                exclWarn.textContent = '⚠ 不可与上级分类互斥：' + msg;
                exclWarn.style.display = '';
            }
        }
        // D-45: parentSel 是 hidden input；改值时由 triggerParentChange() 触发 checkAncestorConflict
        //   （树项点击 / 初始化时都会调）
        renderExclChips();
        renderExclTree();
        checkAncestorConflict();

        form.querySelector('#cfgMenuSaveBtn').addEventListener('click', async () => {
            const name = form.querySelector('#cfgMenuNameInp').value.trim();
            if (!name) { showToast('分类名称不能为空', 'error'); return; }
            // D-42: 拦截与上级分类的互斥冲突
            if (selectedExclIds.size) {
                const newParentId = Number(form.querySelector('#cfgMenuParentSel').value) || 0;
                if (newParentId) {
                    const byId = new Map(menuItems.map(m => [m.id, m]));
                    const conflicts = [];
                    let cur = byId.get(newParentId);
                    while (cur) {
                        if (selectedExclIds.has(cur.id)) conflicts.push({ aid: cur.id, ancName: cur.category_name });
                        cur = cur.parent_id ? byId.get(cur.parent_id) : null;
                    }
                    if (conflicts.length) {
                        const msg = conflicts.map(c => '「' + c.ancName + '」(id=' + c.aid + ')').join('、');
                        showToast('互斥分类冲突：不可与上级分类互斥 ' + msg, 'error');
                        return;
                    }
                }
            }
            const payload = { category_name: name, parent_id: Number(form.querySelector('#cfgMenuParentSel').value)||0, description: form.querySelector('#cfgMenuDescInp').value.trim(), sort_order: Number(form.querySelector('#cfgMenuSortInp').value)||0, is_required: form.querySelector('#cfgMenuReqInp').checked, tag_required: form.querySelector('#cfgMenuTagReqInp').value.trim(), exclusive_with: formatExclusiveWith(Array.from(selectedExclIds)), exclusive_group: formatExclusiveGroup(form.querySelector('#cfgMenuExclGroupInp').value) };
            let r;
            if (menuEditingId) r = await window.api.promptMenu.update({ id: menuEditingId, ...payload });
            else r = await window.api.promptMenu.add(payload);
            if (r.ok) {
                showToast(menuEditingId ? '修改成功' : '添加成功', 'success');
                await loadMenu();
                // D-31-r2: 新增保存后 → 连续新增模式（保留 parent + sort+1，清 name/desc/req）
                // 编辑保存后 → 重新打开刚保存的分类，回显所有字段（包括 exclusive_with）
                if (menuEditingId) {
                    _lastCreateParentId = 0;
                    showMenuForm(menuEditingId);
                } else {
                    _lastCreateParentId = payload.parent_id;
                    showMenuForm(null, { defaultParentId: _lastCreateParentId, keepCreating: true });
                }
            }
            else showToast(r.error||'操作失败', 'error');
        });
        form.querySelector('#cfgMenuCancelBtn').addEventListener('click', () => { document.getElementById('cfgMenuForm').style.display='none'; document.getElementById('cfgMenuEmpty').style.display='block'; menuEditingId = null; _lastCreateParentId = 0; });
        if (id) {
            form.querySelector('#cfgMenuDelBtn').addEventListener('click', async () => {
                if (!confirm('删除分类会同时删除其所有子分类，确定删除？')) return;
                const r = await window.api.promptMenu.delete(id);
                if (r.ok) { showToast('已删除（'+r.deleted+'项）', 'success'); await loadMenu(); showMenuForm(null); }
                else showToast(r.error||'删除失败', 'error');
            });
        }
    }

    // ===================== 提示词配置 =====================
    async function loadItemTree() {
        await loadMenu();
        renderItemTree();
        // 默认自动选中第一个分类
        if (menuItems.length) {
            const byParent = {};
            for (const it of menuItems) { const p = it.parent_id||0; (byParent[p] = byParent[p]||[]).push(it); }
            for (const k in byParent) byParent[k].sort((a,b) => (a.sort_order||0)-(b.sort_order||0)||a.id-b.id);
            function firstId(pid) {
                const children = byParent[pid]||[];
                return children.length ? firstId(children[0].id) : pid;
            }
            const firstCatId = firstId(0);
            if (firstCatId) { currentItemCatId = firstCatId; await loadItemList(firstCatId); }
        }
    }

    function renderItemTree() {
        const el = document.getElementById('cfgItemTree');
        if (!el) return;
        el.innerHTML = '';
        if (!menuItems.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:6px 4px;">暂无分类</div>'; return; }
        const byParent = {};
        for (const it of menuItems) { const p = it.parent_id||0; (byParent[p] = byParent[p]||[]).push(it); }
        for (const k in byParent) byParent[k].sort((a,b) => (a.sort_order||0)-(b.sort_order||0)||a.id-b.id);
        function walk(pid, depth) {
            const children = byParent[pid]||[];
            for (const it of children) {
                const div = document.createElement('div');
                const isSel = currentItemCatId === it.id;
                div.style.cssText = 'padding:5px 6px;border-radius:6px;cursor:pointer;margin-bottom:1px;display:flex;align-items:center;gap:5px;' + (isSel ? 'background:#ede9fe;color:#6d28d9;font-weight:500;' : '');
                if (!isSel) {
                    div.addEventListener('mouseenter', () => { div.style.background = '#ede9fe'; });
                    div.addEventListener('mouseleave', () => { div.style.background = 'transparent'; });
                }
                div.innerHTML = '<span style="color:#d1d5db;font-size:11px;margin-left:' + (depth*14) + 'px;display:inline-block;width:10px;"></span><i class="fa-solid fa-folder' + (it.parent_id ? '-open' : '') + '" style="color:' + (it.parent_id ? '#f59e0b' : '#6366f1') + ';font-size:11px;"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.category_name) + '</span>' + (it.is_required ? '<span title="必选" style="flex-shrink:0;width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;margin-left:2px;"></span>' : '');
                div.title = it.description || it.category_name;
                div.addEventListener('click', async () => { currentItemCatId = it.id; _lastCreateItemCatId = 0; renderItemTree(); await loadItemList(it.id); });
                el.appendChild(div);
                walk(it.id, depth+1);
            }
        }
        walk(0, 0);
    }

    async function loadItemList(catId) {
        const r = await window.api.promptItems.list(catId);
        const items = r.ok ? r.items : [];
        const catName = (menuItems.find(x=>x.id===catId)||{}).category_name || '';
        const listEl = document.getElementById('cfgItemList');
        const wrap = document.getElementById('cfgItemFormWrap');
        listEl.innerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;"><i class="fa-solid fa-tag" style="color:#6366f1;font-size:12px;"></i><span style="font-size:13px;font-weight:600;color:#374151;">' + esc(catName) + '</span><span style="font-size:11px;color:#9ca3af;">(' + items.length + '项)</span></div>';
        const chips = document.createElement('div');
        chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
        if (!items.length) {
            chips.innerHTML = '<span style="font-size:12px;color:#d1d5db;">（暂无数据，点「新增」添加）</span>';
        }
        for (const it of items) {
            const chip = document.createElement('div');
            chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 10px 6px 12px;border-radius:14px;cursor:pointer;user-select:none;font-size:12px;border:1px solid #d1d5db;background:#fff;color:#374151;';
            chip.innerHTML = '<span style="font-weight:500;">' + esc(it.name) + '</span>';
            chip.title = (it.content||'') + (it.description ? '\n\n说明：'+it.description : '');
            chip.addEventListener('click', () => showItemForm(it.id, catId));
            chips.appendChild(chip);
        }
        listEl.appendChild(chips);
        wrap.style.display = 'none';
        wrap.innerHTML = '';
    }

    // D-31-r3: 提示词表单 —— 树形分类下拉 + 默认 cat + 默认 sort + 「连续新增」模式
    //   opts.defaultCatId —— 新增时希望默认选中的 cat（来自 cfgAddBtn 透传）
    //   opts.keepCreating  —— 「连续新增」模式：清 name/content/desc，保留 cat + sort+1
    function showItemForm(id, opts) {
        opts = opts || {};
        itemEditingId = id;
        const wrap = document.getElementById('cfgItemFormWrap');
        wrap.style.display = 'block';
        const keepCreating = !id && !!opts.keepCreating;
        const allItems = [];
        // 预览图状态：fileName=已上传文件名；dataUrl=用户刚选的图 base64；removed=点了「清除」
        const _pv = { fileName: '', dataUrl: '', mime: '', removed: false };
        (async () => {
            if (currentItemCatId) {
                const r = await window.api.promptItems.list(currentItemCatId);
                if (r.ok) allItems.push(...r.items);
            }
            const it = id ? allItems.find(x=>x.id===id)||{category_id:opts.defaultCatId||currentItemCatId||0} : {category_id:opts.defaultCatId||currentItemCatId||0};

            // ---- 树形 catOptions（与 showMenuForm 同步：pid_list 算深度 + ├─/└─ + 全角空格）----
            function depthOf(node) {
                const pl = node.pid_list || '/';
                if (pl === '/' || pl === '') return 0;
                return Math.max(0, (pl.match(/\//g) || []).length - 2);
            }
            const byParent = {};
            for (const x of menuItems) { const p = x.parent_id || 0; (byParent[p] = byParent[p] || []).push(x); }
            for (const k in byParent) byParent[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            const siblingIdx = {};
            for (const k in byParent) {
                const arr = byParent[k];
                arr.forEach((node, i) => { siblingIdx[node.id] = { index: i, isLast: i === arr.length - 1 }; });
            }
            // 决定默认选中：编辑用 it.category_id；新增用 opts.defaultCatId || currentItemCatId || 0
            const defaultCatId = it.category_id || 0;
            // DFS 拍平
            const flatOrdered = [];
            function dfs(pid) { for (const ch of (byParent[pid] || [])) { flatOrdered.push(ch); dfs(ch.id); } }
            dfs(0);
            // 渲染每个 option（深度 + 字符连接符 + selected）
            function renderCatOption(x) {
                const depth = depthOf(x);
                const indent = '　　'.repeat(Math.max(0, depth));
                const prefix = depth === 0 ? '' : (siblingIdx[x.id].isLast ? '└─ ' : '├─ ');
                const sel = (Number(x.id) === Number(defaultCatId)) ? ' selected' : '';
                return '<option value="' + x.id + '"' + sel + '>' + indent + prefix + esc(x.category_name) + '</option>';
            }
            const catOptionsHtml = flatOrdered.map(renderCatOption).join('') || '<option value="0" disabled>（暂无分类）</option>';

            // ---- 「同级 max+1」sort 计算 ----
            // item 的"同级"=同一 category_id 下的所有 item
            function defaultSortForItem(catId) {
                if (!catId) return 0;
                const sibs = allItems.filter(x => (x.category_id || 0) === catId);
                if (!sibs.length) return 0;
                return Math.max(...sibs.map(s => s.sort_order || 0)) + 1;
            }
            // 编辑保留原值；新增按 defaultCatId 算
            const defaultSort = id
                ? (it.sort_order || 0)
                : defaultSortForItem(defaultCatId);

            wrap.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;border-top:1px solid #f3f4f6;padding-top:12px;"><span style="font-size:14px;font-weight:500;color:#374151;">' + (id ? '编辑提示词' : (keepCreating ? '新增提示词 <span style="font-size:11px;color:#059669;font-weight:400;margin-left:6px;">· 连续新增模式</span>' : '新增提示词')) + '</span>' + (id ? '<button id="cfgItemDelBtn" class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;margin-left:auto;"><i class="fa-solid fa-trash"></i> 删除</button>' : '') + '</div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">所属分类 *</label><select id="cfgItemCatSel" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#fff;font-family:inherit;">' + catOptionsHtml + '</select>' + (keepCreating ? '<div style="font-size:11px;color:#059669;margin-top:3px;">· 保持上次选择的分类；改这里会重算排序</div>' : '') + '</div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">提示词名称 *</label><input id="cfgItemNameInp" type="text" value="' + esc((id || !keepCreating) ? (it.name||'') : '') + '" placeholder="如：柔光、暖色调' + (keepCreating ? '（保存后保持此位置，可连着输入下一个）' : '') + '" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;box-sizing:border-box;' + (keepCreating ? 'border-color:#10b981;' : '') + '"></div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">内容</label><textarea id="cfgItemContentInp" rows="2" placeholder="提示词正文内容" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc((id || !keepCreating) ? (it.content||'') : '') + '</textarea></div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">说明</label><textarea id="cfgItemDescInp" rows="2" placeholder="可选，说明此提示词的用途或效果" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc((id || !keepCreating) ? (it.description||'') : '') + '</textarea></div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">敏感度</label><select id="cfgItemSensSel" style="width:160px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#fff;"><option value="sfw"' + (((id || !keepCreating) ? (it.sensitivity||'nsfw') : 'nsfw')==='sfw'?' selected':'') + '>SFW （安全）</option><option value="nsfw"' + (((id || !keepCreating) ? (it.sensitivity||'nsfw') : 'nsfw')==='nsfw'?' selected':'') + '>NSFW （成人）</option></select><span style="font-size:11px;color:#9ca3af;margin-left:8px;">默认 NSFW</span></div>' +
                '<div style="margin-bottom:12px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">排序权重</label><input id="cfgItemSortInp" type="number" value="' + defaultSort + '" min="0" style="width:120px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;' + (keepCreating ? 'border-color:#10b981;' : '') + '"><span style="font-size:11px;color:#9ca3af;margin-left:6px;">越小越靠前' + (id ? '' : ' · 新增自动取同级最大 +1') + '</span></div>' +
                '<div style="margin-bottom:12px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">预览图 <span style="color:#9ca3af;font-weight:400;">（可选，仅 1 张，jpg/png/webp，≤2MB）</span></label><div style="display:flex;gap:10px;align-items:center;"><div id="cfgItemPvThumb" style="width:160px;height:90px;border:1px dashed #d1d5db;border-radius:6px;background:#f9fafb center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px;">暂无预览图</div><div style="display:flex;flex-direction:column;gap:6px;"><input id="cfgItemPvFile" type="file" accept="image/jpeg,image/png,image/webp" style="font-size:12px;max-width:220px;"><button id="cfgItemPvClearBtn" type="button" class="btn btn-sm" style="display:none;background:#fee2e2;color:#dc2626;border:1px solid #fecaca;"><i class="fa-solid fa-xmark"></i> 清除预览图</button></div></div></div>' +
                '<div style="display:flex;gap:8px;"><button id="cfgItemSaveBtn" class="btn btn-sm btn-primary"><i class="fa-solid fa-floppy-disk"></i> 保存' + (keepCreating ? '并继续' : '') + '</button><button id="cfgItemCancelBtn" class="btn btn-sm cfgHoverBtn">取消</button></div>';

            // ---- 预览图：编辑模式拉已有；新增模式清空 ----
            const pvThumb = wrap.querySelector('#cfgItemPvThumb');
            const pvFile = wrap.querySelector('#cfgItemPvFile');
            const pvClearBtn = wrap.querySelector('#cfgItemPvClearBtn');
            const _setPvThumb = (dataUrl, hasImage) => {
                if (hasImage) {
                    pvThumb.style.backgroundImage = 'url(' + dataUrl + ')';
                    pvThumb.textContent = '';
                } else {
                    pvThumb.style.backgroundImage = '';
                    pvThumb.textContent = '暂无预览图';
                }
            };
            if (id) {
                const cur = allItems.find(x => x.id === id);
                const fn = (cur && cur.preview_image) || '';
                if (fn) {
                    window.api.promptPreview.read({ fileName: fn }).then(r => {
                        if (r && r.ok) {
                            _pv.fileName = fn;
                            _setPvThumb(r.dataUrl, true);
                            pvClearBtn.style.display = '';
                        } else {
                            _setPvThumb(null, false);
                        }
                    });
                } else {
                    _setPvThumb(null, false);
                }
            } else {
                _setPvThumb(null, false);
            }
            pvFile.addEventListener('change', async () => {
                const f = pvFile.files && pvFile.files[0];
                if (!f) return;
                if (f.size > 2 * 1024 * 1024) {
                    showToast('预览图不能超过 2MB', 'error');
                    pvFile.value = '';
                    return;
                }
                if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
                    showToast('仅支持 jpg / png / webp', 'error');
                    pvFile.value = '';
                    return;
                }
                try {
                    const r = await window._compressImageToBase64(f, 100 * 1024);
                    _pv.dataUrl = r.dataBase64;
                    _pv.mime = r.mime;
                    _pv.removed = false;
                    _setPvThumb('data:' + r.mime + ';base64,' + r.dataBase64, true);
                    pvClearBtn.style.display = '';
                    if (r.compressed) {
                        showToast(`已压缩：${(r.originalSize/1024).toFixed(0)}KB → ${(r.finalSize/1024).toFixed(0)}KB`, 'success');
                    }
                } catch (e) {
                    showToast('图片处理失败: ' + (e && e.message || e), 'error');
                    pvFile.value = '';
                }
            });
            pvClearBtn.addEventListener('click', () => {
                _pv.fileName = '';
                _pv.dataUrl = '';
                _pv.removed = true;
                _setPvThumb(null, false);
                pvClearBtn.style.display = 'none';
                pvFile.value = '';
            });

            // 改 cat 时重算 sort（仅新增）
            const catSel = wrap.querySelector('#cfgItemCatSel');
            if (!id) {
                catSel.addEventListener('change', () => {
                    const newCatId = Number(catSel.value) || 0;
                    // 拉一下该 cat 下的 items（可能要补一次 list 调用）
                    window.api.promptItems.list(newCatId).then(rr => {
                        const sibs = (rr.ok && rr.items) ? rr.items : [];
                        let ns = 0;
                        if (sibs.length) ns = Math.max(...sibs.map(s => s.sort_order || 0)) + 1;
                        wrap.querySelector('#cfgItemSortInp').value = ns;
                    });
                });
            }

            wrap.querySelector('#cfgItemSaveBtn').addEventListener('click', async () => {
                const name = wrap.querySelector('#cfgItemNameInp').value.trim();
                if (!name) { showToast('提示词名称不能为空', 'error'); return; }
                const payload = { name, category_id: Number(wrap.querySelector('#cfgItemCatSel').value)||0, content: wrap.querySelector('#cfgItemContentInp').value.trim(), description: wrap.querySelector('#cfgItemDescInp').value.trim(), sort_order: Number(wrap.querySelector('#cfgItemSortInp').value)||0, sensitivity: wrap.querySelector('#cfgItemSensSel').value };
                let r;
                if (itemEditingId) r = await window.api.promptItems.update({ id: itemEditingId, ...payload });
                else r = await window.api.promptItems.add(payload);
                if (!r.ok) { showToast(r.error||'操作失败', 'error'); return; }

                // ---- 预览图后处理 ----
                const newId = itemEditingId || r.id;
                if (_pv.removed) {
                    // 清除预览图（仅编辑模式有意义；新增模式本来就没图）
                    await window.api.promptItems.update({ id: newId, preview_clear: true });
                } else if (_pv.dataUrl) {
                    // 上传新图
                    const up = await window.api.promptPreview.upload({
                        mime: _pv.mime,
                        dataBase64: _pv.dataUrl,
                        itemId: newId,
                    });
                    if (up && up.ok) {
                        await window.api.promptItems.update({ id: newId, preview_file: up.fileName });
                    } else if (up && up.error) {
                        showToast('预览图上传失败: ' + up.error, 'error');
                    }
                }

                showToast(itemEditingId ? '修改成功' : '添加成功', 'success');
                await loadItemList(currentItemCatId);
                // D-31-r3: 新增保存后 → 连续新增（保留 cat + sort+1）
                if (itemEditingId) {
                    _lastCreateItemCatId = 0;
                    showItemForm(null);
                } else {
                    _lastCreateItemCatId = payload.category_id;
                    showItemForm(null, { defaultCatId: _lastCreateItemCatId, keepCreating: true });
                }
            });
            wrap.querySelector('#cfgItemCancelBtn').addEventListener('click', () => { wrap.style.display='none'; wrap.innerHTML=''; itemEditingId = null; _lastCreateItemCatId = 0; });
            if (id) {
                wrap.querySelector('#cfgItemDelBtn').addEventListener('click', async () => {
                    if (!confirm('确定删除此提示词？')) return;
                    const r = await window.api.promptItems.delete(id);
                    if (r.ok) { showToast('已删除', 'success'); itemEditingId = null; _lastCreateItemCatId = 0; await loadItemList(currentItemCatId); showItemForm(null); }
                    else showToast(r.error||'删除失败', 'error');
                });
            }
        })();
    }

    // ---- 初始化：加载分类配置 ----
    await loadMenu();
    // 默认打开分类配置 Tab（Tab=menu）；settings.js 透传 initialTab 直接落到对应子模块
    switchTab(initialTab);
}
// ========== toast ==========
    function showToast(msg, type) {
        const c = document.getElementById('toast-container');
        if (!c) { console.log('[toast]', msg); return; }
        const t = document.createElement('div');
        t.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => t.classList.add('show'), 10);
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
    }

    // ========== D-35: 拼装规则面板 ==========
    // 渲染拼装规则面板：左侧可选任意 depth 分类树 + 右侧有序选择列表
    function renderRulePane() {
        // 拉最新规则（从主进程再次确认）
        const availEl = document.getElementById('cfgRuleAvailable');
        const selEl = document.getElementById('cfgRuleSelected');
        if (!availEl || !selEl) return;
        // D-40: 不再只过滤 L1 — 列出全部 depth 的分类，按 sort_order + id 稳定排序
        // UI 通过 prefix (L1/L2/L3 徽标 + 缩进) 体现层级
        const allCats = Array.from(_menuById.values())
            .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
        // 已选 menuId 集合（保持顺序）
        const selected = Array.isArray(_assembleRule) ? _assembleRule.slice() : [];
        const selectedIds = new Set(selected.map(r => r.menuId));
        _renderRuleAvailable(availEl, allCats, selectedIds);
        _renderRuleSelected(selEl, selected);
        // D-35 fix: saveBtn/clearBtn 在 cfgRulePane DOM 里，首次进入 rule tab 时绑一次
        _bindRuleButtons();
    }

    // 计算每个分类的 depth（祖先链长度），用于 UI 缩进和 L1/L2/L3 徽标
    function _depthOf(cat, menuById, cache) {
        if (cache.has(cat.id)) return cache.get(cat.id);
        if (!cat.parent_id || cat.parent_id === 0) {
            cache.set(cat.id, 0);
            return 0;
        }
        const parent = menuById.get(cat.parent_id);
        if (!parent) {
            cache.set(cat.id, 0);
            return 0;
        }
        const d = _depthOf(parent, menuById, cache) + 1;
        cache.set(cat.id, d);
        return d;
    }

    function _renderRuleAvailable(host, allCats, selectedIds) {
        host.innerHTML = '';
        if (!allCats.length) {
            host.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:8px 0;">暂无分类</div>';
            return;
        }
        const depthCache = new Map();
        for (const cat of allCats) {
            const isSel = selectedIds.has(cat.id);
            const depth = _depthOf(cat, _menuById, depthCache);
            const depthLabel = depth === 0 ? 'L1' : depth === 1 ? 'L2' : 'L3';
            const indent = depth * 16;  // 每级缩进 16px
            const icon = depth === 0 ? 'fa-layer-group' : depth === 1 ? 'fa-folder-tree' : 'fa-tag';
            const color = depth === 0 ? '#6366f1' : depth === 1 ? '#0ea5e9' : '#94a3b8';
            const item = document.createElement('div');
            item.style.cssText = `padding:6px 10px 6px ${10 + indent}px;margin-bottom:3px;border-radius:5px;cursor:${isSel ? 'default' : 'pointer'};font-size:12px;background:${isSel ? '#f3f4f6' : '#fff'};border:1px solid ${isSel ? '#e5e7eb' : 'transparent'};color:${isSel ? '#9ca3af' : '#1f2937'};display:flex;align-items:center;justify-content:space-between;transition:background 0.1s;`;
            item.innerHTML = `<span style="display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><span style="font-size:9px;font-weight:700;color:${color};background:${color}15;padding:1px 4px;border-radius:3px;flex-shrink:0;">${depthLabel}</span><i class="fa-solid ${icon}" style="color:${isSel ? '#9ca3af' : color};font-size:10px;flex-shrink:0;"></i><span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(cat.category_name || cat.name || ('分类 #' + cat.id))}</span></span>${isSel ? '<i class="fa-solid fa-check" style="color:#9ca3af;font-size:10px;flex-shrink:0;"></i>' : '<i class="fa-solid fa-plus" style="color:#d1d5db;font-size:10px;flex-shrink:0;"></i>'}`;
            if (!isSel) {
                item.addEventListener('mouseenter', () => { item.style.background = '#f9fafb'; item.style.borderColor = '#e5e7eb'; });
                item.addEventListener('mouseleave', () => { item.style.background = '#fff'; item.style.borderColor = 'transparent'; });
                item.addEventListener('click', () => {
                    if (!_assembleRule) _assembleRule = [];
                    _assembleRule.push({ menuId: cat.id, sortOrder: _assembleRule.length });
                    renderRulePane();
                });
            }
            host.appendChild(item);
        }
    }

    function _renderRuleSelected(host, selected) {
        host.innerHTML = '';
        if (!selected.length) {
            host.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:8px 0;text-align:center;">还没选顺序。左边点 + 加进这里。</div>';
            return;
        }
        const depthCache = new Map();
        for (let i = 0; i < selected.length; i++) {
            const r = selected[i];
            const cat = _menuById.get(r.menuId);
            const depth = cat ? _depthOf(cat, _menuById, depthCache) : 0;
            const depthLabel = depth === 0 ? 'L1' : depth === 1 ? 'L2' : 'L3';
            const color = depth === 0 ? '#6366f1' : depth === 1 ? '#0ea5e9' : '#94a3b8';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:6px;border-radius:6px;background:#eef2ff;border:1px solid #c7d2fe;font-size:13px;';
            row.innerHTML = `
                <span style="background:#6366f1;color:#fff;border-radius:4px;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;flex-shrink:0;">${i + 1}</span>
                <span style="font-size:9px;font-weight:700;color:${color};background:${color}15;padding:1px 4px;border-radius:3px;flex-shrink:0;">${depthLabel}</span>
                <span style="flex:1;color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><i class="fa-solid ${depth === 0 ? 'fa-layer-group' : depth === 1 ? 'fa-folder-tree' : 'fa-tag'}" style="color:${color};margin-right:6px;font-size:11px;"></i>${escapeHtml(cat ? (cat.category_name || cat.name || ('分类 #' + cat.id)) : '已删除分类 #' + r.menuId)}</span>
                <button class="cfgRuleUp" data-idx="${i}" style="background:transparent;border:none;cursor:pointer;color:#6366f1;padding:2px 6px;" title="上移"><i class="fa-solid fa-arrow-up"></i></button>
                <button class="cfgRuleDown" data-idx="${i}" style="background:transparent;border:none;cursor:pointer;color:#6366f1;padding:2px 6px;" title="下移"><i class="fa-solid fa-arrow-down"></i></button>
                <button class="cfgRuleRemove" data-idx="${i}" style="background:transparent;border:none;cursor:pointer;color:#dc2626;padding:2px 6px;" title="删除"><i class="fa-solid fa-xmark"></i></button>
            `;
            host.appendChild(row);
        }
        // 事件绑定（一次性委托到 host）
        host.onclick = (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const idx = parseInt(btn.getAttribute('data-idx'), 10);
            if (isNaN(idx)) return;
            if (btn.classList.contains('cfgRuleUp')) {
                if (idx > 0) {
                    const tmp = _assembleRule[idx - 1];
                    _assembleRule[idx - 1] = _assembleRule[idx];
                    _assembleRule[idx] = tmp;
                    renderRulePane();
                }
            } else if (btn.classList.contains('cfgRuleDown')) {
                if (idx < _assembleRule.length - 1) {
                    const tmp = _assembleRule[idx + 1];
                    _assembleRule[idx + 1] = _assembleRule[idx];
                    _assembleRule[idx] = tmp;
                    renderRulePane();
                }
            } else if (btn.classList.contains('cfgRuleRemove')) {
                _assembleRule.splice(idx, 1);
                renderRulePane();
            }
        };
    }

    // escapeHtml 工具（部分模块可能已有，为防体重名加个 IIFE 局部版）
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    // 跟其他模块（ai-tools.js / settings.js）保持一致：escapeAttr 是 escapeHtml 的别名
    // 之前没定义，新代码里 `data-id="${escapeAttr(rec.id)}"` 会 ReferenceError 让列表渲染挂掉
    function escapeAttr(s) { return escapeHtml(s);
    }

    // 拼装规则面板的保存/清空按钮绑定（只绑一次）
    // D-35 fix: cfgRuleSaveBtn/clearBtn 在 cfg 弹框 DOM 里，IIFE 顶层执行时还没创建
    //   不能直接 .addEventListener() — 会拋 Cannot read properties of null
    //   改成：openConfigModal() 里调 _bindRuleButtons()
    function _bindRuleButtons() {
        const saveBtn = document.getElementById('cfgRuleSaveBtn');
        const clearBtn = document.getElementById('cfgRuleClearBtn');
        if (!saveBtn || !clearBtn) return;
        if (saveBtn.dataset.bound === '1') return;  // 防重复绑
        saveBtn.dataset.bound = '1';
        clearBtn.dataset.bound = '1';
        saveBtn.addEventListener('click', async () => {
            const r = await api.assembleRule.set(_assembleRule || []);
            if (r && r.ok) {
                showToast('拼装规则已保存', 'success');
                liveAssembleAndUpdate();
            } else {
                showToast('保存失败：' + (r && r.error || '未知错误'), 'error');
            }
        });
        clearBtn.addEventListener('click', () => {
            _assembleRule = [];
            renderRulePane();
            liveAssembleAndUpdate();
        });
    }

    // ========== D-40: 场景模板面板 ==========
    // 注：openConfigModal 内的局部 esc() 在 IIFE 顶层访问不到，
    // 这里用顶层已有的 escapeHtml 做别名。
    const esc = escapeHtml;
    let _sceneTemplates = [];   // 缓存，避免重复 IPC
    let _sceneLoaded = false;

    async function renderScenePane(force) {
        const host = document.getElementById('cfgSceneList');
        if (!host) return;
        if (!force && _sceneLoaded) {
            _renderSceneList(host, _sceneTemplates);
            return;
        }
        host.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:40px 0;font-size:13px;"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';
        const r = await window.api.sceneTemplateList();
        if (!r || !r.ok) {
            host.innerHTML = '<div style="color:#dc2626;text-align:center;padding:40px 0;font-size:13px;">加载失败：' + esc((r && r.error) || '未知') + '</div>';
            console.warn('[scenePane] IPC 失败:', r);
            return;
        }
        _sceneTemplates = r.rows || [];
        _sceneLoaded = true;
        console.log('[scenePane] 加载 ' + _sceneTemplates.length + ' 个场景模板');
        _renderSceneList(host, _sceneTemplates);
    }

    function _renderSceneList(host, rows) {
        const totalEl = document.getElementById('cfgSceneCount');
        const enabledEl = document.getElementById('cfgSceneEnabledCount');
        if (totalEl) totalEl.textContent = String(rows.length);
        if (enabledEl) enabledEl.textContent = String(rows.filter(r => r.enabled).length);
        if (!rows.length) {
            host.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:40px 0;font-size:13px;">暂无场景模板</div>';
            return;
        }
        host.innerHTML = '';
        for (const t of rows) {
            const itemIds = Array.isArray(t.item_ids) ? t.item_ids : [];
            const descPreview = (t.description || '').split(String.fromCharCode(10))[0].slice(0, 80);
            const card = document.createElement('div');
            card.style.cssText = `padding:12px 14px;margin-bottom:10px;border-radius:8px;background:${t.enabled ? '#fff' : '#f9fafb'};border:1px solid ${t.enabled ? '#e5e7eb' : '#e5e7eb'};opacity:${t.enabled ? '1' : '0.7'};display:flex;align-items:flex-start;gap:12px;transition:all 0.1s;`;
            card.innerHTML = `
                <label style="display:inline-flex;align-items:center;cursor:pointer;flex-shrink:0;margin-top:2px;" title="${t.enabled ? '已启用，点击禁用' : '已禁用，点击启用'}">
                    <input type="checkbox" class="cfgSceneToggle" ${t.enabled ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;accent-color:#6366f1;">
                </label>
                <div style="flex:1;min-width:0;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                        <span style="font-size:13px;font-weight:600;color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.name)}</span>
                        <span style="font-size:10px;color:#6b7280;background:#f3f4f6;padding:1px 6px;border-radius:3px;flex-shrink:0;">${esc(t.source || 'manual')}</span>
                        <span style="font-size:10px;color:#9ca3af;flex-shrink:0;">${itemIds.length} 项</span>
                    </div>
                    <div style="font-size:11px;color:#6b7280;line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${esc(descPreview)}${(t.description || '').length > 80 ? '...' : ''}</div>
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0;">
                    <button class="cfgSceneEdit btn btn-sm" style="background:#eef2ff;color:#6366f1;border:1px solid #c7d2fe;font-size:11px;padding:4px 10px;" title="编辑"><i class="fa-solid fa-pen"></i></button>
                    <button class="cfgSceneDel btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;font-size:11px;padding:4px 10px;" title="删除"><i class="fa-solid fa-trash"></i></button>
                </div>
            `;
            // 启用切换
            card.querySelector('.cfgSceneToggle').addEventListener('change', async (e) => {
                const enabled = e.target.checked;
                const r = await window.api.sceneTemplateToggleEnabled({ id: t.id, enabled });
                if (r && r.ok) {
                    t.enabled = r.enabled;
                    _renderSceneList(host, _sceneTemplates);
                    showToast(t.enabled ? '已启用' : '已禁用', 'success');
                } else {
                    e.target.checked = !enabled;  // 回滚
                    showToast('操作失败：' + ((r && r.error) || '未知'), 'error');
                }
            });
            // 编辑
            card.querySelector('.cfgSceneEdit').addEventListener('click', () => editSceneTemplate(t));
            // 删除
            card.querySelector('.cfgSceneDel').addEventListener('click', async () => {
                if (!confirm(`确认删除场景模板「${t.name}」？此操作不可恢复。`)) return;
                const r = await window.api.sceneTemplateDelete({ id: t.id });
                if (r && r.ok) {
                    _sceneTemplates = _sceneTemplates.filter(x => x.id !== t.id);
                    _renderSceneList(host, _sceneTemplates);
                    showToast('已删除', 'success');
                } else {
                    showToast('删除失败：' + ((r && r.error) || '未知'), 'error');
                }
            });
            host.appendChild(card);
        }
    }

    // ========== D-40: 场景模板 item_ids 选择器 ==========
    // 3 列布局：分类树 | items 列表 | 已选 chips
    // 顶部搜索框：跨分类过滤 items
    // 异步加载 categories + itemsAll（listAll 一次拉全）
    async function pickSceneItems(initialIds, onConfirm) {
        // 清掉旧 picker
        const old = document.getElementById('scenePickerModal');
        if (old) old.remove();

        // 1) 拉全量数据
        const [catResp, itemResp] = await Promise.all([
            window.api.promptMenu.list(),
            window.api.promptItems.listAll(),
        ]);
        if (!catResp || !catResp.ok) { showToast('分类加载失败', 'error'); return; }
        if (!itemResp || !itemResp.ok) { showToast('提示词加载失败', 'error'); return; }

        const allCats = (catResp.items || catResp.menu || []).filter(c => c && c.id != null);
        const allItems = (itemResp.items || []);

        // 2) 按 category_id 索引 items
        const itemsByCat = new Map();
        for (const it of allItems) {
            const cid = it.category_id;
            if (!itemsByCat.has(cid)) itemsByCat.set(cid, []);
            itemsByCat.get(cid).push(it);
        }

        // 3) 构造 tree：L1 → L2 → L3，idx by id
        const catById = new Map(allCats.map(c => [c.id, c]));
        const childrenOf = (pid) => allCats.filter(c => (c.parent_id || 0) === (pid || 0))
            .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);

        // 4) DOM 构造
        const overlay = document.createElement('div');
        overlay.id = 'scenePickerModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10001;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:10px;width:880px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,0.3);font-family:system-ui,-apple-system,sans-serif;overflow:hidden;">
                <div style="padding:12px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px;background:#f9fafb;">
                    <span style="font-size:14px;font-weight:600;color:#1f2937;"><i class="fa-solid fa-list-check" style="color:#6366f1;margin-right:6px;"></i>选择提示词</span>
                    <input id="scenePickerSearch" type="text" placeholder="搜索提示词名称（跨分类）..." style="flex:1;padding:6px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:5px;margin-left:10px;">
                    <span id="scenePickerCount" style="font-size:12px;color:#059669;font-weight:600;">已选 0 项</span>
                    <button id="scenePickerClear" class="cfgHoverBtn" style="font-size:11px;padding:3px 8px;" title="清空已选"><i class="fa-solid fa-eraser"></i> 清空</button>
                    <button id="scenePickerClose" style="background:transparent;border:none;cursor:pointer;color:#6b7280;font-size:16px;margin-left:4px;"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div style="display:flex;flex:1;min-height:0;overflow:hidden;">
                    <!-- 左：分类树 -->
                    <div id="scenePickerTree" style="width:220px;border-right:1px solid #e5e7eb;overflow-y:auto;padding:8px 6px;background:#fafafa;font-size:12px;"></div>
                    <!-- 中：items 列表 -->
                    <div id="scenePickerItems" style="flex:1;overflow-y:auto;padding:10px 14px;background:#fff;"></div>
                    <!-- 右：已选 chips -->
                    <div style="width:220px;border-left:1px solid #e5e7eb;display:flex;flex-direction:column;background:#fafafa;">
                        <div style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;color:#374151;background:#fff;">已选提示词</div>
                        <div id="scenePickerSelected" style="flex:1;overflow-y:auto;padding:8px 10px;"></div>
                    </div>
                </div>
                <div style="padding:10px 18px;border-top:1px solid #e5e7eb;background:#fafafa;display:flex;justify-content:flex-end;gap:8px;">
                    <button id="scenePickerCancel" class="cfgHoverBtn">取消</button>
                    <button id="scenePickerConfirm" class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-check"></i> 确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // 5) 状态
        const state = {
            selectedIds: new Set((initialIds || []).map(x => Number(x)).filter(x => x > 0)),
            currentCatId: null,  // null = 显示搜索结果或全部分类首项
            searchTerm: '',
        };

        // ---- 渲染：分类树 ----
        function renderTree() {
            const host = document.getElementById('scenePickerTree');
            if (!host) return;
            host.innerHTML = '';
            // 添加"全部"项
            const allLi = document.createElement('div');
            allLi.style.cssText = `padding:5px 8px;margin-bottom:4px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;color:${state.currentCatId === null && !state.searchTerm ? '#6366f1' : '#1f2937'};background:${state.currentCatId === null && !state.searchTerm ? '#eef2ff' : 'transparent'};`;
            allLi.innerHTML = '<i class="fa-solid fa-layer-group" style="margin-right:5px;font-size:10px;"></i>全部分类';
            allLi.addEventListener('click', () => { state.currentCatId = null; state.searchTerm = ''; document.getElementById('scenePickerSearch').value = ''; renderTree(); renderItems(); });
            host.appendChild(allLi);

            const l1 = childrenOf(0);
            for (const cat of l1) {
                renderTreeNode(host, cat, 0);
            }
            if (l1.length === 0) {
                host.innerHTML += '<div style="color:#9ca3af;font-size:11px;padding:6px 8px;">暂无分类</div>';
            }
        }

        function renderTreeNode(parent, cat, depth) {
            const isLeaf = childrenOf(cat.id).length === 0;
            const isSel = state.currentCatId === cat.id;
            const node = document.createElement('div');
            node.style.cssText = `padding:4px ${8 + depth * 12}px;margin-bottom:2px;border-radius:4px;cursor:pointer;font-size:12px;color:${isSel ? '#6366f1' : '#374151'};background:${isSel ? '#eef2ff' : 'transparent'};font-weight:${depth === 0 ? '600' : '400'};`;
            const icon = depth === 0 ? 'fa-folder-tree' : depth === 1 ? 'fa-folder' : 'fa-tag';
            const itemCount = (itemsByCat.get(cat.id) || []).length;
            node.innerHTML = `<i class="fa-solid ${icon}" style="margin-right:5px;font-size:10px;color:${isSel ? '#6366f1' : '#9ca3af'};"></i>${escapeHtml(cat.category_name || cat.name || '#' + cat.id)}<span style="color:#9ca3af;margin-left:4px;font-size:10px;">(${itemCount})</span>`;
            if (isLeaf) {
                node.addEventListener('click', () => { state.currentCatId = cat.id; renderTree(); renderItems(); });
            } else {
                // 父节点：点击不进入（仍可点 L2 / L3），但可展开/折叠
                let expanded = depth < 1;  // L1 默认展开
                if (expanded) {
                    const subWrap = document.createElement('div');
                    parent.appendChild(node);
                    parent.appendChild(subWrap);
                    for (const child of childrenOf(cat.id)) {
                        renderTreeNode(subWrap, child, depth + 1);
                    }
                }
                node.addEventListener('click', () => {
                    // 简单做法：第一次点展开，第二次点折叠
                    if (!node._expanded) {
                        node._expanded = true;
                        const subWrap = document.createElement('div');
                        subWrap.className = 'scene-picker-subwrap';
                        node.after(subWrap);
                        for (const child of childrenOf(cat.id)) {
                            renderTreeNode(subWrap, child, depth + 1);
                        }
                    } else {
                        const sub = node.nextElementSibling;
                        if (sub && sub.className === 'scene-picker-subwrap') sub.remove();
                        node._expanded = false;
                    }
                });
            }
            parent.appendChild(node);
        }

        // ---- 渲染：items 列表 ----
        function renderItems() {
            const host = document.getElementById('scenePickerItems');
            if (!host) return;
            host.innerHTML = '';

            let items;
            if (state.searchTerm) {
                // 跨分类搜索
                const term = state.searchTerm.toLowerCase();
                items = allItems.filter(it => (it.name || '').toLowerCase().includes(term));
                if (items.length > 200) items = items.slice(0, 200);
            } else if (state.currentCatId != null) {
                items = itemsByCat.get(state.currentCatId) || [];
            } else {
                // 全部分类：聚合 L1 下所有 items（去重）
                const l1Ids = allCats.filter(c => (c.parent_id || 0) === 0).map(c => c.id);
                const seen = new Set();
                items = [];
                for (const id of l1Ids) {
                    for (const it of (itemsByCat.get(id) || [])) {
                        if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
                    }
                }
            }

            if (!items.length) {
                host.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:20px;text-align:center;">' + (state.searchTerm ? '无匹配结果' : '该分类下暂无提示词') + '</div>';
                return;
            }

            // 折叠的 items
            for (const it of items) {
                const isSel = state.selectedIds.has(Number(it.id));
                const row = document.createElement('label');
                row.style.cssText = `display:flex;align-items:flex-start;gap:8px;padding:7px 8px;margin-bottom:3px;border-radius:5px;cursor:pointer;background:${isSel ? '#eef2ff' : 'transparent'};border:1px solid ${isSel ? '#c7d2fe' : 'transparent'};font-size:12px;transition:background 0.1s;`;
                row.innerHTML = `
                    <input type="checkbox" ${isSel ? 'checked' : ''} style="width:14px;height:14px;cursor:pointer;accent-color:#6366f1;margin-top:2px;flex-shrink:0;">
                    <div style="flex:1;min-width:0;">
                        <div style="color:#1f2937;font-weight:${isSel ? '600' : '500'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(it.name || '')}</div>
                        ${it.category_name ? `<div style="color:#9ca3af;font-size:10px;margin-top:1px;">${escapeHtml(it.category_name)}</div>` : ''}
                    </div>
                `;
                row.addEventListener('click', (e) => {
                    if (e.target.tagName !== 'INPUT') {
                        const cb = row.querySelector('input[type=checkbox]');
                        cb.checked = !cb.checked;
                    }
                    toggleSelect(Number(it.id), row.querySelector('input[type=checkbox]').checked);
                });
                host.appendChild(row);
            }
        }

        // ---- 渲染：已选 chips ----
        function renderSelected() {
            const host = document.getElementById('scenePickerSelected');
            const countEl = document.getElementById('scenePickerCount');
            if (countEl) countEl.textContent = '已选 ' + state.selectedIds.size + ' 项';
            if (!host) return;
            if (state.selectedIds.size === 0) {
                host.innerHTML = '<div style="color:#9ca3af;font-size:11px;padding:12px;text-align:center;">从中间或左侧勾选提示词</div>';
                return;
            }
            // 按 items 全量列表索引（找不到对应名字的也显示 fallback id）
            const itemMap = new Map(allItems.map(it => [Number(it.id), it]));
            const selected = Array.from(state.selectedIds).map(id => {
                const it = itemMap.get(id);
                return { id, name: it ? (it.name + (it.category_name ? '  ·  ' + it.category_name : '')) : ('#' + id + ' (已删除)') };
            }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
            host.innerHTML = '';
            for (const s of selected) {
                const chip = document.createElement('div');
                chip.style.cssText = 'display:flex;align-items:flex-start;gap:4px;padding:4px 6px;margin-bottom:4px;border-radius:4px;background:#eef2ff;border:1px solid #c7d2fe;font-size:11px;line-height:1.4;';
                chip.innerHTML = `<span style="flex:1;color:#1f2937;word-break:break-all;">${escapeHtml(s.name)}</span><button class="scene-picker-remove" data-id="${s.id}" style="background:transparent;border:none;cursor:pointer;color:#6366f1;padding:0 2px;font-size:12px;flex-shrink:0;" title="移除"><i class="fa-solid fa-xmark"></i></button>`;
                host.appendChild(chip);
            }
            host.querySelectorAll('.scene-picker-remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const id = Number(btn.getAttribute('data-id'));
                    toggleSelect(id, false);
                });
            });
        }

        // ---- 切换选中 ----
        function toggleSelect(id, checked) {
            if (checked) state.selectedIds.add(id);
            else state.selectedIds.delete(id);
            renderSelected();
            // 同步 items 列表的 checkbox 状态（只更新已渲染的）
            const itemsHost = document.getElementById('scenePickerItems');
            if (itemsHost) {
                const rows = itemsHost.querySelectorAll('label');
                rows.forEach(row => {
                    const cb = row.querySelector('input[type=checkbox]');
                    const itemId = Number(allItems.find(it => it.name === row.querySelector('div > div')?.textContent)?.id);
                    // 简化：用 cb.checked 状态反推（不可靠），改用完整重渲染
                });
            }
            // 简单可靠：完整重渲染
            renderItems();
        }

        // ---- 事件绑定 ----
        document.getElementById('scenePickerSearch').addEventListener('input', (e) => {
            state.searchTerm = e.target.value;
            renderItems();
        });
        document.getElementById('scenePickerClear').addEventListener('click', () => {
            state.selectedIds.clear();
            renderSelected();
            renderItems();
        });
        const cancel = () => overlay.remove();
        document.getElementById('scenePickerClose').addEventListener('click', cancel);
        document.getElementById('scenePickerCancel').addEventListener('click', cancel);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
        document.getElementById('scenePickerConfirm').addEventListener('click', () => {
            const ids = Array.from(state.selectedIds);
            try { onConfirm && onConfirm(ids); } catch (e) { console.warn('[pickSceneItems] onConfirm err:', e); }
            cancel();
        });

        // 初次渲染
        renderTree();
        renderItems();
        renderSelected();
    }

    // 编辑场景模板：内嵌一个简单的 modal（不依赖外部 UI 库）
    function editSceneTemplate(t) {
        const old = document.getElementById('cfgSceneEditModal');
        if (old) old.remove();
        const overlay = document.createElement('div');
        overlay.id = 'cfgSceneEditModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center;';
        const initialIds = (t.item_ids || []).map(x => Number(x)).filter(x => x > 0);
        // 内部 state：用户每次 picker 选择后更新这里
        const state = { selectedItemIds: new Set(initialIds), itemMeta: new Map() };
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:10px;width:560px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,0.3);font-family:system-ui,-apple-system,sans-serif;overflow:hidden;">
                <div style="padding:12px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;background:#f9fafb;">
                    <span style="font-size:14px;font-weight:600;color:#1f2937;"><i class="fa-solid fa-pen" style="color:#6366f1;margin-right:6px;"></i>编辑场景模板</span>
                    <button id="cfgSceneEditClose" style="margin-left:auto;background:transparent;border:none;cursor:pointer;color:#6b7280;font-size:16px;"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div style="padding:16px 18px;overflow-y:auto;flex:1;">
                    <div style="margin-bottom:12px;">
                        <label style="display:block;font-size:12px;font-weight:500;color:#374151;margin-bottom:4px;">名称</label>
                        <input id="cfgSceneEditName" type="text" value="${esc(t.name)}" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid #d1d5db;border-radius:5px;box-sizing:border-box;font-family:inherit;">
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="display:block;font-size:12px;font-weight:500;color:#374151;margin-bottom:4px;">描述 / 提示词参考文本</label>
                        <textarea id="cfgSceneEditDesc" rows="6" style="width:100%;padding:7px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:5px;box-sizing:border-box;font-family:'Menlo','Consolas',monospace;resize:vertical;">${esc(t.description || '')}</textarea>
                    </div>
                    <div style="margin-bottom:8px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                            <label style="font-size:12px;font-weight:500;color:#374151;">引用的提示词 <span id="cfgSceneEditItemCount" style="color:#6366f1;font-weight:600;">(${initialIds.length})</span></label>
                            <button id="cfgScenePickBtn" class="cfgHoverBtn" type="button" style="font-size:11px;padding:3px 8px;"><i class="fa-solid fa-list-check"></i> 选择提示词...</button>
                        </div>
                        <div id="cfgSceneEditItemChips" style="min-height:40px;max-height:140px;overflow-y:auto;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px;background:#fafafa;font-size:11px;line-height:1.5;"></div>
                        <div id="cfgSceneEditItemLoading" style="font-size:11px;color:#6b7280;margin-top:3px;"><i class="fa-solid fa-spinner fa-spin"></i> 正在加载已选项...</div>
                    </div>
                </div>
                <div style="padding:10px 18px;border-top:1px solid #e5e7eb;background:#fafafa;display:flex;justify-content:flex-end;gap:8px;">
                    <button id="cfgSceneEditCancel" class="cfgHoverBtn">取消</button>
                    <button id="cfgSceneEditSave" class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // ---- 渲染 chips ----
        function renderChips() {
            const host = document.getElementById('cfgSceneEditItemChips');
            const cnt = document.getElementById('cfgSceneEditItemCount');
            if (cnt) cnt.textContent = '(' + state.selectedItemIds.size + ')';
            if (!host) return;
            if (state.selectedItemIds.size === 0) {
                host.innerHTML = '<div style="color:#9ca3af;font-size:11px;text-align:center;padding:8px 0;">还没选，点上方「选择提示词」按钮</div>';
                return;
            }
            const sorted = Array.from(state.selectedItemIds).map(id => {
                const meta = state.itemMeta.get(id);
                return { id, name: meta ? meta.name : '#' + id + ' (加载中...)', cat: meta ? meta.category_name : '' };
            }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
            host.innerHTML = '';
            for (const s of sorted) {
                const chip = document.createElement('div');
                chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 6px 3px 8px;margin:2px;border-radius:4px;background:#eef2ff;border:1px solid #c7d2fe;font-size:11px;max-width:100%;';
                chip.innerHTML = `<span style="color:#1f2937;word-break:break-all;flex:1;"><span style="font-weight:500;">${escapeHtml(s.name)}</span>${s.cat ? ` <span style="color:#9ca3af;font-size:10px;">· ${escapeHtml(s.cat)}</span>` : ''}</span><button class="cfg-scene-chip-remove" data-id="${s.id}" style="background:transparent;border:none;cursor:pointer;color:#6366f1;padding:0 2px;font-size:11px;line-height:1;flex-shrink:0;" title="移除"><i class="fa-solid fa-xmark"></i></button>`;
                host.appendChild(chip);
            }
            host.querySelectorAll('.cfg-scene-chip-remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    state.selectedItemIds.delete(Number(btn.getAttribute('data-id')));
                    renderChips();
                });
            });
        }

        // ---- 初次加载：批量回显已选 prompt 名称 ----
        (async () => {
            const loadingEl = document.getElementById('cfgSceneEditItemLoading');
            try {
                if (initialIds.length > 0) {
                    const r = await window.api.promptItems.getByIds(initialIds);
                    if (r && r.ok && r.items) {
                        for (const it of r.items) {
                            state.itemMeta.set(Number(it.id), { name: it.name || '', category_name: it.category_name || '' });
                        }
                    }
                    // 标记找不到的 id（item 已被删）— chip 渲染时显示 fallback
                }
            } catch (e) {
                console.warn('[editSceneTemplate] getByIds err:', e);
            } finally {
                if (loadingEl) loadingEl.style.display = 'none';
                renderChips();
            }
        })();

        // ---- 打开 picker ----
        document.getElementById('cfgScenePickBtn').addEventListener('click', async () => {
            await pickSceneItems(Array.from(state.selectedItemIds), (newIds) => {
                state.selectedItemIds = new Set(newIds.map(x => Number(x)).filter(x => x > 0));
                // 补全新加的 id 的 meta
                const missing = Array.from(state.selectedItemIds).filter(id => !state.itemMeta.has(id));
                if (missing.length > 0) {
                    window.api.promptItems.getByIds(missing).then(r => {
                        if (r && r.ok && r.items) {
                            for (const it of r.items) {
                                state.itemMeta.set(Number(it.id), { name: it.name || '', category_name: it.category_name || '' });
                            }
                            renderChips();
                        }
                    });
                }
                renderChips();
            });
        });

        const close = () => overlay.remove();
        document.getElementById('cfgSceneEditClose').addEventListener('click', close);
        document.getElementById('cfgSceneEditCancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.getElementById('cfgSceneEditSave').addEventListener('click', async () => {
            const name = document.getElementById('cfgSceneEditName').value.trim();
            const description = document.getElementById('cfgSceneEditDesc').value;
            if (!name) { showToast('名称不能为空', 'error'); return; }
            const item_ids = Array.from(state.selectedItemIds);
            const r = await window.api.sceneTemplateUpdate({ id: t.id, name, description, item_ids });
            if (r && r.ok) {
                // 更新本地缓存
                const idx = _sceneTemplates.findIndex(x => x.id === t.id);
                if (idx >= 0) {
                    _sceneTemplates[idx] = { ..._sceneTemplates[idx], name, description, item_ids };
                }
                const host = document.getElementById('cfgSceneList');
                if (host) _renderSceneList(host, _sceneTemplates);
                showToast('已保存', 'success');
                close();
            } else {
                showToast('保存失败：' + ((r && r.error) || '未知'), 'error');
            }
        });
    }

    // ========== 暴露 ==========
    window.promptGen = { open, close };
    // settings.js 也需要触发原「配置」弹框（4 子模块迁移前的兼容方案）
    // 调用方式：window.promptGenOpenConfigModal({ tab: 'menu' | 'item' | 'rule' | 'scene' })
    window.promptGenOpenConfigModal = function (opts) { return openConfigModal(opts || {}); };
    // 拼装规则保存/清空后回调，settings.js 自己的 rule 子页面需要通知主页面实时刷新
    window.promptGenLiveAssembleAndUpdate = liveAssembleAndUpdate;
})();

// =================================================================
// D-40: 关联规则管理页面（顶层函数，不依赖 IIFE 内部状态）
// =================================================================
let _assocAllRows = [];  // 缓存列表
let _assocFilter = { rel: '', src: '' };

// 暴露给 settings.js「关联管理」子模块入口（顶部按钮已移出，由 settings.js 卡片调用）
window.openAssociationManager = openAssociationManager;

async function openAssociationManager(opts) {
    opts = opts || {};
    const inlineHost = opts.container || null;
    const isInline = !!inlineHost;

    let page;
    if (isInline) {
        // 内联模式（settings.js 子页面调用）：渲染到指定容器内，无 fixed/z-index，不藏主界面
        inlineHost.innerHTML = '';
        page = document.createElement('div');
        page.id = 'associationPage';
        page.style.cssText = 'display:flex; flex-direction:column; height:100%; background:#f5f6f8; color:#1a1a1a; font-family:system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;';
        inlineHost.appendChild(page);
    } else {
        // 全屏 overlay 模式（兼容历史入口）
        page = document.getElementById('associationPage');
        const existed = !!page;
        if (!page) {
            page = document.createElement('div');
            page.id = 'associationPage';
            page.style.cssText = 'position:fixed; inset:0; background:#f5f6f8; z-index:250; display:flex; flex-direction:column; color:#1a1a1a; font-family:system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;';
            document.body.appendChild(page);
        }
        if (existed) {
            page.style.display = 'flex';
            await loadAssocData();
            return;
        }
        const main = document.getElementById('promptGenPage');
        if (main) main.style.display = 'none';
    }

    page.innerHTML = `
        <div style="display:flex; align-items:center; padding:14px 20px; border-bottom:1px solid #e5e7eb; background:#ffffff;">
            ${isInline ? '' : '<button id="asBtnBack" class="btn" style="margin-right:14px;"><i class="fa-solid fa-arrow-left"></i> 返回</button>'}
            <h2 style="margin:0; flex:1; color:#1f2937; font-size:18px; font-weight:600;"><i class="fa-solid fa-link" style="color:#6366f1;"></i> 关联规则管理</h2>
            <span id="asCount" style="font-size:12px; color:#6b7280; margin-right:12px;">共 0 条</span>
            <button id="asBtnAdd" class="btn" style="margin-left:8px;"><i class="fa-solid fa-plus"></i> 手动添加</button>
            <label class="btn" style="margin-left:8px; cursor:pointer; background:#10b981; color:#ffffff; border-color:#059669;">
                <i class="fa-solid fa-file-import"></i> 导入 Excel
                <input id="asFileInput" type="file" accept=".xlsx,.csv" style="display:none;">
            </label>
            <button id="asBtnExport" class="btn" style="margin-left:8px;"><i class="fa-solid fa-download"></i> 下载模板</button>
        </div>
        <div style="padding:12px 20px; background:#ffffff; border-bottom:1px solid #e5e7eb; display:flex; gap:8px; align-items:center;">
            <span style="font-size:12px; color:#6b7280;">筛选：</span>
            <select id="asFilterRel" style="padding:5px 10px; font-size:12px; border:1px solid #d1d5db; border-radius:4px;">
                <option value="">全部关系</option>
                <option value="strong">强联动</option>
                <option value="weak">弱联动</option>
                <option value="exclusive">互斥</option>
            </select>
            <select id="asFilterSrc" style="padding:5px 10px; font-size:12px; border:1px solid #d1d5db; border-radius:4px;">
                <option value="">全部来源</option>
                <option value="manual">手动</option>
                <option value="excel">Excel</option>
            </select>
            <span style="flex:1;"></span>
            <button id="asBtnRefresh" class="btn btn-sm"><i class="fa-solid fa-rotate"></i> 刷新</button>
        </div>
        <div id="asTableContainer" style="flex:1; overflow:auto; padding:14px 20px;"></div>
    `;

    if (!isInline) {
        page.querySelector('#asBtnBack').addEventListener('click', () => {
            page.style.display = 'none';
            const main = document.getElementById('promptGenPage');
            const settings = document.getElementById('settingsPage');
            // 只有当 settings 模态没在显示时才恢复 promptGenPage，避免从 settings 进入关联管理后误显主界面
            if (main && (!settings || settings.style.display === 'none')) {
                main.style.display = 'flex';
            }
        });
    }
    page.querySelector('#asBtnAdd').addEventListener('click', openAssocAddModal);
    page.querySelector('#asFileInput').addEventListener('change', onAssocFileSelected);
    page.querySelector('#asBtnExport').addEventListener('click', downloadAssocTemplate);
    page.querySelector('#asFilterRel').addEventListener('change', e => { _assocFilter.rel = e.target.value; renderAssocTable(); });
    page.querySelector('#asFilterSrc').addEventListener('change', e => { _assocFilter.src = e.target.value; renderAssocTable(); });
    page.querySelector('#asBtnRefresh').addEventListener('click', loadAssocData);

    if (!isInline) {
        page.style.display = 'flex';
    }
    await loadAssocData();
}

async function loadAssocData() {
    const r = await window.api.promptAssociationListAll();
    if (r && r.ok) {
        _assocAllRows = r.rows || [];
        renderAssocTable();
    } else {
        _assocAllRows = [];
        const c = document.getElementById('asTableContainer');
        if (c) c.innerHTML = `<div style="color:#dc2626; text-align:center; padding:40px;">加载失败：${r ? r.error : '未知错误'}</div>`;
    }
}

function assocEscapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderAssocTable() {
    const container = document.getElementById('asTableContainer');
    const countEl = document.getElementById('asCount');
    if (!container) return;

    let rows = _assocAllRows;
    if (_assocFilter.rel) rows = rows.filter(r => r.relation === _assocFilter.rel);
    if (_assocFilter.src) rows = rows.filter(r => r.source === _assocFilter.src);

    if (countEl) countEl.textContent = `共 ${rows.length} 条`;

    if (rows.length === 0) {
        container.innerHTML = '<div style="color:#9ca3af; text-align:center; padding:60px;">暂无关联规则<br><br>点击「手动添加」或「导入 Excel」开始</div>';
        return;
    }

    const relColor = { strong: '#10b981', weak: '#6b7280', exclusive: '#dc2626' };
    const relLabel = { strong: '强联动', weak: '弱联动', exclusive: '互斥' };
    const srcLabel = { manual: '手动', excel: 'Excel' };

    const html = `
        <table style="width:100%; border-collapse:collapse; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <thead>
                <tr style="background:#f9fafb; border-bottom:2px solid #e5e7eb;">
                    <th style="padding:10px; text-align:left; font-size:12px; color:#6b7280; font-weight:600;">A 提示词</th>
                    <th style="padding:10px; text-align:center; font-size:12px; color:#6b7280; font-weight:600;">关系</th>
                    <th style="padding:10px; text-align:left; font-size:12px; color:#6b7280; font-weight:600;">B 提示词</th>
                    <th style="padding:10px; text-align:center; font-size:12px; color:#6b7280; font-weight:600;">权重</th>
                    <th style="padding:10px; text-align:left; font-size:12px; color:#6b7280; font-weight:600;">原因</th>
                    <th style="padding:10px; text-align:center; font-size:12px; color:#6b7280; font-weight:600;">来源</th>
                    <th style="padding:10px; text-align:center; font-size:12px; color:#6b7280; font-weight:600;">操作</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(r => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                        <td style="padding:8px 10px; font-size:12px; color:#1f2937;">${assocEscapeHtml(r.a_name || ('#' + r.prompt_a_id))}</td>
                        <td style="padding:8px 10px; text-align:center;">
                            <span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; color:#fff; background:${relColor[r.relation] || '#6b7280'};">${relLabel[r.relation] || r.relation}</span>
                        </td>
                        <td style="padding:8px 10px; font-size:12px; color:#1f2937;">${assocEscapeHtml(r.b_name || ('#' + r.prompt_b_id))}</td>
                        <td style="padding:8px 10px; text-align:center; font-size:12px; color:#4b5563;">${r.weight || 50}</td>
                        <td style="padding:8px 10px; font-size:12px; color:#6b7280;">${assocEscapeHtml(r.reason || '')}</td>
                        <td style="padding:8px 10px; text-align:center; font-size:11px; color:#9ca3af;">${srcLabel[r.source] || r.source || '-'}</td>
                        <td style="padding:8px 10px; text-align:center;">
                            <button class="btn btn-sm" data-del="${r.id}" style="background:#fef2f2; color:#dc2626; border:1px solid #fecaca; font-size:11px; padding:3px 10px;">
                                <i class="fa-solid fa-trash"></i> 删除
                            </button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    container.innerHTML = html;
    container.querySelectorAll('[data-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const ok = await assocConfirmModal('确定删除此关联规则？');
            if (!ok) return;
            const r = await window.api.promptAssociationDelete(parseInt(btn.dataset.del));
            assocShowToast(r && r.ok ? '已删除' : ('删除失败：' + (r ? r.error : '')), r && r.ok ? 'success' : 'error');
            if (r && r.ok) {
                invalidateAssocCache();  // 同步失效客户端缓存
                ensureAssocCache();       // 后台静默重载
                loadAssocData();
            }
        });
    });
}

// ========== 自定义确认 modal（替代 window.confirm）==========
function assocConfirmModal(message) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.5); backdrop-filter:blur(2px); z-index:9999; display:flex; align-items:center; justify-content:center;';
        overlay.innerHTML = `
            <div class="asConfirmCard" style="background:#ffffff; border-radius:12px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25); max-width:420px; width:90%; padding:24px;">
                <div style="font-size:15px; color:#1f2937; font-weight:600; margin-bottom:18px; display:flex; align-items:center; gap:8px;">
                    <i class="fa-solid fa-circle-question" style="color:#f59e0b;"></i>
                    <span>${assocEscapeHtml(message)}</span>
                </div>
                <div style="display:flex; gap:8px; justify-content:flex-end;">
                    <button class="btn asConfirmCancel">取消</button>
                    <button class="btn btn-primary asConfirmOk" style="background:#dc2626; border-color:#dc2626;">确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const card = overlay.querySelector('.asConfirmCard');
        const cleanup = (val) => { overlay.remove(); resolve(val); };
        // 关键：卡片内部所有 click 全部阻断冒泡，否则点白卡也算「点 overlay」会误关
        card.addEventListener('click', (e) => e.stopPropagation());
        overlay.addEventListener('click', () => cleanup(false));
        overlay.querySelector('.asConfirmCancel').addEventListener('click', () => cleanup(false));
        overlay.querySelector('.asConfirmOk').addEventListener('click', () => cleanup(true));
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(false); });
    });
}

// ========== 自定义表单 modal（替代 window.prompt）==========
function assocFormModal() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.5); backdrop-filter:blur(2px); z-index:9999; display:flex; align-items:center; justify-content:center;';
        overlay.innerHTML = `
            <div class="asFormCard" style="background:#ffffff; border-radius:12px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25); max-width:560px; width:92%; padding:24px; color:#1f2937; position:relative;">
                <div style="font-size:16px; color:#1f2937; font-weight:600; margin-bottom:18px; display:flex; align-items:center; gap:8px; padding-right:32px;">
                    <i class="fa-solid fa-link" style="color:#6366f1;"></i>
                    <span>手动添加关联规则</span>
                </div>
                <button class="asFormClose" title="关闭 (Esc)" style="position:absolute; top:14px; right:14px; background:transparent; border:none; font-size:18px; color:#9ca3af; cursor:pointer; padding:4px 8px; border-radius:4px; line-height:1;"><i class="fa-solid fa-xmark"></i></button>
                <div style="display:flex; flex-direction:column; gap:14px; font-size:13px;">
                    <div style="display:flex; flex-direction:column; gap:5px;">
                        <span style="color:#374151; font-weight:500;">A 提示词<span style="color:#dc2626;">*</span> <span style="color:#9ca3af; font-weight:normal; font-size:11px;">（可输入或从库中选择）</span></span>
                        <div style="display:flex; gap:6px;">
                            <input id="asFormA" type="text" placeholder="输入名称 或 点右侧「选择」从库选" style="flex:1; padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;" />
                            <button id="asFormAPick" class="btn" style="background:#6366f1; color:#ffffff; border-color:#4f46e5;"><i class="fa-solid fa-list"></i> 选择</button>
                            <button id="asFormAClr" class="btn" style="padding:8px 10px;" title="清除"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                    </div>
                    <div style="display:flex; flex-direction:column; gap:5px;">
                        <span style="color:#374151; font-weight:500;">B 提示词<span style="color:#dc2626;">*</span></span>
                        <div style="display:flex; gap:6px;">
                            <input id="asFormB" type="text" placeholder="输入名称 或 点右侧「选择」从库选" style="flex:1; padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;" />
                            <button id="asFormBPick" class="btn" style="background:#6366f1; color:#ffffff; border-color:#4f46e5;"><i class="fa-solid fa-list"></i> 选择</button>
                            <button id="asFormBClr" class="btn" style="padding:8px 10px;" title="清除"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                    </div>
                    <div style="display:flex; flex-direction:column; gap:5px;">
                        <span style="color:#374151; font-weight:500;">关系类型<span style="color:#dc2626;">*</span></span>
                        <select id="asFormRel" style="padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; background:#ffffff;">
                            <option value="strong">strong - 强联动</option>
                            <option value="weak">weak - 弱联动</option>
                            <option value="exclusive">exclusive - 互斥</option>
                        </select>
                    </div>
                    <div style="display:flex; flex-direction:column; gap:5px;">
                        <span style="color:#374151; font-weight:500;">原因（可选）</span>
                        <input id="asFormReason" type="text" placeholder="如：监控不可能8K画质" style="padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;" />
                    </div>
                    <div style="display:flex; flex-direction:column; gap:5px;">
                        <span style="color:#374151; font-weight:500;">权重 (0-100)</span>
                        <input id="asFormWeight" type="number" min="0" max="100" value="50" style="padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;" />
                    </div>
                    <div id="asFormError" style="display:none; padding:8px 12px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; font-size:12px;"></div>
                </div>
                <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:20px;">
                    <button class="btn asFormCancel">取消</button>
                    <button class="btn btn-primary asFormOk" style="background:#10b981; border-color:#059669;"><i class="fa-solid fa-check"></i> 保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        setTimeout(() => { const i = overlay.querySelector('#asFormA'); if (i) i.focus(); }, 50);

        const showError = (msg) => {
            const el = overlay.querySelector('#asFormError');
            el.textContent = msg;
            el.style.display = 'block';
        };
        const hideError = () => {
            const el = overlay.querySelector('#asFormError');
            el.style.display = 'none';
        };
        const cleanup = (val) => { overlay.remove(); resolve(val); };

        // 选择按钮绑定（共享 picker modal）
        const wirePick = (inputId, btnId, clrId) => {
            overlay.querySelector(btnId).addEventListener('click', async () => {
                const name = await assocPickerModal();
                if (name) {
                    overlay.querySelector(inputId).value = name;
                    hideError();
                }
            });
            overlay.querySelector(clrId).addEventListener('click', () => {
                overlay.querySelector(inputId).value = '';
                overlay.querySelector(inputId).focus();
            });
        };
        wirePick('#asFormA', '#asFormAPick', '#asFormAClr');
        wirePick('#asFormB', '#asFormBPick', '#asFormBClr');

        const submit = () => {
            hideError();
            const promptA = overlay.querySelector('#asFormA').value.trim();
            const promptB = overlay.querySelector('#asFormB').value.trim();
            const relation = overlay.querySelector('#asFormRel').value;
            const reason = overlay.querySelector('#asFormReason').value.trim();
            const weight = parseInt(overlay.querySelector('#asFormWeight').value) || 50;
            if (!promptA) return showError('A 提示词名称必填');
            if (!promptB) return showError('B 提示词名称必填');
            if (promptA === promptB) return showError('A 和 B 不能相同');
            if (!['strong', 'weak', 'exclusive'].includes(relation)) return showError('关系类型无效');
            if (weight < 0 || weight > 100) return showError('权重必须在 0-100 之间');
            cleanup({ promptA, promptB, relation, reason, weight });
        };

        overlay.querySelector('.asFormCancel').addEventListener('click', () => cleanup(null));
        overlay.querySelector('.asFormOk').addEventListener('click', submit);
        // × 关闭按钮
        const closeBtn = overlay.querySelector('.asFormClose');
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#f3f4f6'; closeBtn.style.color = '#1f2937'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'transparent'; closeBtn.style.color = '#9ca3af'; });
        closeBtn.addEventListener('click', () => cleanup(null));

        // 关键：白卡内部 click 全部阻断冒泡，否则点白卡 = 点 overlay = 误关
        const card = overlay.querySelector('.asFormCard');
        card.addEventListener('click', (e) => e.stopPropagation());
        // overlay 自身 click → 关闭（无需再判 e.target）
        overlay.addEventListener('click', () => cleanup(null));

        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') cleanup(null);
        });
    });
}

// ========== 提示词选择器 modal（分类树 + 搜索）==========
// 返回 Promise<string|null>，resolve 选中的提示词名称；用户取消/关闭 resolve null
// 复用现有 IPC：promptMenu.list + promptItems.list（带缓存避免重复加载）
let _assocPickerMenuCache = null;
let _assocPickerItemsCache = null;

async function loadAssocPickerData(force = false) {
    if (!force && _assocPickerMenuCache && _assocPickerItemsCache) {
        return { menu: _assocPickerMenuCache, items: _assocPickerItemsCache };
    }
    const [menuR, itemsR] = await Promise.all([
        window.api.promptMenu.list(),
        window.api.promptItems.list()
    ]);
    if (!menuR.ok) throw new Error('加载分类失败：' + menuR.error);
    if (!itemsR.ok) throw new Error('加载提示词失败：' + itemsR.error);
    _assocPickerMenuCache = menuR.items || [];
    _assocPickerItemsCache = itemsR.items || [];
    return { menu: _assocPickerMenuCache, items: _assocPickerItemsCache };
}

// 强制刷新（添加/删除 prompt 后用）
function invalidateAssocPickerCache() {
    _assocPickerMenuCache = null;
    _assocPickerItemsCache = null;
}

function assocPickerModal() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.5); backdrop-filter:blur(2px); z-index:10000; display:flex; align-items:center; justify-content:center;';
        overlay.innerHTML = `
            <div class="asPickerCard" style="background:#ffffff; border-radius:12px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25); width:92%; max-width:820px; height:82vh; display:flex; flex-direction:column; color:#1f2937; overflow:hidden;">
                <div style="padding:14px 20px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:8px;">
                    <i class="fa-solid fa-list-ul" style="color:#6366f1;"></i>
                    <span style="font-size:15px; font-weight:600; flex:1;">选择提示词</span>
                    <span id="asPickerStats" style="font-size:11px; color:#6b7280;"></span>
                    <button class="asPickerClose btn btn-sm" style="padding:4px 10px;"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div style="padding:10px 20px; border-bottom:1px solid #e5e7eb; display:flex; gap:8px; align-items:center;">
                    <input id="asPickerSearch" type="text" placeholder="🔍 搜索（输入名称片段过滤，可中文/英文）" style="flex:1; padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;" />
                    <button id="asPickerRefresh" class="btn btn-sm" title="刷新数据"><i class="fa-solid fa-rotate"></i></button>
                </div>
                <div style="display:flex; flex:1; min-height:0;">
                    <div id="asPickerTree" style="width:260px; border-right:1px solid #e5e7eb; overflow-y:auto; padding:6px 0; background:#fafafa;"></div>
                    <div id="asPickerItems" style="flex:1; overflow-y:auto; padding:8px 0;"></div>
                </div>
                <div style="padding:10px 20px; border-top:1px solid #e5e7eb; background:#f9fafb; font-size:11px; color:#6b7280; display:flex; gap:14px;">
                    <span>💡 单击提示词 = 选中</span>
                    <span>⏎ 回车 = 选第一个匹配</span>
                    <span style="flex:1;"></span>
                    <span>Esc = 关闭</span>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const treeEl = overlay.querySelector('#asPickerTree');
        const itemsEl = overlay.querySelector('#asPickerItems');
        const searchEl = overlay.querySelector('#asPickerSearch');
        const statsEl = overlay.querySelector('#asPickerStats');
        let currentCatId = null;  // null = 全部
        let data = null;
        let _renderItemsRef = null;  // 闭包引用，供搜索事件触发重渲

        const cleanup = (val) => { overlay.remove(); resolve(val); };

        const buildAndRender = (d) => {
            data = d;
            statsEl.textContent = `共 ${d.items.length} 个提示词 / ${d.menu.length} 个分类`;
            // 按 parent_id 建索引
            const childrenOf = new Map();
            for (const m of d.menu) {
                const p = m.parent_id || 0;
                if (!childrenOf.has(p)) childrenOf.set(p, []);
                childrenOf.get(p).push(m);
            }
            for (const arr of childrenOf.values()) {
                arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            }
            // 按 cat 索引 items
            const itemsByCat = new Map();
            for (const it of d.items) {
                if (!itemsByCat.has(it.category_id)) itemsByCat.set(it.category_id, []);
                itemsByCat.get(it.category_id).push(it);
            }
            for (const arr of itemsByCat.values()) {
                arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            }
            // 算每个分类（含后代）的总 item 数
            const countRecursive = (catId) => {
                let n = (itemsByCat.get(catId) || []).length;
                for (const c of (childrenOf.get(catId) || [])) n += countRecursive(c.id);
                return n;
            };

            const renderTree = () => {
                treeEl.innerHTML = '';
                // 全部
                const allRow = document.createElement('div');
                allRow.style.cssText = 'display:flex; align-items:center; gap:6px; padding:7px 12px; cursor:pointer; font-size:13px; font-weight:500; border-radius:4px; margin:0 6px 4px;' + (currentCatId === null ? 'background:#eef2ff; color:#4338ca;' : 'color:#374151;');
                allRow.innerHTML = `<i class="fa-solid fa-layer-group" style="color:#6366f1; font-size:11px; width:14px; text-align:center;"></i><span style="flex:1;">全部</span><span style="font-size:10px; color:#9ca3af;">${d.items.length}</span>`;
                allRow.addEventListener('mouseenter', () => { if (currentCatId !== null) allRow.style.background = '#f3f4f6'; });
                allRow.addEventListener('mouseleave', () => { if (currentCatId !== null) allRow.style.background = ''; });
                allRow.addEventListener('click', () => { currentCatId = null; renderTree(); renderItems(); });
                treeEl.appendChild(allRow);

                const renderLevel = (parentId, depth) => {
                    const kids = childrenOf.get(parentId) || [];
                    for (const k of kids) {
                        const grandKids = childrenOf.get(k.id) || [];
                        const hasKids = grandKids.length > 0;
                        const itemCount = countRecursive(k.id);
                        const sel = currentCatId === k.id;
                        const row = document.createElement('div');
                        row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:6px 8px; cursor:pointer; font-size:12px; border-radius:4px; margin:0 6px 2px;' + (sel ? 'background:#eef2ff; color:#4338ca; font-weight:500;' : 'color:#374151;');
                        row.style.paddingLeft = (12 + depth * 14) + 'px';
                        row.innerHTML = `
                            <i class="fa-solid ${hasKids ? 'fa-folder' : 'fa-tag'}" style="color:${hasKids ? '#f59e0b' : '#9ca3af'}; font-size:10px; width:14px; text-align:center;"></i>
                            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${assocEscapeHtml(k.category_name)}">${assocEscapeHtml(k.category_name)}</span>
                            <span style="font-size:10px; color:#9ca3af; flex-shrink:0;">${itemCount}</span>
                        `;
                        row.addEventListener('mouseenter', () => { if (!sel) row.style.background = '#f3f4f6'; });
                        row.addEventListener('mouseleave', () => { if (!sel) row.style.background = ''; });
                        row.addEventListener('click', () => { currentCatId = k.id; renderTree(); renderItems(); });
                        treeEl.appendChild(row);
                        if (hasKids) renderLevel(k.id, depth + 1);
                    }
                };
                renderLevel(0, 0);
            };

            const renderItems = () => {
                const search = searchEl.value.trim().toLowerCase();
                let items;
                if (currentCatId === null) {
                    items = d.items;
                } else {
                    // 包含当前分类 + 所有后代
                    const collect = (cid) => {
                        let arr = (itemsByCat.get(cid) || []).slice();
                        for (const c of (childrenOf.get(cid) || [])) arr = arr.concat(collect(c.id));
                        return arr;
                    };
                    items = collect(currentCatId);
                }
                if (search) {
                    items = items.filter(it => (it.name || '').toLowerCase().includes(search));
                }
                itemsEl.innerHTML = '';
                if (items.length === 0) {
                    itemsEl.innerHTML = `<div style="color:#9ca3af; text-align:center; padding:60px 20px; font-size:13px;">${search ? '🔍 无匹配项' : '该分类下暂无提示词'}</div>`;
                    return;
                }
                const head = document.createElement('div');
                head.style.cssText = 'padding:6px 16px 8px; font-size:11px; color:#6b7280; border-bottom:1px solid #f3f4f6;';
                head.textContent = `共 ${items.length} 项${search ? ' · 关键词："' + assocEscapeHtml(search) + '"' : ''}`;
                itemsEl.appendChild(head);
                for (const it of items) {
                    const catName = ((d.menu.find(m => m.id === it.category_id) || {}).category_name) || '';
                    const row = document.createElement('div');
                    row.dataset.itemName = it.name;  // 给 Enter 快捷键用
                    row.style.cssText = 'padding:8px 16px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:8px; transition:background 0.1s;';
                    row.innerHTML = `
                        <i class="fa-solid fa-tag" style="color:#6366f1; font-size:11px; flex-shrink:0;"></i>
                        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${assocEscapeHtml(it.name)}</span>
                        ${catName ? `<span style="font-size:10px; color:#9ca3af; flex-shrink:0; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${assocEscapeHtml(catName)}">${assocEscapeHtml(catName)}</span>` : ''}
                    `;
                    row.addEventListener('mouseenter', () => { row.style.background = '#eef2ff'; });
                    row.addEventListener('mouseleave', () => { row.style.background = ''; });
                    row.title = it.content || it.name;
                    row.addEventListener('click', () => cleanup(it.name));
                    itemsEl.appendChild(row);
                }
            };

            renderTree();
            renderItems();
            // 把 renderItems 引用挂到外层 closure，搜索 input 事件能触发重渲
            _renderItemsRef = renderItems;
        };

        // 初次加载（异步）
        loadAssocPickerData().then(buildAndRender).catch(err => {
            itemsEl.innerHTML = `<div style="color:#dc2626; text-align:center; padding:40px; font-size:13px;">加载失败：${assocEscapeHtml(err.message)}</div>`;
        });

        // 刷新按钮
        overlay.querySelector('#asPickerRefresh').addEventListener('click', async () => {
            try {
                invalidateAssocPickerCache();
                const d = await loadAssocPickerData(true);
                buildAndRender(d);
                assocShowToast('已刷新', 'success');
            } catch (err) {
                assocShowToast('刷新失败：' + err.message, 'error');
            }
        });

        // 关闭按钮 + 阻断冒泡（点白卡不关弹框）
        overlay.querySelector('.asPickerCard').addEventListener('click', (e) => e.stopPropagation());
        overlay.addEventListener('click', () => cleanup(null));
        overlay.querySelector('.asPickerClose').addEventListener('click', () => cleanup(null));

        // 搜索（防抖）+ 回车取第一个匹配项
        let _searchTimer = null;
        searchEl.addEventListener('input', () => {
            if (_searchTimer) clearTimeout(_searchTimer);
            _searchTimer = setTimeout(() => {
                // 触发一次自定义事件让 buildAndRender 内的 renderItems 重跑
                searchEl.dispatchEvent(new CustomEvent('search-changed'));
            }, 100);
        });

        // 监听搜索变化 → 重新渲染 items 区
        searchEl.addEventListener('search-changed', () => {
            if (!_renderItemsRef) return;
            _renderItemsRef();
        });

        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { cleanup(null); return; }
            if (e.key === 'Enter') {
                e.preventDefault();
                const first = itemsEl.querySelector('[data-item-name]');
                if (first) cleanup(first.dataset.itemName);
            }
        });
        setTimeout(() => searchEl.focus(), 50);
    });
}

async function openAssocAddModal() {
    const data = await assocFormModal();
    if (!data) return;  // 用户取消
    const r = await window.api.promptAssociationUpsert(data);
    assocShowToast(r && r.ok ? '已添加' : ('添加失败：' + (r ? r.error : '')), r && r.ok ? 'success' : 'error');
    if (r && r.ok) {
        invalidateAssocCache();  // 同步失效客户端缓存
        ensureAssocCache();       // 后台静默重载
        loadAssocData();
    }
}

async function onAssocFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (typeof XLSX === 'undefined') {
        assocShowToast('XLSX 库未加载，请先在 index.html 头部引入 SheetJS CDN', 'error');
        return;
    }
    try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws);
        if (rows.length === 0) {
            assocShowToast('文件为空', 'warning');
            return;
        }
        const r = await window.api.promptAssociationImport(rows);
        if (r && r.ok) {
            let msg = `导入完成：成功 ${r.imported} 条`;
            if (r.skipped > 0) {
                msg += `，跳过 ${r.skipped} 条`;
                if (r.skippedDetails && r.skippedDetails.length > 0) {
                    console.warn('[association-import] skipped details:', r.skippedDetails);
                }
            }
            assocShowToast(msg, r.skipped > 0 ? 'warning' : 'success');
            invalidateAssocCache();  // 同步失效客户端缓存
            ensureAssocCache();       // 后台静默重载
            loadAssocData();
        } else {
            assocShowToast('导入失败：' + (r ? r.error : ''), 'error');
        }
    } catch (err) {
        assocShowToast('文件解析失败：' + err.message, 'error');
    } finally {
        e.target.value = '';  // 允许同名文件再次上传
    }
}

function downloadAssocTemplate() {
    const csv = 'promptA,promptB,relation,reason,weight\nCCTV,8k,exclusive,监控不可能8K画质,100\nPOV,ceiling mirror,strong,偷拍场景强推天花板镜,80\nlove hotel pink room,heart-shaped bed,strong,情人旅馆强推心形床,75\n';
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'prompt_associations_template.csv';
    a.click();
    URL.revokeObjectURL(url);
    assocShowToast('模板已下载', 'success');
}

function assocShowToast(msg, type) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed; bottom:30px; right:30px; padding:12px 20px; border-radius:6px; font-size:13px; color:#fff; z-index:9999; box-shadow:0 4px 12px rgba(0,0,0,0.15); background:${type === 'error' ? '#dc2626' : type === 'warning' ? '#f59e0b' : '#059669'};`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}
