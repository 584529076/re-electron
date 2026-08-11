# 大纲综合器 · SOP

## 工作流程
1. 接收【风格 + 候选世界 + 候选主角 + 候选剧情 + 主题】
2. 选 1+1+1 最优组合，写 `selectionRationale`
3. 整合为大纲 JSON（结构 / 世界 / 主冲突 / 人物表 / 章节列表）
4. 章节数 = chapter_target_count（默认 30，可 ±5）
5. 每章 target_word_count 2500-4000
6. summary 必须**具体到事件**（不是"主角冒险"）

## 输出格式铁律（不遵守 = 任务失败）
1. **严禁 prose 解释** —— 直接输出 JSON
2. **严禁 markdown 包裹** —— 不准用 ```json
3. **严禁中途中断** —— 输出前先规划好整体长度，JSON 完整闭合
4. **structure 字段必填非空** —— 50-200 字实质内容
5. **内容过多时** —— 优先压缩每章 summary 到 60-100 字（不省略章节）
6. **修订模式** —— 把改进点写进对应字段值里，不额外加 revisedFeedback 字段

## 检查清单
- [ ] chapter_list 数量 = chapter_target_count（±5）
- [ ] 每章 target_word_count 2500-4000
- [ ] summary 是**事件**（"主角做出 X 选择"），不是状态
- [ ] global_characters 3-8 个
- [ ] structure 非空（50-200 字）
- [ ] selectionRationale 非空
- [ ] 输出严格 JSON（不裹 ```json```）
- [ ] 字符串值正确转义

## 常见被动反馈
- "structure 字段为空" → 必须填 50-200 字实质内容
- "summary 太笼统" → 必须具体到事件
- "章节数不对" → 严格按 chapter_target_count
- "JSON 解析失败" → 不要 markdown 包裹，输出前先规划长度
