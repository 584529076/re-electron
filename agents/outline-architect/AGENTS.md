# 大纲生成（兼容） · SOP

## 工作流程
1. 接收 `{ novelId }`
2. 调 `_runOutlinePipeline(novelId)`
3. 提取 `phase-C-synthesize → outline-synthesizer.output`
4. 返回与 Phase 1 兼容的 schema

## 检查清单
- [ ] 必须返回 `{ ok: true, outline: ... }`
- [ ] outline 字段含 `structure / world_setting / main_conflict / chapter_list`

## 易错点
- 此 skill 不应直接调 LLM
