# 部署文档 (DEPLOYMENT)

## 1. 环境要求

- Linux（本项目在 Ubuntu 上开发部署）
- Node.js ≥ 18（本项目**零 npm 依赖**，直接 `node server.js` 即可运行）
- 可选：`cpolar`（公网隧道）、`curl`（数据层容错兜底会用到）

## 2. 本地部署

### 2.1 配置与开发启动

```bash
# 进入项目目录
cd /home/brian/WorkBuddy/stock-lens

# 配置密钥（首次）
cp llm.config.example.json llm.config.json
# 编辑 llm.config.json：
#   accessToken  → 访问口令（留空则关闭口令门）
#   deepseek.apiKey → DeepSeek API Key（留空则 AI 研报不可用）
#   kimi.apiKey     → Kimi API Key（留空则 AI 研报不可用）

# 开发时前台启动
node server.js
```

默认端口 `8630`，可通过环境变量覆盖：`PORT=9000 node server.js`。

### 2.2 生产运行：systemd 用户服务（当前机器已启用）

生产环境不使用前台进程或 `nohup`，而是由 systemd 托管。当前配置提供：

- `enable`：用户服务自动启动。
- `Restart=always` + `RestartSec=5`：进程异常退出或被杀死后，5 秒内自动拉起。
- `loginctl enable-linger brian`：电脑重启后，无需等待用户登录即启动用户服务。
- `logs/server.log`：持久保存应用输出和异常日志。
- cpolar 系统服务也已 `enabled`，开机自动建立公网隧道。

首次安装或配置有更新时：

```bash
cd /home/brian/WorkBuddy/stock-lens
mkdir -p "$HOME/.config/systemd/user" logs
cp deploy/stock-lens.service "$HOME/.config/systemd/user/stock-lens.service"
systemctl --user daemon-reload
systemctl --user enable --now stock-lens.service
loginctl enable-linger brian
```

日常运维：

```bash
systemctl --user status stock-lens       # 查看状态
systemctl --user restart stock-lens      # 修改代码或配置后重启
systemctl --user stop stock-lens         # 主动维护时停止（不会被自动拉起）
systemctl --user start stock-lens        # 维护完成后启动
tail -f logs/server.log                  # 查看应用日志
loginctl show-user brian -p Linger       # 应显示 Linger=yes
```

验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8630/          # 页面 → 200
curl -s -o /dev/null -w "%{http_code}\n" https://stocklens.vip.cpolar.cn/ # 公网页面 → 200
curl -s -H "x-access-token: 你的口令" "http://127.0.0.1:8630/api/analyze?code=600519"
```

## 3. 公网发布（cpolar 隧道）

以本机为例，将本服务通过固定子域名暴露到公网（与 mistake-book 同套模式）。

### 3.1 临时隧道（即时可用）

```bash
cpolar http 8630 -subdomain=stocklens -region=cn_vip -log=stdout -dashboard=off
```

### 3.2 系统级隧道（开机自启，永久生效）

编辑 `/usr/local/etc/cpolar/cpolar.yml`，在 `tunnels:` 下新增：

```yaml
  stocklens:
    proto: http
    addr: '8630'
    subdomain: stocklens
    region: cn_vip
    bind_tls: both
```

然后重启服务加载配置：

```bash
sudo systemctl restart cpolar
```

> 注意：配置变更后必须重启系统级 cpolar 服务才会生效；重启前临时隧道会继续撑住公网访问，重启后需停掉临时进程避免子域名绑定冲突。

## 4. 防火墙与安全

- 服务只监听 `127.0.0.1`，**不对外网直接开放端口**，公网访问统一经 cpolar 隧道
- 公网入口务必配置 `accessToken` 口令（见 llm.config.json），防止被陌生人扫描滥用 API
- API Key 与口令只存在于 `llm.config.json`，已被 `.gitignore` 排除，**切勿提交到 Git**

## 5. 常见问题

| 现象 | 处理 |
|------|------|
| 分析结果"数据源降级到腾讯" | 东财主源被限流，属正常容错；稍后自动恢复 |
| AI 研报报"暂时不可用" | 检查 llm.config.json 的 Key 是否有效、是否欠费；规则引擎不受影响 |
| 页面能打开但数据 401 | 令牌缓存失效，重新输入口令即可 |
| 公网打不开 | 先查 `systemctl --user status stock-lens` 和本地 8630 页面，再查 `systemctl status cpolar`；不要盲目只重启隧道 |
