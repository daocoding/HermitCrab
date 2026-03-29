<div align="center">

<img src="assets/hero.png" alt="构建你自己的 AI 助手" width="600">

# 🦀 构建你自己的 AI 助手

### 一个大脑，所有渠道，你睡觉时它还在工作。

**一份完整的、经过实战检验的蓝图，教你如何构建一个横跨 Telegram、Teams、IDE 等任意渠道的个人 AI 助手——拥有持久记忆、自主运行和自我修复能力。**

*这不是理论。这套系统已经在生产环境中运行了数月。*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**[English](README.md)** · **[中文](#-为什么要自己构建)**

</div>

---

## 问题

你在工作中使用 ChatGPT，在 IDE 里用 Claude，在 Telegram 上用另一个机器人，也许还用 Siri 设闹钟。

**它们彼此不认识。** 没有一个记得你昨天说了什么。没有一个能在你睡觉时做事。

如果你有**一个 AI 助手**能做到：

- 💬 在你使用的**每个渠道**上存在 — Telegram、Teams、Slack、IDE、短信
- 🧠 跨所有渠道**记住一切** — 持久记忆，语义搜索
- 🌙 **在你睡觉时工作** — 执行夜间任务，监控系统，发送晨报
- 🏥 **自我修复** — 崩溃了？自动重启。网络断了？优雅重试
- 🔒 **在你自己的机器上运行** — 无需云服务，数据完全属于你
- 👥 **支持多个 AI 代理** — 添加专业助手，共享同一基础设施

**本指南将一步步教你如何构建它。**

---

## 架构：一壳多蟹 🦀

> *寄居蟹把家背在身上。当它长大了，就换一个更大的壳——但它仍然是同一只蟹，拥有同样的记忆和同样的个性。*

你的 AI 就是那只蟹，渠道就是壳。

```
                    ┌─────────────┐
                    │  Telegram   │──── Bridge ────┐
                    └─────────────┘                │
                    ┌─────────────┐                │     ┌──────────────────┐
                    │   Teams     │──── Bridge ────┼────▶│   🧠 AI 大脑     │
                    └─────────────┘                │     │                  │
                    ┌─────────────┐                │     │  ┌────────────┐  │
                    │    IDE      │──── Bridge ────┤     │  │  记忆系统   │  │
                    └─────────────┘                │     │  └────────────┘  │
                    ┌─────────────┐                │     │  ┌────────────┐  │
                    │  短信/网页   │──── Bridge ────┘     │  │  调度器     │  │
                    └─────────────┘                      │  └────────────┘  │
                                                         └──────────────────┘
```

---

## 章节目录

### 第一部分：基础

| # | 章节 | 你将构建什么 | 时间 |
|---|------|-------------|------|
| 00 | [**设计哲学**](chapters/00-philosophy.md) | 理解"一壳多蟹"架构 | 15 分钟 |
| 01 | [**第一个 Bridge**](chapters/01-first-bridge.md) | 一个能对话的 Telegram AI 机器人 | 1 小时 |
| 02 | [**持久记忆**](chapters/02-memory.md) | 工作记忆 + 跨会话语义搜索 | 2 小时 |

### 第二部分：多渠道

| # | 章节 | 你将构建什么 | 时间 |
|---|------|-------------|------|
| 03 | [**Teams Bridge**](chapters/03-teams-bridge.md) | 企业渠道 — Microsoft Teams 或 Slack 集成 | 2 小时 |
| 04 | [**IDE Bridge**](chapters/04-ide-bridge.md) | 在 VS Code / Cursor 中控制你的 AI | 2 小时 |
| 05 | [**Bridge 协议**](chapters/05-bridge-protocol.md) | 30 分钟内为任意渠道构建 Bridge | 1 小时 |

### 第三部分：自主运行

| # | 章节 | 你将构建什么 | 时间 |
|---|------|-------------|------|
| 06 | [**调度器**](chapters/06-orchestrator.md) | 三层心跳机制的任务调度系统 | 2 小时 |
| 07 | [**自我修复**](chapters/07-self-healing.md) | launchd/systemd 自动重启，优雅恢复 | 1 小时 |
| 08 | [**夜间运行**](chapters/08-overnight.md) | 趁你睡觉时运行的任务 — 监控、索引、报告 | 1 小时 |

### 第四部分：扩展

| # | 章节 | 你将构建什么 | 时间 |
|---|------|-------------|------|
| 09 | [**多机器部署**](chapters/09-multi-machine.md) | 常驻服务器 + 移动笔记本，Tailscale 组网 | 1 小时 |
| 10 | [**多代理系统**](chapters/10-multi-agent.md) | 添加共享基础设施的专业 AI 代理 | 2 小时 |
| 11 | [**安全与密钥**](chapters/11-security.md) | Token 管理，权限边界，审计日志 | 1 小时 |

---

## 快速开始

```bash
git clone https://github.com/daocoding/build-your-own-ai-assistant.git
cd build-your-own-ai-assistant
npm install
cp .env.example .env   # 配置你的 API 密钥
npm run bridge:telegram
```

**→ 然后阅读 [第00章：设计哲学](chapters/00-philosophy.md) 了解完整架构。**

---

## 许可证

MIT — 随意使用。

---

<div align="center">

### 由受够了管理五个互不相识的 AI 助手的开发者构建 🦀

**[开始构建 →](chapters/00-philosophy.md)**

</div>
