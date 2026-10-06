# 测试

## 本地检查

在 macOS 上使用 Node.js 22.19+ 安装锁定依赖：

```bash
npm ci
npm test
npm run build
npm run test:desktop
npm run test:pipeline
npm run test:network
npm run package:mac
npm run verify:package
```

| 命令 | 覆盖范围 |
| --- | --- |
| `npm test` | 文件边界、权限、状态迁移、预算、上下文、MCP 协议、并发、沙箱及日志恢复 |
| `npm run build` | TypeScript 与 Vite 生产构建 |
| `test:desktop` | 真实 Electron 主进程、preload、React、确认、停止、会话、记忆、MCP 配置和设置 |
| `test:pipeline` | 综合工具链、节点并行、计划修订、预算拒绝、假完成、暂停恢复和跨修订撤销 |
| `test:network` | Chromium 模型协议流、HTTP MCP、取消、拒绝重定向/file URL 和 Cookie 隔离 |
| `package:mac` | 生成 arm64 应用；只复制运行时、生产依赖、前端构建与第三方说明 |
| `verify:package` | 核对实际包目录、运行时/前端/图标摘要、上游来源、生产模块导入及开发元数据移除 |

Electron 测试使用临时用户数据和本地服务器，不读取用户的模型密钥、不发送真实邮件，结束后清理临时目录。网络测试默认不访问公网；需要单独核对目录时可运行 `npx electron tests/desktop-network.mjs --live-registry`。

CI 使用 macOS 和 Node.js 24 跑上述检查及依赖审计。公网目录不作为 CI 门槛，真实模型也不在 CI 中自动调用。

## 综合任务

验收任务使用固定销售资料：收入 240 元，成本 90 元，利润 150 元。

读取 `sources.md` → BM25 检索 → 登记 API、隔离网页和 MCP 交叉核对 → SQLite 汇总 → 写 `report.md` → 沙箱命令检查 → 文件验证与 Supervisor 读取核对。

工具、SQLite、浏览器、MCP 和文件操作由实际 Electron 主进程执行。默认模型是确定性的本地协议 fixture，用来验证调度与错误处理；它的回复不能证明真实模型能正确规划或完成业务任务。

反例覆盖：模型声称完成但没有报告、预算仅够规划、两份待确认计划、两个会话同时工作、故意写错利润后修订计划、暂停恢复、排队取消不发模型请求，以及子节点文件 checkpoint 的撤销。

输出写入 `evaluations/latest-pipeline.json`。生成记录可能包含本机路径和任务内容，不纳入 Git。对外保留的检查结论见 [validation.md](validation.md)。

## 真实模型验收

先在梅花中配置可用的执行与需求检查模型，再运行：

```bash
npm run test:real-pipeline
```

脚本读取 macOS 本机保存的模型配置，创建独立测试数据和资料目录，沿用上述综合任务；确认仅在这套测试资料范围内自动回答。它会产生模型调用费用，不修改用户的工作文件。

成功条件包含实际工具调用、报告存在、利润为 150、来源完整与最终检查通过。结果保存在 `evaluations/latest-real-pipeline.json`。该结果只能证明这一项任务，不能推断任意业务成功率。

当前尚无已完成的真实模型验收记录。应在发布稳定版前补充各协议的文本、工具、usage、长上下文与中断恢复检查。

## 恢复测试的边界

任务日志测试覆盖强制结束子进程、提交后视图写入失败、缺失/损坏视图、不完整尾行、完整日志损坏、提交尾部丢失和旧格式原始字节保留。恢复只读取日志，不重新执行已记录工具。

这些测试没有模拟物理断电，也没有验证多进程写同一任务。文件 checkpoint 不覆盖命令和远程服务的全部副作用。
