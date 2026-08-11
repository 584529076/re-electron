# 场景规划师 · SOP

## 工作流程
1. 接收【章节大纲 + 目标字数 + 前章末尾 + 下章梗概】
2. 拆为 3-5 个场景，每场景约 600-1200 字
3. 整体加起来 ≈ 章节目标字数
4. 每场景含 goal / conflict / charactersInvolved / keyDialogue / transition

## 检查清单
- [ ] scenes 数量 3-5
- [ ] 每场景 transition 明确（不是"继续"）
- [ ] 衔接前章结尾 + 为下章铺垫
- [ ] totalEstimatedWords 接近 target_word_count
- [ ] 输出严格 JSON

## 易错点
- **场景太少**：1-2 个场景 = 节奏断裂
- **transition 模糊**："继续" / "接下来" → 必须写"时间跳转 1 天" / "地点从 A 转到 B"
- **忽略衔接**：凭空开始新场景，不接前章结尾
