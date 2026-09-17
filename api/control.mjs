import { isPortFree } from '../utils/health.mjs';
import { findListeningPids, listProcesses } from '../utils/platform/index.mjs';
import fs from 'fs';

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Is anything LISTENING on this port? The OS listener table is the authority
 * here — a bind test only proves *one* address is free, and a server on `::`
 * or `0.0.0.0` does not always block a later bind to 127.0.0.1.
 */
async function findPortPid(port) {
  const listeners = await findListeningPids();
  return listeners.get(port) ?? null;
}

/**
 * Name/command for a PID. The process-table query is only worth its cost once
 * we know there really is a conflict.
 */
async function describePid(pid) {
  const snapshot = await listProcesses({ withCommandLine: true });
  const proc = snapshot.get(pid);
  return {
    pid,
    name: proc?.name || 'unknown',
    command: proc?.cmd || '',
  };
}

async function findPortHolder(port) {
  const pid = await findPortPid(port);
  return pid ? describePid(pid) : null;
}

/**
 * Resolve which port a start action will bind.
 * Priority: sub-project match (dev:frontend -> subProjects.frontend.port)
 *           > PORT=NNN in the script value (re-read package.json)
 *           > project.port
 */
function resolveScriptPort(project, script) {
  if (script && project.subProjects?.length > 0) {
    const suffix = script.split(':').pop();
    const sp = project.subProjects.find((s) => s.name === suffix);
    if (sp?.port) return sp.port;
  }
  if (script && project.scripts?.includes(script)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(project.path, 'utf-8'));
      const value = pkg.scripts?.[script] || '';
      const m = value.match(/\bPORT=(\d+)/);
      if (m) return parseInt(m[1], 10);
    } catch { /* fall through */ }
  }
  return project.port || null;
}

