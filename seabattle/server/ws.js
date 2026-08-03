'use strict';
/* ============================================================================
   Минимальный WebSocket-сервер (RFC 6455) без внешних зависимостей.
   Поддержка: текстовые/бинарные кадры, фрагментация, ping/pong, close.
   ========================================================================== */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 4 * 1024 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragOpcode = 0;
    this.fragChunks = [];
    this.fragLength = 0;
    this.isAlive = true;

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        this._drain();
      } catch (err) {
        this.close(1002, 'protocol error');
      }
    });
    socket.on('error', () => this._dead());
    socket.on('close', () => this._dead());
    socket.setTimeout(0);
    socket.setNoDelay(true);
  }

  _dead() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _drain() {
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(MAX_PAYLOAD)) throw new Error('payload too large');
        len = Number(big);
        offset += 8;
      }
      if (len > MAX_PAYLOAD) throw new Error('payload too large');

      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;

      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = buf.subarray(offset + len);

      // Управляющие кадры
      if (opcode === 0x8) { this.close(1000, ''); return; }
      if (opcode === 0x9) { this._send(0xa, payload); continue; }
      if (opcode === 0xa) { this.isAlive = true; this.emit('pong'); continue; }

      if (opcode === 0x0) {
        if (!this.fragOpcode) throw new Error('unexpected continuation');
        this.fragChunks.push(payload);
        this.fragLength += payload.length;
        if (this.fragLength > MAX_PAYLOAD) throw new Error('payload too large');
        if (fin) {
          const full = Buffer.concat(this.fragChunks, this.fragLength);
          const op = this.fragOpcode;
          this.fragOpcode = 0; this.fragChunks = []; this.fragLength = 0;
          this._deliver(op, full);
        }
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.fragOpcode = opcode;
          this.fragChunks = [payload];
          this.fragLength = payload.length;
          continue;
        }
        this._deliver(opcode, payload);
        continue;
      }
      throw new Error('bad opcode ' + opcode);
    }
  }

  _deliver(opcode, payload) {
    this.isAlive = true;
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { this._dead(); }
  }

  send(text) { this._send(0x1, Buffer.from(String(text), 'utf8')); }
  sendJSON(obj) { this.send(JSON.stringify(obj)); }
  ping() { this.isAlive = false; this._send(0x9, Buffer.alloc(0)); }

  close(code, reason) {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason || ''));
    body.writeUInt16BE(code || 1000, 0);
    if (reason) body.write(reason, 2);
    this._send(0x8, body);
    this.closed = true;
    try { this.socket.end(); } catch (e) { /* noop */ }
    this.emit('close');
  }
}

/** Обрабатывает HTTP upgrade и возвращает соединение (или null). */
function handleUpgrade(req, socket, head, onConnection) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + acceptKey(key),
    '\r\n'
  ];
  socket.write(headers.join('\r\n'));
  const conn = new WebSocketConnection(socket);
  if (head && head.length) socket.emit('data', head);
  onConnection(conn, req);
  return conn;
}

/* ------------------------------ Клиент (для тестов) ----------------------- */
function connect(url) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        reject(new Error('bad accept'));
        return;
      }
      const conn = new WebSocketConnection(socket);
      conn.isClient = true;
      // Клиентские кадры обязаны быть маскированы
      conn._send = function (opcode, payload) {
        if (this.closed || this.socket.destroyed) return;
        const mask = crypto.randomBytes(4);
        const len = payload.length;
        let header;
        if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
        else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
        else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
        header[0] = 0x80 | opcode;
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        try { this.socket.write(Buffer.concat([header, mask, masked])); } catch (e) { this._dead(); }
      };
      if (head && head.length) socket.emit('data', head);
      resolve(conn);
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { handleUpgrade, connect, WebSocketConnection, acceptKey };
