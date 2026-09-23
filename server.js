'use strict';

// ===========================================================================
//  Render 常驻服务：VLESS-over-WebSocket 隧道 + Google API 反代
//
//  与 Vercel 版（api/ws.js + api/proxy.js）保持同一套协议，便于 mihomo 用
//  完全相同的客户端配置接入，只换 server 域名。
//
//  端点：
//    GET  /health           健康检查（Render healthCheckPath）
//    WS   /api/ws           VLESS-over-WS 隧道（mihomo / Xray 客户端）
//    *    /<host>/<path>    Google API 反代，<host> 须为 *.googleapis.com
//    *    /?target=<url>    同上，目标写在查询串里
//
//  为什么不用 HTTP CONNECT 正向代理：Render 边缘对 inbound 请求做了托管
//  代理，CONNECT 方法不可靠；WebSocket 是其官方支持的升级类型，因此隧道走
//  WS。VLESS 头解析逻辑与 Vercel 版逐行一致（含首帧携带 payload 的处理）。
// ===========================================================================

const http = require('http');
const net = require('net');
const { Readable } = require('stream');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// 隧道验证 UUID（须与客户端 outbounds 里的 id 一致）。
const VALID_UUID = (process.env.TUNNEL_UUID || '7ec6d45a-9ef0-4418-8c92-f076448e9c09')
  .toLowerCase()
  .replace(/-/g, '');

const CMD_TCP = 1;
const ADDR_IPV4 = 1;
const ADDR_DOMAIN = 2;
const ADDR_IPV6 = 3;

// VLESS 头最小长度：version(1)+uuid(16)+optLen(1)+cmd(1)+port(2)+addrType(1)+addr(1)
const MIN_HEADER_LEN = 24;

// 头部字段的最大解析长度上限，仅用于校验 cursor 落点是否越界。
//
// 注意：绝不能拿它去限制「整帧长度」。首帧同时携带 VLESS 头与首批应用数据
// （Nagle 合并 / 客户端一次性写入），TLS ClientHello 首包实测约 1.6KB，
// 远超任何合理的头部长度。早期版本误用整帧长度做上限，导致所有 TLS 连接
// 在首帧就被 close（表现为 openssl 只读到 39 字节即 EOF）。
const MAX_HEADER_FIELD_LEN = 512;

