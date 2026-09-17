import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const NAME = `${PKG.name.replace(/@[^/]+\//, '')}-v${PKG.version}`;

// Clean dist
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

const STAGE = path.join(DIST, NAME);
fs.mkdirSync(STAGE, { recursive: true });

// Copy only what's needed
const FILES = ['server', 'api', 'utils', 'public', 'README.md', 'LICENSE'];

for (const file of FILES) {
  const src = path.join(ROOT, file);
  const dest = path.join(STAGE, file);
  if (!fs.existsSync(src)) continue;

  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Create a minimal package.json for the staged copy
const stagePkg = {
  name: PKG.name,
  version: PKG.version,
  description: PKG.description,
  type: 'module',
  bin: PKG.bin,
  engines: PKG.engines,
  scripts: { start: 'node server/server.mjs' },
  license: PKG.license,
};
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(stagePkg, null, 2));

// Create start scripts for convenience
fs.writeFileSync(path.join(STAGE, 'start.bat'), '@echo off\r\nnode server/server.mjs %*\r\n');
fs.writeFileSync(path.join(STAGE, 'start.sh'), '#!/bin/sh\nnode server/server.mjs "$@"\n');

// Create zip
const zipName = `${NAME}.zip`;
const zipPath = path.join(DIST, zipName);

try {
  // Try PowerShell (Windows)
  execSync(`powershell -Command "Compress-Archive -Path '${STAGE}' -DestinationPath '${zipPath}'"`, { stdio: 'pipe' });
} catch {
  try {
    // Try zip (Linux/Mac)
    execSync(`cd "${DIST}" && zip -r "${zipName}" "${NAME}"`, { stdio: 'pipe' });
  } catch {
    console.log('\n  [!] Could not create zip automatically. The dist/ folder is ready to zip manually.');
    process.exit(0);
  }
}

const size = (fs.statSync(zipPath).size / 1024).toFixed(0);
console.log(`\n  ✓ Built: dist/${zipName} (${size} KB)`);
console.log(`\n  Share this file. Friend needs only:`);
console.log(`    1. Extract`);
console.log(`    2. Run: node server/server.mjs`);
console.log(`    3. Open: http://localhost:9999\n`);
