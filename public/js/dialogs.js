// Modal dialogs: Add Project, Change Port, Edit Path, Delete confirm.
// ESC and backdrop click close; focus returns to the opener.
import { api } from './api.js';
import { icons } from './icons.js';
import { toastError, toastSuccess } from './toast.js';
import { getProject, updateProject, addProject, removeProject, getState } from './state.js';
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function openModal({ title, bodyHtml, actions, onOpen, wide = false }) {
  const opener = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal__header">
        <span class="modal__title">${title}</span>
        <button class="btn btn--sm btn--icon" data-mact="close" title="Close">${icons.x}</button>
      </div>
      <div class="modal__body">${bodyHtml}</div>
      <div class="modal__footer"></div>
    </div>`;

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    opener?.focus?.();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    // Escape in a non-empty search box clears the search first. This lives here
    // because this listener is on document in capture phase — a handler on the
    // input itself could never run before it.
    const el = e.target;
    if (el instanceof HTMLInputElement && el.type === 'search' && el.value) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    close();
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('[data-mact="close"]').addEventListener('click', close);

  const footer = backdrop.querySelector('.modal__footer');
  const setActions = (list) => {
    footer.innerHTML = '';
    for (const a of list) {
      const btn = document.createElement('button');
      btn.className = `btn ${a.primary ? 'btn--primary' : ''} ${a.danger ? 'btn--danger' : ''}`;
      btn.textContent = a.label;
      btn.addEventListener('click', () => a.onClick({ backdrop, close, btn }));
      footer.appendChild(btn);
    }
  };
  setActions(actions);

  // Swap body + footer in place — used by multi-step dialogs (Add Project)
  const setStep = ({ title: newTitle, bodyHtml: html, actions: acts, onOpen: after }) => {
    if (newTitle) backdrop.querySelector('.modal__title').textContent = newTitle;
    backdrop.querySelector('.modal__body').innerHTML = html;
    setActions(acts);
    after?.(backdrop);
  };

  document.body.appendChild(backdrop);
  onOpen?.(backdrop);
  return { backdrop, close, setStep };
}

const field = (label, inner) => `
  <label class="field">
    <span class="field__label">${label}</span>
    ${inner}
  </label>`;

const input = (name, value = '', placeholder = '') =>
  `<input class="field__input" name="${name}" value="${value}" placeholder="${placeholder}" spellcheck="false">`;

function busy(btn, label) {
  btn.disabled = true;
  btn.innerHTML = `<span class="btn__spinner"></span> ${label}`;
}

function setError(backdrop, msg) {
  const el = backdrop.querySelector('.field__error');
  const inputEl = backdrop.querySelector('.field__input, .field__combobox, .field__select');
  if (el) el.textContent = msg ?? '';
  inputEl?.classList.toggle('field__input--error', Boolean(msg));
}

// ---------- Searchable checkbox list ----------
// Shared by the workspace scan picker, the dependency picker and the profile
// picker: same markup contract, same filtering semantics.

const searchBox = (placeholder) =>
  `<div class="scan__search-row">
    <input class="field__input scan__search" type="search" spellcheck="false" placeholder="${placeholder}">
  </div>`;

/** Lowercased haystack for a row's data-search attribute. */
const haystack = (...parts) => parts.filter(Boolean).join(' ').toLowerCase();

/**
 * Filter a `.scan__list` from a `.scan__search` box.
 *
 * Rows carry `data-search`; multiple space-separated terms must all match.
 * Selection deliberately survives filtering — searching is how you build a
 * selection in several passes — so bulk actions act on visible rows only and
 * the count reports both numbers.
 *
 * @param {HTMLElement} backdrop
 * @param {{checkSelector: string, headingSelector?: string, countSelected?: () => number}} opts
 */
function wireListSearch(backdrop, { checkSelector, headingSelector = null, countSelected = null }) {
  const rowSelector = '.scan__item';
  const rows = [...backdrop.querySelectorAll(rowSelector)];
  const checks = [...backdrop.querySelectorAll(`${checkSelector}:not([disabled])`)];
  const headings = headingSelector ? [...backdrop.querySelectorAll(headingSelector)] : [];
  const searchEl = backdrop.querySelector('.scan__search');
  const countEl = backdrop.querySelector('.scan__count');
  const emptyEl = backdrop.querySelector('.scan__empty');

  const visibleChecks = () => checks.filter((c) => !c.closest(rowSelector).hidden);

  const sync = () => {
    if (!countEl) return;
    const n = countSelected ? countSelected() : checks.filter((c) => c.checked).length;
    const shown = rows.filter((r) => !r.hidden).length;
    countEl.textContent = shown === rows.length
      ? `${n} selected`
      : `${n} selected · ${shown} of ${rows.length} shown`;
  };

  const applyFilter = () => {
    const query = searchEl.value.trim();
    const terms = query ? query.toLowerCase().split(/\s+/) : [];
    for (const row of rows) {
      row.hidden = terms.some((t) => !row.dataset.search.includes(t));
    }

    // A group heading with nothing left under it is just noise
    for (const heading of headings) {
      let el = heading.nextElementSibling;
      let any = false;
      while (el && !el.matches(headingSelector)) {
        if (el.matches(rowSelector) && !el.hidden) {
          any = true;
          break;
        }
        el = el.nextElementSibling;
      }
      heading.hidden = !any;
    }

    const shown = rows.filter((r) => !r.hidden).length;
    if (emptyEl) {
      emptyEl.hidden = shown > 0;
      emptyEl.textContent = `No matches for "${query}"`;
    }
    sync();
  };

  checks.forEach((c) => c.addEventListener('change', sync));
  searchEl.addEventListener('input', applyFilter);
  sync();

  return { searchEl, rows, checks, visibleChecks, sync, applyFilter };
}

// Wire group select/input toggle — select always visible
function wireGroupPicker(backdrop) {
  const sel = backdrop.querySelector('[name$="-select"]');
  const inp = backdrop.querySelector('[name="group"]');
  if (!sel || !inp) return;
  const toggle = () => {
    inp.style.display = sel.value === '__new__' ? '' : 'none';
    if (sel.value === '__new__') inp.focus(); else inp.value = '';
  };
  sel.addEventListener('change', toggle);
  toggle();
}

// Get final group value from picker
function groupValue(backdrop) {
  const sel = backdrop.querySelector('[name$="-select"]');
  const inp = backdrop.querySelector('[name="group"]');
  if (sel.value === '__new__') return inp?.value.trim() || '';
  return sel.value;
}

// Group picker: select existing + text input for new group (select always visible)
function groupInput(name, value = '') {
  const groups = [...new Set(getState().projects.map(p => p.group).filter(Boolean))].sort();
  const opts = groups.map(g => `<option value="${g}" ${value === g ? 'selected' : ''}>${g}</option>`).join('');
  const isNew = value && !groups.includes(value);
  return `
    <select class="field__input field__select" name="${name}-select">
      <option value="">— Ungrouped —</option>
      ${opts}
      <option value="__new__" ${isNew ? 'selected' : ''}>+ New group…</option>
    </select>
    <input class="field__input field__input--group-new" name="${name}" value="${isNew ? value : ''}"
      placeholder="Type new group name…" spellcheck="false" style="${isNew ? '' : 'display:none'};margin-top:8px">`;
}

// ---------- Add Project ----------
// Step 1: point at a folder/workspace. Step 2: pick which services to add.
export function openAddProjectDialog() {
  const modal = openModal({
    title: 'Add Project',
    wide: true,
    bodyHtml:
      field('Project / workspace folder', input('path', '', 'D:/Works/Neuron/my-workspace')) +
      field('Scan depth', `
        <select class="field__input field__select" name="depth">
          <option value="1">1 level — direct sub-folders</option>
          <option value="2">2 levels</option>
          <option value="3" selected>3 levels (recommended)</option>
          <option value="4">4 levels — slower</option>
        </select>`) +
      '<p class="modal__hint">Every <code>package.json</code> inside the folder is detected as a service. ' +
      'You choose which ones to add on the next step.</p>' +
      '<span class="field__error"></span>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Scan Folder',
        primary: true,
        onClick: ({ backdrop, btn }) => runScan(backdrop, btn),
      },
    ],
    onOpen: (b) => {
      const inp = b.querySelector('[name="path"]');
      inp.focus();
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') b.querySelector('.modal__footer .btn--primary')?.click();
      });
    },
  });

  async function runScan(backdrop, btn) {
    const path = backdrop.querySelector('[name="path"]').value.trim();
    if (!path) return setError(backdrop, 'Folder path is required');
    const depth = Number(backdrop.querySelector('[name="depth"]').value);
    busy(btn, 'Scanning…');
    try {
      const result = await api.scanWorkspace(path, depth);
      showPicker(result, path, depth);
    } catch (err) {
      setError(backdrop, err.message);
      toastError(err.message);
      btn.disabled = false;
      btn.textContent = 'Scan Folder';
    }
  }

  function showPicker(result, path, depth) {
    const selectable = result.services.filter((s) => !s.added);

    modal.setStep({
      title: `Add Services — ${result.name}`,
      bodyHtml:
        `<div class="scan__summary">
          <span class="scan__root" title="${esc(result.root)}">${esc(result.root)}</span>
          <span>${result.services.length} service${result.services.length === 1 ? '' : 's'} found ·
            ${selectable.length} available${result.truncated ? ' · scan truncated' : ''}</span>
        </div>` +
        searchBox('Search name, folder, framework, port, script…') +
        `<div class="scan__toolbar">
          <button class="btn btn--sm" data-sact="all">Select all</button>
          <button class="btn btn--sm" data-sact="none">Select none</button>
          <button class="btn btn--sm" data-sact="runnable">Only runnable</button>
          <span class="scan__count"></span>
        </div>` +
        `<div class="scan__list">${result.services.map(serviceRow).join('')}
          <span class="scan__empty" hidden></span>
        </div>` +
        field('Group for added services', groupInput('group', result.name)) +
        '<span class="field__error"></span>',
      actions: [
        { label: 'Back', onClick: () => modal.setStep(step1(path, depth)) },
        {
          label: 'Add Selected',
          primary: true,
          onClick: async ({ backdrop, close, btn }) => {
            const picked = [...backdrop.querySelectorAll('.scan__check:checked')].map((c) => c.value);
            if (picked.length === 0) return setError(backdrop, 'Select at least one service');
            const group = groupValue(backdrop);
            busy(btn, `Adding ${picked.length}…`);
            try {
              const { added, skipped } = await api.addWorkspaceServices(picked, group || undefined);
              added.forEach(addProject);
              toastSuccess(`${added.length} service${added.length === 1 ? '' : 's'} added`);
              if (skipped.length) toastError(`${skipped.length} skipped: ${skipped[0].reason}`);
              close();
            } catch (err) {
              setError(backdrop, err.message);
              toastError(err.message);
              btn.disabled = false;
              btn.textContent = 'Add Selected';
            }
          },
        },
      ],
      onOpen: (b) => {
        wireGroupPicker(b);
        const { visibleChecks, sync, searchEl } = wireListSearch(b, { checkSelector: '.scan__check' });

        // Bulk actions act on what is currently visible — that is the point of
        // filtering first ("show me *-service, then take all of them").
        b.querySelector('[data-sact="all"]').addEventListener('click', () => {
          visibleChecks().forEach((c) => { c.checked = true; });
          sync();
        });
        b.querySelector('[data-sact="none"]').addEventListener('click', () => {
          visibleChecks().forEach((c) => { c.checked = false; });
          sync();
        });
        b.querySelector('[data-sact="runnable"]').addEventListener('click', () => {
          visibleChecks().forEach((c) => { c.checked = c.dataset.runnable === '1'; });
          sync();
        });

        searchEl.focus();
      },
    });
  }

  // Rebuilt lazily so "Back" keeps whatever the user typed
  function step1(path, depth) {
    return {
      title: 'Add Project',
      bodyHtml:
        field('Project / workspace folder', input('path', esc(path), 'D:/Works/Neuron/my-workspace')) +
        field('Scan depth', `
          <select class="field__input field__select" name="depth">
            ${[1, 2, 3, 4].map((d) => `<option value="${d}" ${d === depth ? 'selected' : ''}>${d} level${d === 1 ? '' : 's'}</option>`).join('')}
          </select>`) +
        '<span class="field__error"></span>',
      actions: [
        { label: 'Cancel', onClick: ({ close }) => close() },
        { label: 'Scan Folder', primary: true, onClick: ({ backdrop, btn }) => runScan(backdrop, btn) },
      ],
      onOpen: (b) => b.querySelector('[name="path"]').focus(),
    };
  }
}

// One row in the scan result list
function serviceRow(s) {
  const badges = [
    s.framework && s.framework !== 'Unknown' ? `<span class="scan__badge">${esc(s.framework)}</span>` : '',
    `<span class="scan__badge">${esc(s.pm)}</span>`,
    s.port ? `<span class="scan__badge">:${s.port}</span>` : '',
    s.workspaces ? '<span class="scan__badge scan__badge--info">monorepo root</span>' : '',
    s.runnable ? '' : '<span class="scan__badge scan__badge--muted">no run script</span>',
    s.added ? '<span class="scan__badge scan__badge--muted">already added</span>' : '',
  ].join('');

  const search = haystack(
    s.name,
    s.relative,
    s.isRoot ? 'root' : '',
    s.framework,
    s.pm,
    s.port ?? '',
    ...(s.scripts || [])
  );

  const checked = !s.added && s.runnable ? 'checked' : '';
  return `
    <label class="scan__item ${s.added ? 'scan__item--disabled' : ''}" data-search="${esc(search)}">
      <input type="checkbox" class="scan__check" value="${esc(s.path)}"
        data-runnable="${s.runnable ? 1 : 0}" ${checked} ${s.added ? 'disabled' : ''}>
      <span class="scan__info">
        <span class="scan__name">${esc(s.name)}</span>
        <span class="scan__path">${s.isRoot ? 'root folder' : esc(s.relative)}</span>
        <span class="scan__badges">${badges}</span>
      </span>
    </label>`;
}

// ---------- Profile (create / edit) ----------
// A profile is a named set of projects that start together, across groups.
export function openProfileDialog(profile = null) {
  const editing = Boolean(profile);
  const selected = new Set(profile?.projectIds || []);
  const projects = [...getState().projects];

  if (projects.length === 0) {
    openModal({
      title: 'New Profile',
      bodyHtml: '<p>Add some projects first — a profile is a set of projects that start together.</p>',
      actions: [{ label: 'Close', primary: true, onClick: ({ close }) => close() }],
    });
    return;
  }

  // Grouped so picking across groups is obvious
  const byGroup = new Map();
  for (const p of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    const key = p.group || 'Ungrouped';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(p);
  }
  const sections = [...byGroup.entries()].sort(([a], [b]) =>
    a === 'Ungrouped' ? 1 : b === 'Ungrouped' ? -1 : a.localeCompare(b)
  );

  // Selection order is the start order; edit keeps whatever was saved
  const order = (profile?.projectIds || []).filter((id) => projects.some((p) => p.id === id));
  const mode = profile?.mode === 'sequential' ? 'sequential' : 'parallel';

  openModal({
    title: editing ? `Edit Profile — ${profile.name}` : 'New Profile',
    wide: true,
    bodyHtml:
      field('Profile name', input('name', esc(profile?.name || ''), 'e.g. POS demo')) +
      field('Start mode',
        `<select class="field__input field__select" name="mode">
          <option value="parallel" ${mode === 'parallel' ? 'selected' : ''}>Parallel — start everything at once</option>
          <option value="sequential" ${mode === 'sequential' ? 'selected' : ''}>Sequential — one at a time, in order</option>
        </select>`) +
      '<p class="modal__hint" data-mode-hint></p>' +
      searchBox('Search project, group, framework, port…') +
      `<div class="scan__toolbar">
        <span class="field__label">Projects</span>
        <button class="btn btn--sm" data-pfact="all" type="button">Select all</button>
        <button class="btn btn--sm" data-pfact="none" type="button">Clear all</button>
        <span class="scan__count"></span>
      </div>` +
      `<div class="scan__list">${sections.map(([group, list]) => `
        <div class="profile__group">${esc(group)}</div>
        ${list.map((p) => `
          <label class="scan__item" data-search="${esc(haystack(p.name, p.group || 'ungrouped', p.framework, p.pm, p.port ?? 'no port'))}">
            <input type="checkbox" class="pf__check scan__check" value="${esc(p.id)}" ${selected.has(p.id) ? 'checked' : ''}>
            <span class="scan__info">
              <span class="scan__name">${esc(p.name)}</span>
              <span class="scan__badges">
                <span class="badge badge--${esc(p.framework.toLowerCase())}">${esc(p.framework)}</span>
                ${p.port ? `<span class="scan__port">:${p.port}</span>` : '<span class="scan__badge scan__badge--muted">no port</span>'}
                ${p.dependsOn?.length ? `<span class="scan__badge scan__badge--info">${p.dependsOn.length} dep${p.dependsOn.length === 1 ? '' : 's'}</span>` : ''}
              </span>
            </span>
          </label>`).join('')}`).join('')}
        <span class="scan__empty" hidden></span>
      </div>` +
      '<div class="order" data-order-wrap>' +
        '<span class="field__label">Start order</span>' +
        '<div class="order__list" data-order-list></div>' +
      '</div>' +
      '<span class="field__error"></span>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: editing ? 'Save' : 'Create',
        primary: true,
        onClick: async ({ backdrop, close, btn }) => {
          const name = backdrop.querySelector('[name="name"]').value.trim();
          if (!name) return setError(backdrop, 'Profile name is required');
          if (order.length === 0) return setError(backdrop, 'Select at least one project');
          const chosenMode = backdrop.querySelector('[name="mode"]').value;

          busy(btn, 'Saving…');
          try {
            if (editing) {
              await api.updateProfileById(profile.id, name, order, chosenMode);
              toastSuccess(`Profile "${name}" updated`);
            } else {
              await api.createProfile(name, order, chosenMode);
              toastSuccess(`Profile "${name}" created`);
            }
            close();
            const { loadProfiles } = await import('./profiles.js');
            await loadProfiles();
          } catch (err) {
            setError(backdrop, err.message);
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = editing ? 'Save' : 'Create';
          }
        },
      },
    ],
    onOpen: (b) => {
      const listEl = b.querySelector('[data-order-list]');
      const wrapEl = b.querySelector('[data-order-wrap]');
      const hintEl = b.querySelector('[data-mode-hint]');
      const modeEl = b.querySelector('[name="mode"]');
      const nameOf = (id) => projects.find((p) => p.id === id)?.name || id;

      // The count comes from the ordered selection, not the checkbox states —
      // they agree, but `order` is the thing that gets saved.
      const search = wireListSearch(b, {
        checkSelector: '.pf__check',
        headingSelector: '.profile__group',
        countSelected: () => order.length,
      });
      const checks = search.checks;

      const renderOrder = () => {
        const sequential = modeEl.value === 'sequential';
        search.sync();

        hintEl.innerHTML = sequential
          ? 'Each service must be <strong>ready</strong> (its port answering) before the next one starts. ' +
            'A service without a port cannot be probed, so the next one follows immediately.'
          : 'Everything starts at once. Dependencies are still honoured — a member waits only for ' +
            'the projects it actually depends on.';

        wrapEl.classList.toggle('order--inactive', !sequential);
        listEl.replaceChildren();

        if (order.length === 0) {
          const empty = document.createElement('span');
          empty.className = 'order__empty';
          empty.textContent = 'Nothing selected yet.';
          listEl.appendChild(empty);
          return;
        }

        order.forEach((id, i) => {
          const row = document.createElement('div');
          row.className = 'order__row';
          row.draggable = true;
          row.dataset.index = String(i);
          row.innerHTML = `
            <span class="order__grip" aria-hidden="true">⠿</span>
            <span class="order__index">${i + 1}</span>
            <span class="order__name">${esc(nameOf(id))}</span>
            <button class="btn btn--sm btn--icon" data-move="up" ${i === 0 ? 'disabled' : ''}
              title="Move up" type="button">↑</button>
            <button class="btn btn--sm btn--icon" data-move="down" ${i === order.length - 1 ? 'disabled' : ''}
              title="Move down" type="button">↓</button>`;

          // Buttons stay for keyboard users and precise single steps
          row.querySelectorAll('[data-move]').forEach((mb) => {
            mb.addEventListener('click', () => {
              const to = mb.dataset.move === 'up' ? i - 1 : i + 1;
              if (to < 0 || to >= order.length) return;
              [order[i], order[to]] = [order[to], order[i]];
              renderOrder();
            });
          });

          listEl.appendChild(row);
        });
      };

      // ---- Drag to reorder ----
      // The list is only rebuilt on drop, so the dragged node stays alive for
      // the whole gesture.
      let dragFrom = null;

      const clearDropMarks = () => {
        listEl.querySelectorAll('.order__row').forEach((r) => {
          r.classList.remove('order__row--drop-above', 'order__row--drop-below');
        });
      };

      listEl.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.order__row');
        if (!row) return;
        dragFrom = Number(row.dataset.index);
        row.classList.add('order__row--dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without payload
        e.dataTransfer.setData('text/plain', String(dragFrom));
      });

      listEl.addEventListener('dragover', (e) => {
        if (dragFrom === null) return;
        const row = e.target.closest('.order__row');
        if (!row) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const to = Number(row.dataset.index);
        clearDropMarks();
        if (to === dragFrom) return;
        // Indicator on the side the row will be inserted
        const rect = row.getBoundingClientRect();
        const below = e.clientY > rect.top + rect.height / 2;
        row.classList.add(below ? 'order__row--drop-below' : 'order__row--drop-above');
      });

      listEl.addEventListener('drop', (e) => {
        if (dragFrom === null) return;
        const row = e.target.closest('.order__row');
        if (!row) return;
        e.preventDefault();

        const over = Number(row.dataset.index);
        const rect = row.getBoundingClientRect();
        const below = e.clientY > rect.top + rect.height / 2;
        let to = below ? over + 1 : over;
        // Removing the dragged item first shifts everything after it down one
        if (dragFrom < to) to -= 1;

        const [moved] = order.splice(dragFrom, 1);
        order.splice(Math.max(0, Math.min(to, order.length)), 0, moved);
        dragFrom = null;
        renderOrder();
      });

      listEl.addEventListener('dragend', () => {
        dragFrom = null;
        listEl.querySelector('.order__row--dragging')?.classList.remove('order__row--dragging');
        clearDropMarks();
      });

      // Dropping outside a row must not leave the list in dragging state
      listEl.addEventListener('dragleave', (e) => {
        if (!listEl.contains(e.relatedTarget)) clearDropMarks();
      });

      checks.forEach((c) => c.addEventListener('change', () => {
        // Newly checked projects go to the end of the start order
        if (c.checked) {
          if (!order.includes(c.value)) order.push(c.value);
        } else {
          const at = order.indexOf(c.value);
          if (at !== -1) order.splice(at, 1);
        }
        renderOrder();
      }));

      modeEl.addEventListener('change', renderOrder);

      // Bulk actions act on visible rows only, so search-then-select works
      b.querySelector('[data-pfact="all"]').addEventListener('click', () => {
        for (const c of search.visibleChecks()) {
          c.checked = true;
          if (!order.includes(c.value)) order.push(c.value);
        }
        renderOrder();
      });
      b.querySelector('[data-pfact="none"]').addEventListener('click', () => {
        for (const c of search.visibleChecks()) {
          c.checked = false;
          const at = order.indexOf(c.value);
          if (at !== -1) order.splice(at, 1);
        }
        renderOrder();
      });

      renderOrder();
      b.querySelector('[name="name"]').focus();
    },
  });
}

// ---------- Delete Profile ----------
export function openDeleteProfileDialog(profile) {
  openModal({
    title: `Delete Profile — ${profile.name}`,
    bodyHtml: `<p>Remove the profile <strong>${esc(profile.name)}</strong>? ` +
      'The projects themselves stay on the dashboard and keep running.</p>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Delete',
        danger: true,
        onClick: async ({ close, btn }) => {
          busy(btn, 'Deleting…');
          try {
            await api.deleteProfile(profile.id);
            toastSuccess(`Profile "${profile.name}" deleted`);
            close();
            const { loadProfiles } = await import('./profiles.js');
            await loadProfiles();
          } catch (err) {
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Delete';
          }
        },
      },
    ],
  });
}

// ---------- Run Settings ----------
// Which script/command Start runs, plus extra environment variables.
export function openRunSettingsDialog(id) {
  const p = getProject(id);
  if (!p) return;

  const scripts = p.scripts || [];
  const envText = Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  const autoPick = scripts.includes('dev') ? 'dev' : scripts.includes('start') ? 'start' : scripts[0] || '—';

  openModal({
    title: `Run Settings — ${p.name}`,
    wide: true,
    bodyHtml:
      field('Start script',
        `<select class="field__input field__select" name="runScript">
          <option value="">Auto — ${esc(autoPick)}</option>
          ${scripts.map((s) => `<option value="${esc(s)}" ${p.runScript === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>`) +
      field('Custom command (overrides the script)',
        `<input class="field__input" name="command" value="${esc(p.command || '')}"
          placeholder="e.g. node server.js --inspect" spellcheck="false">`) +
      field('Environment variables (KEY=value, one per line)',
        `<textarea class="field__input field__textarea" name="env" rows="5"
          placeholder="PORT=4000&#10;NODE_ENV=development" spellcheck="false">${esc(envText)}</textarea>`) +
      `<p class="modal__hint">Runs as <code>${esc(p.pm)}</code> in <code>${esc(p.folder)}</code>. ` +
      'Changes apply the next time the project starts.</p>' +
      '<span class="field__error"></span>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Save',
        primary: true,
        onClick: async ({ backdrop, close, btn }) => {
          const runScript = backdrop.querySelector('[name="runScript"]').value;
          const command = backdrop.querySelector('[name="command"]').value.trim();
          const envRaw = backdrop.querySelector('[name="env"]').value;

          const env = {};
          for (const raw of envRaw.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq < 1) return setError(backdrop, `Invalid line: "${line}" — use KEY=value`);
            const key = line.slice(0, eq).trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
              return setError(backdrop, `Invalid variable name: "${key}"`);
            }
            env[key] = line.slice(eq + 1).trim();
          }

          busy(btn, 'Saving…');
          try {
            const updated = await api.setRunConfig(id, { runScript, command, env });
            updateProject(updated, { structural: false });
            toastSuccess(updated.restartRequired ? 'Saved — restart to apply' : 'Run settings saved');
            close();
          } catch (err) {
            setError(backdrop, err.message);
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Save';
          }
        },
      },
    ],
    onOpen: (b) => b.querySelector('[name="runScript"]').focus(),
  });
}

