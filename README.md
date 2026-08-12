# cdp-control

[![CI](https://github.com/oldcai/cdp-control/actions/workflows/ci.yml/badge.svg)](https://github.com/oldcai/cdp-control/actions/workflows/ci.yml)

通过 Chrome DevTools Protocol (CDP) 控制本地浏览器的 CLI —— 面向 AI agent 读网页。

> ⚠️ **未完工**：此项目仍在开发中，接口与行为可能随时变动，暂不建议依赖。

## 功能

列出/打开/关闭/导航页面、提取元素、点击、填表、执行 JS、截图、读控制台日志。用 ref 索引页面元素，`run` 一次执行自动化脚本。

## 快速开始

```bash
npm install
npm run build
npm link
cdp-control --help
```

## 许可

MIT
