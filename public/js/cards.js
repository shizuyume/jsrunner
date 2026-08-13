// Project card: render + patch + all card-level actions.
import { api } from './api.js';
import { icons } from './icons.js';
import { toastError, toastSuccess, toastInfo } from './toast.js';
import { getState, getProject, updateProject, patchProject, addProject, addRecent } from './state.js';
import { openLogPanel, closeLogPanel } from './logs.js';
import {
  openChangePortDialog, openEditPathDialog, openDeleteDialog, openMoveGroupDialog,
  openRunSettingsDialog, openDependenciesDialog, openPortConflictDialog,
} from './dialogs.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_LABEL = { running: 'Running', stopped: 'Stopped', crashed: 'Crashed', starting: 'Starting…' };

const blocking = new Map(); // projectId -> 'install' | 'build' | undefined
const clickLock = new Set(); // `${projectId}:${script}` in-flight click keys

// A running process whose port is not answering yet is still starting up as far
// as the user is concerned — that is what the health probe is for.
function displayStatus(p) {
  const task = blocking.get(p.id);
  if (task) return { key: task === 'install' ? 'installing' : 'building', label: task === 'install' ? 'Installing…' : 'Building…' };
  if (p.status === 'running' && p.port && p.health === 'waiting') {
    return { key: 'starting', label: 'Starting…' };
  }
  return { key: p.status, label: STATUS_LABEL[p.status] ?? p.status };
}

// Anything mid-flight reads as amber and gets the sweeping progress bar.
const BUSY_KEYS = new Set(['starting', 'installing', 'building']);

// Card border, glow and status hue all come off one attribute.
function applyCardState(el, p) {
  const shown = displayStatus(p);
  el.dataset.state = BUSY_KEYS.has(shown.key) ? 'busy' : shown.key;
}

// Is the log drawer currently streaming this project?
const isLive = (id) => getState().logProjectId === id;

// What Start will actually run
function runLabel(p) {
  if (p.command) return p.command;
  if (p.runScript) return `${p.pm} ${p.runScript}`;
  return null;
}

// Dependency names, falling back to the id for a project that vanished
function depNames(p) {
  return (p.dependsOn || []).map((id) => getProject(id)?.name || id).join(', ');
}

export function formatUptime(startedAt) {
  if (!startedAt) return '—';
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function metaRow(label, value, dataAttr, id, title, html) {
  const val = value ?? '—';
  const titleAttr = title ? ` title="${esc(title)}"` : '';
  return `<div><dt>${label}</dt><dd${dataAttr ? ` data-${dataAttr}="${id}"` : ''}${titleAttr}>${html ?? esc(val)}</dd></div>`;
}

export function renderCard(p) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = p.id;
  if (p.color) {
    el.dataset.color = p.color;
    el.style.setProperty('--card-color', p.color);
  }
  applyCardState(el, p);
  el.innerHTML = cardHtml(p);
  wire(el, p);
  return el;
}

