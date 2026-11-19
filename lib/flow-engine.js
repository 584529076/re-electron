'use strict';
const model = require('../web/js/flow-model');
class FlowEngine {
    constructor(adapter) { this.adapter = adapter; this.state = { status: 'idle', nodes: {}, nodeOutputs: {}, results: [] }; }
    start(graph) {
        if (this.state.status === 'running') throw Error('已有工程正在运行');
        const snapshot = JSON.parse(JSON.stringify(graph)), catalog = this.adapter.catalog();
        const order = model.validate(snapshot,catalog);
        const job = { canceled: false, queueId: null }; this.job = job;
        this.state = { status:'running', nodes:{}, nodeOutputs:{}, results:[], error:'', startedAt:Date.now() };
        this.completion = this.execute(snapshot,order,catalog,job);
        return this.state;
    }
    async cancel() { if (!this.job || this.state.status !== 'running') return; this.job.canceled = true; if (this.job.queueId) await this.adapter.cancel(this.job.queueId); }
    async execute(graph,order,catalog,job) {
        const values = new Map(); let current;
        try {
            for (const node of order) {
                if (job.canceled) break;
                current = node.id; this.state.nodes[current] = 'running';
                const incoming = graph.edges.filter(e=>e.to===node.id);
                let output;
                if (node.kind === 'start') output = { kind:node.dataType, value:node.value };
                else if (node.kind === 'end' || node.kind === 'relay') output = values.get(incoming[0].from);
                else {
                    const formValues = Object.fromEntries(catalog[node.toolId].formFields.filter(f=>f.default !== undefined).map(f=>[f.id,model.defaultValue(f)]));
                    Object.assign(formValues,node.values || {});
                    for (const field of catalog[node.toolId].formFields) if (['image','video'].includes(model.fieldType(field)) && formValues[field.id] && !incoming.some(e=>e.input===field.id)) formValues[field.id] = await this.adapter.stage({ kind:model.fieldType(field), value:formValues[field.id] });
                    for (const edge of incoming) { const data=values.get(edge.from),port=model.ports(node,catalog).inputs.find(p=>p.id===edge.input); if (!data || data.kind !== port.type) throw Error('上游实际输出与输入类型不一致'); formValues[edge.input] = data.kind === 'text' ? data.value : await this.adapter.stage(data); }
                    if (job.canceled) break;
                    const queued = await this.adapter.enqueue({toolId:node.toolId,formValues});
                    if (!queued.ok) throw Error(queued.error || '任务提交失败');
                    job.queueId = queued.queueId;
                    if (job.canceled) { await this.adapter.cancel(job.queueId); break; }
                    for (;;) {
                        if (job.canceled) break;
                        const row = await this.adapter.row(job.queueId);
                        if (!row) throw Error('队列任务已被移除');
                        if (['failed','cancelled'].includes(row.status)) throw Error(row.error_msg || '工作流执行失败');
                        if (row.status === 'done') { output=await this.adapter.result(row); output.queueId=job.queueId; break; }
                        await new Promise(r=>setTimeout(r,this.adapter.pollMs || 500));
                    }
                    job.queueId = null;
                    if (job.canceled) break;
                    if (output.kind !== model.ports(node,catalog).outputs[0].type) throw Error('工作流实际输出与声明类型不一致');
                }
                values.set(node.id,output); this.state.nodes[node.id]='done';
                // 2026-11：保存每个节点的产物（含多产物）供编排画布节点卡片内回显
                if (node.kind === 'workflow') {
                    const arts = Array.isArray(output.artifacts) && output.artifacts.length
                        ? output.artifacts
                        : [{ kind: output.kind, src: output.value, text: output.kind === 'text' ? output.value : '' }];
                    this.state.nodeOutputs[node.id] = {
                        queueId: output.queueId || job.queueId || null,
                        artifacts: arts.map(a => ({
                            kind: a.kind, src: a.src || (a.kind === 'text' ? '' : a.value || ''),
                            text: a.text || '', mime: a.mime || '', filename: a.filename || '', size: a.size || 0,
                        })),
                    };
                }
                if (node.kind === 'end') this.state.results.push({ nodeId:node.id, kind:output.kind, text:output.kind==='text'?output.value:'', queueId:output.queueId || null, path:output.kind!=='text'&&!/^data:/.test(output.value || '')?output.value:'' });
            }
            this.state.status = job.canceled ? 'cancelled' : 'done';
        } catch (error) { this.state.status=job.canceled?'cancelled':'failed'; this.state.error=error.message; }
        finally { if (current && this.state.nodes[current]==='running') this.state.nodes[current]=this.state.status==='cancelled'?'cancelled':'failed'; this.state.finishedAt=Date.now(); }
    }
}
module.exports={FlowEngine};
