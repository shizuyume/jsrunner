// Bootstrap: initial load, header actions, polling loops, event wiring.
import { api } from './api.js';
import { icons, logoIcon } from './icons.js';
import { on, getState, getProject, setProjects, updateProject, setStatusFilter } from './state.js';
import { initTheme } from './theme.js';
import { renderGroups, startGroup, stopGroup, restartGroup } from './groups.js';
import { patchCard, startUptimeTicker } from './cards.js';
import { renderRecent } from './recent.js';
import { initProfiles, renderProfiles, refreshProfileCounts, loadProfiles } from './profiles.js';
import { initSearch } from './search.js';
import { syncLogPanel, notifyLogUpdate } from './logs.js';
import { openAddProjectDialog, openImportScriptsDialog } from './dialogs.js';
import { toastError, toastInfo } from './toast.js';
import { connectEvents } from './events.js';

const main = document.querySelector('#groups');
const recentStrip = document.querySelector('#recent');
const profileStrip = document.querySelector('#profiles');

// Structural re-render on project list / search / collapse / view changes.
on('projects', () => {
  renderGroups(main);
  renderProfiles(); // running counts on the chips
  syncLogPanel();
  refreshRunning();
});
on('project', (p) => {
  patchCard(p);
  refreshProfileCounts();
  refreshRunning();
});
on('profiles', () => renderProfiles());
on('recent', () => renderRecent(recentStrip));

// Crash / auto-restart notifications from the status poll.
on('status', ({ project, prev }) => {
  if (prev && prev.status === 'running' && project.status === 'crashed') {
    toastError(`${project.name} crashed`);
  }
  if (prev && prev.status === 'crashed' && project.status === 'running') {
    toastInfo(`${project.name} auto-restarted`);
  }
  // In status columns a card has to move lanes, which a card-level patch
  // cannot do — re-lay out the board instead.
  if (getState().view === 'kanban') renderGroups(main);
});

// The LIVE badge belongs to whichever card the log drawer is streaming.
let livePrev = null;
on('logpanel', (id) => {
  for (const pid of new Set([livePrev, id])) {
    const p = pid && getProject(pid);
    if (p) patchCard(p);
  }
  livePrev = id;
});

// Header readout: how many projects are actually serving right now.
function refreshRunning() {
  const { projects } = getState();
  const up = projects.filter((p) => p.status === 'running' && (!p.port || p.health !== 'waiting')).length;
  const el = document.querySelector('#running-count');
  if (el) el.textContent = `${up}/${projects.length} running`;
  const stopAll = document.querySelector('#stop-all');
  if (stopAll) stopAll.disabled = !projects.some((p) => (p.runningServices?.length || 0) > 0);
}

function wireHeader() {
  initTheme(document.querySelector('#theme-toggle'));
  document.querySelector('#add-project').addEventListener('click', openAddProjectDialog);
  document.querySelector('#import-scripts').addEventListener('click', openImportScriptsDialog);
  document.querySelector('#stop-all').addEventListener('click', () => stopGroup(getState().projects));
  initSearch(document.querySelector('#search'));
  initStatusFilters();
}

function initStatusFilters() {
  const container = document.querySelector('#status-filters');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const card = e.target.closest('.status-card');
    if (!card) return;
    const status = card.dataset.status;
    setStatusFilter(status === 'all' ? null : status);
    updateStatusCards();
  });

  on('projects', updateStatusCards);
  updateStatusCards();
}

function updateStatusCards() {
  const { projects, statusFilter } = getState();
  const counts = { running: 0, stopped: 0, starting: 0, crashed: 0 };
  for (const p of projects) {
    if (counts[p.status] !== undefined) counts[p.status]++;
  }

  document.querySelectorAll('#status-filters .status-card').forEach((card) => {
    const status = card.dataset.status;
    const isActive = status === 'all' ? statusFilter === null : statusFilter === status;
    card.classList.toggle('status-card--active', isActive);
    card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    const countEl = card.querySelector('.status-card__count');
    if (countEl) countEl.textContent = status === 'all' ? projects.length : (counts[status] || 0);
  });
}

// Merge a fresh project list into the store, re-rendering structurally only
// when the set of cards actually changed (avoids hover flicker).
function applyProjects(list) {
  const cur = getState().projects;
  const structural =
    list.length !== cur.length || list.some((p) => !cur.some((c) => c.id === p.id));
  if (structural) {
    setProjects(list);
  } else {
    for (const p of list) updateProject(p, { structural: false });
  }
}

async function pollStatuses() {
  try {
    applyProjects(await api.getProjects());
  } catch (err) {
    toastError(err.message);
  }
}

function setLiveIndicator(state) {
  const el = document.querySelector('#live-status');
  if (!el) return;
  el.dataset.state = state;
  el.title = state === 'live'
    ? 'Live updates via server-sent events'
    : 'Event stream unavailable — falling back to polling every 2s';
}

async function boot() {
  wireHeader();
  startUptimeTicker(() => getState().projects);
  try {
    setProjects(await api.getProjects());
  } catch (err) {
    toastError(err.message);
  }
  renderRecent(recentStrip);
  initProfiles(profileStrip);
  await loadProfiles();

  // Push instead of poll; the fallback ticker only runs if the stream drops.
  connectEvents({
    onProjects: applyProjects,
    onLogs: (batch) => notifyLogUpdate(batch.map((b) => b.id)),
    onFallbackTick: pollStatuses,
    onStatus: setLiveIndicator,
  });
}

// Icons referenced in index.html static markup are injected here to keep
// the HTML free of duplicated SVG blobs.
document.querySelector('#logo').innerHTML = logoIcon;
document.querySelector('#add-project').insertAdjacentHTML('afterbegin', icons.plus);
document.querySelector('#import-scripts').insertAdjacentHTML('afterbegin', icons.code);
document.querySelector('#stop-all').insertAdjacentHTML('afterbegin', icons.stop);
// Both glyphs live in the thumb; CSS cross-fades them on the active theme.
document.querySelector('.switch-theme__thumb').innerHTML =
  `<span class="switch-theme__sun">${icons.sun}</span><span class="switch-theme__moon">${icons.moon}</span>`;

boot();
