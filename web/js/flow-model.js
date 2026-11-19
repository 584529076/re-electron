(function (host) {
    'use strict';
    const types = ['text', 'image', 'video'];
    const labels = { text: '文本', image: '图片', video: '视频', any: '任意结果' };
    function defaultValue(field) {
        let value = field.default;
        if (field.type === 'number' && value != null && Number.isFinite(Number(value))) {
            value = Number(value);
            if (field.randomizable && value === -1) return value;
            if (field.min != null) value = Math.max(value,Number(field.min));
            if (field.max != null) value = Math.min(value,Number(field.max));
        }
        return value;
    }
    function fieldType(field) {
        if (types.includes(field.type)) return field.type;
        if (['textarea', 'string'].includes(field.type)) return 'text';
        if (field.type === 'file') return /^video\//.test(field.accept || '') ? 'video' : /^image\//.test(field.accept || '') ? 'image' : null;
        return null;
    }
    function ports(node, catalog) {
        if (node.kind === 'start') return { inputs: [], outputs: [{ id: 'out', type: node.dataType, label: labels[node.dataType] }] };
        if (node.kind === 'end') return { inputs: [{ id: 'in', type: 'any', label: '结果' }], outputs: [] };
        if (node.kind === 'relay') return { inputs: [{ id: 'in', type: node.dataType, label: labels[node.dataType] }], outputs: [{ id: 'out', type: node.dataType, label: labels[node.dataType] }] };
        const tool = catalog[node.toolId];
        if (node.kind !== 'workflow' || !tool || tool._broken || tool.broken) throw Error('工作流不可用：' + (node.toolId || node.kind));
        const outputs = [...new Set((tool.outputNodes || []).map(o => o.type))];
        if (outputs.length !== 1 || !types.includes(outputs[0])) throw Error('工作流需要声明单一的文本、图片或视频输出类型：' + tool.name);
        return { inputs: tool.formFields.filter(f => fieldType(f)).map(f => ({ id: f.id, type: fieldType(f), label: f.label || f.id })), outputs: [{ id: 'out', type: outputs[0], label: labels[outputs[0]] }] };
    }
    function checkEdge(graph, edge, catalog) {
        const from = graph.nodes.find(n => n.id === edge.from), to = graph.nodes.find(n => n.id === edge.to);
        if (!from || !to || from === to) throw Error('连线必须连接两个不同节点');
        const output = ports(from, catalog).outputs.find(p => p.id === edge.output), input = ports(to, catalog).inputs.find(p => p.id === edge.input);
        if (!output || !input) throw Error('连线端口不存在');
        if (input.type !== 'any' && input.type !== output.type) throw Error(`${labels[output.type]}不能接入${labels[input.type]}输入`);
        if (graph.edges.some(e => e !== edge && e.to === edge.to && e.input === edge.input)) throw Error('这个输入已连接，请先删除原连线');
        const visited = new Set(), stack = [edge.to];
        while (stack.length) { const id = stack.pop(); if (id === edge.from) throw Error('不能形成循环，请按从开始到结束的方向连接'); if (visited.has(id)) continue; visited.add(id); graph.edges.filter(e => e !== edge && e.from === id).forEach(e => stack.push(e.to)); }
        return true;
    }
    function validate(graph, catalog) {
        if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 100 || graph.edges.length > 500) throw Error('工程格式无效，最多支持 100 个节点、500 条连线');
        const ids = new Set();
        for (const n of graph.nodes) { if (typeof n.id !== 'string' || !n.id || ids.has(n.id)) throw Error('节点标识无效或重复'); ids.add(n.id); if (['start','relay'].includes(n.kind) && !types.includes(n.dataType)) throw Error('请选择节点的数据类型'); ports(n,catalog); }
        const starts = graph.nodes.filter(n => n.kind === 'start'), ends = graph.nodes.filter(n => n.kind === 'end');
        if (starts.length !== 1 || !ends.length) throw Error('工程必须有一个开始节点和至少一个结束节点');
        for (const edge of graph.edges) checkEdge(graph,edge,catalog);
        const walk = (initial, reverse) => { const seen = new Set(), stack = [...initial]; while(stack.length) { const id = stack.pop(); if(seen.has(id))continue; seen.add(id); graph.edges.filter(e => (reverse ? e.to : e.from) === id).forEach(e => stack.push(reverse ? e.from : e.to)); } return seen; };
        const reachable = walk([starts[0].id],false), productive = walk(ends.map(n=>n.id),true);
        for (const node of graph.nodes) {
            if (!reachable.has(node.id) || !productive.has(node.id)) throw Error('存在未连到开始或结束的节点：' + (node.name || node.toolId || node.kind));
            if (node.kind === 'start' && !String(node.value || '').trim()) throw Error('请填写开始节点的文本或选择媒体文件');
            if (node.kind === 'workflow') for (const field of catalog[node.toolId].formFields) {
                if (graph.edges.some(e => e.to === node.id && e.input === field.id)) continue;
                const value = node.values?.[field.id] ?? defaultValue(field);
                if (field.required && (value == null || value === '' || (Array.isArray(value) && !value.length))) throw Error(`${catalog[node.toolId].name}：请填写${field.label || field.id}`);
                if (field.type === 'number' && value != null && value !== '' && (!Number.isFinite(Number(value)) || (field.min != null && Number(value) < field.min && !(field.randomizable && Number(value) === -1)) || (field.max != null && Number(value) > field.max))) throw Error(`${field.label || field.id}超出允许范围`);
            }
        }
        const pending = [...graph.nodes], order = [], done = new Set();
        while(pending.length) { const index=pending.findIndex(n=>graph.edges.filter(e=>e.to===n.id).every(e=>done.has(e.from))); if(index<0)throw Error('连线包含循环'); const n=pending.splice(index,1)[0];order.push(n);done.add(n.id); }
        return order;
    }
    const api = { types, labels, defaultValue, fieldType, ports, checkEdge, validate };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else host.FlowModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
