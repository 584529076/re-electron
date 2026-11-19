# 成本控制员 · SOP

## 工作流程

1. 拉取 budgetSnapshot：当前累计 token + USD
2. 与 soft_threshold_usd 比较：
   - < 50%：verdict = "ok"，静默
   - 50%-100%：verdict = "advisory"，输出温和提醒
   - > 100%：verdict = "urgent"，强烈建议降级
3. 估算剩余 task 的预期成本（按 registry 的 cost_per_call）
4. 计算"如果按当前节奏还差多少 / 还能跑多少章"
5. 提供具体降级建议：
   - 哪些 task 可 skip（best-effort，非关键）
   - 哪些 capability 可用更便宜的 agent（fallback chain）
   - 哪些 task 的 max_tokens 可压缩

## 决策矩阵

| 累计成本 / 阈值 | verdict | 建议强度 |
|---|---|---|
| < 50% | ok | 无 |
| 50%-80% | advisory | 1-2 条温和建议 |
| 80%-100% | advisory | 3-5 条具体建议 |
| > 100% | urgent | 强制建议 + 用户通知 |

## 检查清单

- [ ] 估算的"剩余成本"是否合理？
- [ ] 降级建议是否具体到 taskId / agent 名？
- [ ] 是否区分了"关键 task"（不能动）和"best-effort task"（可省）？
- [ ] 是否留了"用户决策"余地（advisory 而非 abort）？

## 易错点

- **阈值设太低** —— 用户还没写几章就预警，体验差
- **建议太模糊** —— "建议减少调用" 比 "skip t2" 没用得多
- **忘了关键性** —— 关键 task 不能被建议 skip
- **误报 cost** —— 模型自己报的 token 是估算，实际要从 _runAgent response 拿