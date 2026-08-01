# 部署任务：把「传画接龙」部署到 104.214.172.72 服务器

请按下面的要求完成部署，并在完成后汇报访问链接、服务状态和验证结果。

## 1. 项目与目标

- 项目：传画接龙（Draw-Guess），本地源码在 `C:\Users\31626\Downloads\Draw-Guess`
  - Node + Express + Socket.IO，入口 `server.js`，端口默认 `process.env.PORT || 3000`，静态资源在 `public/`
- 服务器：104.214.172.72（Azure 虚拟机）
  - SSH：用户 `azureuser`（注意：`race` 用户认证失败，不要用），端口 22
  - 密钥文件：`C:\Users\31626\Downloads\race_key.pem`
  - 本机 OpenSSH 可能因密钥权限拒绝连接，可用 Python `paramiko` 连接（`python -c "import paramiko"` 验证，没有就 `pip install paramiko`）
- 访问方式（本任务采用）：**80 端口子路径** `http://104.214.172.72/draw-guess/`
  - 服务器上的现有游戏 Fable Race 已迁移到子路径 `http://104.214.172.72/fable-race/`；80 根路径现在是导航页 `http://104.214.172.72/`（逆天のai游戏导航，两个游戏的入口），另外 Colyseus 占用 2567 端口，**均不得干扰**
  - 公网目前只放行了 80、22、2567 三个端口；8080/3000 等端口被 Azure 网络安全组拦截，所以新项目走 80 子路径，不需要改防火墙

## 2. 服务器现状（已核实）

- 2 核 CPU，内存共 844MB（可用约 400MB），磁盘剩 27GB，无 swap，无 Docker
- 现有服务：`nginx`（80 端口，根路径反代到 Fable Race 的 Colyseus 2567 端口）、`fable-race.service`
- 服务器可联网执行 `npm install`（/opt/fable-race 的依赖就是这样装的）
- 不要安装 Docker；新服务内存占用控制在 200MB 以内

## 3. 部署步骤

### 3.1 代码适配（子路径必需，改动很小）

前端资源目前有两处绝对路径，不改成相对路径在子路径下会 404/连错服务器：

1. `public/index.html` 第 278 行：
   `<script src="/socket.io/socket.io.js"></script>` 改为
   `<script src="socket.io/socket.io.js"></script>`（相对路径）
2. `public/game.js` 中的 `socket = io()`（约第 593 行）改为带子路径的 socket 路径，推荐动态推导，保证本地开发不受影响：
   ```js
   socket = io({ path: new URL('socket.io', location.href).pathname });
   ```
   这样本地访问 `/socket.io/`，部署后自动变成 `/draw-guess/socket.io`。
3. 全局搜索 `public/` 下所有绝对路径引用（`src="/..."`、`href="/..."`、`fetch('/...')` 等），一律改为相对路径或基于当前页面路径推导。
4. 服务端 `server.js` 不需要改 socket 路径（nginx 会剥掉 `/draw-guess` 前缀，后端仍是默认 `/socket.io/`）；也不要改监听端口，端口由 systemd 环境变量注入。

改完先在本地跑一遍 `node server.js` 确认游戏可正常开局（单机多开两个浏览器窗口验证建房间/作画/猜词/结算）。

### 3.2 上传与安装

- 把整个项目（含 `public/`、`server.js`、`words.js`、`词库/` 等，排除 `node_modules`、`.git`）上传到服务器 `/opt/draw-guess`
- 在服务器上执行 `cd /opt/draw-guess && npm install --omit=dev`（先确认服务器有 node 和 npm；`node -v` 应 >= 18）
- 注意：不要把 Windows 的 node_modules 直接拷过去

### 3.3 systemd 服务

新建 `/etc/systemd/system/draw-guess.service`：

```ini
[Unit]
Description=Draw Guess (传画接龙)
After=network.target

[Service]
WorkingDirectory=/opt/draw-guess
Environment=PORT=8080
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

执行 `sudo systemctl daemon-reload && sudo systemctl enable --now draw-guess`，确认 `systemctl is-active draw-guess` 为 active，且服务监听 8080 端口（`sudo ss -tlnp | grep 8080`）。

### 3.4 nginx 子路径转发

- 先备份：`sudo cp /etc/nginx/sites-enabled/fable-race /etc/nginx/sites-enabled/fable-race.bak`
  - 在**同一个文件** `/etc/nginx/sites-enabled/games`（网关站点配置，已包含导航页与 Fable Race 子路径）的 server 块内、`location /`（反代到 2567 的 catch-all）**之前**插入：

```nginx
    # 传画接龙：80 端口子路径 /draw-guess/ → 本地 8080
    location /draw-guess/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
    }
```

  （文件顶部已有 `map $http_upgrade $connection_upgrade`，直接复用；不要动该文件里其他任何内容，尤其不要动 Fable Race 的静态目录和 `location /` 反代。）
- `sudo nginx -t` 通过后 `sudo systemctl reload nginx`
- 不要创建会监听 80/2567 的新服务，不要动 `fable-race.service`

### 3.5 验证（全部通过才算完成）

1. 本机：`curl -s http://127.0.0.1:8080/` 能返回游戏页面
2. 本机：`curl -sI http://127.0.0.1:8080/socket.io/socket.io.js` 返回 200
3. 公网：`curl -s http://104.214.172.72/draw-guess/` 返回游戏页面；`curl -sI http://104.214.172.72/draw-guess/socket.io/socket.io.js` 返回 200
4. WebSocket 端到端：用 `socket.io-client`（项目依赖里有）连 `http://104.214.172.72/draw-guess`，指定 `path: '/draw-guess/socket.io'`，验证连接成功、能收发事件（例如创建房间成功）
5. 确认 Fable Race 与导航页未受影响：`curl -sI http://104.214.172.72/fable-race/` 返回 200，`curl -s http://104.214.172.72/` 返回导航页（含“逆天のai游戏导航”），`systemctl is-active fable-race` 仍为 active

## 4. 汇报内容

- 最终访问链接：`http://104.214.172.72/draw-guess/`
- `systemctl status draw-guess` 摘要、内存占用（`ps aux | grep node` 的 RSS）
- 改动过的文件清单（index.html、game.js 等）
- 验证结果列表（第 3.5 节的 1-5 项）
