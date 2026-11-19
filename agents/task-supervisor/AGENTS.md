# 任务监督员 · SOP

## 工作流程

1. 拉取当前 plan 状态（task 列表 + 每个 task 的 status / output）
2. 检查是否有 failed task —— 是 recoverable 还是 fatal？
3. 检查 plan 整体进度 —— 关键任务是否都已完成？
4. 检查成本预算 —— 累计 token / USD 是否超出软阈值？
5. 输出 verdict（continue / replan / skip / abort）
6. 写一条 shared_context：`shared.supervision.{phase}`，importance = 9

## 决策矩阵

| 场景 | verdict | 理由模板 |
|---|---|---|
| 关键 task 失败，重试 2 次后还失败 | `replan` | 切换到 fallback agent |
| 非关键 task 失败 | `skip` | 标记 skipped，记入 memory |
| 累计成本 > 软阈值 | `continue` 但 `nextActions: [{action: "advisory", ...}]` | 让 cost-controller 介入 |
| 用户手动暂停 | `abort` | 等用户决定 |
| 计划全部完成 | `continue` 但 verdict = "phase_complete" | 让下一阶段自动启动 |
| LLM 返回非法 JSON / parseFailed | `continue` 但 nextActions 含 "fallback_static_plan" | 切到 buildOutlinePlan |

## 检查清单

- [ ] 是否区分了 recoverable vs fatal failure？
- [ ] nextActions 是否按"最便宜的修复"排序？
- [ ] 决策是否写到 shared_context？
- [ ] abort 决策是否同时 emit `plan_paused` 事件？

## 易错点

- **把所有失败都报为 abort** —— 用户会觉得 agent 太脆弱
- **静默 skip 关键 task** —— 用户没看到就发现章节缺失
- **不写 shared_context** —— 下游 agent 不知道为什么 task 被 skip
- **over-replan** —— 不要因为一个 task 失败就重排整个 plan