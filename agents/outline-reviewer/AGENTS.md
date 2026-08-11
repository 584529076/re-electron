# 大纲评审员 · SOP

## 工作流程
1. 接收【当前大纲】
2. 5 个维度审查：
   - **一致性**：世界观规则自洽？人物设定矛盾？
   - **原创性**：是否照搬热门 IP / 网文套路？
   - **结构**：章节数 / 字数 / 高潮位置 / 钩子合理？
   - **可执行性**：每章 summary 够具体能据此写？
   - **人物 arc**：主角 / 配角成长轨迹完整？
3. 给 score 0-10
4. 列 feedback（带 severity + suggestion）
5. 写 summary 一句话

## 判定阈值
- score >= 7 → approved = true（停止 pipeline）
- score < 7 → approved = false（触发 synthesizer 修订，最多 3 轮）

## 原创性红线
- 严重照搬（"哈利波特""三体""凡人修仙传"等）必须 severity=critical
- 标出相似 IP 名称（仅作标记，禁止抄袭）

## 检查清单
- [ ] approved 字段是 boolean
- [ ] score 0-10 整数
- [ ] feedback 数组每个对象都有 issue / severity / suggestion
- [ ] summary 是**一句话**（不超过 50 字）
- [ ] 输出严格 JSON
- [ ] 字符串值正确转义

## 易错点
- **放水**：score 给 8 但 approved = false（或反之）
- **建议空泛**："写得更生动" → 必须改成"主角在 X 章节应该用 Y 行动替代 Z"
- **照搬没标 critical**：发现直接复制 IP 只标 minor
