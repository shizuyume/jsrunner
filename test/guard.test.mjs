// Tests for the request guard. Each rule exists because of a specific attack,
// so the cases are named after the attack rather than the branch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

import { createRequestGuard, splitHostPort, isAddressLiteral } from '../server/guard.mjs';

/** Minimal res stand-in that records what the guard wrote. */
function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { this.body += chunk || ''; },
  };
}

/**
 * Run the guard once.
 * @returns {{blocked: boolean, status: number|null, error: string}}
 */
function run(guard, { url = '/api/projects', headers = {} } = {}) {
  const res = fakeRes();
  const blocked = guard({ url, headers }, res);
  let error = '';
  try { error = JSON.parse(res.body).error || ''; } catch { /* no body */ }
  return { blocked, status: res.statusCode, error };
}

const guard = createRequestGuard();

// ---------------------------------------------------------------------------

describe('splitHostPort', () => {
  test('host with port', () => assert.deepEqual(splitHostPort('localhost:9999'), { host: 'localhost', port: '9999' }));
  test('host without port', () => assert.deepEqual(splitHostPort('localhost'), { host: 'localhost', port: '' }));
  test('bracketed IPv6 with port', () => assert.deepEqual(splitHostPort('[::1]:9999'), { host: '::1', port: '9999' }));
  test('bracketed IPv6 without port', () => assert.deepEqual(splitHostPort('[::1]'), { host: '::1', port: '' }));
  test('bare IPv6 is not split on its colons', () =>
    assert.deepEqual(splitHostPort('::1'), { host: '::1', port: '' }));
  test('case is normalised', () => assert.equal(splitHostPort('LocalHost:80').host, 'localhost'));
  test('rejects a non-numeric port', () => assert.equal(splitHostPort('localhost:abc'), null));
  test('rejects empty and non-strings', () => {
    assert.equal(splitHostPort(''), null);
    assert.equal(splitHostPort(undefined), null);
    assert.equal(splitHostPort(null), null);
  });
});

describe('isAddressLiteral', () => {
  test('IPv4 and IPv6 are literals', () => {
    assert.equal(isAddressLiteral('127.0.0.1'), true);
    assert.equal(isAddressLiteral('192.168.1.5'), true);
    assert.equal(isAddressLiteral('::1'), true);
  });
  test('names are not', () => {
    assert.equal(isAddressLiteral('localhost'), false);
    assert.equal(isAddressLiteral('evil.com'), false);
  });
});

// ---------------------------------------------------------------------------

describe('Host check (DNS rebinding)', () => {
  test('rejects a request addressed to an attacker domain', () => {
    // The rebinding case: evil.com now resolves to 127.0.0.1, so Origin looks
    // same-origin and only the Host header gives the game away.
    const r = run(guard, { headers: { host: 'evil.com:9999', origin: 'http://evil.com:9999' } });
    assert.equal(r.blocked, true);
    assert.equal(r.status, 403);
    assert.match(r.error, /evil\.com/);
  });

  test('applies to page loads too, not just /api', () => {
    // Otherwise the attacker's page could load the dashboard itself and then
    // talk to the API genuinely same-origin.
    assert.equal(run(guard, { url: '/', headers: { host: 'evil.com:9999' } }).blocked, true);
  });

  test('accepts localhost', () => {
    assert.equal(run(guard, { headers: { host: 'localhost:9999' } }).blocked, false);
  });

  test('accepts address literals, so --host 0.0.0.0 keeps working on the LAN', () => {
    // Safe because rebinding needs a NAME to re-point; a literal cannot be one.
    for (const host of ['127.0.0.1:9999', '[::1]:9999', '192.168.1.5:9999', '10.0.0.7:9999']) {
      assert.equal(run(guard, { headers: { host } }).blocked, false, host);
    }
  });

  test('rejects a request with no Host header at all', () => {
    assert.equal(run(guard, { headers: {} }).blocked, true);
  });

  test('accepts a name that was explicitly allowed', () => {
    const g = createRequestGuard({ allowHosts: ['dev.local'] });
    assert.equal(run(g, { headers: { host: 'dev.local:9999' } }).blocked, false);
    assert.equal(run(g, { headers: { host: 'other.local:9999' } }).blocked, true);
  });
});

