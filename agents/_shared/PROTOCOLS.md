# Agent 协作协议 v1

> Sprint C 新增。本文件被 `_composeSystemPrompt` 自动注入到所有 agent 的 system prompt 末尾。
> 每次 agent 调用都会看到这段，**不得超出 500 字符**（超出由 context-compressor L4 截断）。

## 1. 共享上下文（Shared Context）

所有 agent 之间共享 4 层上下文，按"长期 → 短期"排列：

| 层 | 写入方式 | 何时注入 system prompt | 典型用途 |
|---|---|---|---|
| blackboard | `blackboardWrite(key, value)` | 摘要（1500 字软上限） | 长期项目状态 |
| shared_context | `sharedContext.set(key, value)` | **按你声明的 `context_needs` 精准注入** | 决策中间结果（带 TTL + importance） |
| inbox | `inboxSend(to, text)` | 未读 8 条 | 点对点消息 |
| task payload | 由 orchestrator 传入 | 必注入 | 当前任务的 input |

**写入 shared_context 时请标注 importance**：
- 10：决策核心依据（绝不压缩）
- 7-9：重要事实（最后压缩）
- 4-6：一般信息
- 1-3：临时细节（首先被淘汰）

## 2. 决策上报协议

每个 agent 的 JSON output 末尾加 `__decision` 字段：

```json
{
  "...": "正常业务输出",
  "__decision": {
    "next": "continue" | "replan" | "skip" | "abort" | "request_help",
    "reason": "简短理由（1 句话）",
    "request_help": { "to": "agent_name", "question": "..." }
  }
}
```

- `continue`：按原计划继续
- `replan`：建议 novel-director 重排（附理由）
- `skip`：跳过当前 task 后续步骤
- `abort`：致命错误，需暂停整个 plan
- `request_help`：向另一个 agent 发求助（自动转 inboxSend）

## 3. 失败上报协议

失败时（throw 或 status='failed'），自动触发 critic agent 评估。
如需主动报告非致命问题，加 `__failure_report`：

```json
{
  "__failure_report": {
    "severity": "low" | "medium" | "high" | "critical",
    "recoverable": true | false,
    "suggest": "重试 / 换 fallback agent / 跳过 / 暂停"
  }
}
```

## 4. 成本上报

每次 LLM 输出末尾估算 `__cost_estimate`：

```json
{
  "__cost_estimate": { "prompt_tokens": 2000, "completion_tokens": 1500 }
}
```

> 实际 token 由 _runAgent 自动计算（来自 provider response），此字段仅作 agent 自我感知用。

## 5. 不要做的事

- ❌ 不要直接调 `taskCreate` 写持久化任务——除非你是 novel-director
- ❌ 不要绕开 orchestrator 自己跑 LLM——所有 LLM 调用必须通过 _runAgent
- ❌ 不要写超过 10MB 的 shared_context value——会被 L1 truncate
- ❌ 不要把"决策依据"放在 inbox——决策依据放 shared_context（importance=9-10）
