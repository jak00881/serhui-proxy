'use strict';

const net = require('net');
const { WebSocketServer } = require('ws');

// ===========================================================================
//  VLESS-over-WebSocket 隧道（附加通路，非主用）
//
//  主用通路是 api/proxy.js 的 HTTP 反代；本文件提供「完整 TCP 隧道」能力，
//  供 Xray / mihomo 等客户端把任意流量经 Vercel 出网。
//
//  注意：Vercel Serverless 有最长执行时间限制（本项目 maxDuration=300s），
//        长连接会被回收，客户端需具备重连能力。
// ===========================================================================

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

// 非 WebSocket 请求（含主动探测）统一返回通用 404。
//
// 安全要点：绝不能在这里暴露本端点的用途。早期版本返回 400 +
// "vless ws tunnel only"，等于用一条普通 HTTPS 请求自报家门——
// 任何扫描到该域名的探测者都能据此确认这是 VLESS 隧道。
// 这里返回与普通静态站点无异的 404 页面，不泄露任何技术细节。
const NOT_FOUND_BODY =
  '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  '<title>404 Not Found</title></head>' +
  '<body><h1>404 Not Found</h1></body></html>';

module.exports = (req, res) => {
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket') {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(NOT_FOUND_BODY));
    res.end(NOT_FOUND_BODY);
    return;
  }
  wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws) => {
    wss.emit('connection', ws, req);
  });
};
