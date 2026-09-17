// POSIX (macOS / Linux / BSD) implementation of the platform interface.
//
// Two things differ fundamentally from Windows and shape everything here:
//
//  1. There is no `taskkill /T`. A process tree is killed by killing its
//     process *group*, which only works if we created one — hence
//     `detached: true` on every spawn, making the shell the group leader.
//  2. There is no CIM. Linux reads /proc directly (no subprocess, and CPU time
//     at clock-tick resolution instead of whole seconds); everything else falls
//     back to `ps`, whose TIME column is far coarser.
import { spawn, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

// Shells and runtimes we are willing to adopt on boot. The recorded PID is the
// shell that `spawnShell` started; its children are the real dev servers.
export const OWNED_IMAGES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish',
  'node', 'npm', 'yarn', 'pnpm', 'bun', 'deno',
]);

const isLinux = process.platform === 'linux';

// Linux /proc reports CPU in clock ticks. _SC_CLK_TCK is 100 on every mainstream
// Linux build and is not exposed to Node, so it is assumed rather than queried.
const CLK_TCK = 100;

/**
 * Spawn a command through the shell, as its own process group.
 *
 * `detached` is what makes `killTree` possible: without a group of our own,
 * killing the shell would orphan npm and node instead of taking them down.
 * The flip side — children survive a hard kill of this server — matches the
 * Windows behaviour and is exactly what orphan adoption expects on next boot.
 */
export function spawnShell(command, { cwd, env, stdio }) {
  return spawn(command, {
    cwd,
    env,
    stdio,
    shell: true,
    detached: true,
  });
}

/**
 * Kill a process and everything below it.
 *
 * Negating the PID targets the whole process group, which covers
 * sh -> npm -> node in one call. Adopted PIDs are not always group leaders
 * (their group died with the previous server), so a direct kill is the
 * fallback. Throws only when both fail — callers treat that as "already gone".
 */
export function killTree(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    process.kill(pid, 'SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// Process table
// ---------------------------------------------------------------------------

/**
 * Parse a `ps` TIME column into milliseconds.
 * Handles `MM:SS`, `MM:SS.cc` (macOS), `HH:MM:SS` and `DD-HH:MM:SS` (Linux).
 */
export function parseCpuTime(value) {
  if (!value) return 0;
  const dash = value.indexOf('-');
  const days = dash === -1 ? 0 : Number(value.slice(0, dash));
  const rest = dash === -1 ? value : value.slice(dash + 1);

  let seconds = 0;
  for (const part of rest.split(':')) {
    const n = Number(part);
    if (!Number.isFinite(n)) return 0;
    seconds = seconds * 60 + n;
  }
  if (!Number.isFinite(days)) return 0;
  return (seconds + days * 86400) * 1000;
}

/**
 * Parse the output of `ps axo pid=,ppid=,rss=,time=,(comm|args)=`.
 * The variable-width column is last so a path with spaces cannot shift fields.
 * Exported for tests.
 */
export function parsePsOutput(stdout, { withCommandLine = false } = {}) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;

    const tail = m[5].trim();
    if (!tail) continue;
    // `comm` is the executable path alone (a full path on macOS), so it may
    // legitimately contain spaces — "/Applications/My App/node". `args` puts
    // arguments after it, where the first token is the best available guess.
    const name = path.basename(withCommandLine ? tail.split(/\s+/)[0] : tail);

    map.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name,
      cpuMs: parseCpuTime(m[4]),
      mem: Number(m[3]) * 1024, // ps reports RSS in KiB
      cmd: withCommandLine ? tail : '',
    });
  }
  return map;
}

/**
 * Parse one /proc/<pid>/stat line. Exported for tests.
 *
 * `comm` is wrapped in parentheses and may itself contain spaces and
 * parentheses, so the fields after it are located from the LAST ')'.
 * Field numbers below are the 1-based ones from proc(5).
 */
export function parseProcStat(raw, pageSize) {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) return null;

  const pid = Number(raw.slice(0, open).trim());
  if (!Number.isInteger(pid)) return null;

  const name = raw.slice(open + 1, close);
  // After ')' the first field is `state` (3), so index i holds field i + 3.
  const f = raw.slice(close + 2).trim().split(/\s+/);
  if (f.length < 22) return null;

  const utime = Number(f[11]); // field 14
  const stime = Number(f[12]); // field 15
  const rss = Number(f[21]);   // field 24, in pages

  return {
    pid,
    ppid: Number(f[1]) || 0, // field 4
    name,
    cpuMs: ((utime || 0) + (stime || 0)) * (1000 / CLK_TCK),
    mem: (rss || 0) * pageSize,
    cmd: '',
  };
}

