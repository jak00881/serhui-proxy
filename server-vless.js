// Render.com VLESS-over-WS 服务器（改进版）
// 基于 Hono.js + WebSocket 实现

import { Hono } from 'hono';
import { websocket } from 'hono/websocket';

const app = new Hono();

// VLESS 配置
const VLESS_CONFIG = {
  uuid: '7ec6d45a-9ef0-4418-8c92-f076448e9c09',
  flow: 'xtls-rprx-vision',
  port: 443,
  network: 'ws',
  path: '/api/ws',
  host: 'serhui-proxy.onrender.com'
};

// 允许的域名后缀
const ALLOWED_SUFFIXES = ['.googleapis.com'];

function isAllowedHost(host) {
  return ALLOWED_SUFFIXES.some(suffix => host.endsWith(suffix));
}

// WebSocket 路由 - VLESS-over-WS
app.use('/api/ws', async (c, next) => {
  const upgrade = c.req.header('Upgrade');
  
  if (!upgrade || upgrade !== 'websocket') {
    await next();
    return;
  }
  
  // 获取目标主机
  const hostHeader = c.req.header('host') || '';
  
  // 检查是否允许
  if (!isAllowedHost(hostHeader)) {
    return c.text(`Forbidden: ${hostHeader}`, 403);
  }
  
  // 创建 WebSocket 对
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  
  // 接受客户端连接
  server.accept();
  
  // VLESS-over-WS 代理逻辑
  let targetWebSocket = null;
  let clientClosed = false;
  let serverClosed = false;
  
  // 监听客户端消息
  client.addEventListener('message', (event) => {
    console.log('Client message received:', event.data);
    
    if (targetWebSocket && !serverClosed) {
      try {
        targetWebSocket.send(event.data);
      } catch (err) {
        console.error('Error forwarding to target:', err);
        closeConnection();
      }
    }
  });
  
  // 监听目标 WebSocket 消息
  if (targetWebSocket) {
    targetWebSocket.addEventListener('message', (event) => {
      if (!clientClosed) {
        client.send(event.data);
      }
    });
    
    targetWebSocket.addEventListener('close', () => {
      serverClosed = true;
      if (!clientClosed) {
        client.close(1000);
      }
    });
    
    targetWebSocket.addEventListener('error', (err) => {
      console.error('Target WebSocket error:', err);
      closeConnection();
    });
  }
  
  // 监听客户端关闭
  client.addEventListener('close', () => {
    clientClosed = true;
    if (!serverClosed && targetWebSocket) {
      targetWebSocket.close(1000);
    }
  });
  
  client.addEventListener('error', (err) => {
    console.error('Client WebSocket error:', err);
    closeConnection();
  });
  
  function closeConnection() {
    if (!clientClosed) {
      client.close(1006);
      clientClosed = true;
    }
    if (!serverClosed && targetWebSocket) {
      targetWebSocket.close(1006);
      serverClosed = true;
    }
  }
  
  return new Response(null, {
    status: 101,
    webSocket: client
  });
});

// 健康检查
app.get('/health', (c) => {
  return c.json({ 
    status: 'ok', 
    timestamp: Date.now(),
    vless_uuid: VLESS_CONFIG.uuid
  });
});

// 错误处理
app.onError((err, c) => {
  console.error('Server error:', err);
  return c.json({ 
    error: 'internal_error', 
    message: err.message 
  }, 500);
});

export default app;