export function registerControlRoutes(router, config, processManager, supervisor) {
  function withRunningServices(project) {
    const services = processManager.getRunningServices(project.id);
    const status = services.length > 0 ? 'running' : (project.status || 'stopped');
    const isUp = status === 'running';
    const health = isUp ? (supervisor.getHealth(project.id) || (project.port ? 'waiting' : 'none')) : 'unknown';
    const url = project.port && health === 'ready' ? `http://localhost:${project.port}` : null;
    return { ...project, status, runningServices: services, health, url };
  }

  // POST /api/project/start
  router.post('/api/project/start', async (req, res) => {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { id, script } = body;
    const project = config.getProject(id);
    if (!project) {
      sendJSON(res, 404, { error: 'Project not found' });
      return;
    }

    // Idempotent: requested script already running
    const running = processManager.getRunningServices(id);
    if (script && running.some((s) => s.script === script)) {
      sendJSON(res, 200, withRunningServices(project));
      return;
    }
    if (!script && running.length > 0) {
      sendJSON(res, 200, withRunningServices(project));
      return;
    }

    // Resolve the port this start will use, then check for conflicts.
    const portToUse = resolveScriptPort(project, script);
    if (portToUse) {
      const holderPid = await findPortPid(portToUse);
      const free = holderPid === null && (await isPortFree(portToUse));
      if (!free) {
        const holder = holderPid ? await describePid(holderPid) : null;
        sendJSON(res, 409, {
          error: holder
            ? `Port ${portToUse} is already in use by ${holder.name} (PID ${holder.pid})`
            : `Port ${portToUse} is already in use`,
          code: 'PORT_IN_USE',
          port: portToUse,
          holder,
        });
        return;
      }
    }

    // A manual start supersedes any queued auto-restart
    supervisor.cancelPendingRestart(id);

    // With dependencies, starting is a background job: deps must come up and
    // answer on their ports first, which can take a while.
    if (project.dependsOn?.length > 0 && !script) {
      const updated = config.updateProject(id, { status: 'starting' });
      supervisor.startWithDependencies(id).catch(() => {
        config.updateProject(id, { status: 'crashed', pid: null, startedAt: null });
      });
      sendJSON(res, 202, updated);
      return;
    }

    try {
      // Explicit script starts one service; empty script starts the default (dev > start > first)
      const result = script
        ? processManager.startServiceProcess(project, script)
        : processManager.startProjectProcess(project);
      config.updateProject(id, {
        status: result.status || 'running',
        pid: result.pid || null,
        startedAt: result.startedAt || null,
      });
      sendJSON(res, 200, withRunningServices(config.getProject(id)));
    } catch (err) {
      config.updateProject(id, { status: 'stopped', pid: null, startedAt: null });
      sendJSON(res, 500, { error: err.message || 'Failed to start process' });
    }
  });

  // POST /api/project/stop
  router.post('/api/project/stop', async (req, res) => {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { id, script } = body;
    const project = config.getProject(id);
    if (!project) {
      sendJSON(res, 404, { error: 'Project not found' });
      return;
    }

    // A manual stop must also cancel a queued auto-restart, even when the
    // project is already down (crashed + restart pending).
    supervisor.cancelPendingRestart(id);

    if (script) {
      processManager.stopServiceProcess(id, script);
    } else {
      processManager.stopAllServicesForProject(id);
      supervisor.clearMetrics(id);
      config.updateProject(id, {
        status: 'stopped',
        pid: null,
        startedAt: null,
      });
    }
    sendJSON(res, 200, withRunningServices(config.getProject(id)));
  });

  // POST /api/project/restart
  router.post('/api/project/restart', async (req, res) => {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { id, script } = body;
    const project = config.getProject(id);
    if (!project) {
      sendJSON(res, 404, { error: 'Project not found' });
      return;
    }

    try {
      supervisor.cancelPendingRestart(id);
      // With a script, only that one service is cycled; the project's other
      // running services are left alone.
      const result = script
        ? processManager.restartServiceProcess(project, script)
        : processManager.restartProjectProcess(project);
      const updated = config.updateProject(id, {
        pid: result.pid,
        startedAt: result.startedAt,
        status: 'running',
      });
      sendJSON(res, 200, withRunningServices(updated));
    } catch {
      sendJSON(res, 500, { error: 'Failed to start process' });
    }
  });

  // POST /api/project/autorestart — toggle crash auto-restart per project
  router.post('/api/project/autorestart', async (req, res) => {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { id, enabled } = body;
    const project = config.getProject(id);
    if (!project) {
      sendJSON(res, 404, { error: 'Project not found' });
      return;
    }
    if (typeof enabled !== 'boolean') {
      sendJSON(res, 400, { error: 'enabled must be a boolean' });
      return;
    }

    if (!enabled) supervisor.cancelPendingRestart(id);
    sendJSON(res, 200, config.updateProject(id, { autoRestart: enabled }));
  });

  // POST /api/project/runconfig — which script/command to run, plus extra env
  router.post('/api/project/runconfig', async (req, res) => {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { id, runScript, command, env } = body;
    const project = config.getProject(id);
    if (!project) {
      sendJSON(res, 404, { error: 'Project not found' });
      return;
    }

    const patch = {};

    if (runScript !== undefined) {
      if (runScript && !project.scripts?.includes(runScript)) {
        sendJSON(res, 400, { error: `Script "${runScript}" is not in package.json` });
        return;
      }
      patch.runScript = runScript || null;
    }

    if (command !== undefined) {
      if (command !== null && typeof command !== 'string') {
        sendJSON(res, 400, { error: 'command must be a string' });
        return;
      }
      patch.command = command && command.trim() ? command.trim() : null;
    }

    if (env !== undefined) {
      if (env !== null && (typeof env !== 'object' || Array.isArray(env))) {
        sendJSON(res, 400, { error: 'env must be an object of KEY: value pairs' });
        return;
      }
      const clean = {};
      for (const [k, v] of Object.entries(env || {})) {
        const key = String(k).trim();
        if (!key) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          sendJSON(res, 400, { error: `Invalid env variable name: ${key}` });
          return;
        }
        clean[key] = String(v ?? '');
      }
      patch.env = Object.keys(clean).length > 0 ? clean : null;
    }

    const updated = config.updateProject(id, patch);
    sendJSON(res, 200, { ...updated, restartRequired: project.status === 'running' });
  });

  // POST /api/project/deps — which projects must be up first
  router.post('/api/project/deps', async (req, res) => {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { id, dependsOn } = body;
    const project = config.getProject(id);
    if (!project) {
      sendJSON(res, 404, { error: 'Project not found' });
      return;
    }
    if (!Array.isArray(dependsOn)) {
      sendJSON(res, 400, { error: 'dependsOn must be an array of project ids' });
      return;
    }

    const all = config.getProjects();
    const ids = [...new Set(dependsOn)];
    for (const depId of ids) {
      if (depId === id) {
        sendJSON(res, 400, { error: 'A project cannot depend on itself' });
        return;
      }
      if (!all.some((p) => p.id === depId)) {
        sendJSON(res, 400, { error: `Unknown project id: ${depId}` });
        return;
      }
    }
    if (supervisor.hasDependencyCycle(id, ids)) {
      sendJSON(res, 400, { error: 'That would create a circular dependency' });
      return;
    }

    sendJSON(res, 200, config.updateProject(id, { dependsOn: ids.length > 0 ? ids : null }));
  });

  // POST /api/port/kill — free a port held by another process
  router.post('/api/port/kill', async (req, res) => {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      sendJSON(res, 400, { error: 'Invalid port' });
      return;
    }

    const holder = await findPortHolder(port);
    if (!holder) {
      sendJSON(res, 404, { error: `Nothing is listening on port ${port}` });
      return;
    }
    // 0 = System Idle, 4 = System — killing those takes the machine down
    if (holder.pid <= 4) {
      sendJSON(res, 403, { error: `Port ${port} is held by a system process (PID ${holder.pid})` });
      return;
    }
    if (holder.pid === process.pid) {
      sendJSON(res, 403, { error: 'That port belongs to this dashboard' });
      return;
    }

    try {
      processManager.killPid(holder.pid);
    } catch (err) {
      sendJSON(res, 500, { error: `Could not kill PID ${holder.pid}: ${err.message}` });
      return;
    }

    // Any project that was tracking this process is now down
    for (const p of config.getProjects()) {
      if (p.pid === holder.pid) {
        supervisor.cancelPendingRestart(p.id);
        processManager.stopProjectProcess(p.id);
        config.updateProject(p.id, { status: 'stopped', pid: null, startedAt: null });
      }
    }

    sendJSON(res, 200, { ok: true, killed: holder });
  });
}
