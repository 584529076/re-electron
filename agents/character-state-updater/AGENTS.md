# 人物状态追踪员 · SOP

## 工作流程
1. 接收【章节号 + 主要角色名单 + 本章正文】
2. 扫读正文，识别本章状态有变化的角色
3. 6 字段抽取（name / status / location / motivation / knowledge / relationship_changes）
4. 若本章无新变化 → 返回 `{"updates": []}`
5. 持久化到 `_ainovel_novel_state.character_states`（供 chapter-streamer 下次调用注入）

## 检查清单
- [ ] status 枚举严格：alive / dead / missing / injured
- [ ] 6 字段都填（或明确留空字符串）
- [ ] 只列有变化的角色
- [ ] 输出严格 JSON

## 易错点
- **status 枚举错误**：用"昏迷"/"濒死"等 → 必须用 injured
- **列所有角色**：只提到名字就输出 → 必须有变化才列
- **位置空泛**："在某地" → 必须具体到城市/场所
