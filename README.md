<div align="center">
  <img src="docs/icon.png" width="96" alt="PetBuddy">

# PetBuddy

**统一的 Windows 桌宠，一键监控你的所有 AI 编码 Agent**

把散落在各个窗口里的 AI Agent 收拢到一只桌宠上：集成、进度、提醒，一处看全。

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)](#)
[![Framework](https://img.shields.io/badge/Electron-33-47848F)](#)
[![Node.js](https://img.shields.io/badge/node.js-%E2%89%A518-339933)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Gitee 镜像](https://img.shields.io/badge/mirror-Gitee-C71D23)](https://gitee.com/Eapp1e/petbuddy)

<img src="docs/01-running.png" width="30%" alt="运行中"> <img src="docs/02-parallel.png" width="30%" alt="多任务并行"> <img src="docs/03-confirm.png" width="30%" alt="确认直达">

<br/>

<img src="docs/04-done.png" width="30%" alt="完成"> <img src="docs/05-idle.png" width="30%" alt="空闲光环"> <img src="docs/06-rest.png" width="30%" alt="休息提醒">

*运行中 · 多任务并行 · 任务面板 · 完成 · 空闲光环 · 休息提醒*
</div>

## 多 Agent 集成

PetBuddy 的对象是**所有** AI 编码 Agent —— 把它们的运行状态收拢到同一只桌宠上。

**一条命令接入全部：**

```bash
npm run install-integrations
```

- 🔍 **自动扫描**：认出机器上装过的 Agent（内置 17 个常见条目：Claude Code、Cursor、Windsurf、Cline、Roo Code、Continue、Aider、Gemini CLI、Qwen Code、iFlow、OpenCode、Crush、Goose、Amp、Trae、VS Code……）
- ✍️ **自动写入钩子**：按各家格式把桥接脚本写进对应配置文件（自动备份原文件，卸载时只删 petbuddy 自己的条目）
- 🌉 **统一事件流**：不同 Agent 的钩子格式千差万别，桥接层全部转成统一事件
- 🐾 **即插即用**：任意 Agent 一开始干活，桌宠自动出现并显示它的状态

**接入新 Agent 不需要手写配置**：设置 → 应用集成 →「扫描应用」，列出的应用点一下「添加」即可 ——
接入方式（写哪个 hooks 文件 / 走镜像模式）自动配好，用量数据源也会在后台自动探测。

> 💡 内置列表只是**预设**，不是边界。只要有钩子机制（Claude 风格 / 配置文件钩子）或能发 HTTP（`POST /api/event`），任何 Agent 都能接入。

## 任务面板

右键桌宠 → 任务面板，每个 Agent 一行，实时看它在干什么。

- **状态镜像**：运行中 / 待确认 / 完成 / 出错，当前工具调用、已执行步数
- **待办清单**：Agent 的 TodoWrite / plan 直接搬进面板，进行中那条高亮，一眼看出卡在哪一步
- **真实任务计时**：起点读自各 Agent **自己的会话记录**（Claude 系 transcript、DSH 投影缓存），桌宠重启不归零；应用长时间"思考"不发钩子事件时，照样能判定"仍在运行"
- **多任务并行**：同一应用开多个会话时按 sessionId 分别跟踪，显示"N 个任务并行"，全部结束才算完成；10 分钟无事件的会话自动退役
- **Token 用量**：从各 Agent 自己的记录里统计**今日生成量**与上下文峰值（Claude 系读 `message.usage`、Codex 读 rollout 累计值、DSH 读投影缓存），行内显示 `1.1M tokens`，悬停看明细
- **点行跳转**：点任意一行，直接把该 Agent 的窗口切到前台，不用去任务栏翻
- **拖动排序**：设置里拖动卡片即可调整顺序，面板与圆点同步

<img src="docs/07-panel.png" width="55%" alt="任务面板">

## 消息提示

不用盯着 Agent 窗口 —— 该说话的时候，桌宠会告诉你。

- **状态气泡**：实时显示在跑的任务 / 工具调用 / 待办；多任务时按顺序轮播
- **完成通知**：任务完成 / 出错 / 等待确认时弹 **Windows 系统通知**（含用时与"N/M 步完成"），桌宠被挡住或已隐藏也不会错过。默认关闭，在 设置 → 行为 → 系统通知 里打开即可
- **休息提醒**：连续工作一段时间后弹出绿色提醒卡，光环同步转绿，间隔与贪睡时长可配
- **提示音**：确认 / 完成 / 出错三类事件可分别开关
- **鼠标悬停反馈**：鼠标移上去，宠物会跳一下打招呼

### 确认与提问直达

- 应用请求权限时弹出确认卡，点「允许」自动聚焦该应用窗口并发送按键（序列可在设置里自定义、一键测试）
- Agent 反问你问题时（如 Claude 的 AskUserQuestion）显示提问卡，可直接输入回答或点它给出的选项 —— 全程不用切窗口

### 桌宠外观

- **Petdex 形象库**：从 [petdex.dev](https://petdex.dev/zh) 按名字导入形象，一键切换；内置 EVE / Tiko 预设
- **多种圆环样式**：经典光弧 / 双环反转 / 缺口旋转 / 彗尾追踪 / 脉冲外扩 / 追光三点 / 虚线段环 / 彩虹流转 / 辉光呼吸 / 双向扫描
- **状态配色**：圆环颜色随任务状态（运行中=青 / 待确认=黄 / 完成=蓝 / 出错=红 / 休息提醒=绿 / 空闲=半透明灰蓝并自动放缓），速度可调

<p align="center">
  <img src="docs/08-pet-lulu.png" width="30%" alt="形象：噜噜">
  <img src="docs/09-pet-tiko.png" width="30%" alt="形象：Tiko">
  <img src="docs/10-pet-eve.png" width="30%" alt="形象：EVE">
</p>

### 休息提醒与单实例

- **休息提醒**：连续工作一段时间后弹出绿色提醒卡，光环同步转绿
- **单实例 / 随开随现**：无论开几个应用只有一只桌宠；任一应用启动自动出现，全部关闭自动隐藏（可配置为退出）

## 设置窗口

外观（大小 / 透明度 / 精灵 / 圆环 / 动画速度 / 置顶 / 气泡）、行为（自动隐藏 / 提示音 / 超时 / 休息提醒）、应用集成（启停 / 装卸 / ⚙修改名称·颜色·图标·进程名·端口·按键 / 测试按键）、系统（开机自启 / 启动隐藏 / 检查更新）；关键处均有悬浮说明。

**全局快捷键**：`Ctrl+Alt+P` 唤起桌宠、`Ctrl+Alt+O` 打开设置（任何时候都能用）。

**自动更新**：打包版启动 20 秒后会静默检查新版本，设置 → 系统里的"检查更新"也可以手动触发。更新源走 `package.json` 的 `build.publish`（当前指向 GitHub Release），因此**发版时要把 `latest.yml` 一起传到 Release 附件**（仓库里的 `.github/workflows/release.yml` 打 tag 时会自动带上）。

<img src="docs/11-settings.png" width="55%" alt="设置窗口">

## 快速开始

环境要求：Windows 10/11，Node.js ≥ 18（仅用于安装依赖，运行时使用项目自带的 Electron）。

```bash
git clone https://github.com/Eapp1e/petbuddy.git
cd petbuddy
npm install
npm start                       # 或双击 start-petbuddy.cmd（隐藏启动: npm run start-hidden）
```

### 接入你的 AI 应用（三步）

```bash
npm run install-integrations    # 一键为机器上已装的 Agent 自动安装桥接
```

1. 重启对应应用（或新开一个会话）
2. 它一开始干活，桌宠就会出现并显示状态
3. 需要确认时，直接在桌宠上点 **允许 / 拒绝**

**更省事的做法**：设置 → 应用集成 → 点「扫描应用」——PetBuddy 会认出本机装过的
Agent（Claude Code、Cursor、Windsurf、Gemini CLI、Qwen Code…），把还没添加的列出来，
点「添加」即可，**接入方式自动配好，不需要手填任何配置路径**。未知应用会自动走镜像模式
（能发 HTTP 就显示），也可以随时在卡片上改成自动写入 Claude 风格 hooks。

## 接入原理

| 应用 | 机制 | 写入位置 |
|---|---|---|
| Codex | 原生 hooks（kebab 事件名）+ `notify` 包装（回合完成，原 notify 链式保留） | `~/.codex/hooks.json`、`~/.codex/config.toml` |
| Claude Code | Claude 风格 `hooks` 键（添加应用 → 自动接入） | `~/.claude/settings.json` |
| WorkBuddy | Claude 风格 `hooks` 键 | `~/.workbuddy/settings.json` |
| ZCode | config-file hooks（7 个事件 → `bridge/pet-bridge.mjs`） | `~/.zcode/cli/config.json` |
| DSH | 挂载 `@deepseek-ai/dsh-hooks-claude-code` 指向 `~/.petbuddy/dsh-hooks.json` | `<DSH_HOME>/profiles/web/cordis.patch.yml`（patchReload: live，无需重启） |

> **上表只是内置预设，不是支持范围的边界。** Claude 系 Agent（Claude Code、Cline、Roo Code…）都能用
> claude-file 样式接入；有 HTTP 能力的用镜像模式；新钩子格式加一个 handler 即可（见下文）。

- 所有钩子只**镜像状态**，永不阻塞/失败（桥接 2 秒超时、始终 exit 0）
- 桥接发现桌宠未运行时会用 `--spawn` 拉起它（因此任一应用一动，桌宠就会出现）
- 修改前自动备份（`*.petbuddy-bak`），卸载接入只删除 petbuddy 条目
- 审批回传：Codex / Claude Code / WorkBuddy / ZCode 通过**键盘注入**（聚焦窗口 + SendKeys）；网页类 UI（如 DSH）桌宠仅镜像提示，审批仍在网页完成
- **Token 用量**：从各 Agent 自己的记录里统计今日生成量与上下文峰值；**数据源自动探测** —— 接入新应用后后台扫描它的配置目录（`~/.<应用>`、`%APPDATA%/<应用>`、接入配置所在目录），近三天改动过的 json/jsonl 逐个嗅探用量字段，找到后写入配置持久化，不需要为每个应用手写解析

## 本地 API（127.0.0.1，端口见 `~/.petbuddy/port`，默认 47650）

```
GET  /api/ping          存活检查
GET  /api/status        完整状态快照
POST /api/event         {app, event, title?, detail?, question?, options?}
POST /api/announce      {app} 心跳
POST /api/confirm       {id, decision: approve|deny|dismiss|answer, text?}
```

`event` 取值：`announce / session-start / prompt / pre-tool / post-tool / post-tool-failure / permission / question / stop / message / turn-complete / compact`

- `permission` → 确认卡（允许/拒绝，走按键注入）
- `question` → **提问卡**：可带 `options: ["选项A","选项B"]`，用户既能点选项也能手打回答，答复以 `decision: "answer" + text` 回传后注入到该应用窗口

手动测试：

```bash
curl -X POST http://127.0.0.1:47650/api/event -d "{\"app\":\"zcode\",\"event\":\"pre-tool\",\"detail\":\"Bash: ls\"}"
```

未知 `app` 会**自动注册**并立即显示（镜像模式，无按键回传）——任何能发 HTTP 的程序都能接入。

## 添加自定义应用

在 设置 → 应用集成 → 添加应用 填写（只填应用 ID 和显示名称即可），或直接编辑
`~/.petbuddy/apps.config.json`：

```jsonc
{
  "apps": [
    {
      "id": "myapp", "name": "MyApp", "color": "#ff8844", "emoji": "🧩",
      "icon": "D:/icons/myapp.png",
      "processNames": ["MyApp.exe"],
      "ports": [],
      "keys": { "approve": "{ENTER}", "deny": "{ESC}" },
      "integration": [
        { "style": "zcode-config" },
        { "style": "claude-file", "path": "~/.myapp/agent.json", "eventCase": "kebab", "standalone": true },
        { "style": "codex-notify" },
        { "style": "dsh-patch" }
      ]
    }
  ]
}
```

`eventCase`: `pascal`（SessionStart）/ `kebab`（session-start）。改完点 设置 → 应用集成 → "扫描应用"。
若新应用的钩子格式不属于以上任何一种，在 `integrations/install.mjs` 的
`STYLE_INSTALL / STYLE_UNINSTALL / STYLE_STATUS` 三个表里各加一个 handler 即可，主进程与 UI 不用动。

## 项目结构

```
app/               应用本体
  main.js            Electron 主进程（窗口 / 托盘 / 看门狗 / IPC / 自动更新）
  pet.html           桌宠（精灵渲染 / 状态气泡 / 确认卡·提问卡 / 圆环样式）
  settings.html      设置窗口（外观 / 行为 / 应用集成 / 系统）
  preload.js         渲染进程桥接
  lib/               状态机、应用注册表、任务计时、token 统计、按键注入、HTTP 服务
  assets/            图标与精灵素材
bridge/            钩子桥接脚本（各应用钩子负载 → 统一事件）
integrations/      接入安装器（zcode-config / claude-file / codex-notify / dsh-patch）
test/              单元测试（node --test）
docs/              截图与图标
```

## 数据与日志

- 配置：`~/.petbuddy/config.json`（设置窗口里改）
- 应用注册表：`~/.petbuddy/apps.config.json`
- 日志：`~/.petbuddy/petbuddy.log`

## 注意

- 确认按键默认 `允许={ENTER}`、`拒绝={ESC}`；如应用实际弹窗不同（如需要按 `1`），在 设置 → 应用集成 → ⚙ 修改 里改按键序列并点"测试"
- **Codex**：notify 包装开箱即用（回合完成通知）。hooks.json 里的条目还需**一次性信任**：在 codex 交互界面输入 `/hooks`，把 PetBuddy 的钩子标记为 trusted（codex 的安全设计，未经审核的钩子不执行）
- **DSH** 的 hooks 配置只在服务启动时读取一次——修改桥接配置后需重启 DSH 服务
- 钩子命令统一走 `~/.petbuddy/pet-bridge.cmd` 垫片（兼容 cmd / PS1 / 直接 spawn 三种执行环境）
- 开机自启写注册表 `HKCU\...\Run`：开发版指向仓库根目录，打包版只指向 exe 本身（可在设置 → 系统里一键开关）

## 开发与测试

```bash
npm test          # node --test：token 解析、按键转义、语法巡检
npm run build     # 打 Windows 安装包 + 便携版（输出到 release/）
```

CI 在 `.github/workflows/ci.yml`：每次 push / PR 跑测试；打 `v*` tag 时 `release.yml`
自动构建并把 `Setup.exe` / `portable.exe` / `latest.yml` 一起挂到 Release。

## 致谢

- [Petdex](https://github.com/crafter-station/petdex)（[petdex.dev](https://petdex.dev/zh)）——
  桌宠形象与动作数据来自这个出色的开源项目，PetBuddy 的形象库直接复用了它的成果，非常感谢 ♥

## License

[MIT](LICENSE) © 2026 EAPPLE
