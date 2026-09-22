// Cloudflare Pages Functions - VLESS-over-WS 代理
// 基于 Hono.js + VLESS 协议实现

import { Hono } from 'hono';

const app = new Hono();

// 允许的域名后缀
const ALLOWED_SUFFIXES = ['.googleapis.com'];

function isAllowedHost(host) {
  return ALLOWED_SUFFIXES.some(suffix => host.endsWith(suffix));
}

// WebSocket 路由
app.get('/api/ws', async (c) => {
  const upgrade = c.req.header('Upgrade');
  
  if (!upgrade || upgrade !== 'websocket') {
    return c.text('WebSocket required', 400);
  }
  
  // 获取目标主机
  const hostHeader = c.req.header('host') || '';
  const targetUrl = `https://${hostHeader}${c.req.path}`;
  
  // 检查是否允许
  if (!isAllowedHost(hostHeader)) {
    return c.text(`Forbidden: ${hostHeader}`, 403);
  }
  
  // 创建 WebSocket 连接
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  
  // 代理逻辑
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    
    // 发起原始请求
    const response = await fetch(targetUrl, {
      headers: {
        ...Object.fromEntries(c.req.raw.headers),
        host: hostHeader
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    // 返回升级响应
    server.accept();
    
    // 双向代理
    let clientClosed = false;
    let serverClosed = false;
    
    server.addEventListener('message', (event) => {
      if (!clientClosed) {
        client.send(event.data);
      }
    });
    
    client.addEventListener('message', (event) => {
      if (!serverClosed) {
        server.send(event.data);
      }
    });
    
    client.addEventListener('close', () => {
      clientClosed = true;
      if (!serverClosed) {
        server.close(1000);
      }
    });
    
    server.addEventListener('close', () => {
      serverClosed = true;
      if (!clientClosed) {
        client.close(1000);
      }
    });
    
    return new Response(null, {
      status: 101,
      webSocket: client
    });
    
  } catch (err) {
    console.error('WebSocket error:', err);
    return c.text(`Error: ${err.message}`, 500);
  }
});

// 健康检查
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

export default app;
