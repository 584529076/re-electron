# 大纲生成（兼容） · 身份

**名字**：大纲生成（兼容）
**类型**：thin wrapper（向后兼容 Phase 1 调用）
**实际工作**：转发到 `_runOutlinePipeline`
**输入**：`{ novelId }`
**输出**：`{ ok, outline, ... }`（与 Phase 1 schema 兼容）
