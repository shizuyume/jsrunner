// Central store with topic-based pub/sub.
const state = {
  projects: [],
  profiles: [], // named sets of projects that start together
  recent: [], // project ids, most recent first
  collapsed: {}, // groupName -> bool
  query: '',
  statusFilter: null, // null = all, or 'running' | 'stopped' | 'crashed' | 'starting'
  logProjectId: null,
  view: readView(), // 'list' | 'kanban' — card grid vs status columns
};

function readView() {
  try {
    return localStorage.getItem('lsr.view') === 'kanban' ? 'kanban' : 'list';
  } catch {
    return 'list';
  }
}

const listeners = new Map(); // topic -> Set<fn>

export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}

export function emit(topic, payload) {
  const set = listeners.get(topic);
  if (set) for (const fn of set) fn(payload);
}

export function getState() {
  return state;
}

export function getProject(id) {
  return state.projects.find((p) => p.id === id);
}

// Full list replace (initial load / status poll). Emits per-project diffs.
export function setProjects(list) {
  const prev = new Map(state.projects.map((p) => [p.id, p]));
  state.projects = list;
  for (const p of list) {
    const old = prev.get(p.id);
    if (!old || old.status !== p.status) emit('status', { project: p, prev: old });
  }
  emit('projects');
}

// Merge one project; 'projects' triggers structural re-render, 'project' a patch.
export function updateProject(project, { structural = true } = {}) {
  const i = state.projects.findIndex((p) => p.id === project.id);
  if (i === -1) return;
  const prev = state.projects[i];
  state.projects[i] = project;
  if (prev.status !== project.status) emit('status', { project, prev });
  emit(structural ? 'projects' : 'project', project);
}

export function patchProject(id, patch, { structural = false } = {}) {
  const p = getProject(id);
  if (p) updateProject({ ...p, ...patch }, { structural });
}

export function addProject(project) {
  state.projects.push(project);
  emit('projects');
}

export function removeProject(id) {
  state.projects = state.projects.filter((p) => p.id !== id);
  state.recent = state.recent.filter((rid) => rid !== id);
  if (state.logProjectId === id) state.logProjectId = null;
  emit('projects');
  emit('recent');
}

export function setProfiles(list) {
  state.profiles = list;
  emit('profiles');
}

export function getProfile(id) {
  return state.profiles.find((p) => p.id === id);
}

export function setQuery(q) {
  state.query = q.trim().toLowerCase();
  emit('projects');
}

export function setStatusFilter(status) {
  state.statusFilter = state.statusFilter === status ? null : status;
  emit('projects');
}

export function toggleCollapsed(group) {
  state.collapsed[group] = !state.collapsed[group];
  emit('projects');
}

export function toggleView() {
  state.view = state.view === 'list' ? 'kanban' : 'list';
  try {
    localStorage.setItem('lsr.view', state.view);
  } catch {
    /* private mode — the choice still holds for this session */
  }
  emit('projects');
}

export function addRecent(id) {
  state.recent = [id, ...state.recent.filter((r) => r !== id)].slice(0, 10);
  emit('recent');
}

export function removeRecent(id) {
  state.recent = state.recent.filter((r) => r !== id);
  emit('recent');
}

export function setLogProject(id) {
  state.logProjectId = id;
  emit('logpanel', id);
}

export function matchesQuery(p) {
  if (state.statusFilter && p.status !== state.statusFilter) return false;
  if (!state.query) return true;
  const hay = [p.name, p.folder, String(p.port ?? ''), p.framework, p.group ?? '', p.pm]
    .join(' ')
    .toLowerCase();
  return hay.includes(state.query);
}
