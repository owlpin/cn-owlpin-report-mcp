---
name: owlpin-report
display_name: 出报告（在线报告页）
display_name_en: Make a report page
description: 把对话或用户给的材料整理成一页排版好的「在线报告页」，返回一个可分享、可下载 PDF 的报告链接（小鸮钉台，app.owlpin.cn/b/…），不生成 Word / PPT 文件。用户说「出报告」「生成报告」「出个报告」「整理成报告」「做成报告页」「汇总成一页」「生成报告链接」「make a report」，且没有指明要 Word / docx / PPT / Excel 文件时，优先用这个技能。
description_zh: 把对话整理成一页在线报告，返回可分享的报告链接
description_en: Turn the conversation into a one-page online report with a shareable link (not a Word file)
version: 1.1.0
author: 小鸮钉台
---

# 出报告（在线报告页）

把对话里已经讨论出的结论、数据、待办整理成一页结构化报告，发布到小鸮钉台，回复报告链接。

## 什么时候用

- 用户要「报告」，但没说要 Word / docx / PPT / Excel 等文件：用这个技能，产出是一个网页链接，打开即可看，也能在页面里下载 PDF。
- 用户明确要 Word / docx / PPT 文件，或要编辑已有文档：不要用这个技能，交给对应的文档技能。
- 拿不准时，可以直接用这个技能（几秒出链接），回复里顺带说一句「需要 Word 版可以再告诉我」。

## 步骤

1. 调用 `get_report_format`（MCP 连接器 owlpin-report 的工具，可能在延迟加载的工具列表里，需要先加载），拿到页面格式、组件目录和内容规则。每次会话调用一次即可。
2. 按格式写 `spec`（`{ "root": "page", "elements": { ... } }`）：
   - 第一个元素是 `Hero`，标题就是报告标题，副标题一句话说明报告内容。
   - 之后 3–6 个 `Section`：结论 / 关键数据 / 分析 / 风险 / 下一步等，按对话内容取舍。
   - 有数字时优先用 `Grid` + `Stat`、`Table`、`Chart`；步骤和分工用 `Steps`；时间安排用 `Timeline`；利弊用 `ProsCons`。
   - **控制体量**：整份 spec 控制在 60 个元素以内、每段文字简洁。spec 太长时工具参数会被截断而失败；内容多就精简要点，不要把原文整段搬进去。
   - 只用对话和用户提供的材料里的事实与数据，不编造数字；拿不准的写成待确认事项。
   - 不放链接和图片（发布时会被去掉）；用对话的语言书写。
3. 调用 `create_report`，参数 `spec`。
   - 返回错误时，按错误里列出的 issues 修正 spec 后再调一次，最多重试 2 次。
4. 回复用户：报告标题 + 返回的链接（原样给出，不要改写），并提醒「报告 8 小时后自动清空，需要保留请在页面里下载 PDF」。

## 注意

- 报告任何拿到链接的人都能打开，不要把密码、证件号、联系方式等敏感信息写进去；对话里有这类信息时先提醒用户。
- 用户只是想看总结、没有要报告时，不要调用。
