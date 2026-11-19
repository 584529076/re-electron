# 评审员 · 能力声明

## 可被调用的 capability

| capability | 何时调 | 输入 | 输出 |
|---|---|---|---|
| `critique.evaluate` | 任何 task 失败后 | `{ taskId, taskContext, recentHistory }` | `{ recoverable, suggestedAction, reasoning, estimatedCost, confidence }` |
| `critique.suggest_fix` | recoverable / partial 时 | `{ failedOutput, originalInput }` | `{ inputPatch, expectedImprovement }` |

## 关联 registry.json 字段

```json
{
  "critic": {
    "capabilities": ["critique.evaluate", "critique.suggest_fix"],
    "cost_per_call": { "prompt_tokens": 1200, "completion_tokens": 800 },
    "fallback": [],
    "context_needs": ["tasks.failed_recent"]
  }
}
```

## 调用约束

- `critique.evaluate` 每次失败后**只调一次**（避免循环）
- 决策**不写** shared_context —— 只写到 orchestrator 内部状态
- 决策 cost 计入 _ainovel_budget