function cardHtml(p) {
  const running = p.status === 'running';
  const busy = p.status === 'starting';
  const fw = p.framework.toLowerCase();
  const services = p.runningServices || [];
  const block = blocking.get(p.id);
  const anyRunning = services.length > 0;
  const runningParent = services.some((s) => s.script === 'dev' || s.script === 'start');
  const serviceRunning = anyRunning && !runningParent;
  const isParentScript = (s) => s === 'dev' || s === 'start';
  const scriptDisabled = (s) => busy || !!block || runningParent || (serviceRunning && isParentScript(s)) || services.some((x) => x.script === s);
  const actionDisabled = busy || !!block || anyRunning;
  const VISIBLE_SCRIPT = (s) => s === 'dev' || s === 'start' || s.startsWith('dev:') || s.startsWith('start:');
  const visibleScripts = p.scripts.filter(VISIBLE_SCRIPT);
  const shown = displayStatus(p);
  // Process is up but the port is not answering yet — restarting now would just
  // cycle a boot that has not finished, so Restart waits for "running".
  const settling = shown.key === 'starting';
  const deps = p.dependsOn?.length || 0;
  const run = runLabel(p);
  const live = isLive(p.id);
  // Nothing to launch means Start would only produce a server-side error.
  const canStart = !!(p.command || p.runScript || p.scripts?.length);
  const portCell = p.port
    ? `<a href="${esc(p.url || `http://localhost:${p.port}`)}" target="_blank" rel="noopener">${p.port}</a>`
    : '—';
  return `
    ${BUSY_KEYS.has(shown.key) ? '<span class="card__sweep" aria-hidden="true"></span>' : ''}
    <div class="card__head">
      <span class="status status--${shown.key}">
        <span class="status__dot"></span>${shown.label}
      </span>
      ${live ? '<span class="tag tag--live" title="Streaming logs in the drawer">● LIVE</span>' : ''}
      ${p.adopted ? '<span class="tag tag--warn" title="Re-attached after a server restart — live logs are not available until you restart this service">re-attached</span>' : ''}
      ${p.color ? `<span class="card__color" title="Project colour"></span>` : ''}
    </div>
    <h3 class="card__name" title="${esc(p.name)}">${esc(p.name)}</h3>
    <div class="card__badges">
      <span class="badge badge--${esc(fw)}">${esc(p.framework)}</span>
      <span class="badge badge--pm">${esc(p.pm)}</span>
    </div>
    <dl class="card__meta">
      ${metaRow('Folder', p.folder, null, null, p.folder)}
      ${metaRow('Port', p.port ?? 'n/a', null, null, p.port ? `Open ${p.url || `http://localhost:${p.port}`}` : null, portCell)}
      ${metaRow('PID', running ? p.pid : null, 'pid', p.id)}
      ${metaRow('Uptime', running ? formatUptime(p.startedAt) : null, 'uptime', p.id)}
      ${metaRow('CPU', running ? `${p.cpu ?? '0.0'}%` : null, 'cpu', p.id, 'Whole process tree (cmd → npm → node)')}
      ${metaRow('Memory', running ? `${p.mem ?? '0'} MB` : null, 'mem', p.id, 'Working set of the whole process tree')}
      ${run ? metaRow('Runs', run, null, null, 'Configured in Run Settings') : ''}
      ${deps > 0 ? metaRow('Needs', depNames(p), null, null, 'Started and awaited before this project') : ''}
    </dl>
    <div class="card__actions">
      ${running
        ? `<button class="btn btn--primary-stop card__primary" data-act="stop">${icons.stop} Stop</button>`
        : busy || !!block
          ? `<button class="btn card__primary" disabled><span class="btn__spinner"></span> ${esc(shown.label)}</button>`
          : `<button class="btn btn--primary-start card__primary" data-act="start"
              ${canStart ? '' : 'disabled title="No dev/start script — set one in Run settings"'}>${icons.play} Start</button>`}
      <button class="btn" data-act="restart"
        ${running ? (settling ? 'disabled title="Still starting up"' : '') : p.status === 'crashed' ? '' : 'disabled'}>${icons.restart} Restart</button>
      <button class="btn" data-act="install" ${actionDisabled ? 'disabled' : ''}>${icons.install} Install</button>
      <button class="btn" data-act="build" ${actionDisabled ? 'disabled' : ''}>${icons.build} Build</button>
    </div>
    ${visibleScripts.length ? `
    <div class="card__scripts">
      <span class="card__label">Scripts</span>
      <div class="card__chips">
        ${visibleScripts.map((s) => `<button class="script-chip${services.some((x) => x.script === s) ? ' script-chip--active' : ''}"
          data-script="${esc(s)}" ${scriptDisabled(s) ? 'disabled' : ''}>${esc(s)}</button>`).join('')}
      </div>
    </div>` : ''}
    <div class="card__footer">
      <button class="btn btn--icon" data-act="group" title="Move to group">${icons.folder}</button>
      <button class="btn btn--icon" data-act="runsettings" title="Run settings — script, command, env">${icons.sliders}</button>
      ${p.url ? `<a class="btn btn--icon" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open ${esc(p.url)}">${icons.external}</a>` : ''}
      <button class="btn btn--icon ${deps > 0 ? 'btn--active' : ''}" data-act="deps"
        title="${deps > 0 ? `Starts after: ${esc(depNames(p))}` : 'Set start dependencies'}">${icons.link}</button>
      <button class="btn btn--icon ${p.autoRestart ? 'btn--active' : ''}" data-act="autorestart"
        title="Auto restart on crash: ${p.autoRestart ? 'ON' : 'OFF'}"
        aria-pressed="${p.autoRestart ? 'true' : 'false'}">${icons.shield}</button>
      <button class="btn btn--icon" data-act="logs" title="View logs">${icons.terminal}</button>
      <button class="btn btn--icon" data-act="port" title="Change port">${icons.port}</button>
      <button class="btn btn--icon" data-act="rescan" title="Rescan package.json">${icons.refresh}</button>
      <button class="btn btn--icon" data-act="edit" title="Edit path">${icons.edit}</button>
      <button class="btn btn--icon btn--danger card__delete" data-act="delete" title="Delete project">${icons.trash}</button>
    </div>
    ${p.subProjects?.length > 0 ? `
    <div class="card__subprojects">
      <span class="card__subprojects-label">Sub-projects</span>
      ${p.subProjects.map(sp => `
        <div class="card__subproject">
          <span>${esc(sp.name)}</span>
          <span class="card__subproject-port">${sp.port ?? 'n/a'}</span>
          <button class="btn btn--sm" data-act="port-sub" data-target="${esc(sp.name)}">Port</button>
          <button class="btn btn--sm" data-act="promote-sub" data-path="${esc(sp.path)}" data-name="${esc(sp.name)}"
            title="Add as its own card so it can be started, logged and monitored separately">+ Card</button>
        </div>`).join('')}
    </div>` : ''}`;
}

// Replace card content in place (status/actions changed).
export function patchCard(p) {
  const el = document.querySelector(`.card[data-id="${p.id}"]`);
  if (!el) return;
  applyCardState(el, p);
  el.innerHTML = cardHtml(p);
}

async function run(id, action, { optimistic, success, recent = false } = {}) {
  if (optimistic) patchProject(id, optimistic);
  try {
    const updated = await action();
    if (updated) updateProject(updated, { structural: false });
    if (recent) addRecent(id);
    if (success) toastSuccess(success);
    return updated;
  } catch (err) {
    toastError(err.message);
    // Roll back an optimistic "starting" state on failure.
    if (optimistic) patchProject(id, { status: 'stopped' });
    return null;
  }
}

/**
 * Start one script straight away — no confirmation modal. A port conflict is
 * the only thing that opens a dialog, because it needs a decision (kill the
 * holder or not) before the start can succeed.
 */
function startScript(id, script) {
  const send = () => {
    patchProject(id, { status: 'starting' }, { structural: false });
    return api.startProject(id, script)
      .then((updated) => { if (updated) updateProject(updated, { structural: false }); })
      .catch((err) => {
        // Drop the optimistic "starting" first: the conflict dialog can be
        // cancelled, and a card must not be left spinning forever.
        patchProject(id, { status: 'stopped' });
        if (err.code === 'PORT_IN_USE') {
          openPortConflictDialog(id, err, send);
          return;
        }
        toastError(err.message);
      });
  };
  send();
}

function withSpinner(btn, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="btn__spinner"></span>`;
  return fn().finally(() => {
    btn.disabled = false;
    btn.innerHTML = original;
  });
}

