# 第三方组件与素材

## 运行时依赖

依赖版本由 `package-lock.json` 锁定；完整清单见 `package.json` 和锁文件。以下是主要组件，并非全部传递依赖：

| 组件 | 使用范围 | 许可与来源 |
| --- | --- | --- |
| Pi Agent Core / Pi AI | 模型协议、消息流和工具循环 | MIT，[earendil-works/pi](https://github.com/earendil-works/pi) |
| Electron | 桌面窗口、Chromium、IPC 和系统存储 | MIT，[electron/electron](https://github.com/electron/electron) |
| React | 页面组件 | MIT，[facebook/react](https://github.com/facebook/react) |
| officeParser | PDF 和 Office 文本提取 | MIT，[harshankur/officeParser](https://github.com/harshankur/officeParser) |
| MCP TypeScript SDK | MCP 客户端 | MIT，[modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Sandbox Runtime 子集 | macOS Seatbelt 策略生成 | Apache-2.0，[anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime) |

除下述 Sandbox Runtime 子集外，项目通过 npm 使用这些组件。各包随附许可保留在对应依赖中。

## 随仓库保存的上游代码

`electron/vendor/sandbox-runtime/` 包含 `@anthropic-ai/sandbox-runtime@0.0.78` 发布包中的九个原始文件，逐字节保留。完整 Apache-2.0 许可、用途说明和 SHA-256 分别位于该目录的 `LICENSE`、`NOTICE.md` 和 `provenance.json`。

该子集只用于 macOS 策略生成。TLS/MITM、SOCKS、其他平台二进制与 node-forge 未包含。保留的 Java/seccomp 辅助模块是上游本地依赖，应用未启用这些执行路径。升级前应人工审查并重跑文件、网络与进程探针。

## 参考实现

执行机制研究基于 [openai/codex 固定提交](https://github.com/openai/codex/tree/822e58cc3d666166c7446c5b1ea2e52f5d09594c)。参考内容包括子代理生命周期、上下文压缩、工具并发与持久日志；没有复制其 Rust 代码或声称功能完全一致。

设置参考 [Claude Code 设置](https://code.claude.com/docs/en/settings)、[权限](https://code.claude.com/docs/en/permissions)及 [Codex 配置](https://developers.openai.com/codex/config-basic)。需求检查的逐个追问思路参考 [grill-me](https://github.com/matt-riley/agent-skills/blob/main/skills/grill-me/SKILL.md)，规则在本项目独立编写。界面的输入区域和模型选择位置参考 Codex 桌面应用。

## 项目素材与开发方式

雪梅枝插画使用 AI 生成，花形图标由项目脚本绘制。`snow-plum-working.mp4` 是项目发起者提供并指定用于运行背景的视频。

项目使用 AI 辅助开发。第三方代码和素材按来源说明；原创代码尚未指定独立开源许可证，公开仓库不改变第三方组件各自的许可。
