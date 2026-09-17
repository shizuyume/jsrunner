import { spawnShell, killTree } from './platform/index.mjs';
import * as logger from './logger.mjs';

// Map<projectId, { child, pid, script, startedAt, running }>
const runners = new Map();

/**
 * Run a one-shot script command in background (fire-and-forget).
 * Returns immediately with { pid, status, script }.
 * On completion/cancellation: entry removed from map, log pushed.
 */
export function runScript(project, script, command) {
  const { id } = project;

  // Don't double-start
  const existing = runners.get(id);
  if (existing && existing.running) {
    return { pid: existing.pid, status: 'running', script: existing.script };
  }

  const child = spawnShell(command, {
    cwd: project.folder,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry = {
    child,
    pid: child.pid,
    script,
    startedAt: Date.now(),
    running: true,
  };

  runners.set(id, entry);

  child.stdout.on('data', (d) => {
    logger.pushLog(id, d.toString());
  });
  child.stderr.on('data', (d) => {
    logger.pushLog(id, d.toString(), true);
  });

  child.on('close', (code) => {
    // Guard: already cleaned up by cancelScript
    if (!entry.running) return;
    entry.running = false;
    runners.delete(id);

    if (code === 0) {
      logger.pushLog(id, `[runner] script "${script}" finished successfully`);
    } else {
      logger.pushLog(id, `[runner] script "${script}" exited with code ${code}`, true);
    }
  });

  child.on('error', (err) => {
    entry.running = false;
    runners.delete(id);
    logger.pushLog(id, `[runner] script "${script}" error: ${err.message}`, true);
  });

  return { pid: child.pid, status: 'running', script };
}

/**
 * Cancel a running script, taking its whole process tree with it.
 * Returns true if a script was running, false otherwise.
 */
export function cancelScript(id) {
  const entry = runners.get(id);
  if (!entry || !entry.running) return false;

  entry.running = false;
  runners.delete(id);

  try {
    killTree(entry.pid);
  } catch {
    try { entry.child.kill(); } catch { /* give up */ }
  }

  logger.pushLog(id, `[runner] script "${entry.script}" cancelled`);
  return true;
}

/**
 * Get the running script name for a project, or null if not running.
 */
export function getRunningScript(id) {
  const entry = runners.get(id);
  if (!entry || !entry.running) return null;
  return entry.script;
}

/**
 * Check whether a script is currently running for a project.
 */
export function isScriptRunning(id) {
  const entry = runners.get(id);
  return !!(entry && entry.running);
}
