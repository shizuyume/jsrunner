// Tests for the OS boundary in utils/platform/.
//
// Two halves:
//  - parser tests, which run everywhere off recorded command output, so a
//    Linux runner still catches a broken netstat regex and vice versa;
//  - live tests, which actually spawn, kill and inspect real processes on
//    whichever OS is running them. Those are the ones the CI matrix is for.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';

import * as platform from '../utils/platform/index.mjs';
import * as win from '../utils/platform/win.mjs';
import * as posix from '../utils/platform/posix.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Windows parsers
// ---------------------------------------------------------------------------

describe('win: parseNetstat', () => {
  const OUTPUT = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234',
    '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       5678',
    '  TCP    [::]:8080              [::]:0                 LISTENING       9012',
    '  TCP    [::1]:9911             [::]:0                 LISTENING       2468',
    '  TCP    127.0.0.1:3000         127.0.0.1:52001        ESTABLISHED     4321',
    '  TCP    [::1]:64607            [::1]:9911             TIME_WAIT       0',
    '  UDP    0.0.0.0:5353           *:*                                    3690',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       9999',
  ].join('\r\n');

  test('maps listening ports to pids', () => {
    const map = win.parseNetstat(OUTPUT);
    assert.equal(map.get(3000), 1234);
    assert.equal(map.get(5173), 5678);
    assert.equal(map.get(8080), 9012);
  });

  test('sees IPv6-only listeners', () => {
    // Node binds ::1 for 'localhost' on modern Windows, so missing these means
    // missing most dev servers. `netstat -p TCP` filters them out — which is
    // why findListeningPids does not pass that flag.
    assert.equal(win.parseNetstat(OUTPUT).get(9911), 2468);
  });

  test('ignores non-listening rows', () => {
    const map = win.parseNetstat(OUTPUT);
    assert.equal(map.has(52001), false);
    assert.equal(map.has(64607), false);
  });

  test('ignores UDP rows', () => {
    assert.equal(win.parseNetstat(OUTPUT).has(5353), false);
  });

  test('first listener wins when a port appears twice', () => {
    // 0.0.0.0 and :: rows both show up for a dual-stack server
    assert.equal(win.parseNetstat(OUTPUT).get(3000), 1234);
  });

  test('survives garbage', () => {
    assert.equal(win.parseNetstat('').size, 0);
    assert.equal(win.parseNetstat('not netstat output at all').size, 0);
  });
});

describe('win: parseProcessJson', () => {
  test('converts CIM 100ns ticks to milliseconds', () => {
    const map = win.parseProcessJson(
      JSON.stringify([{ p: 100, pp: 4, n: 'node.exe', t: 12_345_678, w: 1048576, c: 'node x.js' }])
    );
    const proc = map.get(100);
    assert.equal(proc.ppid, 4);
    assert.equal(proc.name, 'node.exe');
    assert.equal(proc.cpuMs, 1234.5678);
    assert.equal(proc.mem, 1048576);
    assert.equal(proc.cmd, 'node x.js');
  });

  test('accepts a bare object (ConvertTo-Json unwraps single rows)', () => {
    const map = win.parseProcessJson(JSON.stringify({ p: 7, pp: 1, n: 'cmd.exe', t: 0, w: 0 }));
    assert.equal(map.size, 1);
    assert.equal(map.get(7).name, 'cmd.exe');
  });

  test('skips rows without a numeric pid, and invalid JSON', () => {
    assert.equal(win.parseProcessJson(JSON.stringify([{ p: null, n: 'x' }])).size, 0);
    assert.equal(win.parseProcessJson('<not json>').size, 0);
  });
});

// ---------------------------------------------------------------------------
// POSIX parsers
// ---------------------------------------------------------------------------

