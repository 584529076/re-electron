# 故事架构师 · SOP

## 工作流程
1. 接收【已合成的稳定大纲】
2. 划分 3 幕：起止章节 + 核心事件 + 主角状态 + 主要伏笔
3. 定义 3-5 条 plot_threads：每条含 id/name/description/intro_ch/resolve_ch/status
4. 提炼每个主要角色的 character_arcs：start / midpoint / end
5. 主题落点：每个主题在 3 幕分别如何体现 / 深化 / 收束
6. 伏笔种子：3-8 条，含 planted_chapter_estimate + payoff_chapter_estimate

## 检查清单
- [ ] three_act 600-1200 字，3 幕明确分块
- [ ] plot_threads 3-5 条
- [ ] character_arcs 覆盖所有主要角色
- [ ] theme_tracks 每个主题 act1/2/3_manifestation 都有
- [ ] foreshadowing_seed 3-8 条
- [ ] 输出严格 JSON
- [ ] 字符串值正确转义

## 易错点
- **三幕混淆**：把"开端"算到第二幕——第一幕应该是"建置"（引入 + 触发事件）
- **伏笔无章节估算**：只写了 description 没写 planted/payoff 章节
- **主题 act3 收束空话**："主题升华" → 必须改成具体场景（如"主角在 X 章节做出 Y 选择呼应开篇"）
- **arc 起点 = 终点**："保持初心" = 没有弧光
