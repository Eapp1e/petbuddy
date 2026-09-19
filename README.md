<div align="center">
  <img src="docs/icon.png" width="96" alt="PetBuddy">

# PetBuddy

**AI 编码 Agent 状态聚合工具**

把本机同时运行的多个 AI 编码 Agent 汇总到桌面上的一个窗口里：谁在工作、进行到哪一步、
今天消耗了多少 Token、什么时候需要你回答，不必在多个窗口之间来回切换。

![Framework](https://img.shields.io/badge/Electron-33-47848F)

![Node.js](https://img.shields.io/badge/node.js-%E2%89%A518-339933)

![License](https://img.shields.io/badge/license-MIT-green)

<img src="docs/01-running.png" width="30%" alt="运行中"> <img src="docs/02-parallel.png" width="30%" alt="多任务并行"> <img src="docs/03-confirm.png" width="30%" alt="确认请求">

<br/>

<img src="docs/04-done.png" width="30%" alt="完成"> <img src="docs/05-idle.png" width="30%" alt="空闲光环"> <img src="docs/06-rest.png" width="30%" alt="休息提醒">

*运行中 · 多任务并行 · 确认请求 · 完成 · 空闲 · 休息提醒*
</div>

## 项目简介

PetBuddy 把本机多个 AI 编码 Agent 的运行状态聚合到同一个窗口里显示，并在任务完成、
出错或等待你输入时给出提示。

**它做什么** — 汇总各 Agent 的运行状态、当前工具调用、待办清单、用时与 Token 用量；
用气泡、提示音和可选系统通知提示状态变化；需要点「允许」或回答问题时，直接在桌宠上操作。

**它怎么接入** — 在 Agent 自己的配置文件里写入一行钩子（自动备份，卸载时只删自己的条目），
或者由应用直接向本机接口 `POST /api/event` 上报。

**它不做什么** — 不接管、不代理任何 Agent 的工作；桥接脚本只读事件、不参与决策，
异常时始终以 0 退出；数据只在本机处理，除「检查更新」外没有对外请求。

> 平台：Windows 10 / 11。

## 多 Agent 集成

一条命令接入全部：

```bash
npm run install-integrations
```

- **扫描**本机装过的 Agent。内置 22 个常见条目，按当前热度排：
  Claude Code、Codex、Cursor、Trae、OpenCode、WorkBuddy、Qoder、Windsurf、Gemini CLI、
  Aider、Cline、Roo Code、Qwen Code、ZCode、DeepSeek Harness 等
- **写入钩子**：按各家格式写进对应配置文件，统一转成同一套事件
- **自动出现**：已接入的 Agent 开始工作时，桌宠就会显示它的状态

**接入新 Agent 不需要手写配置**：设置 → 应用集成 →「扫描应用」，点「添加」即可，
接入方式会自动配好，用量数据源也会在后台自动探测。

> 内置列表只是预设，不是支持范围的边界。有新钩子格式时加一个 handler 即可（见「接入原理」）。

## 任务面板

右键桌宠 → 任务面板。每个 Agent 一行，显示它当前的状态。

- **状态**：运行中 / 待确认 / 完成 / 出错，以及当前工具调用和已执行步数
- **待办清单**：Agent 的任务清单（TodoWrite / plan）同步进面板，进行中的那条高亮
- **用时与 Token**：用时起点读自各 Agent 自己的会话记录，桌宠重启不归零；
  Token 统计今日生成量与上下文峰值，行内显示 `1.1M tokens`，悬停看明细
- **并行任务**：同一应用开多个会话时分别跟踪，全部结束才算完成
- **点行跳转**：点任意一行，把该 Agent 的窗口切到前台

<p align="center">
  <img src="docs/07-panel.png" width="55%" alt="任务面板">
</p>

## 消息提示

- **状态气泡**：显示当前在跑的任务、工具调用与待办；多个任务时轮播
- **完成通知**：任务完成 / 出错 / 等待确认时弹出系统通知（默认关闭，在 设置 → 行为 中开启）
- **休息提醒**：连续工作一段时间后弹出提醒卡，光环同步转绿，间隔与贪睡时长可配
- **悬停反馈**：鼠标移到宠物上会有一个小动作

## 确认与提问直达

- 应用请求权限时弹出确认卡，点「允许」会聚焦该应用窗口并发送按键（序列可在设置里自定义并测试）
- Agent 反问你问题时（如 Claude 的 AskUserQuestion）显示提问卡，可以直接输入回答或点选项

## 桌宠外观

- **形象库**：从 [petdex.dev](https://petdex.dev/zh) 按名字导入形象，一键切换；内置 EVE / Tiko 预设
- **圆环**：10 种样式，颜色随状态变化，速度可调

<p align="center">
  <img src="docs/08-pet-lulu.png" width="30%" alt="形象：噜噜">
  <img src="docs/09-pet-tiko.png" width="30%" alt="形象：Tiko">
  <img src="docs/10-pet-eve.png" width="30%" alt="形象：EVE">
</p>

## 自动显示与隐藏

- 任何时刻只有一只桌宠：重复启动不会开出第二只，带 `--show` 启动会让已有的那只现身
- 有被监控的应用在运行就自动出现，全部关闭后自动隐藏（也可设为直接退出）

## 休息提醒

连续工作一段时间后弹出提醒卡，光环同步转绿，间隔与贪睡时长可配。

## 设置窗口

外观（大小 / 透明度 / 精灵 / 圆环 / 置顶 / 气泡）、行为（自动隐藏 / 提示音 / 超时 / 休息
提醒 / 系统通知）、应用集成（启停 / 装卸 / 修改名称·颜色·图标·进程名·端口·按键）、
系统（开机自启 / 检查更新）。

**全局快捷键**：`Ctrl+Alt+P` 唤起桌宠、`Ctrl+Alt+O` 打开设置。

**自动更新**：打包版启动后会静默检查新版本，也可在 设置 → 系统 手动触发
（更新源为 GitHub Release，发版时把 `latest.yml` 一起上传即可）。

<p align="center">
  <img src="docs/11-settings.png" width="55%" alt="设置窗口">
</p>

## 快速开始

环境要求：Windows 10/11，Node.js ≥ 18（仅用于安装依赖，运行时使用项目自带的 Electron）。

```bash
git clone https://github.com/Eapp1e/petbuddy.git     # 国内可用 gitee.com/Eapp1e/petbuddy
cd petbuddy
npm install
npm start                        # 隐藏启动：npm run start-hidden
npm run install-integrations     # 一键为已装的 Agent 安装桥接
```

之后重启对应应用（或新开一个会话），它一开始干活桌宠就会出现。
也可以在 设置 → 应用集成 里「扫描应用」，把还没接入的一键加上。

## 接入原理

| 应用 | 机制 | 写入位置 |
|---|---|---|
| Codex | 原生 hooks（kebab 事件名）+ `notify` 包装 | `~/.codex/hooks.json`、`~/.codex/config.toml` |
| Claude Code | Claude 风格 `hooks` 键 | `~/.claude/settings.json` |
| WorkBuddy | Claude 风格 `hooks` 键 | `~/.workbuddy/settings.json` |
| ZCode | config-file hooks | `~/.zcode/cli/config.json` |
| DSH | 挂载 `@deepseek-ai/dsh-hooks-claude-code` | `<DSH_HOME>/profiles/web/cordis.patch` |

> 上表只是内置预设。Claude 系 Agent 都能用 claude-file 样式接入；有 HTTP 能力的用镜像模式。

- 钩子只**镜像状态**，永不阻塞（桥接 2 秒超时、始终 exit 0）；桌宠未运行时会被 `--spawn` 拉起
- 修改前自动备份（`*.petbuddy-bak`），卸载只删 petbuddy 条目
- 审批回传通过键盘注入（聚焦窗口 + SendKeys）；网页类 UI 仅镜像提示，审批仍在网页完成
- Token 用量自动探测数据源：接入后后台扫描应用的配置目录，找到用量记录即统计

## 本地 API

端口见 `~/.petbuddy/port`（默认 47650）。未知 `app` 会自动注册并显示（镜像模式），
任何能发 HTTP 的程序都能接入。

```
GET  /api/ping      GET  /api/status
POST /api/event     {app, event, title?, detail?, question?, options?}
POST /api/announce  {app}
POST /api/confirm   {id, decision: approve|deny|dismiss|answer, text?}
```

`event` 取值：`announce / session-start / prompt / pre-tool / post-tool /
post-tool-failure / permission / question / stop / message / turn-complete / compact`。
其中 `permission` 弹确认卡，`question` 弹提问卡（可带 `options`，答复以
`decision: "answer" + text` 回传后注入到应用窗口）。

## 添加自定义应用

设置 → 应用集成 → 添加应用，只填 ID 和名称即可；也可以直接编辑
`~/.petbuddy/apps.config.json`：

```jsonc
{
  "apps": [{
    "id": "myapp", "name": "MyApp", "color": "#ff8844",
    "processNames": ["MyApp.exe"],
    "keys": { "approve": "{ENTER}", "deny": "{ESC}" },
    "integration": [
      { "style": "claude-file", "path": "~/.myapp/agent.json", "eventCase": "kebab", "standalone": true }
    ]
  }]
}
```

`eventCase`：`pascal`（SessionStart）/ `kebab`（session-start）。改完点「扫描应用」。
新钩子格式在 `integrations/install.mjs` 的三个表里各加一个 handler 即可。

## 项目结构

```
app/               应用本体（主进程 / 桌宠 / 设置窗口 / 状态机 / token 统计 / 按键注入）
bridge/            钩子桥接脚本（各应用钩子负载 → 统一事件）
integrations/      接入安装器（zcode-config / claude-file / codex-notify / dsh-patch）
test/              单元测试（node --test）
docs/              截图与图标
```

## 注意

- 确认按键默认 `允许={ENTER}`、`拒绝={ESC}`；弹窗不同（如需要按 `1`）时在应用卡片的
  「修改」里改序列并点"测试"
- **Codex** 的 hooks 条目需一次性信任：在 codex 交互界面输入 `/hooks`，把 PetBuddy 标记为 trusted
- **DSH** 的 hooks 配置只在服务启动时读取一次，修改后需重启 DSH
- 钩子命令统一走 `~/.petbuddy/pet-bridge.cmd` 垫片（兼容 cmd / PS1 / 直接 spawn）

## 开发与测试

```bash
npm test          # node --test：token 解析、按键转义、语法巡检
npm run build     # 打 Windows 安装包 + 便携版（输出到 release/）
```

CI：每次 push / PR 跑测试（`.github/workflows/ci.yml`）；打 `v*` tag 时 `release.yml`
自动构建并把安装包、便携版和 `latest.yml` 一起挂到 Release。

## 致谢

[Petdex](https://github.com/crafter-station/petdex)（[petdex.dev](https://petdex.dev/zh)）——
桌宠形象与动作数据来自这个出色的开源项目，非常感谢。

## License

[MIT](LICENSE) © 2026 EAPPLE
