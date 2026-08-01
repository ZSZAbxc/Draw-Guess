# Draw-Guess 传画接龙 — 项目说明（给 AI 代理）

> 本文件是 Codex 在该仓库工作时自动读取的入口说明。完整历史与部署细节见 `HANDOVER.md`、`DEPLOY_TO_SERVER_PROMPT.md`。

## 项目概述

多人联机"传画接龙"派对游戏：玩家轮流作画、猜词形成"画→猜→画→猜"链条，结束后回顾链条并投票评选"一眼丁真"（最佳猜手）与"灵魂画手"（最佳画家）。

## 技术栈

- Node.js + Express + Socket.IO（入口 `server.js`，默认端口 3000，可用 `PORT` 环境变量覆盖）
- 前端纯 HTML/CSS/JS + Canvas（`public/`），无构建步骤
- 词库：`词库/` 目录下 `【简体中文】*.txt`，运行时热切换（房主可选）
- 存储：全内存、无数据库；单进程多房间

## 快速开始

```bash
npm install
npm start        # 或 node server.js
# 浏览器打开 http://localhost:3000
```

## 目录结构

| 路径 | 说明 |
|---|---|
| `server.js` | 服务端全部逻辑（房间、链条、回合、投票、重连、聊天、保活） |
| `words.js` | 词库加载器（module.exports 为数组并挂载方法） |
| `public/index.html` / `style.css` / `game.js` | 前端页面/样式/逻辑 |
| `词库/` | 7 个中文词库 |
| `test.html` | 遗留测试页（未被 Express 托管） |

## 核心架构（改动前务必理解）

- 房间对象见 `createRoom()`：`players`、`config`、`chains`、`chainDrawings/chainGuesses`、`votesAccuracy/votesArtwork`、`scoreA/scoreB` 等
- 链条生成：N 名玩家 → N 条链，K=⌊N/2⌋，每条链 2K 步交替 draw/guess；**每名玩家每轮恰好 1 个任务**
- 回合推进：`nextStage()` → `advanceToNextRound()`；超时走 `handleRoundTimeout()`（自动补空白画布或随机词）
- 回顾+投票：`processNextReviewStep()` → `startVotingPhase()` → 正误投票 → 画作人气投票 → `finishGame()`；全投完自动缩短倒计时到 5 秒
- 断线重连：`reconnect_to_room` 按昵称找回角色，迁移分数/投票/提交/链 ID，并按阶段恢复界面
- 保活：Render 部署时有玩家在线才每 10 分钟自 ping（`RENDER_EXTERNAL_URL`）
- 无人房间清理：全员掉线超 15 分钟自动销毁

## 通信约定（历史教训：一律传对象）

- 客户端 `emit('event', { ... })`、服务端 `const { ... } = data`，**禁止散装参数**（早期 9 次同类 bug）
- 画作提交 `{ image: base64DataURL }`；服务端校验必须以 `data:image/` 开头且 ≤5MB
- 猜词/灵机一动服务端限长（>50 / >20 字符忽略），昵称 ≤12，头像 ≤8（表情符）
- 选词只允许候选词之一（服务端校验）；聊天文本前端 `escapeHtml` 后注入

## 重要约定与陷阱

- **空白画布**：超时自动填充用 `isBlank: true` 标记（600x400 纯白 SVG），禁止再用"长度 < 200"这类魔法判断
- **补交画作**：猜词轮/回顾阶段收到 `submit_drawing` 时，只覆盖**该玩家自己**最近一个 `isBlank` 槽位，绝不写入他人槽位
- **聊天**：消息列表绝对定位在输入框上方（`bottom:100%`），`.chat-box` **不能加 `overflow:hidden`**（会裁掉消息）。淡出规则：最后一条消息 15s 后淡出 3s；淡出期间来新消息则保留历史，否则完全隐藏后清空
- **fixed 定位陷阱**：含 `position:fixed` 子元素的容器不要加 `backdrop-filter/filter/transform`（会改变 fixed 包含块，历史 bug：画笔弹层跑出屏幕、延迟文字定位错乱）
- **渐变文字**：`background-clip:text` + 透明填充必须配 `@supports` 降级，否则不支持时文字消失
- **XSS**：用户可控文本（昵称/头像/猜词/提示词/画作 src）进入 innerHTML 前必须 `escapeHtml`（函数已存在）
- **静态资源**：一律相对路径（部署在 `/draw-guess/` 子路径下，见下）

## 部署现状（已上线，勿破坏）

- 生产地址：`http://104.214.172.72/draw-guess/`（Azure VM）
- 服务器：systemd `draw-guess.service` 监听 8080（`PORT=8080`），nginx 将 `/draw-guess/` 子路径反代到 8080（当前生效站点是 `/etc/nginx/sites-available/games`）
- 子路径适配：`index.html` 用相对 `socket.io/socket.io.js`；`game.js` 用 `io({ path: new URL('socket.io', location.href).pathname })`
- GitHub：`git@github.com:ZSZAbxc/Draw-Guess.git`，分支 `main`
- 服务器 SSH：`azureuser@104.214.172.72`，密钥 `C:\Users\31626\Downloads\race_key.pem`（paramiko 可用）

## 当前状态与待办

- 2026-08-02 已提交并部署安全/稳定性修复（V2.4，见 HANDOVER.md）：
  - 删除遗留 `reconnect_request` handler（可被任意房间成员顶替他人身份/房主，前端未使用）
  - 灵机一动模式补上选词超时兜底（此前玩家不选词会永久卡死），普通/灵机一动共用 `scheduleWordSelectTimeout`
  - `back_to_room` 仅在非进行中阶段清除计时器（防止恶意调用导致整轮卡死）
  - `submit_guess` / `select_word` / `submit_clever_word` 统一改传 `{ word }` 对象（服务端兼容旧裸字符串）
- `npm audit` 提示 5 个漏洞（1 low / 4 high，来自 express/socket.io 依赖树），建议后续升级
- `node_modules` 与 `.reasonix/truncated-results/*` 已被提交进 git（仓库卫生问题，因 Render 部署依赖未轻易清理）
- 项目文件夹刚从 `Downloads\Draw-Guess` 迁移到 `Downloads\nitianai\Draw-Guess`（旧目录待手动删除）
