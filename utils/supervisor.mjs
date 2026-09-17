// Keeps config/projects.json in sync with what is actually running:
//  - writes crash/exit status back to config (so the dashboard stops lying)
//  - auto-restarts crashed projects that opted in, with a crash-loop guard
//  - adopts orphan processes left behind by a previous server run
//  - holds live CPU/memory samples (kept in memory, never written to disk)
import { listProcesses, findListeningPids, pidAlive, OWNED_IMAGES } from './platform/index.mjs';
import { probePort, waitForPort } from './health.mjs';

const RESTART_DELAY_MS = 1500;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const HEALTH_INTERVAL_MS = 1500;
const DEP_WAIT_MS = 90_000;

// id -> { cpu, mem }
const metrics = new Map();
// id -> 'ready' | 'waiting' | 'none'  ('none' = nothing to probe)
const health = new Map();
// id -> { count, since }
const restartAttempts = new Map();
// id -> Timeout
const pendingRestarts = new Map();
// ids currently being started by the dependency orchestrator
const orchestrating = new Set();

let config;
let processManager;
let logger;

function log(id, text, err = false) {
  logger?.pushLog(id, `[runner] ${text}`, err);
}

/**
 * Wire the supervisor to the process manager. Call once at startup.
 */
export function initSupervisor(deps) {
  config = deps.config;
  processManager = deps.processManager;
  logger = deps.logger;

  processManager.setExitCallback(handleExit);
}

function handleExit(id, { code, killed, adopted }) {
  health.delete(id);
  metrics.delete(id);

  // Stop/Restart already own the config write for intentional kills
  if (killed) return;

  const project = config.getProject(id);
  if (!project) return;

  const crashed = typeof code === 'number' && code !== 0;
  config.updateProject(id, {
    status: crashed ? 'crashed' : 'stopped',
    pid: null,
    startedAt: null,
  });

  if (adopted) {
    log(id, `adopted process ended (PID ${project.pid ?? '?'})`, true);
  }

  if (crashed && project.autoRestart) {
    scheduleRestart(id, code);
  }
}

function scheduleRestart(id, code) {
  const now = Date.now();
  const attempt = restartAttempts.get(id);

  if (!attempt || now - attempt.since > RESTART_WINDOW_MS) {
    restartAttempts.set(id, { count: 1, since: now });
  } else if (attempt.count >= MAX_RESTARTS) {
    log(id, `auto-restart stopped after ${MAX_RESTARTS} attempts in ${RESTART_WINDOW_MS / 1000}s — fix the crash and start manually`, true);
    return;
  } else {
    attempt.count += 1;
  }

  const count = restartAttempts.get(id).count;
  log(id, `crashed with exit code ${code} — auto-restarting (${count}/${MAX_RESTARTS}) in ${RESTART_DELAY_MS / 1000}s`, true);

  const timer = setTimeout(() => {
    pendingRestarts.delete(id);
    const project = config.getProject(id);
    // Cancelled by a manual start/stop in the meantime
    if (!project || !project.autoRestart || project.status === 'running' || project.status === 'starting') return;

    try {
      const result = processManager.startProjectProcess(project);
      config.updateProject(id, {
        status: result.status || 'running',
        pid: result.pid || null,
        startedAt: result.startedAt || null,
      });
      log(id, `auto-restarted (PID ${result.pid})`);
    } catch (err) {
      config.updateProject(id, { status: 'crashed', pid: null, startedAt: null });
      log(id, `auto-restart failed: ${err.message}`, true);
    }
  }, RESTART_DELAY_MS);

  timer.unref?.();
  pendingRestarts.set(id, timer);
}

/**
 * Drop a queued auto-restart — called when the user stops the project himself.
 */
export function cancelPendingRestart(id) {
  const timer = pendingRestarts.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingRestarts.delete(id);
  }
  restartAttempts.delete(id);
}

export function setMetrics(id, value) {
  metrics.set(id, value);
}

export function clearMetrics(id) {
  metrics.delete(id);
  health.delete(id);
}

// ---------- Health ----------

/**
 * Probe every running project that has a port, so the dashboard can tell
 * "process spawned" apart from "server actually accepting connections".
 */
export function startHealthChecks({ intervalMs = HEALTH_INTERVAL_MS } = {}) {
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const running = processManager.getRunningProjects();
      const runningIds = new Set(running.map((r) => r.id));
      for (const id of health.keys()) {
        if (!runningIds.has(id)) health.delete(id);
      }

      await Promise.all(
        running.map(async ({ id }) => {
          const project = config.getProject(id);
          if (!project) return;
          if (!project.port) {
            health.set(id, 'none');
            return;
          }
          const ready = await probePort(project.port);
          const prev = health.get(id);
          health.set(id, ready ? 'ready' : 'waiting');
          if (ready && prev === 'waiting') {
            log(id, `ready on http://localhost:${project.port}`);
          }
        })
      );
    } catch {
      // Never break the loop
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return { stop: () => clearInterval(timer) };
}

