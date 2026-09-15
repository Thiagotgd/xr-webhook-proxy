const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const UPDATE_SECRET = process.env.UPDATE_SECRET || 'xr-proxy-update-2024';
const TARGET_WEBHOOK_TOKEN = process.env.TARGET_WEBHOOK_TOKEN || 'zo02xvbo62bps9s7va9q6';

// Current target URL for forwarding webhooks
// Falls back to INITIAL_TARGET env var on cold start (Render free tier resets memory)
let targetUrl = process.env.INITIAL_TARGET || '';
// Destinos extras: recebem uma copia do webhook (fire-and-forget); erro neles nao afeta o destino principal
const EXTRA_TARGETS = (process.env.EXTRA_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean);
function forwardExtra(body, srcHeaders) {
  for (const t of EXTRA_TARGETS) {
    try {
      const u = new URL(t.replace(/\/+$/, '') + '/webhook/cfaz');
      if (TARGET_WEBHOOK_TOKEN && !u.searchParams.get('token')) u.searchParams.set('token', TARGET_WEBHOOK_TOKEN);
      const headers = { 'Content-Type': srcHeaders['content-type'] || 'application/json', 'Content-Length': Buffer.byteLength(body) };
      if (TARGET_WEBHOOK_TOKEN) headers['X-Webhook-Token'] = TARGET_WEBHOOK_TOKEN;
      const proto = u.protocol === 'https:' ? https : http;
      const rq = proto.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers }, (rs) => {
        rs.resume(); console.log(`[PROXY] Extra ${u.hostname}:${u.port} -> ${rs.statusCode}`);
      });
      rq.on('error', (e) => console.log(`[PROXY] Extra ${t} erro: ${e.message}`));
      rq.setTimeout(8000, () => rq.destroy());
      rq.write(body); rq.end();
    } catch (e) { console.log(`[PROXY] Extra ${t} invalido: ${e.message}`); }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname.replace(/\/+$/, '');

  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Token'
    });
    return res.end();
  }

  // Health check
  if (p === '' || p === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', target: targetUrl ? 'configured' : 'not set' }));
  }

  // Update target URL
  if (p === '/update-target' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.secret !== UPDATE_SECRET) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid secret' }));
        }
        targetUrl = data.target;
        console.log(`[PROXY] Target updated: ${targetUrl}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, target: targetUrl }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  // Get current target (for debugging)
  if (p === '/current-target' && req.method === 'GET') {
    const secret = url.searchParams.get('secret');
    if (secret !== UPDATE_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid secret' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ target: targetUrl }));
  }

  // Forward webhook to target
  if (p === '/webhook/cfaz' && req.method === 'POST') {
    if (!targetUrl) {
      console.log('[PROXY] No target configured, dropping webhook');
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no target configured' }));
    }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const forwardUrl = new URL(targetUrl.replace(/\/+$/, '') + '/webhook/cfaz');
      if (TARGET_WEBHOOK_TOKEN && !forwardUrl.searchParams.get('token')) {
        forwardUrl.searchParams.set('token', TARGET_WEBHOOK_TOKEN);
      }
      console.log(`[PROXY] Forwarding to: ${forwardUrl.toString()}`);
      if (EXTRA_TARGETS.length) forwardExtra(body, req.headers);

      const parsed = forwardUrl;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      // Copy auth headers / force target token when source does not provide one
      if (req.headers['x-webhook-token']) options.headers['X-Webhook-Token'] = req.headers['x-webhook-token'];
      else if (TARGET_WEBHOOK_TOKEN) options.headers['X-Webhook-Token'] = TARGET_WEBHOOK_TOKEN;
      if (req.headers['authorization']) options.headers['Authorization'] = req.headers['authorization'];

       const proto = parsed.protocol === 'https:' ? https : http;
       const fwdReq = proto.request(options, (fwdRes) => {
         let respBody = '';
         fwdRes.on('data', c => respBody += c);
        fwdRes.on('end', () => {
          console.log(`[PROXY] Forward response: ${fwdRes.statusCode}`);
          if (res.writableEnded) return;
          res.writeHead(fwdRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(respBody);
        });
      });

      fwdReq.on('error', (err) => {
        console.log(`[PROXY] Forward error: ${err.message}`);
        if (res.writableEnded) return;
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forward failed', detail: err.message }));
      });

      fwdReq.setTimeout(10000, () => {
        fwdReq.destroy();
        if (res.writableEnded) return;
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forward timeout' }));
      });
      fwdReq.write(body);
      fwdReq.end();
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[PROXY] Webhook proxy running on port ${PORT}`);
  console.log(`[PROXY] Target: ${targetUrl || 'not set'}`);
});