// ---------- Dependencies ----------
// Start order: these projects must be listening before this one starts.
export function openDependenciesDialog(id) {
  const p = getProject(id);
  if (!p) return;

  const others = getState().projects.filter((x) => x.id !== id);
  const current = new Set(p.dependsOn || []);

  if (others.length === 0) {
    openModal({
      title: `Dependencies — ${p.name}`,
      bodyHtml: '<p>Add another project first — dependencies point at other projects on this dashboard.</p>',
      actions: [{ label: 'Close', primary: true, onClick: ({ close }) => close() }],
    });
    return;
  }

  openModal({
    title: `Dependencies — ${p.name}`,
    wide: true,
    bodyHtml:
      '<p class="modal__hint">Starting <strong>' + esc(p.name) + '</strong> will start these first and wait until ' +
      'each one answers on its port (projects without a port are only started, not waited for).</p>' +
      searchBox('Search project, group, port…') +
      `<div class="scan__toolbar">
        <button class="btn btn--sm" data-dact="none" type="button">Clear all</button>
        <span class="scan__count"></span>
      </div>` +
      `<div class="scan__list">${others.map((o) => `
        <label class="scan__item" data-search="${esc(haystack(o.name, o.group || 'ungrouped', o.framework, o.port ?? 'no port'))}">
          <input type="checkbox" class="dep__check" value="${esc(o.id)}" ${current.has(o.id) ? 'checked' : ''}>
          <span class="scan__info">
            <span class="scan__name">${esc(o.name)}</span>
            <span class="scan__path">${esc(o.group || 'Ungrouped')} · ${o.port ? `port ${o.port}` : 'no port'}</span>
          </span>
        </label>`).join('')}
        <span class="scan__empty" hidden></span>
      </div>` +
      '<span class="field__error"></span>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Save',
        primary: true,
        onClick: async ({ backdrop, close, btn }) => {
          const dependsOn = [...backdrop.querySelectorAll('.dep__check:checked')].map((c) => c.value);
          busy(btn, 'Saving…');
          try {
            const updated = await api.setDeps(id, dependsOn);
            updateProject(updated, { structural: false });
            toastSuccess(dependsOn.length > 0
              ? `${dependsOn.length} dependenc${dependsOn.length === 1 ? 'y' : 'ies'} saved`
              : 'Dependencies cleared');
            close();
          } catch (err) {
            setError(backdrop, err.message);
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Save';
          }
        },
      },
    ],
    onOpen: (b) => {
      const { visibleChecks, sync, searchEl } = wireListSearch(b, { checkSelector: '.dep__check' });
      b.querySelector('[data-dact="none"]').addEventListener('click', () => {
        visibleChecks().forEach((c) => { c.checked = false; });
        sync();
      });
      searchEl.focus();
    },
  });
}

