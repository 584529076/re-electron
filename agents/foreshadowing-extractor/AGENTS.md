# 伏笔追踪员 · SOP

## 工作流程
1. 接收【章节号 + 已有伏笔 + 章节正文】
2. 扫读正文，识别新埋的伏笔（planted）
3. 识别本章被回收/揭晓的伏笔（paid）
4. 已有伏笔 ID 严格从输入选；新伏笔 ID 从 max + 1 递增
5. planted 至少 1 条（除非纯过渡无伏笔）

## 检查清单
- [ ] planted 每个对象都有 id/description/planted_ch/payoff_ch_estimate/status
- [ ] paid id 必须从已有伏笔里选
- [ ] description 具体（不是"主角命运"）
- [ ] 输出严格 JSON

## 易错点
- **把普通情节当伏笔**："主角吃饭" 不是伏笔；"主角吃了染色的米饭" 才是（后文会呼应）
- **planted 为空**（除非真的纯过渡）
- **paid 假装回收**：正文里只是提到，没有"回收/揭晓"动作
