// The OS boundary. Everything in the app that has to touch processes or ports
// goes through this module, so adding a platform means adding one file here
// rather than editing the process manager, the supervisor and the metrics loop.
//
// The interface:
//   spawnShell(command, opts)   -> ChildProcess, running `command` in a shell
//   killTree(pid)               -> kills that process and its descendants
//   listProcesses(opts)         -> Promise<Map<pid, ProcessRecord>>
//   findListeningPids(opts)     -> Promise<Map<port, pid>>
//   OWNED_IMAGES                -> process names we may re-attach to on boot
//
// ProcessRecord is normalised across platforms:
//   { pid, ppid, name, cpuMs, mem, cmd }
//   cpuMs — cumulative CPU time in ms; mem — resident bytes; cmd — '' unless
//   listProcesses was called with { withCommandLine: true }.
import * as win from './win.mjs';
import * as posix from './posix.mjs';

export const isWindows = process.platform === 'win32';

const impl = isWindows ? win : posix;

export const { spawnShell, killTree, listProcesses, findListeningPids, OWNED_IMAGES } = impl;

/**
 * Cheap liveness check, identical on every platform.
 * EPERM means the PID exists but belongs to someone else.
 */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * All PIDs in the tree rooted at rootPid (inclusive), from a snapshot.
 * Pure — the snapshot is whatever listProcesses returned.
 */
export function collectTree(rootPid, snapshot) {
  const children = new Map(); // ppid -> pid[]
  for (const proc of snapshot.values()) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc.pid);
  }

  const tree = [];
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue; // guards against cycles from PID reuse
    seen.add(pid);
    if (!snapshot.has(pid)) continue;
    tree.push(pid);
    for (const child of children.get(pid) || []) queue.push(child);
  }
  return tree;
}