// ---------- Port In Use ----------
// Shown when Start fails the pre-flight check, with the actual holder.
export function openPortConflictDialog(id, err, onRetry) {
  const p = getProject(id);
  if (!p) return;
  const holder = err.holder;

  openModal({
    title: `Port ${err.port} In Use`,
    wide: true,
    bodyHtml:
      `<p>Cannot start <strong>${esc(p.name)}</strong> — port <strong>${err.port}</strong> is already taken.</p>` +
      (holder
        ? field('Held by', `<div class="field__value">${esc(holder.name)} · PID ${holder.pid}</div>`) +
          (holder.command ? `<p class="modal__hint"><code>${esc(holder.command)}</code></p>` : '')
        : '<p class="modal__hint">The holding process could not be identified.</p>') +
      '<span class="field__error"></span>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Change Port',
        onClick: ({ close }) => {
          close();
          openChangePortDialog(id);
        },
      },
      ...(holder
        ? [{
            label: `Kill PID ${holder.pid} & Start`,
            danger: true,
            onClick: async ({ backdrop, close, btn }) => {
              busy(btn, 'Killing…');
              try {
                await api.killPort(err.port);
                toastSuccess(`Freed port ${err.port}`);
                close();
                onRetry?.();
              } catch (killErr) {
                setError(backdrop, killErr.message);
                toastError(killErr.message);
                btn.disabled = false;
                btn.textContent = `Kill PID ${holder.pid} & Start`;
              }
            },
          }]
        : []),
    ],
  });
}

