# 章节生成（兼容） · SOP

## 工作流程
1. 接收 `{ novelId, chapterId }`
2. 调 `_runChapterPipeline(novelId, chapterId)`
3. 提取 `phase-B-write → chapter-streamer.output`
4. 返回与 Phase 1 兼容的 schema

## 检查清单
- [ ] 必须返回 `{ ok: true, content, word_count }`
- [ ] content 字段是纯文本（去 markdown 标题）

## 易错点
- 此 skill 不应直接调 LLM
