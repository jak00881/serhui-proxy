# Vercel → Render 迁移指南

## 📋 文件清单

已准备好以下文件：

- ✅ `server.js` - Render 兼容的 Node.js 服务器
- ✅ `package.json` - Node.js 依赖配置
- ✅ `render.yaml` - Render 配置文件
- ✅ `.gitignore` - Git 忽略文件

## 🚀 部署步骤

### 1. 初始化 Git 仓库（已完成）

```bash
cd /root/bin/serhui-proxy
git init
git add .
git commit -m "Render migration"
```

### 2. 推送到 GitHub

```bash
# 在 GitHub 创建新仓库
# https://github.com/new

git remote add origin git@github.com:YOUR_USERNAME/serhui-proxy.git
git branch -M main
git push -u origin main
```

### 3. 在 Render 部署

1. **访问**: https://render.com/
2. **登录**: 使用 GitHub 账户
3. **New → Web Service**
4. **Connect your GitHub repo** → 选择 `serhui-proxy`

### 4. Render 配置

#### Basic Settings
- **Name**: `serhui-proxy`
- **Region**: Singapore (ap-southeast-1)
- **Branch**: `main`
- **Root Directory**: `/root/bin/serhui-proxy` (可选)
- **Environment**: Node

#### Build and Deploy
- **Build Command**: `npm install`
- **Start Command**: `node server.js`
- **Instance Type**: Free

#### Advanced Options
- **Health Check Path**: `/health`
- **Auto-deploy**: ✅ Enable

### 5. 获取部署信息

部署成功后，Render 会提供：
- **URL**: `https://serhui-proxy.onrender.com`
- **Public IP**: （如果需要）

### 6. 更新 Mihomo 配置

在 `/etc/mihomo/config.yaml` 中添加：

```yaml
proxies:
  - name: "🟢 Render-SG"
    type: vless
    server: serhui-proxy.onrender.com
    port: 443
    uuid: 7ec6d45a-9ef0-4418-8c92-f076448e9c09
    network: ws
    tls: true
    udp: true
    servername: serhui-proxy.onrender.com
    client-fingerprint: chrome
    skip-cert-verify: false
    ws-opts:
      path: /api/ws
      headers:
        Host: serhui-proxy.onrender.com
```

然后添加到代理组：

```yaml
proxy-groups:
  - name: 🤖 Google-Gemini
    type: select
    proxies:
      - 🟢 Render-SG  # 添加在这里
      - 🇸🇬 新加坡优先 (故障转日本)
      - ...
```

### 7. 重启 Mihomo

```bash
pkill mihomo && nohup /usr/local/bin/mihomo -d /etc/mihomo -ext-ui /opt/metacubexd &
```

### 8. 测试连接

```bash
curl --proxy http://127.0.0.1:7890 https://www.google.com
```

## ⚠️ 注意事项

### Free Tier 休眠问题
Render 的免费服务会在闲置时进入休眠。解决方法：

1. **使用 Uptime Robot 监控**
   - 访问 https://uptimerobot.com/
   - 添加 Monitor → Type: HTTP(s)
   - URL: `https://serhui-proxy.onrender.com/health`
   - Check every 5 minutes

2. **或者升级到 Starter ($7/月)**
   - 保持始终在线
   - 更好的性能

## 📊 成本对比

| 方案 | 每月成本 | 是否全天在线 | 推荐度 |
|------|---------|-------------|--------|
| Render Free | $0 | ❌ 需唤醒 | ⭐⭐⭐ |
| Render Starter | $7 | ✅ 始终在线 | ⭐⭐⭐⭐⭐ |
| Oracle Cloud | $0 | ✅ 始终在线 | ⭐⭐⭐⭐⭐ |
| Fly.io Free | $0 (3 VMs) | ✅ 始终在线 | ⭐⭐⭐⭐ |

## 🔧 故障排查

### 构建失败
- 检查 `package.json` 是否正确
- 查看 Render 日志
- 确保 Node.js 版本 ≥ 18

### WebSocket 连接失败
- 确认路径是 `/api/ws`
- 检查 Mihomo 配置中的 `ws-opts.path`
- 验证域名和端口

### 无法访问
- 检查 Render 服务状态
- 确认健康检查通过
- 尝试手动唤醒（访问网站）

## 📝 总结

✅ 代码已准备就绪  
✅ 支持 VLESS-over-WS  
✅ 兼容 Mihomo  
⚠️ Free tier 需要唤醒  

开始部署吧！
