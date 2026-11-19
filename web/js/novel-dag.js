// web/js/novel-dag.js
// Sprint 4: DAG 可视化渲染器（纯 SVG，无外部 d3 依赖）
//
// 输入：snapshot = { novelId, planName, tasks: [{id, capability, status, depends_on, agentName, attempt, ...}], edges: [{from, to}] }
// 输出：SVG 节点（圆角矩形按 status 染色）+ 边（带箭头）
// 交互：点击节点触发 'novel-dag:select' CustomEvent，detail 含完整 task 对象
//
// API：
//   NovelDag.mount(containerEl, opts?) → 返回 { setData(snapshot), destroy(), getNode(id) }
//   NovelDag.computeLayout(tasks, edges, opts?) → 返回 { positions: {id: {x, y, w, h}}, width, height }
//   NovelDag.STATUS_COLORS → {pending, in_progress, completed, failed, skipped}

(function (global) {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ARROW_MARKER_ID = 'novel-dag-arrow';

    const STATUS_COLORS = {
        pending:    { fill: '#475569', stroke: '#64748b', text: '#e2e8f0' },
        in_progress:{ fill: '#2563eb', stroke: '#60a5fa', text: '#ffffff' },
        completed:  { fill: '#16a34a', stroke: '#4ade80', text: '#ffffff' },
        failed:     { fill: '#dc2626', stroke: '#f87171', text: '#ffffff' },
        skipped:    { fill: '#ca8a04', stroke: '#facc15', text: '#ffffff' },
    };

    const DEFAULT_OPTS = {
        nodeWidth: 180,
        nodeHeight: 60,
        hGap: 80,           // 列间距
        vGap: 24,           // 行间距
        padding: 20,        // 容器内边距
        virtualScrollThreshold: 50,  // 超过此节点数启用虚拟滚动
        maxRenderNodes: 200,         // 单次渲染上限（超过截断并提示）
        statusIcons: {
            pending: '○',
            in_progress: '◐',
            completed: '●',
            failed: '✕',
            skipped: '⊘',
        },
    };

    // ===== 布局算法 =====
    /**
     * 分层布局（类似 dagre-lite）：
     * 1) 计算每个节点的"层号"（从根节点出发的最长路径）
     * 2) 同层节点按 id 稳定排序
     * 3) 每层 y 轴均匀分布，x 轴按层索引定位
     *
     * 复杂度：O(V + E)，单次扫描
     * @param {Array<{id, depends_on: string[]}>} tasks
     * @param {Array<{from, to}>} edges
     * @param {object} opts
     * @returns {{positions: Record<string, {x, y, w, h, layer, rowInLayer}>, width: number, height: number}}
     */
    function computeLayout(tasks, edges, opts) {
        opts = Object.assign({}, DEFAULT_OPTS, opts || {});
        const byId = new Map();
        for (const t of tasks) byId.set(t.id, t);

        // 拓扑层级：每个节点的层号 = max(deps 的层号) + 1
        const layer = new Map();
        const visiting = new Set();      // 检测环
        const onStack = new Set();
        function depthOf(id) {
            if (layer.has(id)) return layer.get(id);
            if (visiting.has(id)) {
                // 防御：环检测（前端 layout 不应遇到，但容错）
                if (!onStack.has(id)) return 0;
                // 真环 → 0 层（避免无限递归）
                return 0;
            }
            visiting.add(id);
            onStack.add(id);
            const t = byId.get(id);
            let d = 0;
            if (t && Array.isArray(t.depends_on)) {
                for (const dep of t.depends_on) {
                    if (!byId.has(dep)) continue;
                    d = Math.max(d, depthOf(dep) + 1);
                }
            }
            onStack.delete(id);
            visiting.delete(id);
            layer.set(id, d);
            return d;
        }
        for (const t of tasks) depthOf(t.id);

        // 按 layer 分组
        const layers = [];
        for (const t of tasks) {
            const d = layer.get(t.id) || 0;
            if (!layers[d]) layers[d] = [];
            layers[d].push(t);
        }
        // 每层按 id 稳定排序
        for (const arr of layers) {
            if (!arr) continue;
            arr.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        }

        // 算坐标
        const positions = {};
        let maxRow = 0;
        for (let d = 0; d < layers.length; d++) {
            const arr = layers[d] || [];
            if (!arr.length) continue;
            const colW = opts.nodeWidth + opts.hGap;
            for (let i = 0; i < arr.length; i++) {
                const t = arr[i];
                positions[t.id] = {
                    x: opts.padding + d * colW,
                    y: opts.padding + i * (opts.nodeHeight + opts.vGap),
                    w: opts.nodeWidth,
                    h: opts.nodeHeight,
                    layer: d,
                    rowInLayer: i,
                };
                if (i > maxRow) maxRow = i;
            }
        }

        const width = opts.padding * 2 + layers.length * opts.nodeWidth + Math.max(0, layers.length - 1) * opts.hGap;
        const height = opts.padding * 2 + (maxRow + 1) * opts.nodeHeight + Math.max(0, maxRow) * opts.vGap;

        return { positions, width, height, layers: layers.map(a => (a || []).length) };
    }

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function createSvg(opts) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('xmlns', SVG_NS);
        svg.classList.add('novel-dag-svg');
        // 箭头 marker
        const defs = document.createElementNS(SVG_NS, 'defs');
        const marker = document.createElementNS(SVG_NS, 'marker');
        marker.setAttribute('id', ARROW_MARKER_ID);
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '9');
        marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '8');
        marker.setAttribute('markerHeight', '8');
        marker.setAttribute('orient', 'auto-start-reverse');
        const arrowPath = document.createElementNS(SVG_NS, 'path');
        arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
        arrowPath.setAttribute('fill', '#94a3b8');
        marker.appendChild(arrowPath);
        defs.appendChild(marker);
        svg.appendChild(defs);
        return svg;
    }

    function buildEdgePath(from, to) {
        // 从 from 节点右边缘中点 → to 节点左边缘中点；折线（横-竖-横）
        const sx = from.x + from.w;
        const sy = from.y + from.h / 2;
        const tx = to.x;
        const ty = to.y + to.h / 2;
        const midX = (sx + tx) / 2;
        return `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${ty} L ${tx} ${ty}`;
    }

    // ===== Renderer =====
    function createRenderer(container, opts) {
        opts = Object.assign({}, DEFAULT_OPTS, opts || {});
        container.classList.add('novel-dag-host');
        const svg = createSvg(opts);
        container.appendChild(svg);
        const edgesLayer = document.createElementNS(SVG_NS, 'g');
        edgesLayer.classList.add('novel-dag-edges');
        const nodesLayer = document.createElementNS(SVG_NS, 'g');
        nodesLayer.classList.add('novel-dag-nodes');
        svg.appendChild(edgesLayer);
        svg.appendChild(nodesLayer);

        let currentSnapshot = null;
        let currentLayout = null;
        const nodeIndex = new Map();   // id → {g, data}

        function clear() {
            edgesLayer.innerHTML = '';
            nodesLayer.innerHTML = '';
            nodeIndex.clear();
        }

        function renderEdges(edges, positions) {
            const frag = document.createDocumentFragment();
            for (const e of edges) {
                const f = positions[e.from], t = positions[e.to];
                if (!f || !t) continue;
                const p = document.createElementNS(SVG_NS, 'path');
                p.setAttribute('d', buildEdgePath(f, t));
                p.setAttribute('stroke', '#94a3b8');
                p.setAttribute('stroke-width', '1.5');
                p.setAttribute('fill', 'none');
                p.setAttribute('marker-end', `url(#${ARROW_MARKER_ID})`);
                p.classList.add('novel-dag-edge');
                // 按 source 节点状态染色（completed 时边变绿；失败变红）
                const sourceStatus = currentSnapshot && currentSnapshot.tasks.find(x => x.id === e.from);
                if (sourceStatus) {
                    p.classList.add(`novel-dag-edge-${sourceStatus.status}`);
                }
                frag.appendChild(p);
            }
            edgesLayer.appendChild(frag);
        }

        function renderNodes(tasks, positions) {
            const frag = document.createDocumentFragment();
            for (const t of tasks) {
                const pos = positions[t.id];
                if (!pos) continue;
                const color = STATUS_COLORS[t.status] || STATUS_COLORS.pending;
                const icon = opts.statusIcons[t.status] || '?';

                const g = document.createElementNS(SVG_NS, 'g');
                g.classList.add('novel-dag-node');
                g.classList.add(`novel-dag-node-${t.status || 'pending'}`);
                g.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
                g.setAttribute('data-task-id', t.id);
                g.setAttribute('tabindex', '0');
                g.setAttribute('role', 'button');

                // 矩形
                const rect = document.createElementNS(SVG_NS, 'rect');
                rect.setAttribute('width', pos.w);
                rect.setAttribute('height', pos.h);
                rect.setAttribute('rx', '8');
                rect.setAttribute('ry', '8');
                rect.setAttribute('fill', color.fill);
                rect.setAttribute('stroke', color.stroke);
                rect.setAttribute('stroke-width', '1.5');
                g.appendChild(rect);

                // 状态图标（左上角）
                const iconText = document.createElementNS(SVG_NS, 'text');
                iconText.setAttribute('x', '12');
                iconText.setAttribute('y', '20');
                iconText.setAttribute('fill', color.text);
                iconText.setAttribute('font-size', '14');
                iconText.setAttribute('font-weight', '600');
                iconText.textContent = icon;
                g.appendChild(iconText);

                // 主标题（task id）
                const idText = document.createElementNS(SVG_NS, 'text');
                idText.setAttribute('x', '32');
                idText.setAttribute('y', '20');
                idText.setAttribute('fill', color.text);
                idText.setAttribute('font-size', '12');
                idText.setAttribute('font-weight', '700');
                idText.textContent = String(t.id).length > 18 ? String(t.id).slice(0, 16) + '…' : String(t.id);
                g.appendChild(idText);

                // capability
                const capText = document.createElementNS(SVG_NS, 'text');
                capText.setAttribute('x', '12');
                capText.setAttribute('y', '40');
                capText.setAttribute('fill', color.text);
                capText.setAttribute('font-size', '11');
                capText.setAttribute('opacity', '0.9');
                capText.textContent = String(t.capability || '').length > 24 ? String(t.capability).slice(0, 22) + '…' : String(t.capability || '');
                g.appendChild(capText);

                // 副标题（agent）
                if (t.agentName) {
                    const agText = document.createElementNS(SVG_NS, 'text');
                    agText.setAttribute('x', '12');
                    agText.setAttribute('y', '54');
                    agText.setAttribute('fill', color.text);
                    agText.setAttribute('font-size', '10');
                    agText.setAttribute('opacity', '0.8');
                    const ag = String(t.agentName);
                    agText.textContent = ag.length > 26 ? ag.slice(0, 24) + '…' : ag;
                    g.appendChild(agText);
                }

                // in_progress 进度条（在底边）
                if (t.status === 'in_progress') {
                    const pbBg = document.createElementNS(SVG_NS, 'rect');
                    pbBg.setAttribute('x', '0');
                    pbBg.setAttribute('y', String(pos.h - 3));
                    pbBg.setAttribute('width', String(pos.w));
                    pbBg.setAttribute('height', '3');
                    pbBg.setAttribute('fill', 'rgba(255,255,255,0.25)');
                    g.appendChild(pbBg);
                    const pb = document.createElementNS(SVG_NS, 'rect');
                    pb.setAttribute('x', '0');
                    pb.setAttribute('y', String(pos.h - 3));
                    pb.setAttribute('width', String(pos.w * 0.5));   // 未知进度，固定 50%
                    pb.setAttribute('height', '3');
                    pb.setAttribute('fill', '#ffffff');
                    pb.classList.add('novel-dag-progress');
                    g.appendChild(pb);
                }

                // 交互
                g.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    container.dispatchEvent(new CustomEvent('novel-dag:select', {
                        detail: { task: t, position: pos },
                        bubbles: true,
                    }));
                });
                g.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        g.dispatchEvent(new MouseEvent('click'));
                    }
                });

                frag.appendChild(g);
                nodeIndex.set(t.id, { g, data: t });
            }
            nodesLayer.appendChild(frag);
        }

        function setData(snapshot) {
            if (!snapshot) {
                clear();
                currentSnapshot = null;
                currentLayout = null;
                return;
            }
            if (typeof snapshot === 'string') snapshot = JSON.parse(snapshot);

            // 截断（防止一次渲染过多节点拖垮浏览器）
            const total = snapshot.tasks.length;
            const truncated = total > opts.maxRenderNodes;
            const tasks = truncated ? snapshot.tasks.slice(0, opts.maxRenderNodes) : snapshot.tasks;
            const ids = new Set(tasks.map(t => t.id));
            const edges = (snapshot.edges || []).filter(e => ids.has(e.from) && ids.has(e.to));

            currentSnapshot = { ...snapshot, tasks, edges };
            currentLayout = computeLayout(tasks, edges, opts);

            svg.setAttribute('viewBox', `0 0 ${currentLayout.width} ${currentLayout.height}`);
            svg.setAttribute('width', String(currentLayout.width));
            svg.setAttribute('height', String(currentLayout.height));

            clear();
            renderEdges(edges, currentLayout.positions);
            renderNodes(tasks, currentLayout.positions);

            if (truncated) {
                const note = document.createElement('div');
                note.className = 'novel-dag-truncated-note';
                note.textContent = `节点数 ${total} 超过 ${opts.maxRenderNodes} 上限，仅渲染前 ${opts.maxRenderNodes} 个`;
                container.appendChild(note);
            }
        }

        function updateNode(taskId, patch) {
            const entry = nodeIndex.get(taskId);
            if (!entry) return;
            Object.assign(entry.data, patch);
            // 简化：仅重渲染该节点；为安全起见重渲染整图（节点数受限，性能可接受）
            setData(currentSnapshot);
        }

        function getNode(taskId) {
            const e = nodeIndex.get(taskId);
            return e ? e.data : null;
        }

        function destroy() {
            clear();
            if (svg.parentNode) svg.parentNode.removeChild(svg);
            container.classList.remove('novel-dag-host');
            currentSnapshot = null;
            currentLayout = null;
        }

        return { setData, updateNode, getNode, destroy, svg };
    }

    global.NovelDag = {
        STATUS_COLORS,
        DEFAULT_OPTS,
        computeLayout,
        mount: createRenderer,
        _escHtml: escHtml,
    };
})(window);