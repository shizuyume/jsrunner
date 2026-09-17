import { spawnShell, killTree, pidAlive } from './platform/index.mjs';

// In-memory process store: "id:script" → { child, pid, startedAt, status, command, script, killed, adopted, onCrashCallbacks[] }
// `child` is null for adopted entries — processes started by a previous run of
// the server that we re-attached to by PID (no stdio, so no logs).
const processes = new Map();
let logCallback = null;
let exitCallback = null;
const startLocks = new Set();

/**
 * Is this entry's process still alive? Adopted entries have no child handle,
 * so they are checked against the OS.
 */
function isAlive(entry) {
  if (!entry) return false;
  if (entry.adopted) return pidAlive(entry.pid);
  return entry.child?.exitCode === null;
}

function notifyExit(id, info) {
  if (exitCallback) {
    try { exitCallback(id, info); } catch { /* never let a listener break teardown */ }
  }
}

/**
 * Determine the run command for a project.
 * Priority: explicit `command` > chosen `runScript` > explicit script > dev > start > first script.
 */
export function buildCommand({ scripts = [], pm, id, runScript, command }, explicitScript) {
  if (typeof command === 'string' && command.trim()) return command.trim();

  let script;
  if (explicitScript && scripts.includes(explicitScript)) {
    script = explicitScript;
  } else if (runScript && scripts.includes(runScript)) {
    script = runScript;
  } else if (scripts.includes('dev')) {
    script = 'dev';
  } else if (scripts.includes('start')) {
    script = 'start';
  } else if (scripts.length > 0) {
    script = scripts[0];
  } else {
    throw new Error(`No scripts available for project ${id}`);
  }

  if (pm === 'npm') return `npm run ${script}`;
  // bun/pnpm/yarn: <pm> dev|start|run <script>
  return script === 'dev' || script === 'start'
    ? `${pm} ${script}`
    : `${pm} run ${script}`;
}

/**
 * Spawn a process through the platform shell.
 * Per-project env vars are layered over the server's own environment; the
 * shell invocation itself (cmd.exe vs sh, process group or not) is the
 * platform layer's business.
 */
function spawnProcess(command, cwd, env) {
  const extra = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v !== null && v !== undefined) extra[k] = String(v);
  }

  return spawnShell(command, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.keys(extra).length > 0 ? { ...process.env, ...extra } : process.env,
  });
}

/** Default script for a project: dev > start > first. */
function defaultScript({ scripts }) {
  if (scripts.includes('dev')) return 'dev';
  if (scripts.includes('start')) return 'start';
  return scripts[0];
}

/** Resolve requested script to one that exists; fall back to default. */
function resolveScript(project, script) {
  if (script && project.scripts.includes(script)) return script;
  return defaultScript(project);
}

/** Kill an entry's process tree; swallow failures. */
function killEntry(entry) {
  entry.killed = true;
  try {
    killTree(entry.pid);
  } catch {
    try { entry.child?.kill(); } catch { /* give up */ }
  }
}

/** Wire stdout/stderr/close/error handlers onto a spawned entry. */
function attachEntryHandlers(id, entry) {
  entry.child.stdout.on('data', (data) => {
    if (logCallback) logCallback(id, data.toString(), false, entry.script);
  });

  entry.child.stderr.on('data', (data) => {
    if (logCallback) logCallback(id, data.toString(), true, entry.script);
  });

  entry.child.on('close', (code) => {
    if (code !== 0 && !entry.killed) {
      entry.status = 'crashed';
      if (logCallback) logCallback(id, `Process crashed with exit code ${code}`, true, entry.script);

      for (const cb of entry.onCrashCallbacks) {
        try { cb(code); } catch { /* swallow callback errors */ }
      }
    } else if (code === 0) {
      entry.status = 'exited';
    }
    // Entry stays in map for status queries after exit
    notifyExit(id, { code, killed: entry.killed, adopted: false });
  });

  entry.child.on('error', (err) => {
    entry.status = 'error';
    if (logCallback) logCallback(id, `Process error: ${err.message}`, true, entry.script);
  });
}

