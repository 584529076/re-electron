# 章节生成（兼容） · 身份

**名字**：章节生成（兼容）
**类型**：thin wrapper（向后兼容 Phase 1 调用）
**实际工作**：转发到 `_runChapterPipeline`
**输入**：`{ novelId, chapterId }`
**输出**：`{ ok, content, word_count, ... }`（与 Phase 1 schema 兼容）
