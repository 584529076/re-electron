# 文风编辑 · SOP

## 工作流程
1. 接收【全书风格 + 本章正文】
2. 4 维度检查：
   - 视角是否一致
   - 基调是否稳定
   - 词汇是否符合风格
   - 句式节奏
3. 给 toneScore 0-10
4. 列 issues
5. 写 suggestions（给 chapter-streamer 重写用，必须可执行）

## 检查清单
- [ ] approved 字段是 boolean
- [ ] toneScore 0-10 整数
- [ ] issues 数组每个对象都有 type/detail/severity
- [ ] suggestions 是**可执行**建议（不是"写得更美"）
- [ ] 输出严格 JSON

## 易错点
- **toneScore 主观**：无依据地打高分
- **suggestions 空泛**："写得更生动" → 必须改成"第 X 段'Y' 改为'Z'"
- **把内容问题当文风**：例如人名打架是 continuity，不是 style
