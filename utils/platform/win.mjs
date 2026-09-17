// Windows implementation of the platform interface.
//
// The process table comes from a single PowerShell/CIM call per sample —
// cheaper than one wmic call per PID, and wmic is deprecated on recent builds.
import { spawn, execSync, execFile } from 'child_process';

const FIELDS = [
  'p=$_.ProcessId',
  'pp=$_.ParentProcessId',
  'n=$_.Name',
  't=[int64]($_.KernelModeTime + $_.UserModeTime)',
  'w=[int64]$_.WorkingSetSize',
];

// Images we are willing to adopt on boot — anything else holding that PID is a
// stranger, and PIDs do get recycled.
export const OWNED_IMAGES = new Set(['cmd.exe', 'node.exe', 'bun.exe', 'deno.exe']);

/**
 * Spawn a command through the shell.
 *
 * ALL package managers (npm/yarn/pnpm/bun) need the cmd.exe wrapper here
 * because they are .cmd/.bat files, not .exe — spawn cannot resolve them.
 *
 * `windowsVerbatimArguments` is not optional. Without it Node escapes the
 * command MSVCRT-style, turning every embedded quote into \" — which cmd.exe
 * reads literally, so `node "src/app.js"` arrives as a path *containing*
 * quotes. Wrapping the command in one outer quote pair and letting /s strip it
 * is the same shape child_process.exec() uses on Windows, and it keeps a
 * quoted command behaving the way it already does under `sh -c` on POSIX.
 */
export function spawnShell(command, { cwd, env, stdio }) {
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    cwd,
    env,
    stdio,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}

/**
 * Kill a process and everything below it — taskkill /T walks the tree for us.
 * Throws when the PID is already gone; callers decide whether that matters.
 */
export function killTree(pid) {
  execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true });
}

function buildScript(withCommandLine) {
  const fields = withCommandLine ? [...FIELDS, 'c=$_.CommandLine'] : FIELDS;
  return (
    '@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ' +
    fields.join('; ') +
    ' } }) | ConvertTo-Json -Compress'
  );
}

/**
 * Parse the CIM JSON payload into the shared process-record shape.
 * Exported for tests — the transport needs a real Windows box, parsing does not.
 */
export function parseProcessJson(stdout) {
  const map = new Map();
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return map;
  }
  if (!Array.isArray(rows)) rows = [rows];

  for (const r of rows) {
    if (typeof r?.p !== 'number') continue;
    map.set(r.p, {
      pid: r.p,
      ppid: typeof r.pp === 'number' ? r.pp : 0,
      name: r.n || '',
      // CIM reports CPU time in 100ns units; the interface speaks milliseconds.
      cpuMs: (Number(r.t) || 0) / 10_000,
      mem: Number(r.w) || 0,
      cmd: r.c || '',
    });
  }
  return map;
}

/**
 * @returns {Promise<Map<number, {pid:number, ppid:number, name:string, cpuMs:number, mem:number, cmd:string}>>}
 *          Empty map when the query fails — callers treat that as "no data".
 */
export function listProcesses({ withCommandLine = false, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', buildScript(withCommandLine)],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err || !stdout ? new Map() : parseProcessJson(stdout));
      }
    );
  });
}

/**
 * Parse `netstat -ano -p TCP` output into port -> pid. Exported for tests.
 */
export function parseNetstat(stdout) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    // "  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    1234"
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    const port = parseInt(m[1], 10);
    const pid = parseInt(m[2], 10);
    if (!map.has(port)) map.set(port, pid);
  }
  return map;
}

/**
 * Which PID is listening on which TCP port.
 * A hard-killed server leaves orphans whose recorded PID (the cmd.exe wrapper)
 * is gone while the real server keeps holding its port — the port is then the
 * only reliable way to find it again.
 *
 * @returns {Promise<Map<number, number>>} port -> pid
 */
export function findListeningPids({ timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'netstat',
      // Deliberately no `-p TCP`: that filter is IPv4-only, so a server bound
      // to ::1 — which is what Node does by default for 'localhost' on modern
      // Windows — would be invisible here. Plain -ano lists both families
      // (still labelled TCP), and the regex drops UDP and non-LISTENING rows.
      ['-ano'],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err || !stdout ? new Map() : parseNetstat(stdout));
      }
    );
  });
}
