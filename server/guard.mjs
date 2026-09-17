// Request guard: keeps other web pages from driving this server.
//
// Starting a project here runs an arbitrary shell command, so every /api route
// is a remote-code-execution primitive for anything that can reach it. Two
// browser-borne attacks do reach it, and they need different defences:
//
//  1. CSRF. A POST with Content-Type: text/plain is a "simple request" — no
//     preflight, so the browser sends it and the server acts on it, even though
//     the attacker cannot read the reply. Bodies are parsed as JSON regardless
//     of content type, so /api/project/start, /api/port/kill and
//     DELETE /api/project/:id all fire. Caught by the Origin check.
//
//  2. DNS rebinding. evil.com re-resolves to 127.0.0.1, so the attacker's page
//     becomes same-origin with us and the Origin check waves it through. What
//     gives it away is the Host header: it reads "evil.com:9999", never
//     "localhost". Caught by the Host check.
//
// The Host rule accepts any IP literal on purpose. Rebinding needs a *name* to
// re-point, so a literal address cannot be used for it — which lets
// `--host 0.0.0.0` keep working over the LAN without punching a hole.
//
// None of this is authentication. Anything that can already send raw HTTP —
// curl, another local process, a program on the LAN in --host 0.0.0.0 mode —
// is unaffected, because it is not a browser and has no origin to lie about.
import net from 'net';

/**
 * Split a Host or Origin authority into { host, port }.
 * Handles "localhost:9999", "[::1]:9999", bare "::1" and "example.com".
 * Exported for tests.
 *
 * @returns {{host: string, port: string} | null} port is '' when not given
 */
export function splitHostPort(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;

  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end === -1) return null;
    const rest = s.slice(end + 1);
    if (rest && !rest.startsWith(':')) return null;
    return { host: s.slice(1, end).toLowerCase(), port: rest.slice(1) };
  }

  // More than one colon and no brackets means a bare IPv6 literal, not host:port
  if ((s.match(/:/g) || []).length > 1) return { host: s.toLowerCase(), port: '' };

  const idx = s.indexOf(':');
  if (idx === -1) return { host: s.toLowerCase(), port: '' };

  const port = s.slice(idx + 1);
  if (!/^\d+$/.test(port)) return null;
  return { host: s.slice(0, idx).toLowerCase(), port };
}

/** An address literal can never be DNS-rebound. Exported for tests. */
export function isAddressLiteral(host) {
  return net.isIP(host) !== 0;
}

/**
 * Create the guard.
 *
 * @param {{allowHosts?: string[]}} [options] extra hostnames to trust — for a
 *        reverse proxy or a custom /etc/hosts name in front of the dashboard
 * @returns {(req, res) => boolean} true when the request was rejected and the
 *          response has already been written
 */
export function createRequestGuard({ allowHosts = [] } = {}) {
  const allowed = new Set(allowHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean));
  // One warning per offending host — a rebinding attempt retries in a loop and
  // would otherwise bury the console.
  const warned = new Set();

  function hostAllowed(host) {
    if (!host) return false;
    if (host === 'localhost') return true;
    if (isAddressLiteral(host)) return true;
    return allowed.has(host);
  }

  /** Does this Origin belong to the same server the request was addressed to? */
  function originAllowed(origin, hostHeader) {
    if (origin === 'null') return false; // sandboxed iframe or data: URL

    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }

    const originHost = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // An explicitly trusted name is trusted whatever port it answers on —
    // a TLS-terminating proxy rewrites the port out from under us.
    if (allowed.has(originHost)) return true;

    const target = splitHostPort(hostHeader);
    if (!target) return false;

    const originPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    const targetPort = target.port || '80';
    return originHost === target.host && originPort === targetPort;
  }

  function reject(res, reason, detail) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: reason, detail, code: 'FORBIDDEN_ORIGIN' }));
  }

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`\n⚠  ${message}\n`);
  }

  return function guard(req, res) {
    const hostHeader = req.headers.host;
    const parsed = splitHostPort(hostHeader);

    // HTTP/1.1 requires Host. Something without one is not a browser we need to
    // serve, and letting it through would skip the rebinding check entirely.
    if (!parsed || !hostAllowed(parsed.host)) {
      warnOnce(`host:${hostHeader}`,
        `Blocked a request addressed to "${hostHeader}". If you reach the dashboard through that name on purpose, restart with --allow-host ${parsed?.host || '<name>'}`);
      reject(res, `Host "${hostHeader}" is not allowed`,
        'Only localhost, address literals and --allow-host names are served. This blocks DNS rebinding.');
      return true;
    }

    // Side effects live under /api; a plain page load is not one, so navigating
    // to the dashboard from a link on another site keeps working.
    const isApi = (req.url || '').startsWith('/api/');
    if (!isApi) return false;

    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin, hostHeader)) {
      warnOnce(`origin:${origin}`,
        `Blocked an /api request from "${origin}". A web page you have open tried to control this dashboard.`);
      reject(res, `Origin "${origin}" is not allowed`,
        'Only the dashboard served from this same address may call the API.');
      return true;
    }

    // Catches browser-initiated cross-site requests that carry no Origin at
    // all, such as a GET from an <img> or <script> tag. Absent on non-browser
    // clients, which are not the threat here.
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      warnOnce(`site:${site}`,
        `Blocked a cross-site /api request (Sec-Fetch-Site: ${site}).`);
      reject(res, 'Cross-site requests are not allowed',
        'The dashboard API only answers requests made by the dashboard itself.');
      return true;
    }

    return false;
  };
}