// ---------- Change Port ----------
export function openChangePortDialog(id, target) {
  const p = getProject(id);
  if (!p) return;

  const hasSub = p.subProjects?.length > 0;

  const bodyHtml = hasSub
    ? field('Target',
        `<select class="field__input field__select" name="port-target">
          <option value="">Root (${esc(p.name)})</option>
          ${p.subProjects.map(sp =>
            `<option value="${esc(sp.name)}" ${sp.name === target ? 'selected' : ''}>${esc(sp.name)} (port: ${sp.port ?? 'n/a'})</option>`
          ).join('')}
        </select>`) +
      field('New Port', input('port', '', 'e.g. 5180')) +
      '<span class="field__error"></span>'
    : field('Current Port', `<div class="field__value">${p.port ?? 'n/a'}</div>`) +
      field('New Port', input('port', '', 'e.g. 5180')) +
      '<span class="field__error"></span>';

  openModal({
    title: `Change Port — ${p.name}`,
    bodyHtml,
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Save',
        primary: true,
        onClick: async ({ backdrop, close, btn }) => {
          const raw = backdrop.querySelector('[name="port"]').value.trim();
          const port = Number(raw);
          if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) {
            return setError(backdrop, 'Invalid port');
          }
          const targetSel = backdrop.querySelector('[name="port-target"]');
          const t = targetSel ? targetSel.value : undefined;
          busy(btn, 'Saving…');
          try {
            const updated = await api.changePort(id, port, t || undefined);
            updateProject(updated, { structural: false });
            toastSuccess(`Port updated to ${port}`);
            close();
          } catch (err) {
            setError(backdrop, err.message);
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Save';
          }
        },
      },
    ],
    onOpen: (b) => { const inp = b.querySelector('[name="port"]'); if (inp) inp.focus(); },
  });
}

