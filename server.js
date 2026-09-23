// Render.com HTTP 代理服务器（修复版）

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8080;

// 允许的域名后缀
const ALLOWED_SUFFIXES = ['.googleapis.com'];

function isAllowedHost(host) {
  return ALLOWED_SUFFIXES.some(suffix => host.endsWith(suffix));
}

// HTTP 服务器
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // 健康检查
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
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
    
    // 流式传输响应体
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
    }
    
    res.end();
    
  } catch (err) {
    console.error('Proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy error', message: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`HTTP proxy server running on port ${PORT}`);
});

module.exports = server;
