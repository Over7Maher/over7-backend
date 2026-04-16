const http = require('http');

const BASE = 'http://localhost:3000';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(`${BASE}${path}`, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(data) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function pass(label) { console.log(`  ✓ ${label}`); }
function fail(label, detail) { console.error(`  ✗ ${label}`, detail); process.exitCode = 1; }

async function run() {
  console.log(`\nOver7 API — test suite  [${BASE}]\n`);

  // ── GET /health ──────────────────────────────────────────────────────────────
  console.log('GET /health');
  {
    const r = await request('GET', '/health');
    r.status === 200 && r.body.status === 'ok' && r.body.timestamp
      ? pass(`200 { status: "ok", timestamp: "${r.body.timestamp}" }`)
      : fail('Expected 200 ok', r);
  }

  // ── GET /unknown → 404 ───────────────────────────────────────────────────────
  console.log('\nGET /unknown-route');
  {
    const r = await request('GET', '/not-a-real-route');
    r.status === 404
      ? pass('404 Not found')
      : fail('Expected 404', r);
  }

  // ── POST /api/users/register — missing fields → 422 ─────────────────────────
  console.log('\nPOST /api/users/register  (missing fields)');
  {
    const r = await request('POST', '/api/users/register', {});
    r.status === 422
      ? pass(`422 Validation error — ${r.body.errors.length} field(s) rejected`)
      : fail('Expected 422', r);
  }

  // ── GET /api/users/me — no token → 401 ──────────────────────────────────────
  console.log('\nGET /api/users/me  (no token)');
  {
    const r = await request('GET', '/api/users/me');
    r.status === 401
      ? pass('401 Unauthorized')
      : fail('Expected 401', r);
  }

  console.log('\nDone.\n');
}

run().catch(err => { console.error(err); process.exit(1); });
