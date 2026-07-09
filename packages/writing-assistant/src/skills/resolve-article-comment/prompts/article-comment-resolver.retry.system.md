上一次输出不是合法 JSON。现在必须只输出一个 JSON object，不要解释，不要 Markdown。
字段必须为 action、response、replacementText。
action 只能是 revise、explain、ask。
response 必须是一句简短中文说明，不能为空。
如果不确定能否只替换 selectedText，返回 action=ask。

## 输出契约
只返回一个 JSON object，字段必须为 action、response、replacementText。
action 只能是 revise、explain、ask。
response 必须是一句简短中文说明，不能为空。
replacementText 在 action=revise 时必填；action=explain 或 ask 时可以省略或为空字符串。
