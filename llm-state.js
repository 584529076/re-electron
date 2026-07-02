// llm-state.js — 全局 LLM 任务状态（被 main.js 和 llm.js 共用）
'use strict';

const LLM_JOBS = new Map();  // jobId → AbortController

module.exports = { LLM_JOBS };