describe('posix: parseCpuTime', () => {
  test('MM:SS.cc (macOS)', () => assert.equal(posix.parseCpuTime('0:04.23'), 4230));
  test('MM:SS', () => assert.equal(posix.parseCpuTime('02:30'), 150_000));
  test('HH:MM:SS', () => assert.equal(posix.parseCpuTime('1:02:03'), 3_723_000));
  test('DD-HH:MM:SS (Linux, long-lived process)', () =>
    assert.equal(posix.parseCpuTime('2-03:04:05'), 183_845_000));
  test('unparsable input is zero, not NaN', () => {
    assert.equal(posix.parseCpuTime(''), 0);
    assert.equal(posix.parseCpuTime('-'), 0);
    assert.equal(posix.parseCpuTime('??:??'), 0);
  });
});

describe('posix: parsePsOutput', () => {
  const COMM = [
    '    1     0   12345   0:04.23 /usr/bin/node',
    '  789     1    4096   1:02:03 /bin/sh',
    'ps: some warning on stderr-ish line',
  ].join('\n');

  test('reads pid/ppid/rss/time and basenames the image', () => {
    const map = posix.parsePsOutput(COMM);
    assert.equal(map.get(1).name, 'node');
    assert.equal(map.get(1).cpuMs, 4230);
    assert.equal(map.get(1).mem, 12345 * 1024); // ps reports KiB
    assert.equal(map.get(789).ppid, 1);
    assert.equal(map.get(789).name, 'sh');
    assert.equal(map.get(789).cpuMs, 3_723_000);
  });

  test('ignores lines that are not process rows', () => {
    assert.equal(posix.parsePsOutput(COMM).size, 2);
  });

  test('keeps the full command line when asked, spaces and all', () => {
    const map = posix.parsePsOutput('  900   789   2048   0:00.10 npm run dev --port 3000', {
      withCommandLine: true,
    });
    assert.equal(map.get(900).cmd, 'npm run dev --port 3000');
    assert.equal(map.get(900).name, 'npm');
  });

  test('a path with spaces cannot shift the numeric columns', () => {
    // This is why the variable-width column is last in the ps format string
    const map = posix.parsePsOutput('  42   1   1024   0:00.01 /Applications/My App/node');
    assert.equal(map.get(42).mem, 1024 * 1024);
    // In comm mode the whole tail is the executable path, spaces included
    assert.equal(map.get(42).name, 'node');
  });
});

describe('posix: parseProcStat', () => {
  // pid (comm) state ppid ... utime[14] stime[15] ... rss[24]
  const STAT =
    '4242 (my (weird) app) S 1 4242 4242 0 -1 4194304 1000 0 0 0 250 50 0 0 20 0 7 0 98765 123456789 5000';

  test('locates fields after a comm containing spaces and parens', () => {
    const proc = posix.parseProcStat(STAT, 4096);
    assert.equal(proc.pid, 4242);
    assert.equal(proc.ppid, 1);
    assert.equal(proc.name, 'my (weird) app');
  });

  test('sums utime+stime at 100 ticks/sec', () => {
    assert.equal(posix.parseProcStat(STAT, 4096).cpuMs, (250 + 50) * 10);
  });

  test('scales rss by the real page size', () => {
    assert.equal(posix.parseProcStat(STAT, 4096).mem, 5000 * 4096);
    // 16K pages (Apple silicon, some arm64 Linux) must not under-report by 4x
    assert.equal(posix.parseProcStat(STAT, 16384).mem, 5000 * 16384);
  });

  test('rejects truncated or malformed rows', () => {
    assert.equal(posix.parseProcStat('4242 (node) S 1 2 3', 4096), null);
    assert.equal(posix.parseProcStat('no parens here', 4096), null);
    assert.equal(posix.parseProcStat('', 4096), null);
  });
});

describe('posix: parseSs', () => {
  const OUTPUT = [
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=1234,fd=23))',
    'LISTEN 0      511             [::]:5173          [::]:*    users:(("node",pid=5678,fd=24))',
    'LISTEN 0      128        127.0.0.1:6379       0.0.0.0:*    ',
  ].join('\n');

  test('maps ports to pids, IPv4 and IPv6', () => {
    const map = posix.parseSs(OUTPUT);
    assert.equal(map.get(3000), 1234);
    assert.equal(map.get(5173), 5678);
  });

  test('skips the header row', () => {
    assert.equal(posix.parseSs(OUTPUT).has(NaN), false);
    assert.equal(posix.parseSs(OUTPUT).size, 2);
  });

  test('skips sockets with no visible pid rather than guessing', () => {
    // Without privileges ss hides other users' pids — a port with no owner is
    // worse than no row at all, since the caller would report a bogus holder.
    assert.equal(posix.parseSs(OUTPUT).has(6379), false);
  });
});

