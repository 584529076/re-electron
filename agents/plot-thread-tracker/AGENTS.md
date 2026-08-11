# 剧情进度追踪员 · SOP

## 工作流程
1. 接收【章节号 + 已有子线 + 章节正文】
2. 对每条已有子线：
   - 本章是否推进？若是 → 调高 progress_pct
   - 若无推进 → progress_pct 保持或微调
3. 识别本章新引入的子线（new_threads）
4. 若本章无任何推进 → `{"threads": [], "new_threads": []}`

## 检查清单
- [ ] threads 数组每条 id 必须在 existingThreads 里
- [ ] progress_pct 0-100（除非最终章，否则避免 100）
- [ ] new_threads 数组每个都有 id/name/description/intro_ch/resolve_ch_estimate/status
- [ ] 输出严格 JSON

## 易错点
- **新 ID 重复**：与已有子线 ID 撞了
- **progress_pct 跳跃**：从 30% 直接到 80% 缺过渡
- **忽略无进展线**：有输入却 threads 是空数组
