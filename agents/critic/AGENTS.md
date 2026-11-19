# 评审员 · SOP

## 工作流程

1. 接收 failed task 的完整 context（capability / input / attempts / error message）
2. 评估错误类型：
   - `parse_failed`：JSON 解析失败 → 通常 recoverable（修 input）
   - `llm_timeout`：LLM 超时 → recoverable（重试）
   - `llm_refused`：LLM 拒绝回答 → partially_recoverable（换 prompt 角度）
   - `validation_failed`：output 不符合 schema → recoverable（修 input）
   - `repeated_failure`：同类 task 3+ 次都失败 → fatal
3. 检查该 task 在 plan 中的位置：关键任务还是 best-effort？
4. 估算修复成本（按当前 cost_per_call 算）
5. 输出 verdict + 建议 + 估算成本 + confidence

## 决策矩阵

| 错误类型 | 尝试次数 | 关键性 | verdict | action |
|---|---|---|---|---|
| parse_failed | 1-2 | 关键 | yes | retry + simplify input |
| parse_failed | 3+ | 关键 | partial | reassign |
| llm_timeout | 1-2 | any | yes | retry |
| llm_refused | 1-2 | any | partial | retry + 改 user prompt |
| repeated | 3+ | 关键 | no | reassign |
| repeated | 3+ | non-critical | no | skip |
| validation_failed | 1-2 | any | yes | retry + 加 schema hint |
| any | 1 | non-critical | yes | retry |

## 检查清单

- [ ] 是否区分了 recoverable 与 fatal？
- [ ] 修复成本估算是否合理（与 cost_per_call 对齐）？
- [ ] reassign 时是否给出 fallback agent 候选？
- [ ] abort 时是否同时建议"哪些 task 可保留"？

## 易错点

- **confidence 永远给 0.9+** —— 没用，置信度应该反映真实不确定性
- **每次都建议 retry** —— 用户会感觉"agent 在空转"
- **不考虑 task 在 plan 中的角色** —— 关键 task 失败和 best-effort 失败的处理应该不同
- **abort 太草率** —— LLM provider 抽风 1 次不该 abort