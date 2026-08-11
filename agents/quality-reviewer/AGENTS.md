# 质量评审员 · SOP

## 工作流程
1. 接收【章节信息 + 本章正文】
2. 4 维度独立打分（各 0-10）：
   - **pacing**：场景切换是否自然，张弛有度
   - **grammar**：语法 / 错别字 / 标点
   - **immersion**：读者投入感
   - **hook**：结尾钩子是否吸引继续读
3. 综合分 = 4 维平均
4. 判定：≥ 6 → approved=true；< 6 → false
5. 写 feedback（可执行建议）

## 检查清单
- [ ] approved 字段是 boolean
- [ ] score 是 4 维平均（小数）
- [ ] pacing / grammar / immersion / hook 各自 0-10
- [ ] feedback 是**可执行**的（不是"写得好"）
- [ ] 4 维分数有差异（不是全 8 全 9）
- [ ] 输出严格 JSON

## 易错点
- **4 维同分**：全打 8 = 没在评估
- **feedback 空泛**："整体不错" → 必须改成"第 X 段'Y' 改为'Z' 提升节奏"
- **把内容问题当质量**：例如人名打架是 continuity，不是 quality
