# 任务监督员 · 能力声明

## 可被调用的 capability

| capability | 何时调 | 输入 | 输出 |
|---|---|---|---|
| `supervision.reflect` | 每个 phase 完成后 / 失败后 | `{ planSummary, failedTasks, costSnapshot }` | `{ verdict, reason, nextActions[] }` |
| `supervision.decide` | 用户暂停 / 决策死锁时 | `{ context, currentPlan, options[] }` | `{ decision, rationale, planPatch? }` |

## 关联 registry.json 字段

```json
{
  "task-supervisor": {
    "capabilities": ["supervision.reflect", "supervision.decide"],
    "cost_per_call": { "prompt_tokens": 1500, "completion_tokens": 1000 },
    "fallback": ["novel-director"],
    "context_needs": ["plan.*", "tasks.recent_results", "shared.*"]
  }
}
```

## 调用约束

- `supervision.reflect` 是 idempotent —— 同样的输入同样的输出
- 单次 plan 中最多调用 5 次 `reflect`（每个 phase 一次 + 失败后一次）
- 决策**永远**写到 shared_context（importance ≥ 8），不只是 output