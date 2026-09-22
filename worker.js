// Cloudflare Workers HTTP 反向代理
// 支持直接访问和参数化访问

async function proxyRequest(req, env) {
  const url = new URL(req.url);
  
  // 检查是否需要代理的目标主机
  let targetUrl = null;
  
  if (url.searchParams.has('target')) {
    // 通过 URL 参数指定目标
    targetUrl = url.searchParams.get('target');
  } else if (url.searchParams.has('host') && url.searchParams.has('path')) {
    // 分离 host 和 path
    const host = url.searchParams.get('host');
    const path = url.searchParams.get('path');
    targetUrl = `https://${host}${path}`;
  } else {
    // 使用 Host header 作为目标
    const hostHeader = req.headers.get('host') || url.hostname;
    
    // 允许的目标域名后缀
    const allowedSuffixes = ['.googleapis.com'];
    const isAllowed = allowedSuffixes.some(suffix => hostHeader.endsWith(suffix));
    
    if (!isAllowed) {
      return new Response(JSON.stringify({ 
        error: 'forbidden host', 
        host: hostHeader,
        allowed: allowedSuffixes.join(', ')
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    targetUrl = `https://${hostHeader}${url.pathname}${url.search}`;
  }
  
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'no target specified' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    return await handleProxy(targetUrl, req);
  } catch (err) {
    console.error('Proxy error:', err);
    return new Response(JSON.stringify({ 
      error: 'proxy error', 
      message: err.message 
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleProxy(targetUrl, req) {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname;
    
    // 构建请求头
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      // 跳过 hop-by-hop 头
      if (!['transfer-encoding', 'keep-alive', 'upgrade', 'connection'].includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
    headers.set('host', host);
    
    // 发起代理请求
    const proxyReq = new Request(targetUrl, {
      method: req.method,
      headers,
      body: req.body
    });
    
    // 设置超时（Cloudflare Workers 默认 10s，可延长到 60s）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    
    const proxyRes = await fetch(proxyReq, {
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    // 构建响应头
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!['transfer-encoding', 'keep-alive', 'upgrade', 'connection'].includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }
    
    // 设置 CORS 头（如果需要）
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    
    return new Response(proxyRes.body, {
      status: proxyRes.status,
      headers: responseHeaders
    });
    
  } catch (err) {
    console.error('Proxy error:', err);
    return new Response(JSON.stringify({ 
      error: 'proxy error', 
      message: err.message 
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export default {
  async fetch(req, env, ctx) {
    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }
    
    return proxyRequest(req, env);
  }
};
