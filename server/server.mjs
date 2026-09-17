#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { createRouter } from './router.mjs';
import { serveStatic } from './static.mjs';
import { registerProjectRoutes } from '../api/projects.mjs';
import * as processManager from '../utils/process.mjs';
import * as logger from '../utils/logger.mjs';
import { registerLogRoutes } from '../api/logs.mjs';
import * as config from '../utils/config.mjs';
import { registerControlRoutes } from '../api/control.mjs';
import { registerScriptRoutes } from '../api/script.mjs';
import { registerPortRoutes } from '../api/port.mjs';
import { registerPathRoutes } from '../api/path.mjs';
import { registerGroupRoutes } from '../api/group.mjs';
import { registerWorkspaceRoutes } from '../api/workspace.mjs';
import { registerScriptsRoutes } from '../api/scripts.mjs';
import { registerEventRoutes } from '../api/events.mjs';
import { registerProfileRoutes } from '../api/profiles.mjs';
import * as supervisor from '../utils/supervisor.mjs';
import { startMetricsCollection } from '../utils/metrics.mjs';

// ---------------------------------------------------------------------------
// CLI argument parsing (falls back to env, then defaults)
// ---------------------------------------------------------------------------
const USAGE = `jsrunner — local multi-project dev dashboard

Usage:
  jsrunner [options]
  jsr [options]
  npm start [-- --help]

Options:
  --port <n>       HTTP port                  (default: 9999, env PORT)
  --host <addr>    Bind address               (default: localhost, env HOST;
                   use 0.0.0.0 to expose on the LAN — the tool has NO auth)
  --workdir <dir>  Where config/projects.json lives (default: ~/.jsrunner, env WORKDIR)
  --version, -v    Print version and exit
  --help, -h       Show this help and exit

Examples:
  jsrunner                        Start on http://localhost:9999
  jsrunner --port 9876            Start on http://localhost:9876
  jsrunner --host 0.0.0.0         Expose to local network (no auth — be careful)
`;

function printHelp() {
  console.log(USAGE);
}

function printBanner() {
  const tty = Boolean(process.stdout.isTTY);
  const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
  const url = opts.host === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${opts.host}:${PORT}`;
  const w = 54;
  const edge = c('36', '═'.repeat(w));
  console.log(edge);
  console.log(`${c('1;36', '  🚀 jsrunner')} ${c('33', `v${pkg.version}`)}`);
  console.log(`  ${c('2', 'Local multi-project dev dashboard — zero dependencies')}`);
  console.log(edge);
  console.log(`  ${c('1;32', '→')} Dashboard : ${c('4;1', url)}`);
  console.log(`  ${c('1;32', '→')} Config    : ${config.getConfigPath()}`);
  if (opts.workdir) console.log(`  ${c('1;32', '→')} Workdir   : ${opts.workdir}`);
  console.log(edge);
  console.log(`  ${c('2', 'Update check on startup — Ctrl+C stops all running processes')}`);
  console.log('');
}

function readPackage() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  } catch {
    return { name: 'jsrunner', version: '0.0.0-dev' };
  }
}

const pkg = readPackage();

// Self-update notice: user-installed copies get a heads-up when a new
// version lands on npm. Read-only, never blocks startup, silent offline.
async function checkForUpdate() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const { version } = await res.json();
    if (version && version !== pkg.version) {
      console.log(`\n⬆  Update tersedia: ${pkg.name}@${version} (terpasang: ${pkg.version})`);
      console.log(`   Jalankan: npm install -g ${pkg.name}@latest\n`);
    }
  } catch {
    // Offline or registry hiccup — skip silently.
  }
}

const opts = {
  port: parseInt(process.env.PORT, 10) || 9999,
  host: process.env.HOST || 'localhost',
  workdir: process.env.WORKDIR || null,
};

{
  const args = process.argv.slice(2);
  const next = () => args.shift();
  while (args.length) {
    const a = next();
    switch (a) {
      case '--help': case '-h': printHelp(); process.exit(0); break;
      case '--version': case '-v': console.log(pkg.version); process.exit(0); break;
      case '--port': opts.port = parseInt(next(), 10) || 9999; break;
      case '--host': opts.host = next() || 'localhost'; break;
      case '--workdir': opts.workdir = next() || process.cwd(); break;
      default:
        console.error(`Unknown option: ${a}\n\n${USAGE}`);
        process.exit(1);
    }
  }
}

const PORT = opts.port;
if (opts.workdir) config.setBase(opts.workdir);

// Static files ship inside the package (repo root in dev, node_modules when
// installed globally). Config defaults to ~/.jsrunner (stable) unless
// --workdir/WORKDIR overrides it.
// ponytail: single-file bundle (pkg/nexe) can't serve public/ from disk —
// embed it as an assets map when that mode is needed.
const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

const router = createRouter();
const staticHandler = serveStatic(PKG_ROOT);

logger.initLogger(processManager);
supervisor.initSupervisor({ config, processManager, logger });

registerProjectRoutes(router, processManager, supervisor);
registerLogRoutes(router, config, logger);
registerControlRoutes(router, config, processManager, supervisor);
registerScriptRoutes(router, config, processManager);
registerPortRoutes(router);
registerPathRoutes(router);
registerGroupRoutes(router, config);
registerWorkspaceRoutes(router);
registerScriptsRoutes(router);
registerEventRoutes(router, { supervisor, logger });
registerProfileRoutes(router, config, supervisor, processManager);

const server = http.createServer(async (req, res) => {
  try {
    // Try API routes first; if none matched, fall through to static file serving
    const matched = router.match(req, res);
    if (!matched) {
      await staticHandler(req, res);
    }
  } catch (err) {
    console.error('Request handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

// Live CPU/memory for running projects (in memory — never written to config)
startMetricsCollection(processManager, (id, m) => supervisor.setMetrics(id, m));
// TCP readiness probes: "process spawned" vs "server actually listening"
supervisor.startHealthChecks();

server.listen(PORT, opts.host, async () => {
  printBanner();
  checkForUpdate();

  // Re-attach to services left running by a previous run of this server
  try {
    const { adopted, cleared } = await supervisor.adoptOrphans();
    for (const p of adopted) {
      console.log(`Re-attached to "${p.name}" (PID ${p.adoptedPid}, matched by ${p.via})`);
    }
    for (const p of cleared) {
      console.log(`Marked "${p.name}" as stopped — its process is gone`);
    }
  } catch (err) {
    console.error('Orphan adoption failed:', err.message);
  }
});

// Kill all child processes on shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — stopping all processes...`);
  processManager.stopAll();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Windows: Ctrl+C sends SIGINT

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exitCode = 1;
});
