'use strict';

const https = require('https');

// ===========================================================================
//  Google API 反代（Vercel Serverless Function）
//
//  用途：本机直连 *.googleapis.com 会被网络层阻断（TLS SNI 重置/超时），
//        经本反代落到 Vercel 边缘机房出网。本项目锁定 sin1（新加坡），
//        是离 Google 亚太区最近的 Vercel 区域。
//
//  路由约定：<host> 作为第一个路径段
//    /daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent
//      → https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent
//
//  安全：只允许转发 *.googleapis.com，不提供通用 HTTP 代理能力，
//        避免被当作开放代理滥用。
// ===========================================================================

const ALLOWED_SUFFIX = '.googleapis.com';
const DEFAULT_TARGET_HOST = 'generativelanguage.googleapis.com';

// 可选访问令牌。设置环境变量 PROXY_TOKEN 后，所有代理请求必须携带
//   Authorization: Bearer <token>   或   ?__token=<token>
// 留空（默认）则不校验，与原部署行为一致。
const ACCESS_TOKEN = (process.env.PROXY_TOKEN || '').trim();

// 逐跳头部（RFC 7230 §6.1）：不应由代理转发。
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// 目标主机白名单校验。
// 用 label 边界匹配：`notgoogleapis.com` 与 `evil-googleapis.com` 都不以
// `.googleapis.com` 结尾，会被拒绝；只有 `*.googleapis.com` 通过。
function isAllowedHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false;
  const lower = host.toLowerCase();
  return lower === ALLOWED_SUFFIX.slice(1) || lower.endsWith(ALLOWED_SUFFIX);
}

// 从 /<host><path> 形态解析出目标主机与路径（含 query）。
function parseTarget(rawUrl) {
  const url = String(rawUrl || '/');
  const match = url.match(/^\/([a-zA-Z0-9.-]+\.googleapis\.com)(.*)$/);
  if (!match) {
    return { host: DEFAULT_TARGET_HOST, path: url || '/' };
  }
  const rest = match[2] || '';
  let path = rest === '' ? '/' : rest;
  // 形如 /host?query 时补上前导斜杠，保证 path 合法。
  if (path.startsWith('?')) path = '/' + path;
  return { host: match[1], path };
}

function stripHopByHop(rawHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function isAuthorized(req) {
  if (!ACCESS_TOKEN) return true;
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ') && header.slice(7).trim() === ACCESS_TOKEN) {
    return true;
  }
  const url = String(req.url || '');
  const marker = '__token=';
  const idx = url.indexOf(marker);
  if (idx >= 0) {
    const value = url.slice(idx + marker.length).split('&')[0];
    try {
      if (decodeURIComponent(value) === ACCESS_TOKEN) return true;
    } catch (_) {
      /* 非法转义：视为未授权 */
    }
  }
  return false;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  const rawUrl = String(req.url || '/');

  // 鉴权先于任何响应分支：未授权一律 404（而非 401），
  // 避免向探测者暴露"此处存在受保护资源"这一信息。
  if (!isAuthorized(req)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8">' +
            '<title>404 Not Found</title></head>' +
            '<body><h1>404 Not Found</h1></body></html>');
    return;
  }

  // ---- 诊断端点：回显 Vercel 区域与真实出网 IP（需鉴权）----
  if (rawUrl.split('?')[0] === '/__diag') {
    let egress;
    try {
      const response = await fetch('https://ipinfo.io/json');
      egress = await response.json();
    } catch (err) {
      egress = { error: String(err) };
    }
    return json(res, 200, {
      vercelRegion: process.env.VERCEL_REGION || 'unknown',
      reqUrl: rawUrl,
      egress,
    });
  }

  const { host, path } = parseTarget(rawUrl);
  if (!isAllowedHost(host)) {
    return json(res, 403, { error: 'forbidden host', host });
  }

  const headers = stripHopByHop(req.headers);
  headers.host = host;

  const proxyReq = https.request(
    { hostname: host, port: 443, path, method: req.method, headers },
    (proxyRes) => {
      // 流式透传：不缓冲，SSE（alt=sse）才能逐块下发。
      res.writeHead(proxyRes.statusCode || 502, stripHopByHop(proxyRes.headers));
      proxyRes.pipe(res, { end: true });
    },
  );

  proxyReq.on('error', (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(res, 502, { error: 'proxy error', message: String(err) });
  });

  req.pipe(proxyReq, { end: true });
};
