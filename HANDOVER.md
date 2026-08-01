# Draw-Guess 会话交接记录

记录截至 2026-08-02。后续会话先读 `AGENTS.md`，本文件提供历史上下文与运维信息。

## 1. 已完成的开发工作

### 安全与稳定性修复（V2.4, 2026-08-02）

- **删除 `reconnect_request` handler**：该遗留事件可被任意房间成员调用（房间内所有玩家 id 经 `room_update` 公开），直接顶替目标玩家的槽位并连带夺取房主身份；实测可复现。前端实际重连走 `reconnect_to_room`（按昵称），删除后无影响。
- **灵机一动选词超时兜底**：`applyCleverWordsToSelection` 此前不设选词计时器，玩家不选词会永久卡在选词页；抽出 `scheduleWordSelectTimeout` 与普通模式共用。
- **`back_to_room` 守卫**：进行中阶段（选词/作画/猜词/灵机一动/回顾投票）不再清除回合计时器，防止任意玩家调用导致整轮卡死。
- **事件传参统一为对象**：`submit_guess` / `select_word` / `submit_clever_word` 改为 `{ word }`（服务端兼容旧裸字符串），落实"一律传对象"约定。
- 本地 E2E 回归 39 项断言全过（4 人完整局、断线重连、超时补白、投票结算、安全边界、上述 4 个修复点）。

### 审阅与修复（V2.3, commit 8a35f4a）

- **存储型 XSS 封堵**：服务端校验猜词/灵机一动/画作/选词/头像长度与格式；前端所有 innerHTML 注入点统一 `escapeHtml`
- **补交画作机制重写**：原逻辑因"每玩家每轮恰好一个任务"而永远不触发，超时画布会覆盖他人画作；现改为只覆盖本人 `isBlank` 槽位
- **空白画布**：从"长度 < 200"魔法判断改为显式 `isBlank` 标记，画布为 600x400 纯白 SVG
- **其他**：无人房间 15 分钟清理、重复开始守卫、聊天历史恢复、结算分数展示、退出提示语修正、socket.io 本地托管（去 CDN）、`.gitignore` 新增

### UI 美化（V2.3, commit 8a35f4a）

- 暗色玻璃拟态 + 渐变主题全新重制（入口/大厅/游戏/投票/回顾/结算），响应式适配

### UI 回归修复（V2.3.1, commit 90a4990）

- 聊天消息不可见：`.chat-box` 的 `overflow:hidden` 裁掉了上方消息列表 → 移除，圆角改由输入行承担
- 画笔粗细调不了：`.draw-toolbar` 的 `backdrop-filter` 破坏 fixed 弹层包含块 → 移除
- 历史消息规则：最后一条 15s 淡出 3s；淡出期间来新消息保留历史，否则清空
- 延迟显示定位（入口卡片 backdrop-filter 影响 fixed 定位）修复
- 渐变文字 `@supports` 降级保护

## 2. 部署记录（104.214.172.72）

- **V2.4 部署（2026-08-02）**：SFTP 上传 `server.js`、`public/game.js`、`public/index.html` 至 `/opt/draw-guess`（上传前备份为 `server.js.bak-20260802-040245` 等），`systemctl restart draw-guess` 后服务 active；本地 8080 与 nginx `/draw-guess/` 均 200；生产 E2E 冒烟 8/8 通过（建房/词库7个/加人/选词/作画/猜词/回顾/reconnect_request 已失效）。本地 sha1 与服务器文件一致。
- 访问：`http://104.214.172.72/draw-guess/`
- 服务：`draw-guess.service`（systemd，`PORT=8080`，WorkingDirectory `/opt/draw-guess`，node server.js，Restart=always）
- nginx：当前生效站点 `/etc/nginx/sites-available/games`（symlink 自 sites-enabled），内含 `location /draw-guess/` 反代到 `http://127.0.0.1:8080/`（含 Upgrade/Connection 头，支持 WebSocket）；备份 `games.bak`
- 验证全通过：本地 8080 页面/socket.io.js 200；nginx `/draw-guess/` 及 socket.io.js 200；公网 HTTP 200；WebSocket 端到端建房成功；无头浏览器公网建房成功；fable-race 200、服务 active
- 内存：draw-guess RSS ≈ 65MB（上限 200MB），服务器 844MB 总量
- 服务器操作建议用 paramiko（本机已装 5.0.0），密钥 `C:\Users\31626\Downloads\race_key.pem`

### 部署期间的重要事件

- 部署中途服务器 nginx 被外部并发修改：`sites-enabled` 从 `fable-race` 换成 `games`（导航页迁至 `/opt/game-nav`），我写入 fable-race 的转发规则被还原；最终规则加到了生效的 `games` 配置。**若再有其他会话并行操作该服务器，先核对 sites-enabled 现状再改动**
- 服务器根路径实际是导航页（200），不是文档所述的 301；未改动原有行为
- systemd unit 与 nginx 注释用英文写入（中文经 SSH heredoc 会乱码）
- 服务器 `npm audit` 同样提示 5 个依赖漏洞

## 3. 验证方法（可复用）

- 本地冒烟：启动 `node server.js`，用 `socket.io-client`（node_modules 内）双客户端跑建房→选词→作画→猜词→回顾
- 浏览器级：无头 Edge（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）加 `--headless=new --remote-debugging-port`，Node 全局 WebSocket 走 CDP 驱动页面（建房、聊天可见性、画笔面板、淡出规则等）
- 公网 WebSocket 验证：`io('http://104.214.172.72', { path: '/draw-guess/socket.io' })`（URL 不要带路径，否则会被当作 namespace）

## 4. 未提交改动（本地）

- `public/game.js`、`public/index.html`、`test.html`：子路径部署适配（相对 socket.io 路径 + 动态 path）
- 未跟踪：`DEPLOY_TO_SERVER_PROMPT.md`
- 部署到服务器的文件已包含这些改动，本地 git 尚未提交

## 5. 项目位置迁移

- 已从 `C:\Users\31626\Downloads\Draw-Guess` 迁移到 `C:\Users\31626\Downloads\nitianai\Draw-Guess`（完整副本，git 完好）
- 旧目录因被会话占用未能自动删除，待手动执行：
  `Remove-Item -LiteralPath 'C:\Users\31626\Downloads\Draw-Guess' -Recurse -Force`

## 6. 已知问题清单

- `npm audit`：5 个漏洞（1 low / 4 high）
- git 仓库卫生：`node_modules`、`.reasonix/truncated-results/*` 被提交；有 `.gitignore` 但已跟踪文件未移除
- 密码功能/`transfer_owner`/`reconnect_request` 等存在但前端未接入的死代码
- `docx` 依赖声明但未使用
