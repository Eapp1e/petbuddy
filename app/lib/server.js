'use strict';
const http = require('http');

/**
 * Local HTTP API. Everything binds to 127.0.0.1 only.
 *
 *   GET  /api/ping              -> {ok:true, version}
 *   GET  /api/status            -> full snapshot {apps:[], confirms:[]}
 *   POST /api/event             -> {app, event, sessionId?, title?, detail?, question?, options?, toolName?}
 *   POST /api/announce          -> {app}  (heartbeat: "this app is alive")
 *   POST /api/confirm           -> {id, decision: 'approve'|'deny'|'dismiss'|'answer', text?}
 */
function createApiServer({ version, handleEvent, handleConfirm, snapshot }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };
    const readBody = () => new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1024 * 1024) { resolve(null); req.destroy(); }
      });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });

    (async () => {
      try {
        if (req.method === 'GET' && url.pathname === '/api/ping') {
          return send(200, { ok: true, version });
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          return send(200, { ok: true, ...snapshot() });
        }
        if (req.method === 'POST' && url.pathname === '/api/event') {
          const body = await readBody();
          if (!body) return send(400, { ok: false, error: 'bad json' });
          const result = handleEvent(body);
          return send(200, { ok: true, ...result });
        }
        if (req.method === 'POST' && url.pathname === '/api/announce') {
          const body = await readBody();
          if (!body) return send(400, { ok: false, error: 'bad json' });
          handleEvent({ app: body.app, event: 'announce' });
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/confirm') {
          const body = await readBody();
          if (!body || !body.id) return send(400, { ok: false, error: 'bad id' });
          const result = await handleConfirm(body.id, body.decision || 'dismiss', body.text);
          return send(200, { ok: true, ...result });
        }
        return send(404, { ok: false, error: 'not found' });
      } catch (err) {
        return send(500, { ok: false, error: String(err && err.message || err) });
      }
    })();
  });
  return server;
}

/** Try ports starting at `start`; resolve with the first free one. */
function listen(server, start, attempts = 12) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, left) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(port + 1, left - 1);
        else reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    };
    tryPort(start, attempts);
  });
}

module.exports = { createApiServer, listen };
