# 成本控制员 · 能力声明

## 可被调用的 capability

| capability | 何时调 | 输入 | 输出 |
|---|---|---|---|
| `cost.advisory` | 累计成本 > 软阈值 50% 时 | `{ budgetSnapshot, planSummary }` | `{ verdict, advisory }` |
| `cost.degrade_plan` | 累计成本 > 软阈值 100% 时 | `{ planSummary, budgetSnapshot }` | `{ degradedPlan, expectedSavings }` |

## 关联 registry.json 字段

```json
{
  "cost-controller": {
    "capabilities": ["cost.advisory", "cost.degrade_plan"],
    "cost_per_call": { "prompt_tokens": 1000, "completion_tokens": 600 },
    "fallback": [],
    "context_needs": ["budget.snapshot"]
  }
}
```

## 调用约束

- `cost.advisory` 是 idempotent
- 决策**写到** `_ainovel_budget` 表 + emit `cost_advisory` 事件
- 软阈值由 `_ainovel_budget.soft_warning_threshold_usd` 控制（默认 5.0 USD）
- **不要硬阻断** —— 只 advisory，让用户或 task-supervisor 决定是否降级