// ---------- Edit Path ----------
export function openEditPathDialog(id) {
  const p = getProject(id);
  if (!p) return;
  openModal({
    title: `Edit Path — ${p.name}`,
    bodyHtml:
      field('package.json path', input('path', p.path)) +
      '<span class="field__error"></span>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Save & Rescan',
        primary: true,
        onClick: async ({ backdrop, close, btn }) => {
          const path = backdrop.querySelector('[name="path"]').value.trim();
          if (!path) return setError(backdrop, 'Path is required');
          busy(btn, 'Scanning…');
          try {
            const updated = await api.editPath(id, path);
            updateProject(updated, { structural: false });
            toastSuccess('Path updated');
            close();
          } catch (err) {
            setError(backdrop, err.message);
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Save & Rescan';
          }
        },
      },
    ],
    onOpen: (b) => b.querySelector('[name="path"]').focus(),
  });
}

// ---------- Move to Group ----------
export function openMoveGroupDialog(id) {
  const p = getProject(id);
  if (!p) return;
  openModal({
    title: `Move "${p.name}" to Group`,
    bodyHtml: field('Group name', groupInput('group', p.group || '')) + '<span class="field__error"></span>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Move',
        primary: true,
        onClick: async ({ backdrop, close, btn }) => {
          const group = groupValue(backdrop);
          busy(btn, 'Moving…');
          try {
            const updated = await api.editGroup(id, group || null);
            // Use structural:true so groups re-render in correct section
            updateProject(updated, { structural: true });
            toastSuccess(`Moved "${p.name}" to ${group || 'Ungrouped'}`);
            close();
          } catch (err) {
            setError(backdrop, err.message);
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Move';
          }
        },
      },
    ],
    onOpen: (b) => { b.querySelector('[name="group"]').focus(); wireGroupPicker(b); },
  });
}

