// relations.js - Sprint 8.3: 力导向关系图谱（Canvas 渲染）
'use strict';
(function () {
    if (!window.RelationsPanel) {
        // ---- 配置 ----
        const NODE_RADIUS = { character: 18, organization: 22, worldview: 20 };
        const NODE_COLORS = {
            character: '#4fc3f7',
            organization: '#ffb74d',
            worldview: '#ba68c8',
        };
        const LABEL_FONT = '13px sans-serif';
        const FORCE_K = 0.05;          // 弹簧劲度系数
        const FORCE_REPULSE = 800;     // 斥力系数
        const FORCE_CENTER = 0.01;     // 向心力
        const FORCE_DAMPING = 0.85;    // 阻尼
        const MAX_NODES = 200;         // 节点上限（超过则折叠）
        const ITERATIONS = 300;

        // ---- 状态 ----
        let _state = {
            novelId: null,
            relations: [],
            nodes: [],     // [{id, type, name, x, y, vx, vy}]
            edges: [],     // [{source, target, label, strength, relId}]
            selected: null, // edgeId or nodeId
            canvas: null,
            ctx: null,
            width: 0,
            height: 0,
            dragging: null, // {nodeId, x, y}
            hoverNode: null,
        };

        // ---- 力导向布局（纯函数）----
        function _buildGraph(relations) {
            // 从关系中抽取唯一节点（source + target）
            const nodeMap = new Map();
            for (const r of relations) {
                if (!nodeMap.has(r.sourceId)) {
                    nodeMap.set(r.sourceId, {
                        id: r.sourceId,
                        type: r.sourceType,
                        name: r.sourceName || r.sourceId,
                        x: Math.random() * 400 + 200,
                        y: Math.random() * 300 + 200,
                        vx: 0, vy: 0,
                    });
                }
                if (!nodeMap.has(r.targetId)) {
                    nodeMap.set(r.targetId, {
                        id: r.targetId,
                        type: r.targetType,
                        name: r.targetName || r.targetId,
                        x: Math.random() * 400 + 200,
                        y: Math.random() * 300 + 200,
                        vx: 0, vy: 0,
                    });
                }
            }
            const nodes = Array.from(nodeMap.values());
            // 折叠：超过 MAX_NODES 只保留 degree 最高的节点
            if (nodes.length > MAX_NODES) {
                const degree = new Map();
                for (const r of relations) {
                    degree.set(r.sourceId, (degree.get(r.sourceId) || 0) + 1);
                    degree.set(r.targetId, (degree.get(r.targetId) || 0) + 1);
                }
                nodes.sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
                nodes.length = MAX_NODES;
            }
            const nodeIds = new Set(nodes.map(n => n.id));
            const edges = relations
                .filter(r => nodeIds.has(r.sourceId) && nodeIds.has(r.targetId))
                .map(r => ({
                    source: r.sourceId,
                    target: r.targetId,
                    label: r.label || '',
                    strength: r.strength || 5,
                    relId: r.id,
                }));
            return { nodes, edges };
        }

        function _layout(graph, width, height) {
            const nodes = graph.nodes;
            const edges = graph.edges;
            const cx = width / 2;
            const cy = height / 2;
            // 预初始化坐标
            for (const n of nodes) {
                if (typeof n.x !== 'number' || isNaN(n.x)) { n.x = cx + (Math.random() - 0.5) * 100; n.y = cy + (Math.random() - 0.5) * 100; }
            }
            for (let it = 0; it < ITERATIONS; it++) {
                // 斥力
                for (let i = 0; i < nodes.length; i++) {
                    const a = nodes[i];
                    for (let j = i + 1; j < nodes.length; j++) {
                        const b = nodes[j];
                        const dx = b.x - a.x, dy = b.y - a.y;
                        let dist2 = dx * dx + dy * dy;
                        if (dist2 < 1) dist2 = 1;
                        const force = FORCE_REPULSE / dist2;
                        const dist = Math.sqrt(dist2);
                        const fx = (dx / dist) * force;
                        const fy = (dy / dist) * force;
                        a.vx -= fx; a.vy -= fy;
                        b.vx += fx; b.vy += fy;
                    }
                }
                // 弹簧（按强度调节目标距离）
                for (const e of edges) {
                    const s = nodes.find(n => n.id === e.source);
                    const t = nodes.find(n => n.id === e.target);
                    if (!s || !t) continue;
                    const dx = t.x - s.x, dy = t.y - s.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const target = 80 + (10 - (e.strength || 5)) * 8; // 强度越大距离越近
                    const force = FORCE_K * (dist - target);
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    s.vx += fx; s.vy += fy;
                    t.vx -= fx; t.vy -= fy;
                }
                // 向心力
                for (const n of nodes) {
                    n.vx += (cx - n.x) * FORCE_CENTER;
                    n.vy += (cy - n.y) * FORCE_CENTER;
                }
                // 应用速度 + 阻尼 + 速度上限（防止数值爆炸）
                const MAX_V = 50;
                for (const n of nodes) {
                    n.vx *= FORCE_DAMPING;
                    n.vy *= FORCE_DAMPING;
                    if (n.vx > MAX_V) n.vx = MAX_V; else if (n.vx < -MAX_V) n.vx = -MAX_V;
                    if (n.vy > MAX_V) n.vy = MAX_V; else if (n.vy < -MAX_V) n.vy = -MAX_V;
                    n.x += n.vx;
                    n.y += n.vy;
                    // 边界
                    n.x = Math.max(20, Math.min(width - 20, n.x));
                    n.y = Math.max(20, Math.min(height - 20, n.y));
                }
            }
        }

        // ---- 渲染 ----
        function _render() {
            const ctx = _state.ctx;
            const W = _state.width, H = _state.height;
            ctx.clearRect(0, 0, W, H);

            // 画边
            for (const e of _state.edges) {
                const s = _state.nodes.find(n => n.id === e.source);
                const t = _state.nodes.find(n => n.id === e.target);
                if (!s || !t) continue;
                const isSelected = _state.selected === e.relId;
                ctx.beginPath();
                ctx.moveTo(s.x, s.y);
                ctx.lineTo(t.x, t.y);
                ctx.strokeStyle = isSelected ? '#ff6b6b' : `rgba(180,180,180,${0.3 + (e.strength || 5) / 20})`;
                ctx.lineWidth = isSelected ? 3 : (1 + (e.strength || 5) / 5);
                ctx.stroke();
                // label
                if (e.label && (isSelected || (e.strength || 5) >= 7)) {
                    const mx = (s.x + t.x) / 2;
                    const my = (s.y + t.y) / 2;
                    ctx.fillStyle = '#ccc';
                    ctx.font = '11px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText(e.label, mx, my - 4);
                }
            }

            // 画节点
            for (const n of _state.nodes) {
                const r = NODE_RADIUS[n.type] || 18;
                ctx.beginPath();
                ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
                ctx.fillStyle = NODE_COLORS[n.type] || '#888';
                ctx.fill();
                ctx.strokeStyle = _state.hoverNode === n.id ? '#fff' : '#333';
                ctx.lineWidth = _state.hoverNode === n.id ? 2 : 1;
                ctx.stroke();
                // name
                ctx.fillStyle = '#fff';
                ctx.font = LABEL_FONT;
                ctx.textAlign = 'center';
                ctx.fillText(n.name.slice(0, 12), n.x, n.y + r + 14);
            }
        }

        // ---- 交互：点击节点 / 边 / 拖拽 ----
        function _hitTestNode(x, y) {
            // 反向遍历（顶层节点优先）
            for (let i = _state.nodes.length - 1; i >= 0; i--) {
                const n = _state.nodes[i];
                const r = NODE_RADIUS[n.type] || 18;
                const dx = x - n.x, dy = y - n.y;
                if (dx * dx + dy * dy <= r * r + 8) return n;
            }
            return null;
        }
        function _hitTestEdge(x, y) {
            // 检查点是否在某条边的邻近范围内
            for (const e of _state.edges) {
                const s = _state.nodes.find(n => n.id === e.source);
                const t = _state.nodes.find(n => n.id === e.target);
                if (!s || !t) continue;
                const dx = t.x - s.x, dy = t.y - s.y;
                const len2 = dx * dx + dy * dy;
                if (len2 === 0) continue;
                const tProj = ((x - s.x) * dx + (y - s.y) * dy) / len2;
                if (tProj < 0 || tProj > 1) continue;
                const px = s.x + tProj * dx;
                const py = s.y + tProj * dy;
                const ddx = x - px, ddy = y - py;
                if (ddx * ddx + ddy * ddy < 64) return e;
            }
            return null;
        }

        function _bindCanvas() {
            const canvas = _state.canvas;
            if (!canvas) return;
            canvas.addEventListener('mousedown', (e) => {
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const node = _hitTestNode(x, y);
                if (node) {
                    _state.dragging = { nodeId: node.id, dx: x - node.x, dy: y - node.y };
                    _state.selected = null;
                    _render();
                    _renderDetail();
                    return;
                }
                const edge = _hitTestEdge(x, y);
                if (edge) {
                    _state.selected = edge.relId;
                    _state.dragging = null;
                    _render();
                    _renderDetail();
                    return;
                }
                _state.selected = null;
                _render();
                _renderDetail();
            });
            canvas.addEventListener('mousemove', (e) => {
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                if (_state.dragging) {
                    const n = _state.nodes.find(nn => nn.id === _state.dragging.nodeId);
                    if (n) { n.x = x - _state.dragging.dx; n.y = y - _state.dragging.dy; _render(); }
                    return;
                }
                const node = _hitTestNode(x, y);
                const newHover = node ? node.id : null;
                if (newHover !== _state.hoverNode) {
                    _state.hoverNode = newHover;
                    _render();
                }
            });
            canvas.addEventListener('mouseup', () => { _state.dragging = null; });
            canvas.addEventListener('mouseleave', () => { _state.dragging = null; });
            window.addEventListener('resize', () => {
                if (!_state.canvas) return;
                _state.width = canvas.clientWidth;
                _state.height = canvas.clientHeight;
                canvas.width = _state.width;
                canvas.height = _state.height;
                _render();
            });
        }

        function _renderDetail() {
            let panel = document.getElementById('relationsDetailPanel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'relationsDetailPanel';
                panel.className = 'rel-detail-panel';
                _state.canvas.parentElement.appendChild(panel);
            }
            if (!_state.selected) { panel.innerHTML = ''; return; }
            const rel = _state.relations.find(r => r.id === _state.selected);
            if (!rel) { panel.innerHTML = ''; return; }
            panel.innerHTML = `
                <div class="rel-row"><strong>类型</strong> ${_esc(rel.sourceType)} → ${_esc(rel.targetType)}</div>
                <div class="rel-row"><strong>关系</strong> ${_esc(rel.label || '(无标签)')}</div>
                <div class="rel-row"><strong>强度</strong> ${rel.strength}/10</div>
                <div class="rel-row"><strong>来源</strong> ${_esc(rel.source || 'manual')}</div>
                ${rel.chapterNo ? `<div class="rel-row"><strong>章节</strong> 第${rel.chapterNo}章</div>` : ''}
                <div class="rel-row"><strong>源</strong> ${_esc(rel.sourceName)}</div>
                <div class="rel-row"><strong>目标</strong> ${_esc(rel.targetName)}</div>
                <div class="rel-actions">
                    <button id="relBtnDelete">删除</button>
                </div>
            `;
            const btn = document.getElementById('relBtnDelete');
            if (btn) {
                btn.addEventListener('click', async () => {
                    if (!confirm('确认删除这条关系？')) return;
                    const r = await window.api.ainovel.deleteRelation(rel.id);
                    if (r && r.ok) {
                        panel.innerHTML = '';
                        await render();
                    }
                });
            }
        }

        function _esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        async function render(novelId) {
            _state.novelId = novelId;
            const tab = document.getElementById('novelTabRelations');
            if (!tab) return;
            tab.innerHTML = `
                <div class="relations-toolbar">
                    <button id="relBtnReload"><i class="fa-solid fa-arrows-rotate"></i> 重载</button>
                    <button id="relBtnRelayout"><i class="fa-solid fa-diagram-project"></i> 重新布局</button>
                    <span class="rel-count" id="relCount"></span>
                </div>
                <div class="relations-canvas-wrap">
                    <canvas id="relationsCanvas"></canvas>
                    <div class="rel-legend">
                        <div class="rel-legend-item"><span class="rel-legend-dot character"></span>角色</div>
                        <div class="rel-legend-item"><span class="rel-legend-dot organization"></span>组织</div>
                        <div class="rel-legend-item"><span class="rel-legend-dot worldview"></span>世界</div>
                    </div>
                </div>
            `;
            _state.canvas = document.getElementById('relationsCanvas');
            const wrap = _state.canvas.parentElement;
            _state.width = wrap.clientWidth;
            _state.height = wrap.clientHeight;
            _state.canvas.width = _state.width;
            _state.canvas.height = _state.height;
            _state.ctx = _state.canvas.getContext('2d');

            await _loadAndDraw();

            document.getElementById('relBtnReload').addEventListener('click', async () => {
                await _loadAndDraw();
            });
            document.getElementById('relBtnRelayout').addEventListener('click', () => {
                // 重置位置后重新布局
                for (const n of _state.nodes) {
                    n.x = _state.width / 2 + (Math.random() - 0.5) * 200;
                    n.y = _state.height / 2 + (Math.random() - 0.5) * 200;
                    n.vx = 0; n.vy = 0;
                }
                _layout({ nodes: _state.nodes, edges: _state.edges }, _state.width, _state.height);
                _render();
            });
        }

        async function _loadAndDraw() {
            const list = await window.api.ainovel.listRelations(_state.novelId);
            _state.relations = list || [];
            const graph = _buildGraph(_state.relations);
            _state.nodes = graph.nodes;
            _state.edges = graph.edges;
            _layout({ nodes: _state.nodes, edges: _state.edges }, _state.width, _state.height);
            const countEl = document.getElementById('relCount');
            if (countEl) {
                countEl.textContent = `${_state.nodes.length} 节点 / ${_state.edges.length} 关系`;
                if (_state.nodes.length === 0) {
                    countEl.textContent += '（空）';
                    _state.ctx.fillStyle = '#888';
                    _state.ctx.font = '14px sans-serif';
                    _state.ctx.textAlign = 'center';
                    _state.ctx.fillText('暂无关系数据。运行小说后由 relation-extractor 自动抽取。',
                        _state.width / 2, _state.height / 2);
                    return;
                }
            }
            _render();
            _renderDetail();
        }

        window.RelationsPanel = {
            render,
            _bindCanvas, // 测试用
        };
    }
})();