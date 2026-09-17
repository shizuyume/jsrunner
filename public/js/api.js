const BASE = '/api';

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Request failed: ${res.status}`);
    err.status = res.status;
    // Structured failures (e.g. PORT_IN_USE carries the holder) so callers can
    // offer a fix instead of just showing the message.
    Object.assign(err, data);
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const real = {
  getProjects: () => req('GET', '/projects'),
  getMetrics: async () => {
    // No dedicated endpoint yet; derive from the project list.
    const list = await req('GET', '/projects');
    return Object.fromEntries(list.map((p) => [p.id, { cpu: p.cpu, mem: p.mem }]));
  },
  addProject: (path, group, pm) => req('POST', '/project', { path, group, pm }),
  scanWorkspace: (path, depth) => req('POST', '/workspace/scan', { path, depth }),
  addWorkspaceServices: (services, group) => req('POST', '/workspace/add', { services, group }),
  scanScripts: (path) => req('POST', '/scripts/scan', { path }),
  addScripts: (path, scripts, group) => req('POST', '/scripts/add', { path, scripts, group }),
  startProject: (id, script) => req('POST', '/project/start', { id, script }),
  stopProject: (id, script) => req('POST', '/project/stop', { id, script }),
  restartProject: (id, script) => req('POST', '/project/restart', { id, script }),
  setAutoRestart: (id, enabled) => req('POST', '/project/autorestart', { id, enabled }),
  setRunConfig: (id, patch) => req('POST', '/project/runconfig', { id, ...patch }),
  setDeps: (id, dependsOn) => req('POST', '/project/deps', { id, dependsOn }),
  killPort: (port) => req('POST', '/port/kill', { port }),
  runScript: (id, script) => req('POST', '/project/script', { id, script }),
  install: (id) => req('POST', '/project/script', { id, script: 'install' }),
  rescanProject: (id) => req('POST', '/project/rescan', { id }),
  // Endpoints not yet specified in the BRD; drop in the contract later.
  changePort: (id, port, target) => req('POST', '/project/port', { id, port, target }),
  editPath: (id, path) => req('POST', '/project/path', { id, path }),
  deleteProject: (id) => req('DELETE', `/project/${id}`),
  fetchLogs: (id, after = 0, script) => req('GET', `/project/${id}/logs?after=${after}${script ? `&script=${encodeURIComponent(script)}` : ''}`),
  clearLogs: (id) => req('POST', `/project/${id}/logs/clear`),
  cancelScript: (id) => req('POST', '/project/script/cancel', { id }),
  editGroup: (id, group) => req('POST', '/project/group', { id, group }),
  renameGroup: (oldName, newName) => req('POST', '/group/rename', { oldName, newName }),
  deleteGroup: (name, mode) => req('POST', '/group/delete', { name, mode }),
  getProfiles: () => req('GET', '/profiles'),
  createProfile: (name, projectIds, mode) => req('POST', '/profiles', { name, projectIds, mode }),
  updateProfileById: (id, name, projectIds, mode) => req('PUT', `/profiles/${id}`, { name, projectIds, mode }),
  deleteProfile: (id) => req('DELETE', `/profiles/${id}`),
  startProfile: (id) => req('POST', `/profiles/${id}/start`),
  stopProfile: (id) => req('POST', `/profiles/${id}/stop`),
};

const call = (fn, ...args) => (real[fn](...args));

export const api = {
  getProjects: () => call('getProjects'),
  getMetrics: () => call('getMetrics'),
  addProject: (path, group, pm) => call('addProject', path, group, pm),
  scanWorkspace: (path, depth) => call('scanWorkspace', path, depth),
  addWorkspaceServices: (services, group) => call('addWorkspaceServices', services, group),
  scanScripts: (path) => call('scanScripts', path),
  addScripts: (path, scripts, group) => call('addScripts', path, scripts, group),
  startProject: (id, script) => call('startProject', id, script),
  stopProject: (id, script) => call('stopProject', id, script),
  restartProject: (id, script) => call('restartProject', id, script),
  setAutoRestart: (id, enabled) => call('setAutoRestart', id, enabled),
  setRunConfig: (id, patch) => call('setRunConfig', id, patch),
  setDeps: (id, dependsOn) => call('setDeps', id, dependsOn),
  killPort: (port) => call('killPort', port),
  runScript: (id, script) => call('runScript', id, script),
  install: (id) => call('install', id),
  rescanProject: (id) => call('rescanProject', id),
  changePort: (id, port, target) => call('changePort', id, port, target),
  editPath: (id, path) => call('editPath', id, path),
  deleteProject: (id) => call('deleteProject', id),
  fetchLogs: (id, after, script) => call('fetchLogs', id, after, script),
  clearLogs: (id) => call('clearLogs', id),
  cancelScript: (id) => call('cancelScript', id),
  editGroup: (id, group) => call('editGroup', id, group),
  renameGroup: (oldName, newName) => call('renameGroup', oldName, newName),
  deleteGroup: (name, mode) => call('deleteGroup', name, mode),
  getProfiles: () => call('getProfiles'),
  createProfile: (name, projectIds, mode) => call('createProfile', name, projectIds, mode),
  updateProfileById: (id, name, projectIds, mode) => call('updateProfileById', id, name, projectIds, mode),
  deleteProfile: (id) => call('deleteProfile', id),
  startProfile: (id) => call('startProfile', id),
  stopProfile: (id) => call('stopProfile', id),
};
