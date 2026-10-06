# 本机验收记录

`npm run test:pipeline` 和 `npm run test:real-pipeline` 在这里生成 JSON 结果，分别标明本地协议模型或真实模型。测试资料与用户数据使用独立临时目录。

生成记录可能包含本机路径、任务标识和报告内容，默认由 `.gitignore` 排除。提交检查结论时，整理到 `docs/validation.md`，保留命令、范围、失败与未验证项，去掉个人路径及认证信息。