export function getHealth(id) {
  return health.get(id) || 'unknown';
}

// ---------- Dependency-ordered start ----------

function spawnAndRecord(project) {
  const result = processManager.startProjectProcess(project);
  return config.updateProject(project.id, {
    status: result.status || 'running',
    pid: result.pid || null,
    startedAt: result.startedAt || null,
  });
}

/**
 * Bring up a set of projects as a dependency graph rather than a queue.
 *
 * Each project waits only for its own dependencies, so unrelated services come
 * up at the same time instead of queueing behind someone else's slow database.
 * Launches are memoised per run, so a dependency shared by several targets is
 * started — and awaited — exactly once. Dependency cycles are broken by
 * dropping the edge that closes the loop.
 *
 * With `sequential`, the targets are walked one at a time and each is fully
 * ready before the next one is spawned. The memo map is shared across steps,
 * so a service already brought up as someone's dependency is not started twice.
 *
 * @param {string[]} targetIds
 * @param {{sequential?: boolean}} [options]
 * @returns {Promise<{started: string[], skipped: string[], failed: string[], aborted?: string[]}>}
 */
async function launchGraph(targetIds, { sequential = false } = {}) {
  const inFlight = new Map(); // id -> Promise<void> settling when ready (or given up on)
  const started = [];
  const skipped = [];
  const failed = [];

  const launch = (id, chain = new Set()) => {
    const existing = inFlight.get(id);
    if (existing) return existing;

    const nextChain = new Set(chain).add(id);
    const task = (async () => {
      const project = config.getProject(id);
      if (!project) return;

      orchestrating.add(id);
      try {
        // Cycle guard: never wait on something already waiting on us
        const deps = (project.dependsOn || []).filter((depId) => !nextChain.has(depId));
        if (deps.length > 0) {
          const names = deps.map((d) => config.getProject(d)?.name || d).join(', ');
          log(id, `waiting for dependencies: ${names}`);
          await Promise.all(deps.map((depId) => launch(depId, nextChain)));
        }

        if (processManager.isRunning(id)) {
          skipped.push(id);
        } else {
          try {
            spawnAndRecord(project);
            started.push(id);
          } catch (err) {
            config.updateProject(id, { status: 'crashed', pid: null, startedAt: null });
            log(id, `failed to start: ${err.message}`, true);
            failed.push(id);
            return;
          }
        }

        // Anything depending on this one must not proceed until it answers
        if (!project.port) {
          if (sequential) {
            log(id, 'no port to probe — the next service starts right away');
          }
          return;
        }
        const ready = await waitForPort(project.port, {
          timeoutMs: DEP_WAIT_MS,
          signal: () => processManager.isRunning(id),
        });
        if (ready) {
          health.set(id, 'ready');
        } else {
          log(id, `not ready after ${DEP_WAIT_MS / 1000}s — dependents will continue anyway`, true);
        }
      } finally {
        orchestrating.delete(id);
      }
    })();

    inFlight.set(id, task);
    return task;
  };

  if (!sequential) {
    await Promise.all(targetIds.map((id) => launch(id)));
    return { started, skipped, failed };
  }

  // Sequential: one at a time, each ready before the next is spawned
  const aborted = [];
  for (let i = 0; i < targetIds.length; i++) {
    const id = targetIds[i];
    const project = config.getProject(id);
    if (!project) continue;

    log(id, `step ${i + 1}/${targetIds.length} of the profile`);
    await launch(id);

    // A step that could not even spawn makes the rest pointless — the whole
    // reason for sequential mode is that later services need earlier ones.
    if (failed.includes(id)) {
      const rest = targetIds.slice(i + 1);
      for (const restId of rest) {
        aborted.push(restId);
        config.updateProject(restId, { status: 'stopped', pid: null, startedAt: null });
        log(restId, `skipped — ${project.name} failed to start`, true);
      }
      break;
    }
  }

  return { started, skipped, failed, aborted };
}

/**
 * Start a project after its dependencies are up and answering on their ports.
 * Runs in the background: the HTTP request returns immediately with 'starting'
 * so the browser is never left hanging on a slow dependency chain.
 */
export async function startWithDependencies(id) {
  if (orchestrating.has(id)) return;
  await launchGraph([id]);
}

/**
 * Start a whole profile.
 *
 * - `parallel` (default): one dependency graph. Members with no dependencies
 *   start immediately; members sharing a dependency wait for that dependency,
 *   not for each other.
 * - `sequential`: members are started in the listed order, each fully ready
 *   before the next one is spawned.
 *
 * @param {string[]} projectIds - in start order (only meaningful when sequential)
 * @param {{mode?: 'parallel'|'sequential'}} [options]
 */
export function startProfile(projectIds, { mode = 'parallel' } = {}) {
  return launchGraph(projectIds, { sequential: mode === 'sequential' });
}

/**
 * Would adding these dependencies create a cycle?
 */