/**
 * Start one service script for a project.
 * Idempotent: returns existing entry if "id:script" already running/starting.
 * Keyed per "id:script" so multiple scripts of one project can run together.
 */
export function startServiceProcess(project, script) {
  const { id } = project;
  const resolved = resolveScript(project, script);
  const key = `${id}:${resolved}`;

  const existing = processes.get(key);
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    return { pid: existing.pid, status: existing.status, startedAt: existing.startedAt, script: resolved };
  }
  if (startLocks.has(key)) {
    const locked = processes.get(key);
    if (locked && (locked.status === 'running' || locked.status === 'starting')) {
      return { pid: locked.pid, status: locked.status, startedAt: locked.startedAt, script: resolved };
    }
  }

  startLocks.add(key);

  try {
    const command = buildCommand(project, resolved);
    const child = spawnProcess(command, project.folder, project.env);
    if (logCallback) {
      logCallback(id, `[runner] ${command}${project.port ? ` (port ${project.port})` : ''}`, false, resolved);
    }

    const entry = {
      child,
      pid: child.pid,
      startedAt: Date.now(),
      status: 'running',
      command,
      script: resolved,
      killed: false,
      adopted: false,
      onCrashCallbacks: [],
    };

    processes.set(key, entry);
    attachEntryHandlers(id, entry);

    return { pid: child.pid, status: 'running', startedAt: entry.startedAt, script: resolved };
  } finally {
    startLocks.delete(key);
  }
}

/**
 * Stop one service script for a project.
 * The whole process tree goes, not just the shell wrapper.
 */
export function stopServiceProcess(id, script) {
  const key = `${id}:${script}`;
  const entry = processes.get(key);
  if (!entry) return { success: false };

  killEntry(entry);
  processes.delete(key);
  return { success: true };
}

/** Stop all service entries whose key starts with "id:". Returns count. */
export function stopAllServicesForProject(id) {
  const prefix = `${id}:`;
  let count = 0;
  for (const key of [...processes.keys()]) {
    if (key.startsWith(prefix)) {
      stopServiceProcess(id, key.slice(prefix.length));
      count++;
    }
  }
  return count;
}