// ---------- Rename Group ----------
export function openRenameGroupDialog(oldName) {
  if (oldName === 'Ungrouped') return;
  const examples = [...new Set(getState().projects.map(p => p.group).filter(Boolean))].filter(g => g !== oldName).sort();
  openModal({
    title: `Rename Group`,
    bodyHtml: field('Current name', `<div class="field__value">${oldName}</div>`) +
      field('New name', input('name', oldName, 'New group name')) +
      '<span class="field__error"></span>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Rename',
        primary: true,
        onClick: async ({ backdrop, close, btn }) => {
          const newName = backdrop.querySelector('[name="name"]').value.trim();
          if (!newName) return setError(backdrop, 'Name is required');
          if (newName === oldName) return setError(backdrop, 'Must be different from current name');
          if (examples.includes(newName)) return setError(backdrop, 'Group name already exists');
          busy(btn, 'Renaming…');
          try {
            await api.renameGroup(oldName, newName);
            toastSuccess(`Group renamed to "${newName}"`);
            close();
            const { setProjects } = await import('./state.js');
            setProjects(await api.getProjects());
          } catch (err) {
            setError(backdrop, err.message);
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Rename';
          }
        },
      },
    ],
    onOpen: (b) => {
      const inp = b.querySelector('[name="name"]');
      inp.focus();
      inp.select();
    },
  });
}