export function hasDependencyCycle(id, dependsOn) {
  const visit = (current, chain) => {
    if (current === id && chain.length > 0) return true;
    const project = config.getProject(current);
    const edges = current === id && chain.length === 0 ? dependsOn : project?.dependsOn || [];
    for (const next of edges) {
      if (chain.includes(next)) continue;
      if (next === id) return true;
      if (visit(next, [...chain, next])) return true;
    }
    return false;
  };
  return visit(id, []);
}

/**
 * The project list as the dashboard should see it: config values corrected
 * against live process state, plus CPU/memory. Drift is persisted so a stale
 * "running" never survives a page reload.
 */
export function reconcile() {
  processManager.sweepAdopted();

  const projects = config.getProjects();
  const out = [];

  for (const project of projects) {
    const live = processManager.getProcessStatus(project.id);
    const patch = {};

    if (live && live.alive && live.status === 'running') {
      if (project.status !== 'running') patch.status = 'running';
      if (project.pid !== live.pid) patch.pid = live.pid;
      if (project.startedAt !== live.startedAt) patch.startedAt = live.startedAt;
    } else if (live && !live.alive) {
      // Process is gone; 'crashed' was already written by the exit callback
      const status = live.status === 'crashed' ? 'crashed' : 'stopped';
      if (project.status !== status) patch.status = status;
      if (project.pid !== null) patch.pid = null;
      if (project.startedAt !== null) patch.startedAt = null;
    } else if (!live && (project.status === 'running' || project.status === 'starting')) {
      // Untracked but config claims it runs — nothing left to manage.
      // Exception: the orchestrator is legitimately holding it at 'starting'
      // while its dependencies come up, with no process of its own yet.
      if (!orchestrating.has(project.id) && !pidAlive(project.pid)) {
        patch.status = 'stopped';
        patch.pid = null;
        patch.startedAt = null;
      }
    }

    const merged = Object.keys(patch).length > 0
      ? config.updateProject(project.id, patch) || { ...project, ...patch }
      : project;

    const isUp = merged.status === 'running';
    const m = isUp ? metrics.get(project.id) : null;
    const state = isUp ? (health.get(project.id) || (merged.port ? 'waiting' : 'none')) : 'unknown';

    out.push({
      ...merged,
      cpu: m?.cpu ?? '0.0',
      mem: m?.mem ?? '0',
      adopted: live?.adopted ?? false,
      health: state,
      url: merged.port && state === 'ready' ? `http://localhost:${merged.port}` : null,
    });
  }

  return out;
}

/**
 * Re-attach to processes from a previous server run.
 *
 * Two identification strategies, both deliberately conservative — losing track
 * of one of our processes is far better than killing a stranger's:
 *  1. the recorded PID is still alive and is one of our images
 *  2. the recorded PID is gone (a hard kill takes out the shell wrapper but
 *     not always its node grandchild) but something is still listening on the
 *     project's port — that listener is the orphan
 */
export async function adoptOrphans() {
  const projects = config.getProjects();
  const candidates = projects.filter(
    (p) => (p.pid || p.port) && (p.status === 'running' || p.status === 'starting')
  );
  if (candidates.length === 0) return { adopted: [], cleared: [] };

  const [snapshot, listeners] = await Promise.all([
    listProcesses({ withCommandLine: true }),
    findListeningPids(),
  ]);

  const adopted = [];
  const cleared = [];

  const isOwned = (pid) => {
    const proc = snapshot.get(pid);
    return proc ? OWNED_IMAGES.has(proc.name.toLowerCase()) : false;
  };

  for (const project of candidates) {
    // Strategy 1 — recorded PID still alive
    if (project.pid && pidAlive(project.pid) && isOwned(project.pid)) {
      const result = processManager.adoptProcess({
        id: project.id,
        pid: project.pid,
        startedAt: project.startedAt,
        command: snapshot.get(project.pid)?.cmd || '',
      });
      if (result) {
        adopted.push({ ...project, adoptedPid: project.pid, via: 'pid' });
        log(project.id, `re-attached to PID ${project.pid} after server restart — Stop/Restart work, but earlier output is not available`);
        continue;
      }
    }

    // Strategy 2 — the port is still held by a process we recognise
    const listenerPid = project.port ? listeners.get(project.port) : undefined;
    if (listenerPid && isOwned(listenerPid)) {
      const result = processManager.adoptProcess({
        id: project.id,
        pid: listenerPid,
        startedAt: project.startedAt,
        command: snapshot.get(listenerPid)?.cmd || '',
      });
      if (result) {
        config.updateProject(project.id, { pid: listenerPid });
        adopted.push({ ...project, adoptedPid: listenerPid, via: 'port' });
        log(project.id, `re-attached via port ${project.port} to PID ${listenerPid} after server restart — earlier output is not available`);
        continue;
      }
    }

    config.updateProject(project.id, { status: 'stopped', pid: null, startedAt: null });
    cleared.push(project);
  }

  return { adopted, cleared };
}