describe('Origin check (CSRF)', () => {
  test('rejects the simple-request attack from another site', () => {
    // POST with Content-Type: text/plain skips preflight, so the request lands
    // and /api/project/start would run a shell command.
    const r = run(guard, {
      url: '/api/project/start',
      headers: { host: 'localhost:9999', origin: 'https://evil.com' },
    });
    assert.equal(r.blocked, true);
    assert.equal(r.status, 403);
  });

  test('rejects another local server on a different port', () => {
    // Any other dev app on the machine would otherwise be able to drive this one
    const r = run(guard, { headers: { host: 'localhost:9999', origin: 'http://localhost:3000' } });
    assert.equal(r.blocked, true);
  });

  test('rejects a null origin (sandboxed iframe, data: URL)', () => {
    assert.equal(run(guard, { headers: { host: 'localhost:9999', origin: 'null' } }).blocked, true);
  });

  test('rejects an unparseable origin', () => {
    assert.equal(run(guard, { headers: { host: 'localhost:9999', origin: 'not a url' } }).blocked, true);
  });

  test('accepts the dashboard talking to itself', () => {
    for (const [host, origin] of [
      ['localhost:9999', 'http://localhost:9999'],
      ['127.0.0.1:9999', 'http://127.0.0.1:9999'],
      ['[::1]:9999', 'http://[::1]:9999'],
      ['192.168.1.5:9999', 'http://192.168.1.5:9999'],
    ]) {
      assert.equal(run(guard, { headers: { host, origin } }).blocked, false, origin);
    }
  });

  test('accepts a request with no Origin, so curl and the CLI still work', () => {
    // Non-browser clients cannot be CSRF'd — they have no ambient credentials
    // and no attacker-controlled page driving them.
    assert.equal(run(guard, { headers: { host: 'localhost:9999' } }).blocked, false);
  });

  test('page loads are not origin-checked', () => {
    // Clicking a link to the dashboard from another site should still work
    const r = run(guard, { url: '/', headers: { host: 'localhost:9999', origin: 'https://github.com' } });
    assert.equal(r.blocked, false);
  });

  test('an allowed name is trusted on any port, for a TLS-terminating proxy', () => {
    const g = createRequestGuard({ allowHosts: ['dev.local'] });
    const r = run(g, { headers: { host: 'dev.local', origin: 'https://dev.local' } });
    assert.equal(r.blocked, false);
  });
});

describe('Sec-Fetch-Site check', () => {
  test('rejects cross-site requests that carry no Origin', () => {
    // e.g. a GET triggered by <img> or <script> on the attacker's page
    const r = run(guard, { headers: { host: 'localhost:9999', 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.blocked, true);
  });

  test('rejects same-site-but-different-origin', () => {
    assert.equal(run(guard, { headers: { host: 'localhost:9999', 'sec-fetch-site': 'same-site' } }).blocked, true);
  });

  test('accepts same-origin and user-initiated navigation', () => {
    assert.equal(run(guard, { headers: { host: 'localhost:9999', 'sec-fetch-site': 'same-origin' } }).blocked, false);
    assert.equal(run(guard, { headers: { host: 'localhost:9999', 'sec-fetch-site': 'none' } }).blocked, false);
  });
});

// ---------------------------------------------------------------------------

describe('over a real HTTP connection', () => {
  let server;
  let port;

  const request = (headers) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/projects', method: 'POST', headers },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.end('{}');
    });

  test('setup', async () => {
    const g = createRequestGuard();
    server = http.createServer((req, res) => {
      if (g(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reached: true }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  test('a normal dashboard call gets through', async () => {
    const res = await request({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` });
    assert.equal(res.status, 200);
    assert.match(res.body, /reached/);
  });

  test('a cross-origin POST is refused before the handler runs', async () => {
    const res = await request({
      Host: `127.0.0.1:${port}`,
      Origin: 'https://evil.com',
      'Content-Type': 'text/plain',
    });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /reached/, 'the handler must not have been called');
  });

  test('a rebound Host is refused', async () => {
    const res = await request({ Host: `evil.com:${port}`, Origin: `http://evil.com:${port}` });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /reached/);
  });

  test('teardown', async () => {
    await new Promise((resolve) => server.close(resolve));
  });
});