let pageSizePromise = null;

/**
 * RSS in /proc is counted in pages, and the page size is 16K on Apple-silicon
 * style kernels and some arm64 Linux builds — assuming 4K there would
 * under-report memory fourfold. Queried once, then cached.
 */
function getPageSize() {
  pageSizePromise ||= new Promise((resolve) => {
    execFile('getconf', ['PAGESIZE'], { timeout: 3000 }, (err, stdout) => {
      const n = parseInt(String(stdout).trim(), 10);
      resolve(err || !Number.isInteger(n) || n <= 0 ? 4096 : n);
    });
  });
  return pageSizePromise;
}

async function listProcessesProc(withCommandLine) {
  const pageSize = await getPageSize();
  let entries;
  try {
    entries = await fs.promises.readdir('/proc');
  } catch {
    return null; // no /proc — caller falls back to ps
  }

  const pids = entries.filter((name) => /^\d+$/.test(name));
  const map = new Map();

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const proc = parseProcStat(await fs.promises.readFile(`/proc/${pid}/stat`, 'utf-8'), pageSize);
        if (!proc) return;
        if (withCommandLine) {
          try {
            const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf-8');
            // Arguments are NUL-separated, with a trailing NUL
            proc.cmd = raw.replace(/\0+$/, '').split('\0').join(' ');
          } catch {
            // Kernel thread, or it exited — the stat row is still usable
          }
        }
        map.set(proc.pid, proc);
      } catch {
        // The process exited between readdir and readFile — normal, skip it
      }
    })
  );

  return map;
}

function listProcessesPs(withCommandLine, timeout) {
  const format = `pid=,ppid=,rss=,time=,${withCommandLine ? 'args=' : 'comm='}`;
  return new Promise((resolve) => {
    // BSD syntax (no leading dash) is understood by both macOS ps and procps.
    execFile('ps', ['axo', format], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err || !stdout ? new Map() : parsePsOutput(stdout, { withCommandLine }));
    });
  });
}

/**
 * @returns {Promise<Map<number, {pid:number, ppid:number, name:string, cpuMs:number, mem:number, cmd:string}>>}
 *          Empty map when the query fails — callers treat that as "no data".
 */
export async function listProcesses({ withCommandLine = false, timeout = 10000 } = {}) {
  if (isLinux) {
    const fromProc = await listProcessesProc(withCommandLine);
    if (fromProc && fromProc.size > 0) return fromProc;
  }
  return listProcessesPs(withCommandLine, timeout);
}

// ---------------------------------------------------------------------------
// Listening ports
// ---------------------------------------------------------------------------

/**
 * Parse `ss -tlnp` output into port -> pid. Exported for tests.
 * Rows look like:
 *   LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=23))
 */
export function parseSs(stdout) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const addr = fields[3].match(/:(\d+)$/);
    if (!addr) continue; // header row, or a unix socket
    const pid = line.match(/pid=(\d+)/);
    if (!pid) continue; // someone else's socket: no pid without privileges
    const port = Number(addr[1]);
    if (!map.has(port)) map.set(port, Number(pid[1]));
  }
  return map;
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN` output into port -> pid. Exported for tests.
 * Rows look like:
 *   node    12345 me   23u  IPv4 0x..  0t0  TCP *:3000 (LISTEN)
 */
export function parseLsof(stdout) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\S+\s+(\d+)\s+.*\s\S*?:(\d+)\s+\(LISTEN\)/);
    if (!m) continue;
    const port = Number(m[2]);
    if (!map.has(port)) map.set(port, Number(m[1]));
  }
  return map;
}

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // ss and lsof both exit non-zero when *some* rows were unreadable, so
      // partial output is still worth parsing.
      resolve(stdout || null);
    });
  });
}

// ss ships with iproute2 and is the norm on modern Linux; lsof is the norm on
// macOS. Either may be missing, so both are tried in the locally likely order.
const PORT_PROBES = [
  { cmd: 'ss', args: ['-tlnp'], parse: parseSs },
  { cmd: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN'], parse: parseLsof },
];

/**
 * Which PID is listening on which TCP port.
 * Returns an empty map when neither tool is installed — the port-conflict guard
 * then falls back to a plain bind test.
 *
 * @returns {Promise<Map<number, number>>} port -> pid
 */
export async function findListeningPids({ timeout = 8000 } = {}) {
  const probes = isLinux ? PORT_PROBES : [...PORT_PROBES].reverse();
  for (const { cmd, args, parse } of probes) {
    const stdout = await run(cmd, args, timeout);
    if (!stdout) continue;
    const map = parse(stdout);
    if (map.size > 0) return map;
  }
  return new Map();
}
