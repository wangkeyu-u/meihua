# 梅花

[![Source checks](https://github.com/wangkeyu-u/meihua/actions/workflows/source-checks.yml/badge.svg)](https://github.com/wangkeyu-u/meihua/actions/workflows/source-checks.yml)

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

当前源码检查在 Linux / Node.js 24 上安装锁定依赖，检查 Electron 主进程及构建脚本的 JavaScript 语法，并执行 TypeScript 检查与前端构建。可在本地运行同一组命令：

```bash
npm ci --ignore-scripts
npm run check:source
npm run build
```

`--ignore-scripts` 用于源码检查，跳过 Electron 和其他依赖的安装脚本；桌面运行仍按“快速开始”使用 `npm ci`。此 CI 验证源码编译和语法，不覆盖 macOS 应用启动、打包、签名、公证或真实模型调用。当前简化的源码安装版本没有运行时自动化测试套件，CI 不代表完整功能验收。

启动前端开发服务：

```bash
npm run dev
```

在另一个终端打开桌面窗口：

```bash
ZHUGE_DEV_URL=http://127.0.0.1:5173 npm run app
```

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