// ===========================================================================
//  VLESS-over-WS 隧道
// ===========================================================================

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  let remote = null;
  let parsed = false;

  const cleanup = () => {
    if (remote && !remote.destroyed) remote.destroy();
  };

  ws.on('message', (msg) => {
    const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);

    // 头部已解析：后续帧原样写入上游。
    if (parsed) {
      if (remote && !remote.destroyed) remote.write(buf);
      return;
    }

    if (buf.length < MIN_HEADER_LEN) {
      ws.close();
      return;
    }

    try {
      const version = buf[0];
      if (buf.subarray(1, 17).toString('hex') !== VALID_UUID) {
        ws.close();
        return;
      }

      const optLen = buf[17];
      let cursor = 18 + optLen;

      // 头部字段区越界防护：optLen 声称的长度不能超出本帧可读范围。
      // 首帧尾部的 payload 属于应用数据，不参与头部字段校验。
      if (cursor + 4 > buf.length) {
        ws.close();
        return;
      }

      const cmd = buf[cursor];
      cursor += 1;
      if (cmd !== CMD_TCP) {
        // 只支持 TCP；UDP（含 DNS over tunnel）不支持。
        ws.close();
        return;
      }

      const port = buf.readUInt16BE(cursor);
      cursor += 2;

      const addrType = buf[cursor];
      cursor += 1;

      let host = '';
      if (addrType === ADDR_IPV4) {
        if (cursor + 4 > buf.length) {
          ws.close();
          return;
        }
        host = [buf[cursor], buf[cursor + 1], buf[cursor + 2], buf[cursor + 3]].join('.');
        cursor += 4;
      } else if (addrType === ADDR_DOMAIN) {
        const len = buf[cursor];
        cursor += 1;
        if (len === 0 || len > MAX_HEADER_FIELD_LEN || cursor + len > buf.length) {
          ws.close();
          return;
        }
        host = buf.subarray(cursor, cursor + len).toString('utf8');
        cursor += len;
      } else if (addrType === ADDR_IPV6) {
        if (cursor + 16 > buf.length) {
          ws.close();
          return;
        }
        const parts = [];
        for (let i = 0; i < 8; i += 1) {
          parts.push(buf.readUInt16BE(cursor + i * 2).toString(16));
        }
        host = parts.join(':');
        cursor += 16;
      } else {
        ws.close();
        return;
      }

      const payload = buf.subarray(cursor);
      parsed = true;

      remote = net.connect({ host, port }, () => {
        // VLESS 响应头：version(1) + addonsLen(1)
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from([version, 0]));
        if (payload.length > 0) remote.write(payload);
      });

      remote.on('data', (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });
      remote.on('error', () => ws.close());
      remote.on('close', () => ws.close());
    } catch (_) {
      ws.close();
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// ===========================================================================
//  Google API 反代（只放行 *.googleapis.com，不做通用开放代理）
// ===========================================================================

// 反代白名单（逗号分隔的后缀）。默认只放行 googleapis.com，
// 需要时可在 Render 环境变量里覆盖，不必改代码。
// 例：ALLOWED_SUFFIXES=.googleapis.com,.googleusercontent.com
const ALLOWED_SUFFIXES = (process.env.ALLOWED_SUFFIXES || '.googleapis.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

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

function isAllowedHost(host) {
  if (typeof host !== 'string') return false;
  const h = host.toLowerCase();
  return ALLOWED_SUFFIXES.some((suffix) => {
    // 后缀以 . 开头时同时允许裸域（如 googleapis.com 本身）。
    const bare = suffix.startsWith('.') ? suffix.slice(1) : null;
    return h === bare || h.endsWith(suffix);
  });
}

function resolveTarget(req, url, hostHeader) {
  // 1) Host 本身就是 googleapis 域名（自有 DNS 指向本服务时）。
  if (isAllowedHost(hostHeader)) {
    return `https://${hostHeader}${url.pathname}${url.search}`;
  }

  // 2) 路径首段即目标主机：/<host>/<path>
  const seg = url.pathname.split('/')[1];
  if (isAllowedHost(seg)) {
    const rest = url.pathname.slice(1 + seg.length);
    return `https://${seg}${rest}${url.search}`;
  }

  // 3) 显式 ?target=
  const target = url.searchParams.get('target');
  if (target) {
    try {
      const u = new URL(target);
      if (isAllowedHost(u.hostname)) return target;
    } catch (_) {
      return null;
    }
  }

  return null;
}

async function handleReverseProxy(req, res, targetUrl) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'host') headers[k] = v;
  }
  headers.host = new URL(targetUrl).host;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unreachable', message: String(err && err.message) }));
    return;
  }

  const outHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
  });

  res.writeHead(upstream.status, outHeaders);

  if (!upstream.body) {
    res.end();
    return;
  }

  // 流式透传：不缓冲，SSE（alt=sse）才能逐块下发。
  const body = Readable.fromWeb(upstream.body);
  body.on('error', () => res.destroy());
  body.pipe(res);
}

// 非 WebSocket、非白名单请求统一返回通用 404。
//
// 安全要点：绝不能在这里暴露本端点的用途。VLESS 端点若返回
// "vless ws tunnel only" 之类的提示，等于用一条普通 HTTPS 请求自报家门，
// 扫描者据此即可确认这是代理隧道。这里返回与普通静态站点无异的 404。
const NOT_FOUND_BODY =
  '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  '<title>404 Not Found</title></head>' +
  '<body><h1>404 Not Found</h1></body></html>';

function sendNotFound(res) {
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(NOT_FOUND_BODY),
  });
  res.end(NOT_FOUND_BODY);
}

const server = http.createServer((req, res) => {
  const hostHeader = String(req.headers.host || '').split(':')[0];
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // 健康检查必须在白名单判定之前，且不依赖任何鉴权。
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()) }));
    return;
  }

  const target = resolveTarget(req, url, hostHeader);
  if (!target) {
    sendNotFound(res);
    return;
  }

  handleReverseProxy(req, res, target).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy error', message: String(err && err.message) }));
    } else {
      res.destroy();
    }
  });
});

// WebSocket 升级只认 /api/ws，其它路径直接断开（不给探测者任何提示）。
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch (_) {
    socket.destroy();
    return;
  }

  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (pathname !== '/api/ws' || upgrade !== 'websocket') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// 隧道是长连接：关掉 Node 默认的请求超时，避免大文件/长会话被腰斩。
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(PORT, () => {
  console.log(`serhui-proxy listening on port ${PORT}`);
});

module.exports = server;
