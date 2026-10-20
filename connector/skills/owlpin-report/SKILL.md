---
name: owlpin-report
display_name: 出报告
display_name_en: Make a report
description: 把对话内容整理成一页排版好的报告并生成分享链接（小鸮钉台）。用户说「出报告」「生成报告」「整理成报告」「做成报告页」「汇总成一页」「make a report」时使用。
description_zh: 把对话整理成一页报告，生成可分享的链接
description_en: Turn the conversation into a one-page report with a shareable link
version: 1.0.0
author: 小鸮钉台
---

# 出报告

把对话里已经讨论出的结论、数据、待办整理成一页结构化报告，发布到小鸮钉台，回复报告链接。

## 步骤

1. 调用 `get_report_format`，拿到页面格式、组件目录和内容规则（每次会话调用一次即可）。
2. 按格式写 `spec`（`{ "root": "page", "elements": { ... } }`）：
   - 第一个元素是 `Hero`，标题就是报告标题，副标题一句话说明报告内容。
   - 之后 3–8 个 `Section`：结论 / 关键数据 / 分析 / 风险 / 下一步等，按对话内容取舍。
   - 有数字时优先用 `Grid` + `Stat`、`Table`、`Chart`；步骤和分工用 `Steps`；时间安排用 `Timeline`；利弊用 `ProsCons`。
   - 只用对话和用户提供的材料里的事实与数据，不编造数字；拿不准的写成待确认事项。
   - 不放链接和图片（发布时会被去掉）；用对话的语言书写。
3. 调用 `create_report`，参数 `spec`。
   - 返回错误时，按错误里列出的 issues 修正 spec 后再调一次，最多重试 2 次。
4. 回复用户：报告标题 + 返回的链接（原样给出，不要改写），并提醒「报告 8 小时后自动清空，需要保留请在页面里下载 PDF」。

## 注意

- 报告任何拿到链接的人都能打开，不要把密码、证件号、联系方式等敏感信息写进去；对话里有这类信息时先提醒用户。
- 用户只是想看总结、没有要报告页时，不要调用。