// ---------- Delete Group ----------
export function openDeleteGroupDialog(name) {
  if (name === 'Ungrouped') return;
  openModal({
    title: `Delete Group — ${name}`,
    bodyHtml: `<p>What should happen to projects in <strong>${name}</strong>?</p>`,
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Move to Ungrouped',
        onClick: async ({ close, btn }) => {
          busy(btn, 'Moving…');
          try {
            await api.deleteGroup(name, 'ungroup');
            toastSuccess(`Projects moved to Ungrouped`);
            close();
            const { setProjects } = await import('./state.js');
            setProjects(await api.getProjects());
          } catch (err) {
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Move to Ungrouped';
          }
        },
      },
      {
        label: 'Delete all projects',
        danger: true,
        onClick: async ({ close, btn }) => {
          busy(btn, 'Deleting…');
          try {
            await api.deleteGroup(name, 'delete_all');
            toastSuccess(`Group "${name}" and its projects deleted`);
            close();
            const { setProjects } = await import('./state.js');
            setProjects(await api.getProjects());
          } catch (err) {
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Delete all projects';
          }
        },
      },
    ],
  });
}
// ---------- Import Scripts from package.json ----------
// Import individual scripts from a single package.json as separate cards.
export function openImportScriptsDialog() {
  const modal = openModal({
    title: 'Import Scripts',
    wide: true,
    bodyHtml:
      field('package.json path', input('path', '', 'D:/Projects/door-v3/package.json')) +
      '<p class="modal__hint">Import individual scripts from a <code>package.json</code> as separate service cards. ' +
      'Each script gets its own Start/Stop/Logs controls.</p>' +
      '<span class="field__error"></span>',
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Scan Scripts',
        primary: true,
        onClick: ({ backdrop, btn }) => runScriptsScan(backdrop, btn),
      },
    ],
    onOpen: (b) => {
      const inp = b.querySelector('[name="path"]');
      inp.focus();
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') b.querySelector('.modal__footer .btn--primary')?.click();
      });
    },
  });

  async function runScriptsScan(backdrop, btn) {
    const path = backdrop.querySelector('[name="path"]').value.trim();
    if (!path) return setError(backdrop, 'Path is required');
    busy(btn, 'Scanning…');
    try {
      const result = await api.scanScripts(path);
      showScriptsPicker(result, path);
    } catch (err) {
      setError(backdrop, err.message);
      toastError(err.message);
      btn.disabled = false;
      btn.textContent = 'Scan Scripts';
    }
  }

  function showScriptsPicker(result, originalPath) {
    const selectable = result.candidates.filter((s) => !s.added);

    modal.setStep({
      title: `Import Scripts — ${result.packageName}`,
      bodyHtml:
        `<div class="scan__summary">
          <span class="scan__root" title="${esc(result.folder)}">${esc(result.packageName)}</span>
          <span>${result.totalScripts} script${result.totalScripts === 1 ? '' : 's'} found ·
            ${selectable.length} available</span>
          <span class="scan__badges" style="margin-left:8px">
            <span class="scan__badge">${esc(result.framework)}</span>
            <span class="scan__badge">${esc(result.pm)}</span>
          </span>
        </div>` +
        searchBox('Search script name…') +
        `<div class="scan__toolbar">
          <button class="btn btn--sm" data-sact="all">Select all</button>
          <button class="btn btn--sm" data-sact="none">Select none</button>
          <button class="btn btn--sm" data-sact="runnable">Only runnable</button>
          <span class="scan__count"></span>
        </div>` +
        `<div class="scan__list">${result.candidates.map(scriptRow).join('')}
          <span class="scan__empty" hidden></span>
        </div>` +
        field('Group for imported scripts', groupInput('group', result.packageName)) +
        '<span class="field__error"></span>',
      actions: [
        { label: 'Back', onClick: () => modal.setStep(importScriptsStep1(originalPath)) },
        {
          label: 'Import Selected',
          primary: true,
          onClick: async ({ backdrop, close, btn }) => {
            const picked = [...backdrop.querySelectorAll('.scan__check:checked')].map((c) => c.value);
            if (picked.length === 0) return setError(backdrop, 'Select at least one script');
            const group = groupValue(backdrop);
            busy(btn, `Importing ${picked.length}…`);
            try {
              const { added, skipped } = await api.addScripts(result.path, picked, group || undefined);
              added.forEach(addProject);
              toastSuccess(`${added.length} script${added.length === 1 ? '' : 's'} imported`);
              if (skipped.length) toastError(`${skipped.length} skipped: ${skipped[0].reason}`);
              close();
            } catch (err) {
              setError(backdrop, err.message);
              toastError(err.message);
              btn.disabled = false;
              btn.textContent = 'Import Selected';
            }
          },
        },
      ],
      onOpen: (b) => {
        wireGroupPicker(b);
        const { visibleChecks, sync, searchEl } = wireListSearch(b, { checkSelector: '.scan__check' });

        b.querySelector('[data-sact="all"]').addEventListener('click', () => {
          visibleChecks().forEach((c) => { c.checked = true; });
          sync();
        });
        b.querySelector('[data-sact="none"]').addEventListener('click', () => {
          visibleChecks().forEach((c) => { c.checked = false; });
          sync();
        });
        b.querySelector('[data-sact="runnable"]').addEventListener('click', () => {
          visibleChecks().forEach((c) => { c.checked = c.dataset.runnable === '1'; });
          sync();
        });

        searchEl.focus();
      },
    });
  }

  function importScriptsStep1(path) {
    return {
      title: 'Import Scripts',
      bodyHtml:
        field('package.json path', input('path', esc(path), 'D:/Projects/door-v3/package.json')) +
        '<p class="modal__hint">Import individual scripts from a <code>package.json</code> as separate service cards.</p>' +
        '<span class="field__error"></span>',
      actions: [
        { label: 'Cancel', onClick: ({ close }) => close() },
        { label: 'Scan Scripts', primary: true, onClick: ({ backdrop, btn }) => runScriptsScan(backdrop, btn) },
      ],
      onOpen: (b) => b.querySelector('[name="path"]').focus(),
    };
  }
}

