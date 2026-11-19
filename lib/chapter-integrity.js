'use strict';

const { createHash } = require('crypto');
const REVIEWERS = ['continuity-checker', 'style-editor', 'quality-reviewer'];
const hash = value => createHash('sha256').update(String(value || '')).digest('hex');

function reviewOutput(parsed, name) {
    if (!parsed || typeof parsed.approved !== 'boolean' ||
        (name && name !== 'quality-reviewer' && !Array.isArray(parsed.issues)) ||
        (name === 'quality-reviewer' && (!Number.isFinite(parsed.score) || parsed.score < 0 || parsed.score > 10)) ||
        (parsed.issues !== undefined && (!Array.isArray(parsed.issues) || parsed.issues.some(i =>
            !i || !['critical', 'major', 'minor'].includes(i.severity) || typeof i.detail !== 'string')))) {
        return { approved: false, __error: '审查结果不完整，需要重新检查', issues: [] };
    }
    return parsed;
}

function blockingReviews(reviews) {
    return REVIEWERS.filter(name => {
        const result = reviews && reviews[name];
        if (!result || result.__error || !result.output) return true;
        const out = reviewOutput(result.output, name);
        return out.__error || out.approved !== true ||
            (name === 'quality-reviewer' && out.score < 6) ||
            (out.issues || []).some(i => i.severity === 'critical' || i.severity === 'major');
    });
}

function validateHandoff(parsed, content) {
    if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim() ||
        !['time', 'location', 'pov', 'narrative_voice'].every(k => typeof parsed[k] === 'string') ||
        !['present_characters', 'open_actions'].every(k => Array.isArray(parsed[k]) && parsed[k].every(v => typeof v === 'string'))) {
        throw new Error('章节交接记录不完整，草稿已保留，请重试保存');
    }
    return { ...parsed, content_hash: hash(content), tail: String(content).slice(-1500), version: 1 };
}

function boundary(chapter) {
    if (!chapter) return '【章节交接】这是第一章。';
    let saved;
    try { saved = JSON.parse(chapter.handoff_json || 'null'); } catch { /* legacy */ }
    const valid = saved && saved.content_hash === hash(chapter.content) && !chapter.continuity_dirty;
    return `【章节交接：第 ${chapter.chapter_no} 章】\n` +
        (valid ? `已确认交接记录：${JSON.stringify(saved)}\n` : '旧章尚无有效交接记录，以实际正文为准，不把大纲当成已发生事实。\n') +
        `前章末尾原文：\n${String(chapter.content || '').slice(-1500)}\n` +
        '承接未完成的动作、对话、人物知识和情绪；允许有明确叙事依据的转场或视角切换。无需机械重述五要素。';
}

function statePatch(state, chapterNo, handoff, outputs) {
    const read = (name, fields) => {
        const result = outputs[name];
        const out = result && result.output;
        if (!out || result.__error || out.__error || !fields.every(k => Array.isArray(out[k]))) {
            throw new Error(`${name} 状态提取失败，草稿已保留`);
        }
        for (const field of fields) {
            if (out[field].some(v => !v || typeof v !== 'object' || !(name === 'character-state-updater' ? v.name : v.id))) {
                throw new Error(`${name} 状态条目缺少名称或 ID`);
            }
        }
        return out;
    };
    const chars = read('character-state-updater', ['updates']);
    const threads = read('plot-thread-tracker', ['threads', 'new_threads']);
    const fores = read('foreshadowing-extractor', ['planted', 'paid']);
    const character_states = { ...(state.character_states || {}) };
    for (const change of chars.updates) {
        character_states[change.name] = { ...character_states[change.name], ...change, last_chapter: chapterNo };
    }
    const merge = (existing, changes) => {
        const map = new Map(existing.map(v => [v.id, { ...v }]));
        for (const change of changes) map.set(change.id, { ...map.get(change.id), ...change });
        return [...map.values()];
    };
    return {
        character_states,
        active_plot_threads: merge(state.active_plot_threads || [], [...threads.threads, ...threads.new_threads]),
        planted_foreshadowing: merge(state.planted_foreshadowing || [], [...fores.planted, ...fores.paid.map(f => ({ ...f, status: 'paid' }))]),
        retired_characters: [...new Set([...(state.retired_characters || []), ...chars.updates.filter(c => c.status === 'dead').map(c => c.name)])],
        global_summary: [state.global_summary, `第${chapterNo}章：${handoff.summary}`].filter(Boolean).join('\n').split('\n').slice(-5).join('\n'),
        last_chapter_no: chapterNo,
    };
}

// One IPC/database update per batch. Always flush the final partial batch.
function batchChunks(send, interval = 80) {
    let timer = null, pending = '', full = '';
    const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!pending) return;
        const chunk = pending;
        pending = '';
        send(chunk, full);
    };
    const push = (chunk, accumulated) => {
        pending += chunk || '';
        full = accumulated == null ? full + (chunk || '') : accumulated;
        if (!timer) timer = setTimeout(flush, interval);
    };
    return { push, flush };
}

module.exports = { REVIEWERS, hash, reviewOutput, blockingReviews, validateHandoff, boundary, statePatch, batchChunks };
