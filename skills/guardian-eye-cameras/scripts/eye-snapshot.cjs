#!/usr/bin/env node
'use strict';

// Fetch a single current video frame from an already-open local viewer.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

async function frame(socketPath, name) {
  return new Promise((resolve, reject) => {
    const req = http.get({socketPath, path:`/${name}`, timeout:3000}, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Camera unavailable')); return; }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.once('error', reject);
    });
    req.once('timeout', () => req.destroy(new Error('Snapshot timed out')));
    req.once('error', reject);
  });
}

async function main() {
  const name = process.argv[2];
  if (!['13p', 'x'].includes(name)) throw new Error('Usage: eye-snapshot 13p|x [output.jpg]');
  const directory = path.join(os.homedir(), '.cache/guardian-eye');
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  const sockets = entries.filter(n => /^viewer-\d+\.sock$/.test(n))
    .map(n => path.join(directory, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const start = performance.now();
  for (const socket of sockets) {
    let data;
    try { data = await frame(socket, name); }
    catch (_) { continue; }
    if (process.argv[3] === '--stdout') {
      process.stdout.write(data);
      return;
    }
    const output = process.argv[3] || path.join(os.tmpdir(), `guardian-eye-${name}-${Date.now()}.jpg`);
    fs.writeFileSync(output, data, {flag:'wx', mode:0o600});
    console.log(`${output}\n${Math.round(performance.now()-start)} ms`);
    return;
  }
  throw new Error(`No open, connected viewer for ${name}; start eye or eye-13p first`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
