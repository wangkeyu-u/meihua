# 梅花

一个用自然语言处理日常工作的 macOS 桌面 Agent，基于 Electron、React 和 TypeScript。

选择工作文件夹、连接模型后，可以整理资料、查询数据、生成文档或修改项目文件。界面使用雪与梅花主题，任务运行时播放雪梅背景视频。

## 功能

- 读取文本、代码、PDF 和 Office 文件，搜索、创建和编辑工作目录中的文件。
- 支持 OpenAI、DeepSeek、GLM、Kimi、Anthropic 及 OpenAI 兼容接口。
- 任务规划、子代理分工、上下文管理、记忆和用量预算。
- MCP 工具发现与配置、本地资料检索、SQLite 查询、网页和 API 调用。
- 会话管理、附件、文件与 Git 预览；执行操作前确认，支持暂停、恢复和文件修改撤销。

## 快速开始

需要 macOS 和 Node.js 22.19 或更高版本，建议使用 Node.js 24。

```bash
git clone https://github.com/wangkeyu-u/meihua.git
cd meihua
npm ci
npm start
```

`npm start` 会构建前端并打开桌面应用。首次安装会下载 Electron。

1. 创建工作台，或选择已有工作文件夹。
2. 在输入框右下角连接模型，填写自己的 API Key、模型名称和接口地址。
3. 输入任务，选择直接执行、分工完成、先做计划或仅问答。

OpenAI 兼容服务可填写自定义地址，例如本地 Ollama 的 `http://127.0.0.1:11434/v1`。执行任务需要所选模型支持工具调用。

MCP 在侧栏“扩展工具”中配置：搜索服务，填写所需密钥或路径，添加后检查连接。也可以手动配置本机 stdio 服务或远程 HTTP 服务。

## 开发

启动前端开发服务：

```bash
npm run dev
```

在另一个终端打开桌面窗口：

```bash
ZHUGE_DEV_URL=http://127.0.0.1:5173 npm run app
```

SQLite 参数回归可以单独运行（使用 Node.js 24 或更高版本，无需启动 Electron 或连接模型）：

```bash
npm run test:sql
```

该检查通过真实 SQL 子进程查询临时数据库，验证有限数值、字符串和显式 `null` 的传递，并在读取文件前拒绝非有限数值及稀疏数组参数。GitHub Actions 也运行这组检查。

## 打包

```bash
npm run package:mac
```

生成的 Apple Silicon 应用位于 `release/梅花-darwin-arm64/梅花.app`。当前未提供签名、公证或自动更新。

## 代码结构

```text
electron/              主进程、模型连接、工具和任务运行时
electron/runtime/      规划、并发、上下文、记忆与任务恢复
src/                   React 界面
assets/                图标、插画和运行背景
scripts/package-mac.mjs macOS 打包脚本
```

本项目使用 AI 辅助开发。第三方组件、参考实现和素材来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