function wire(el, p) {
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const script = btn.dataset.script;

    if (script && !act) {
      const lockKey = `${p.id}:${script}`;
      if (clickLock.has(lockKey)) return;
      clickLock.add(lockKey);
      setTimeout(() => clickLock.delete(lockKey), 400);
      // Scripts section only contains dev/start/dev:*/start:* (filtered in cardHtml)
      // and a script that is already running is rendered disabled — so a click
      // here always means "start this script". No detail modal in between.
      startScript(p.id, script);
      return;
    }

    switch (act) {
      case 'start':
        // No script argument: the server picks the default (dev > start > first).
        startScript(p.id);
        break;
      case 'stop':
        run(p.id, () => api.stopProject(p.id));
        break;
      case 'stop-service':
        run(p.id, () => api.stopProject(p.id, btn.dataset.script));
        break;
      case 'restart-service':
        run(p.id, () => api.restartProject(p.id, btn.dataset.script), {
          success: `${btn.dataset.script} restarted`,
        });
        break;
      case 'service-logs':
        openLogPanel(p.id, btn.dataset.script);
        break;
      case 'restart':
        run(p.id, () => api.restartProject(p.id), {
          optimistic: { status: 'starting' },
          recent: true,
        });
        break;
      case 'install':
        blocking.set(p.id, 'install');
        patchCard(p);
        withSpinner(btn, () =>
          api.install(p.id)
            .then(() => toastSuccess('Dependencies installed'))
            .catch((err) => toastError(err.message))
            .finally(() => { blocking.delete(p.id); patchCard(p); })
        );
        break;
      case 'build':
        blocking.set(p.id, 'build');
        patchCard(p);
        withSpinner(btn, () =>
          api.runScript(p.id, 'build')
            .then(() => toastSuccess('Build finished'))
            .catch((err) => toastError(err.message))
            .finally(() => { blocking.delete(p.id); patchCard(p); })
        );
        break;
      case 'rescan':
        withSpinner(btn, () =>
          run(p.id, () => api.rescanProject(p.id), { success: 'Project rescanned' })
        );
        break;
      case 'runsettings':
        openRunSettingsDialog(p.id);
        break;
      case 'deps':
        openDependenciesDialog(p.id);
        break;
      case 'autorestart': {
        // Read from the store: `p` is the snapshot from render time
        const next = !getProject(p.id)?.autoRestart;
        run(p.id, () => api.setAutoRestart(p.id, next), {
          success: `Auto restart ${next ? 'enabled' : 'disabled'} for ${p.name}`,
        });
        break;
      }
      case 'logs':
        openLogPanel(p.id);
        break;

      case 'port':
        openChangePortDialog(p.id);
        break;
      case 'port-sub':
        openChangePortDialog(p.id, btn.dataset.target);
        break;
      case 'promote-sub': {
        const { path, name } = btn.dataset;
        withSpinner(btn, () =>
          api.addProject(path, p.group || undefined)
            .then((project) => { addProject(project); toastSuccess(`"${name}" added as its own card`); })
            .catch((err) => toastError(err.message))
        );
        break;
      }
      case 'edit':
        openEditPathDialog(p.id);
        break;
      case 'group':
        openMoveGroupDialog(p.id);
        break;
      case 'delete':
        openDeleteDialog(p.id);
        break;
    }
  });

}


// Called once from main.js: ticks uptime every second for running projects.
export function startUptimeTicker(getProjects) {
  setInterval(() => {
    for (const p of getProjects()) {
      if (p.status !== 'running') continue;
      const dd = document.querySelector(`[data-uptime="${p.id}"]`);
      if (dd) dd.textContent = formatUptime(p.startedAt);
    }
  }, 1000);
}