describe('posix: parseLsof', () => {
  const OUTPUT = [
    'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node    12345   me   23u  IPv4 0x1234567890abcdef      0t0  TCP *:3000 (LISTEN)',
    'node    67890   me   24u  IPv6 0xfedcba0987654321      0t0  TCP [::1]:5173 (LISTEN)',
    'Dropbox  4321   me   30u  IPv4 0x1111111111111111      0t0  TCP 127.0.0.1:17500 (LISTEN)',
  ].join('\n');

  test('maps ports to pids', () => {
    const map = posix.parseLsof(OUTPUT);
    assert.equal(map.get(3000), 12345);
    assert.equal(map.get(17500), 4321);
  });

  test('handles bracketed IPv6 addresses', () => {
    assert.equal(posix.parseLsof(OUTPUT).get(5173), 67890);
  });

  test('skips the header row', () => {
    assert.equal(posix.parseLsof(OUTPUT).size, 3);
  });
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

describe('collectTree', () => {
  const snapshot = new Map(
    [
      { pid: 10, ppid: 1 },   // the shell we spawned
      { pid: 11, ppid: 10 },  // npm
      { pid: 12, ppid: 11 },  // node
      { pid: 13, ppid: 11 },  // a second worker
      { pid: 20, ppid: 1 },   // someone else entirely
    ].map((p) => [p.pid, p])
  );

  test('collects every descendant', () => {
    assert.deepEqual(platform.collectTree(10, snapshot).sort((a, b) => a - b), [10, 11, 12, 13]);
  });

  test('does not wander into unrelated trees', () => {
    assert.equal(platform.collectTree(10, snapshot).includes(20), false);
  });

  test('unknown root yields nothing', () => {
    assert.deepEqual(platform.collectTree(999, snapshot), []);
  });

  test('a parent cycle from PID reuse terminates', () => {
    const cyclic = new Map(
      [{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }].map((p) => [p.pid, p])
    );
    assert.deepEqual(platform.collectTree(1, cyclic).sort((a, b) => a - b), [1, 2]);
  });
});

describe('interface', () => {
  test('resolves one implementation for this platform', () => {
    assert.equal(platform.isWindows, process.platform === 'win32');
    for (const name of ['spawnShell', 'killTree', 'listProcesses', 'findListeningPids']) {
      assert.equal(typeof platform[name], 'function', `${name} must be wired up`);
    }
    assert.ok(platform.OWNED_IMAGES.size > 0);
  });

  test('pidAlive: true for us, false for nothing', () => {
    assert.equal(platform.pidAlive(process.pid), true);
    assert.equal(platform.pidAlive(0), false);
    assert.equal(platform.pidAlive(null), false);
  });
});

// ---------------------------------------------------------------------------
// Live: the part the CI matrix exists for
// ---------------------------------------------------------------------------

describe('live process control', () => {
  // A three-level tree — shell -> node -> node — so the kill has something
  // real to walk. Both levels print their pid and then refuse to exit.
  const HELPER = `
import { spawn } from 'child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('PARENT ' + process.pid);
console.log('CHILD ' + child.pid);
setInterval(() => {}, 1000);
`;

  let dir;
  let helperPath;
  let spacedPath;

  test('setup', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsrunner-platform-'));
    helperPath = path.join(dir, 'helper.mjs');
    fs.writeFileSync(helperPath, HELPER, 'utf-8');

    // A folder with a space in it, because that is where shell quoting breaks
    const spacedDir = path.join(dir, 'a folder');
    fs.mkdirSync(spacedDir);
    spacedPath = path.join(spacedDir, 'echo.mjs');
    fs.writeFileSync(spacedPath, `console.log('SPACED OK');\n`, 'utf-8');
  });

  /** Run a command to completion and hand back everything it produced. */
  const capture = (command) =>
    new Promise((resolve, reject) => {
      const child = platform.spawnShell(command, {
        cwd: dir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
    });

  test('spawnShell runs a command and streams stdout', async () => {
    const { code, out, err } = await capture('node --version');
    assert.equal(code, 0, err);
    assert.match(out, /^v\d+\./);
  });

  test('spawnShell does not mangle quotes in the command', async () => {
    // Regression guard: cmd.exe needs verbatim arguments, or Node escapes the
    // inner quotes as \" and the command arrives corrupted.
    const { code, out, err } = await capture(`node -e "console.log(40 + 2)"`);
    assert.equal(code, 0, err);
    assert.match(out, /\b42\b/);
  });

  test('spawnShell handles a quoted path containing spaces', async () => {
    const { code, out, err } = await capture(`node "${spacedPath}"`);
    assert.equal(code, 0, err);
    assert.match(out, /SPACED OK/);
  });

  test('killTree takes down the whole tree, not just the shell', async () => {
    const child = platform.spawnShell(`node "${helperPath}"`, {
      cwd: dir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for both levels to announce themselves
    const pids = await new Promise((resolve, reject) => {
      let buf = '';
      let errBuf = '';
      const timer = setTimeout(
        () => reject(new Error(`helper never reported.\nstdout: ${buf}\nstderr: ${errBuf}`)),
        30_000
      );
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const parent = buf.match(/PARENT (\d+)/);
        const grandchild = buf.match(/CHILD (\d+)/);
        if (parent && grandchild) {
          clearTimeout(timer);
          resolve({ parent: Number(parent[1]), grandchild: Number(grandchild[1]) });
        }
      });
      child.stderr.on('data', (d) => { errBuf += d.toString(); });
      child.on('error', reject);
    });

    assert.equal(platform.pidAlive(pids.grandchild), true, 'grandchild should be up before the kill');

    platform.killTree(child.pid);

    // Reaping is not instant on either platform
    for (let i = 0; i < 100 && platform.pidAlive(pids.grandchild); i++) await wait(100);

    assert.equal(platform.pidAlive(pids.grandchild), false, 'grandchild survived killTree');
    assert.equal(platform.pidAlive(pids.parent), false, 'intermediate node survived killTree');
  });

  test('listProcesses sees this very process', async () => {
    const snapshot = await platform.listProcesses({ withCommandLine: true });
    assert.ok(snapshot.size > 0, 'process table came back empty');

    const self = snapshot.get(process.pid);
    assert.ok(self, `own pid ${process.pid} missing from the process table`);
    assert.match(self.name, /node/i);
    assert.ok(self.mem > 0, 'resident memory should not be zero');
    assert.ok(self.cpuMs >= 0 && Number.isFinite(self.cpuMs), `cpuMs was ${self.cpuMs}`);
    assert.ok(self.ppid > 0, 'parent pid should be set');
  });

  test('listProcesses omits the command line unless asked', async () => {
    const snapshot = await platform.listProcesses();
    assert.equal(snapshot.get(process.pid)?.cmd, '');
  });

  test('findListeningPids finds a port we are holding', async (t) => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const listeners = await platform.findListeningPids();
      if (listeners.size === 0) {
        // No ss/lsof/netstat on this box: the port-conflict guard degrades to
        // a bind test, which is a supported (if weaker) mode.
        t.skip('no listener-table tool available on this runner');
        return;
      }
      assert.equal(listeners.get(port), process.pid, `port ${port} should map back to us`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('findListeningPids finds an IPv6-only listener', async (t) => {
    // The case that matters most in practice: Node resolves 'localhost' to ::1
    // on modern Windows, so this is how a typical dev server actually binds.
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '::1', resolve);
      });
    } catch {
      t.skip('no IPv6 loopback on this runner');
      return;
    }

    const { port } = server.address();
    try {
      const listeners = await platform.findListeningPids();
      if (listeners.size === 0) {
        t.skip('no listener-table tool available on this runner');
        return;
      }
      assert.equal(listeners.get(port), process.pid, `IPv6 port ${port} should map back to us`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('teardown', () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
