# 📱 国粹棋牌 · Android Termux 原生直接部署教程

> 本教程面向 **全新直接部署在 Android 手机 Termux** 中使用，无需安装任何 Linux/Ubuntu 虚拟机或容器，拉取仓库后即可运行。
> 若后续计划将同一套代码部署到**家里旧电脑（Linux）**或**云服务器**，请参考另一份《Linux 电脑与云服务器部署教程》。

---

## 一、 准备工作（30 秒）

1. **安装最新版 Termux**（建议从 GitHub Releases 或 F-Droid 下载，不要使用 Google Play 旧版）。
2. **关闭手机系统省电限制**（避免息屏后掉线或延迟飙升）：
   - 手机系统设置 → 应用管理 → Termux → 电池策略改为 **“无限制 / 允许完全后台运行”**；
   - 尽量使用 **5GHz Wi-Fi 并保持插电** 运行（相比移动流量可大幅减少基站休眠唤醒带来的延迟抖动）。

---

## 二、 拉取代码并一键部署

打开 Termux 终端，依次执行以下命令：

### 1. 更新源并安装 Git
```bash
termux-wake-lock
pkg update -y && pkg upgrade -y
pkg install -y git
```

### 2. 拉取项目代码并执行原生部署脚本
```bash
git clone https://github.com/你的用户名/你的仓库名.git ~/chess-lobby
cd ~/chess-lobby
chmod +x deploy_termux_native.sh
./deploy_termux_native.sh
```

脚本会自动完成以下全部工作（**支持智能检测，已安装内容不重复下载**）：
- 逐项检测 `nodejs-lts`、`cloudflared`、`tmux`、`jq`、`curl` 等工具，已安装直接跳过 `pkg update/install`，安装后自动清理缓存；
- 对比 `package.json` / `package-lock.json` 指纹，依赖未变更时跳过 `npm install --omit=dev`，避免反复下载膨胀缓存；
- 智能检查前端静态包 `dist/`，仅在首次缺少或前端源码更新时检查拉取最新 `dist.tar.gz`；
- 创建 `.env` 与 `data/` 数据目录；
- 启动名为 `chess-native` 的 `tmux` 后台双窗口会话（`server` 跑后端、`tunnel` 跑隧道），后续更新仅热重启后端、尽量保持隧道不断线。

---

## 三、 配置 `.env`（机器人与管理密钥）

首次运行脚本后会在项目根目录生成 `.env`，按需编辑：

```bash
cd ~/chess-lobby
nano .env
```

核心字段说明：
- `PORT=3000`：服务端口（保持默认即可）
- `URL=` / `APP_URL=`：填写你的公网 HTTPS 域名（如 `https://m.my66.cc.cd`）；若留空则 Telegram Bot 自动采用长轮询
- `TELEGRAM_BOT_TOKEN=`：填写你的 Telegram 机器人 Token
- `ADMIN_API_SECRET=`：设置一个高强度管理接口密钥（用于管理后台与导出接口鉴权）

修改保存（`Ctrl+O` 回车保存，`Ctrl+X` 退出）后，重启服务生效：
```bash
./deploy_termux_native.sh
```

---

## 四、 配置 Cloudflare Tunnel（针对禁用 QUIC / HTTP/2 场景）

由于多数手机运营商或局域网环境下 QUIC/UDP 无法连通，脚本已内置专门针对 HTTP/2 的低延迟启动参数：
`--edge-ip-version 4 --protocol http2 --ha-connections 2`

### 方式 A：Token 模式（推荐，在 Cloudflare Zero Trust 后台配置好域名指向 `http://127.0.0.1:3000`）
将你的隧道 Token 写入 Termux 启动环境（`~/.bashrc`）或直接写入 `.env`：
```bash
echo 'export CLOUDFLARED_TUNNEL_TOKEN="你的隧道Token"' >> ~/.bashrc
source ~/.bashrc
cd ~/chess-lobby && ./deploy_termux_native.sh
```
之后每次运行脚本，`tunnel` 窗口都会自动拉起固定域名隧道。

### 方式 B：配置文件模式（`~/.cloudflared/config.yml`）
如果已在 `~/.cloudflared/` 放好 `cert.pem`、凭证 JSON 和 `config.yml`，直接运行 `./deploy_termux_native.sh` 即会自动识别并拉起。

### 方式 C：临时公网域名测试
切到隧道窗口手动启动：
```bash
tmux attach -t chess-native
# 先按 Ctrl+b 再按 n 切到 tunnel 窗口，然后执行：
cloudflared tunnel --edge-ip-version 4 --protocol http2 --url http://127.0.0.1:3000
```

### 排查隧道连线机房（定位延迟来源）
在 Termux 执行以下命令查看 `location=` 后的机房代号：
```bash
tmux capture-pane -pt chess-native:tunnel -S -80 | grep -i "location="
```
- 若返回 `lax`/`sjc` 等美西机房，高延迟主要源于跨洋绕行；若能连通 `sin`/`nrt`/`hkg` 等亚太节点，体验会显著改善。
- 若玩家和手机处于同一 Wi-Fi，可直接在客户端右上角【服务器配置】切换为局域网 IP 连接，延迟通常仅 **5～30ms**。

---

## 五、 日常运维与代码更新

### 1. 查看与管理后台进程
```bash
# 打开实时日志面板
tmux attach -t chess-native

# 在面板内切换 server / tunnel 窗口：先按 Ctrl+b，松开后再按 n
# 退出面板但保持后台继续运行（切勿直接按 Ctrl+C）：先按 Ctrl+b，松开后再按 d
```

### 2. 拉取最新代码增量更新（不重装软件包）
```bash
cd ~/chess-lobby
git pull
./deploy_termux_native.sh
```
> 增量机制说明：
> - 已安装的系统工具不会再触发 `pkg update/install`；
> - `package.json` 无变化时不会重跑 `npm install`；
> - 仅按需更新 `dist/` 并热重启服务端，现有隧道连接保持不断；
> - 如需强制重新拉取 `dist.tar.gz` 可加 `--update-dist`，强制重装依赖可加 `--force-deps`，强制连同隧道一起重启可加 `--restart-all`。

### 3. 停止全部后台服务
```bash
tmux kill-session -t chess-native
```