/** List running services of a project: [{ script, pid, startedAt, status }]. */
export function getRunningServices(id) {
  const prefix = `${id}:`;
  const result = [];
  for (const [key, entry] of processes) {
    if (key.startsWith(prefix) && entry.status === 'running' && isAlive(entry)) {
      result.push({ script: entry.script, pid: entry.pid, startedAt: entry.startedAt, status: entry.status });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Backward-compatible aliases (old single-process-per-project API)
// ---------------------------------------------------------------------------

/**
 * Kill an arbitrary PID and its tree — used to free a port held by a process
 * this dashboard does not manage.
 */
export function killPid(pid) {
  killTree(pid);
}

/**
 * Start a project process (backward compat).
 * Alias for startServiceProcess with default script when no explicit script given.
 */
export function startProjectProcess(project, explicitScript) {
  return startServiceProcess(project, explicitScript || defaultScript(project));
}

/** Stop a project (backward compat). Alias for stopAllServicesForProject. */
export function stopProjectProcess(id) {
  return stopAllServicesForProject(id);
}

/** Restart one service script: stop that entry only, start it again. */
export function restartServiceProcess(project, script) {
  stopServiceProcess(project.id, script);
  return startServiceProcess(project, script);
}

/**
 * Restart a project: cycle exactly the scripts that were running, so a card
 * with several services comes back with the same set. With nothing running,
 * falls back to the default script. Returns the first started entry.
 */
export function restartProjectProcess(project) {
  const scripts = getRunningServices(project.id).map((s) => s.script);
  stopAllServicesForProject(project.id);
  if (scripts.length === 0) return startServiceProcess(project, defaultScript(project));
  return scripts.map((s) => startServiceProcess(project, s))[0];
}

/**
 * Get process status by id (backward compat).
 * Running if any service of the project is running; otherwise reflects
 * the latest entry status, or 'stopped' when the project has no entries.
 */
export function getProcessStatus(id) {
  const running = getRunningServices(id);
  if (running.length > 0) {
    const first = running[0];
    return {
      pid: first.pid,
      status: 'running',
      startedAt: first.startedAt,
      command: first.script,
      adopted: false,
      alive: true,
      cpu: 0,
      mem: 0,
    };
  }

  const prefix = `${id}:`;
  let latest = null;
  for (const [key, entry] of processes) {
    if (key.startsWith(prefix)) {
      if (!latest || entry.startedAt > latest.startedAt) latest = entry;
    }
  }
  if (latest) {
    return {
      pid: latest.pid,
      status: latest.status,
      startedAt: latest.startedAt,
      command: latest.script,
      adopted: !!latest.adopted,
      alive: isAlive(latest),
      cpu: 0,
      mem: 0,
    };
  }

  return { pid: null, status: 'stopped', startedAt: null, command: null, adopted: false, alive: false, cpu: 0, mem: 0 };
}

/** Check if any service of a project is running (backward compat). */
export function isRunning(id) {
  return getRunningServices(id).length > 0;
}

/**
 * Re-attach to a process started by a previous run of the server.
 * No stdio is available, so logs stay empty until the project is restarted —
 * but Stop/Restart work, which is what makes the orphan manageable again.
 */
export function adoptProcess({ id, pid, startedAt, command, script }) {
  if (!pidAlive(pid)) return null;

  const resolved = script || 'adopted';
  const key = `${id}:${resolved}`;
  const entry = {
    child: null,
    pid,
    startedAt: startedAt || Date.now(),
    status: 'running',
    command: command || '',
    script: resolved,
    killed: false,
    adopted: true,
    onCrashCallbacks: [],
  };
  processes.set(key, entry);
  return { pid, status: 'running', startedAt: entry.startedAt };
}

/**
 * Detect adopted processes that died while we were not watching them.
 * Real children report via their 'close' event; adopted ones need this sweep.
 */
export function sweepAdopted() {
  for (const [key, entry] of processes) {
    if (!entry.adopted || entry.status !== 'running') continue;
    if (pidAlive(entry.pid)) continue;
    entry.status = 'exited';
    const id = key.split(':')[0];
    if (logCallback) logCallback(id, `Adopted process (PID ${entry.pid}) is no longer running`, true, entry.script);
    notifyExit(id, { code: null, killed: false, adopted: true });
  }
}

/**
 * Set the log callback.
 * fn: (id, text, err, script) => void
 */
export function setLogCallback(fn) {
  logCallback = fn;
}

/**
 * Set the process-exit callback — fires for every exit, clean or not.
 * fn: (id, { code, killed, adopted }) => void
 */
export function setExitCallback(fn) {
  exitCallback = fn;
}

/**
 * Register a crash callback for a process.
 * Called when process exits with non-zero code and was not intentionally killed.
 * Usage: onCrash(id, cb) applies to all services of the project;
 *        onCrash(id, script, cb) targets one specific service script.
 */
export function onCrash(id, scriptOrCallback, maybeCallback) {
  let entries = [];
  if (typeof scriptOrCallback === 'function') {
    for (const [key, entry] of processes) {
      if (key.startsWith(`${id}:`)) entries.push(entry);
    }
    maybeCallback = scriptOrCallback;
  } else {
    const entry = processes.get(`${id}:${scriptOrCallback}`);
    if (entry) entries.push(entry);
  }
  for (const entry of entries) entry.onCrashCallbacks.push(maybeCallback);
}

/**
 * Get all running entries from the map.
 * Optionally accepts an external map; defaults to internal.
 * Returns [{ id, pid, startedAt }] — one row per running service.
 */
export function getRunningProjects(map) {
  const target = map || processes;
  const result = [];
  for (const [key, entry] of target) {
    if (entry.status === 'running' && isAlive(entry)) {
      const id = key.slice(0, key.length - entry.script.length - 1);
      result.push({ id, pid: entry.pid, startedAt: entry.startedAt, adopted: !!entry.adopted });
    }
  }
  return result;
}

/**
 * Stop ALL running processes. Used for cleanup on server shutdown.
 */
export function stopAll() {
  for (const entry of processes.values()) {
    if (entry.status === 'running' && isAlive(entry)) {
      killEntry(entry);
    }
  }
  processes.clear();
}
