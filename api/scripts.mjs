import path from 'path';
import fs from 'fs';
import * as config from '../utils/config.mjs';
import * as scanner from '../utils/scanner.mjs';
import { toFolder, isDuplicate, pickColor } from '../utils/project-factory.mjs';

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
 * Try to extract a port number from a script command string.
 * Looks for patterns like: --port 3000, -p 3000, PORT=3000
 */
function extractPortFromCommand(cmd) {
  if (!cmd) return null;
  const m = cmd.match(/--port\s+(\d+)/) || cmd.match(/-p\s+(\d+)/) || cmd.match(/\bPORT=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Categorize scripts into groups for better UX.
 * Returns { runnable: [], utility: [], other: [] }
 */
function categorizeScripts(scripts) {
  const RUNNABLE = /^(dev|start|serve|watch)(:|$)/;
  const UTILITY = /^(build|test|lint|format|check|clean|migrate|seed|deploy|audit|verify)(:|$)/;

  const runnable = [];
  const utility = [];
  const other = [];

  for (const [name, cmd] of Object.entries(scripts)) {
    if (RUNNABLE.test(name)) {
      runnable.push({ name, command: cmd });
    } else if (UTILITY.test(name)) {
      utility.push({ name, command: cmd });
    } else {
      other.push({ name, command: cmd });
    }
  }

  return { runnable, utility, other };
}

export function registerScriptsRoutes(router) {
  /**
   * POST /api/scripts/scan
   * Read a package.json and return all scripts as import candidates.
   * Body: { path: string } — path to folder or package.json
   */
  router.post('/api/scripts/scan', async (req, res) => {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }

    if (!body.path || typeof body.path !== 'string' || !body.path.trim()) {
      sendJSON(res, 400, { error: 'Path to package.json is required' });
      return;
    }

    const folderPath = toFolder(body.path.trim());
    const pkgPath = path.join(folderPath, 'package.json');

    if (!fs.existsSync(pkgPath)) {
      sendJSON(res, 404, { error: 'package.json not found at: ' + pkgPath });
      return;
    }

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch {
      sendJSON(res, 400, { error: 'Invalid package.json' });
      return;
    }

    if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) {
      sendJSON(res, 404, { error: 'No scripts found in package.json' });
      return;
    }

    const meta = scanner.scanProject(folderPath);
    const categorized = categorizeScripts(pkg.scripts);
    const existing = config.getProjects();

    // Build candidate list with metadata
    const candidates = Object.entries(pkg.scripts).map(([name, command]) => {
      const port = extractPortFromCommand(command);
      const isRunnable = /^(dev|start|serve|watch)(:|$)/.test(name);
      const isUtility = /^(build|test|lint|format|check|clean|migrate|seed|deploy|audit|verify)(:|$)/.test(name);

      // Check if already added (by script name + same folder)
      const scriptId = `script:${folderPath}:${name}`;
      const added = existing.some(p => p.scriptId === scriptId);

      return {
        name,
        command,
        port,
        isRunnable,
        isUtility,
        added,
        scriptId,
      };
    });

    sendJSON(res, 200, {
      packageName: pkg.name || path.basename(folderPath),
      folder: folderPath,
      path: pkgPath,
      framework: meta.framework,
      pm: meta.pm,
      totalScripts: candidates.length,
      categorized,
      candidates,
    });
  });

  /**
   * POST /api/scripts/add
   * Create project entries for selected scripts.
   * Body: { path: string, scripts: string[], group?: string }
   *   - path: folder or package.json path
   *   - scripts: array of script names to import
   *   - group: optional group name for all imported scripts
   */
  router.post('/api/scripts/add', async (req, res) => {
    let body;
    try {
      body = await collectBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }

    if (!body.path || typeof body.path !== 'string') {
      sendJSON(res, 400, { error: 'Path is required' });
      return;
    }

    const scriptNames = Array.isArray(body.scripts) ? body.scripts : [];
    if (scriptNames.length === 0) {
      sendJSON(res, 400, { error: 'No scripts selected' });
      return;
    }

    const folderPath = toFolder(body.path.trim());
    const pkgPath = path.join(folderPath, 'package.json');

    if (!fs.existsSync(pkgPath)) {
      sendJSON(res, 404, { error: 'package.json not found' });
      return;
    }

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch {
      sendJSON(res, 400, { error: 'Invalid package.json' });
      return;
    }

    if (!pkg.scripts) {
      sendJSON(res, 400, { error: 'No scripts in package.json' });
      return;
    }

    const meta = scanner.scanProject(folderPath);
    const defaultGroup = typeof body.group === 'string' && body.group.trim()
      ? body.group.trim()
      : (pkg.name || path.basename(folderPath));

    const added = [];
    const skipped = [];

    for (const scriptName of scriptNames) {
      if (!pkg.scripts[scriptName]) {
        skipped.push({ script: scriptName, reason: 'Script not found in package.json' });
        continue;
      }

      const command = pkg.scripts[scriptName];
      const port = extractPortFromCommand(command);
      const scriptId = `script:${folderPath}:${scriptName}`;

      // Check for duplicate
      const existingProjects = config.getProjects();
      if (existingProjects.some(p => p.scriptId === scriptId)) {
        skipped.push({ script: scriptName, reason: 'Already added' });
        continue;
      }

      // Create a project entry for this script
      const project = {
        id: config.nextId(),
        name: `${pkg.name || path.basename(folderPath)}:${scriptName}`,
        group: defaultGroup,
        framework: meta.framework,
        pm: meta.pm,
        folder: meta.folder,
        path: meta.path,
        port: port,
        scripts: [scriptName],
        runScript: scriptName,
        command: null,
        env: {},
        dependsOn: [],
        autoRestart: false,
        color: pickColor(added.length),
        status: 'stopped',
        pid: null,
        startedAt: null,
        scriptId: scriptId,
        subProjects: [],
      };

      config.addProject(project);
      added.push(project);
    }

    sendJSON(res, added.length > 0 ? 201 : 400, { added, skipped });
  });
}
