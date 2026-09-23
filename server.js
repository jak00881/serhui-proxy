// Render.com V2Ray VLESS-over-WS 服务器
// 兼容原 Vercel Worker 功能

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// 允许的域名后缀
const ALLOWED_SUFFIXES = ['.googleapis.com'];

function isAllowedHost(host) {
  return ALLOWED_SUFFIXES.some(suffix => host.endsWith(suffix));
}

// WebSocket 服务器
const wss = new WebSocket.Server({ 
  path: '/api/ws',
  noServer: true 
});

wss.on('connection', (ws, req) => {
  console.log('WebSocket connection established');
  
  let targetSocket = null;
  let clientClosed = false;
  let serverClosed = false;
  
  ws.on('message', (data) => {
    if (targetSocket && !serverClosed) {
      targetSocket.write(data);
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    if (!clientClosed) {
      ws.close();
      clientClosed = true;
    }
  });
  
  ws.on('close', () => {
    clientClosed = true;
    if (!serverClosed && targetSocket) {
      targetSocket.end();
    }
  });
});

// HTTP 服务器
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // 健康检查
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    return;
  }
  
  // WebSocket 升级请求
  if (url.pathname === '/api/ws' && req.headers.upgrade === 'websocket') {
    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }
  
  // 检查是否需要代理的目标主机
  let targetUrl = null;
  
  if (url.searchParams.has('target')) {
    targetUrl = url.searchParams.get('target');
  } else {
    const hostHeader = req.headers.host || '';
    
    if (!isAllowedHost(hostHeader)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'forbidden host', 
        host: hostHeader,
        allowed: ALLOWED_SUFFIXES.join(', ')
      }));
      return;
    }
    
    targetUrl = `https://${hostHeader}${url.pathname}${url.search}`;
  }
  
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no target specified' }));
    return;
  }
  
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined
    });
    
    const headers = {};
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'keep-alive', 'upgrade', 'connection'].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    });
    
    res.writeHead(response.status, headers);
    response.body.pipe(res);
    
  } catch (err) {
    console.error('Proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy error', message: err.message }));
  }
});

// 启动服务器
wss.on('listening', () => {
  console.log('WebSocket server ready');
});

server.listen(PORT, () => {
  console.log(`V2Ray proxy server running on port ${PORT}`);
});

module.exports = server;