// One row in the scripts scan result list
function scriptRow(s) {
  const badges = [
    s.isRunnable ? '<span class="scan__badge scan__badge--success">runnable</span>' : '',
    s.isUtility ? '<span class="scan__badge scan__badge--info">utility</span>' : '',
    s.port ? `<span class="scan__badge">:${s.port}</span>` : '',
    s.added ? '<span class="scan__badge scan__badge--muted">already added</span>' : '',
  ].join('');

  const search = haystack(s.name, s.command, s.port ?? '');
  const checked = !s.added && s.isRunnable ? 'checked' : '';

  return `
    <label class="scan__item ${s.added ? 'scan__item--disabled' : ''}" data-search="${esc(search)}">
      <input type="checkbox" class="scan__check" value="${esc(s.name)}"
        data-runnable="${s.isRunnable ? 1 : 0}" ${checked} ${s.added ? 'disabled' : ''}>
      <span class="scan__info">
        <span class="scan__name">${esc(s.name)}</span>
        <span class="scan__path" title="${esc(s.command)}">${esc(truncateCommand(s.command))}</span>
        <span class="scan__badges">${badges}</span>
      </span>
    </label>`;
}

// Truncate long commands for display
function truncateCommand(cmd, maxLen = 60) {
  if (!cmd) return '';
  return cmd.length > maxLen ? cmd.slice(0, maxLen) + '…' : cmd;
}

// ---------- Delete ----------
export function openDeleteDialog(id) {
  const p = getProject(id);
  if (!p) return;
  openModal({
    title: `Delete — ${p.name}`,
    bodyHtml: `<p>Remove <strong>${p.name}</strong> from the dashboard? The project folder on disk is not deleted.</p>`,
    actions: [
      { label: 'Cancel', onClick: ({ close }) => close() },
      {
        label: 'Delete',
        danger: true,
        onClick: async ({ close, btn }) => {
          busy(btn, 'Deleting…');
          try {
            await api.deleteProject(id);
            removeProject(id);
            toastSuccess(`Project "${p.name}" removed`);
            close();
          } catch (err) {
            toastError(err.message);
            btn.disabled = false;
            btn.textContent = 'Delete';
          }
        },
      },
    ],
  });
}
