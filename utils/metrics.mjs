// CPU% / memory per project.
// The tracked PID is the shell wrapper, so counters are summed over the whole
// process tree (sh/cmd.exe → npm → node → …) or the numbers would always read ~0.
import os from 'os';
import { listProcesses, collectTree } from './platform/index.mjs';

const CORES = Math.max(1, os.cpus().length);

// rootPid -> { cpuMs, at } from the previous sample
const prevSamples = new Map();

const ZERO = { cpu: '0.0', mem: '0' };

/**
 * Sample CPU/memory for several process trees at once.
 * First sample for a PID is a baseline and reports zeros.
 *
 * @param {number[]} rootPids
 * @returns {Promise<Map<number, {cpu: string, mem: string}>>}
 */
export async function sampleMetrics(rootPids) {
  const out = new Map();
  const pids = rootPids.filter(Boolean);
  if (pids.length === 0) {
    prevSamples.clear();
    return out;
  }

  const snapshot = await listProcesses();
  if (snapshot.size === 0) {
    for (const pid of pids) out.set(pid, ZERO);
    return out;
  }

  const now = Date.now();

  for (const rootPid of pids) {
    const tree = collectTree(rootPid, snapshot);
    if (tree.length === 0) {
      prevSamples.delete(rootPid);
      out.set(rootPid, ZERO);
      continue;
    }

    let cpuMs = 0;
    let mem = 0;
    for (const pid of tree) {
      const proc = snapshot.get(pid);
      cpuMs += proc.cpuMs;
      mem += proc.mem;
    }

    const memMB = Math.round(mem / (1024 * 1024)).toString();
    const prev = prevSamples.get(rootPid);
    prevSamples.set(rootPid, { cpuMs, at: now });

    if (!prev || now <= prev.at) {
      out.set(rootPid, { cpu: '0.0', mem: memMB });
      continue;
    }

    const busyMs = cpuMs - prev.cpuMs;
    const elapsedMs = now - prev.at;
    const pct = Math.max(0, (busyMs / elapsedMs / CORES) * 100);

    out.set(rootPid, { cpu: pct.toFixed(1), mem: memMB });
  }

  // Drop bookkeeping for trees we no longer track
  for (const pid of prevSamples.keys()) {
    if (!pids.includes(pid)) prevSamples.delete(pid);
  }

  return out;
}

/**
 * Poll running projects and report metrics. Skips sampling entirely when
 * nothing is running, so an idle dashboard never queries the process table.
 *
 * @param {object} processManager - must expose getRunningProjects()
 * @param {(id: string, metrics: {cpu: string, mem: string}) => void} onUpdate
 * @param {{intervalMs?: number}} [options]
 * @returns {{ stop: () => void }}
 */
export function startMetricsCollection(processManager, onUpdate, { intervalMs = 3000 } = {}) {
  let running = false;

  const tick = async () => {
    if (running) return; // a slow sample must not stack up
    running = true;
    try {
      const projects = processManager.getRunningProjects();
      if (projects.length === 0) {
        prevSamples.clear();
        return;
      }
      const metrics = await sampleMetrics(projects.map((p) => p.pid));
      for (const p of projects) {
        const m = metrics.get(p.pid);
        if (m && onUpdate) onUpdate(p.id, m);
      }
    } catch {
      // Swallow — never break the polling loop
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return { stop: () => clearInterval(timer) };
}
