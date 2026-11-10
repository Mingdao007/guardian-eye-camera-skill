#!/usr/bin/env node
'use strict';

// Local Guardian Eye viewer: camera passwords stay in owner-only files and
// are sent only to the configured, certificate-verified camera origin.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { X509Certificate, createHash, randomBytes } = require('crypto');
const sourceZoom = require('./onvif-zoom.cjs');

const home = os.homedir();
const expand = p => p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
const configFile = process.env.GUARDIAN_EYE_CONFIG || path.join(home, '.config/guardian-eye/settings.json');
const playwrightPath = process.env.GUARDIAN_PLAYWRIGHT_CORE || 'playwright-core';
const { chromium } = require(playwrightPath);

function cameraConfig(name, raw) {
  if (!raw || !raw.address || !raw.hostname || !raw.certificate || !raw.credentials) {
    throw new Error(`Missing connection settings for ${name}`);
  }
  return {
    name, address: raw.address, hostname: raw.hostname, port: raw.port || 8443,
    certificate: expand(raw.certificate), credentials: expand(raw.credentials),
    label: raw.label || name, zoomPositions:raw.zoomPositions || null,
    onvifPort:raw.onvifPort || 8080, onvifProfile:raw.onvifProfile || 'Profile000',
  };
}

async function verifyCamera(camera) {
  const pem = new X509Certificate(fs.readFileSync(camera.certificate)).toString();
  if ((fs.statSync(camera.credentials).mode & 0o077) !== 0) throw new Error('Credentials must be owner-only');
  const credentials = JSON.parse(fs.readFileSync(camera.credentials, 'utf8'));
  if (!credentials.username || !credentials.password) throw new Error('Missing credentials');
  const pin = await new Promise((resolve, reject) => {
    const socket = tls.connect({host: camera.address, port: camera.port,
      servername: camera.hostname, ca: pem, rejectUnauthorized: true}, () => {
      try {
        const cert = new X509Certificate(socket.getPeerCertificate().raw);
        const spki = cert.publicKey.export({type: 'spki', format: 'der'});
        resolve(createHash('sha256').update(spki).digest('base64'));
      } catch (e) { reject(e); }
      socket.end();
    });
    socket.setTimeout(6000, () => socket.destroy(new Error('Camera connection timed out')));
    socket.once('error', reject);
  });
  return {...camera, pem, pin, privateCredentials:credentials, authorization: 'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64')};
}

function reduceReceiverDelay(parentOrigin) {
  for (const [name, maximum] of [['jitterBufferTarget', 100], ['playoutDelayHint', 0.1]]) {
    const desc = Object.getOwnPropertyDescriptor(RTCRtpReceiver.prototype, name);
    if (!desc || !desc.configurable || !desc.set) continue;
    Object.defineProperty(RTCRtpReceiver.prototype, name, {...desc, set(value) {
      const target = this.track?.kind === 'video' && typeof value === 'number' ? Math.min(value, maximum) : value;
      return desc.set.call(this, target);
    }});
  }
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(...args) { super(...args); window.__guardianEyePeer = this; }
  };
  window.__guardianDisplayZoom = 1;
  window.addEventListener('message', event => {
    if (event.origin !== parentOrigin || event.data?.type !== 'guardian-display-zoom' || ![1, 2, 4].includes(event.data.value)) return;
    const video = document.querySelector('video');
    if (!video) return;
    video.parentElement.style.overflow = 'hidden';
    video.style.transform = `scale(${event.data.value})`;
    video.style.transformOrigin = 'center center';
    window.__guardianDisplayZoom = event.data.value;
  });
}

function fetchCameraPage(camera, parentOrigin) {
  return new Promise((resolve, reject) => {
    const req = https.get({host:camera.address, port:camera.port, servername:camera.hostname,
      ca:camera.pem, path:'/ge/webrtc/', headers:{Host:camera.hostname, Authorization:camera.authorization}, timeout:6000}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const headers = {...response.headers};
        delete headers['content-length']; delete headers['transfer-encoding']; delete headers.connection;
        const policy = headers['content-security-policy'];
        if (policy) headers['content-security-policy'] = policy.replace(/frame-ancestors\s+[^;]+/i, `frame-ancestors ${parentOrigin}`);
        resolve({status:response.statusCode, headers, body:Buffer.concat(chunks)});
      });
      response.once('error', reject);
    });
    req.once('timeout', () => req.destroy(new Error('Camera page timed out')));
    req.once('error', reject);
  });
}

async function openCamera(page, camera) {
  let stage = 'configure viewer';
  try {
    const element = await page.locator(`#camera-${camera.name}`).elementHandle();
    const frame = await element.contentFrame();
    await element.evaluate((el, origin) => { el.dataset.origin = origin; }, `https://${camera.hostname}:${camera.port}`);
    stage = 'open camera page';
    const response = await frame.goto(`https://${camera.hostname}:${camera.port}/ge/webrtc/`, {waitUntil: 'domcontentloaded', timeout: 15000});
    if (!response || !response.ok()) throw new Error(`Camera page returned ${response?.status() || 'no response'}`);
    await element.evaluate(el => { el.style.display = 'block'; });
    stage = 'start camera';
    await frame.locator('#start').click({timeout: 10000});
    stage = 'receive video';
    await frame.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.videoWidth && window.__guardianEyePeer?.connectionState === 'connected';
    }, null, {timeout: 25000});
    const stats = await frame.evaluate(async () => {
      const v = document.querySelector('video'), peer = window.__guardianEyePeer;
      const r = peer.getReceivers().find(x => x.track?.kind === 'video');
      const count = async () => {
        let decoded = 0;
        (await peer.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'video') decoded = s.framesDecoded || 0; });
        return decoded;
      };
      const before = await count();
      await new Promise(resolve => setTimeout(resolve, 1500));
      return {width:v.videoWidth, height:v.videoHeight, targetMs:r?.jitterBufferTarget, newFrames:(await count())-before};
    });
    if (stats.newFrames <= 0) throw new Error('No fresh decoded frames');
    if (process.env.GUARDIAN_EYE_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.GUARDIAN_EYE_EVIDENCE_DIR, {recursive:true, mode:0o700});
      await page.screenshot({path:path.join(process.env.GUARDIAN_EYE_EVIDENCE_DIR, `${camera.name}.png`)});
    }
    console.log(`${camera.label}: connected ${stats.width}x${stats.height}, ${stats.newFrames} fresh frames, receive target ${stats.targetMs} ms`);
    return {camera, frame, page};
  } catch (error) {
    throw new Error(`${stage} (${error.name})`);
  }
}

async function startSnapshots(viewers) {
  const directory = path.join(home, '.cache/guardian-eye');
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, `viewer-${process.pid}.sock`);
  const server = http.createServer(async (request, response) => {
    const viewer = viewers.find(v => request.method === 'GET' && request.url === `/${v.camera.name}` && !v.page.isClosed());
    if (!viewer) { response.writeHead(404).end(); return; }
    try {
      const data = await viewer.frame.evaluate(() => {
        const video = document.querySelector('video');
        if (!video?.videoWidth || window.__guardianEyePeer?.connectionState !== 'connected') throw new Error('Camera is not connected');
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
      });
      response.writeHead(200, {'Content-Type':'image/jpeg', 'Cache-Control':'no-store'}).end(Buffer.from(data, 'base64'));
    } catch (_) { response.writeHead(503).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  fs.chmodSync(socket, 0o600);
  const clean = () => { try { fs.unlinkSync(socket); } catch (_) {} };
  process.once('exit', clean);
  return {server, clean};
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const mode = process.argv[2] || 'both';
  const names = mode === 'both' ? ['13p', 'x'] : [mode];
  if (names.some(n => !['13p', 'x'].includes(n))) throw new Error('Use 13p, x, or both');
  const verified = await Promise.allSettled(names.map(name => Promise.resolve()
    .then(() => cameraConfig(name, config.cameras?.[name])).then(verifyCamera)));
  const cameras = verified.flatMap((result, i) => {
    if (result.status === 'fulfilled') return [result.value];
    console.error(`${config.cameras?.[names[i]]?.label || names[i]}: unavailable or certificate verification failed`);
    return [];
  });
  if (!cameras.length) return 1;
  const mappings = cameras.map(c => `MAP ${c.hostname} ${c.address}`).join(',');
  const args = [`--host-resolver-rules=${mappings}`, `--ignore-certificate-errors-spki-list=${cameras.map(c => c.pin).join(',')}`];
  const browser = await chromium.launch({headless:false, executablePath:expand(config.chrome), args});
  const token = randomBytes(24).toString('base64url');
  const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8').replace('GUARDIAN_LOCAL_TOKEN', token);
  let parentOrigin;
  const dashboard = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'}).end(html); return;
    }
    if (request.method !== 'POST' || request.url !== '/zoom' || request.headers.origin !== parentOrigin || request.headers['x-guardian-token'] !== token) {
      response.writeHead(403).end(); return;
    }
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error('Invalid request'); }
      const input = JSON.parse(body), camera = cameras.find(c => c.name === input.camera);
      const position = camera?.zoomPositions?.[String(input.factor)];
      if (![1, 2, 4].includes(input.factor) || typeof position !== 'number') throw new Error('Zoom not calibrated');
      const actual = await sourceZoom.move(camera, camera.privateCredentials, position);
      if (Math.abs(actual - position) > 0.003) throw new Error('Zoom readback differs');
      response.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'}).end(JSON.stringify({ok:true, position:actual}));
    } catch (_) { response.writeHead(503, {'Content-Type':'application/json'}).end('{"ok":false}'); }
  });
  await new Promise((resolve, reject) => { dashboard.once('error', reject); dashboard.listen(0, '127.0.0.1', resolve); });
  parentOrigin = `http://127.0.0.1:${dashboard.address().port}`;
  const context = await browser.newContext({viewport:null});
  const page = await context.newPage();
  await page.addInitScript(reduceReceiverDelay, parentOrigin);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const camera = cameras.find(c => url.protocol === 'https:' && url.hostname === c.hostname && Number(url.port || 443) === c.port);
    if (!camera) { await route.continue(); return; }
    if (request.resourceType() === 'document' && url.pathname === '/ge/webrtc/') {
      try { await route.fulfill(await fetchCameraPage(camera, parentOrigin)); }
      catch (_) { await route.abort(); }
      return;
    }
    await route.continue({headers:{...request.headers(), authorization:camera.authorization}});
  });
  await page.goto(parentOrigin, {waitUntil:'domcontentloaded'});
  await page.evaluate(requested => {
    for (const name of ['13p','x']) if (!requested.includes(name)) document.querySelector(`#pane-${name}`).classList.add('hidden');
  }, names);
  await page.evaluate(available => {
    for (const {name, factors} of available) for (const factor of factors) {
      const button = document.querySelector(`button[data-source-camera="${name}"][data-source-zoom="${factor}"]`);
      if (button) button.disabled = false;
      const status = document.querySelector(`#source-status-${name}`);
      if (status) status.textContent = '可用';
    }
  }, cameras.map(c => ({name:c.name, factors:Object.keys(c.zoomPositions || {})})));
  const attempts = await Promise.allSettled(cameras.map(c => openCamera(page, c)));
  const viewers = attempts.flatMap((r, i) => {
    if (r.status === 'fulfilled') return [r.value];
    console.error(`${cameras[i].label}: could not open the video: ${r.reason.message}`);
    return [];
  });
  if (!viewers.length) { await browser.close(); dashboard.close(); return 1; }
  if (process.env.GUARDIAN_EYE_EVIDENCE_DIR) {
    await page.screenshot({path:path.join(process.env.GUARDIAN_EYE_EVIDENCE_DIR, 'dashboard.png')});
  }
  console.log(`Dashboard: ${parentOrigin}/ (${viewers.length} live cameras)`);
  if (process.env.GUARDIAN_EYE_VERIFY_ZOOM) {
    for (const viewer of viewers) {
      for (const factor of [2, 4, 1]) {
        await page.locator(`button[data-camera="${viewer.camera.name}"][data-zoom="${factor}"]`).click();
        await viewer.frame.waitForFunction(value => window.__guardianDisplayZoom === value, factor, {timeout:3000});
        const applied = await viewer.frame.evaluate(() => getComputedStyle(document.querySelector('video')).transform);
        console.log(`${viewer.camera.label}: display zoom ${factor}x (${applied})`);
        if (factor === 2 && process.env.GUARDIAN_EYE_EVIDENCE_DIR) {
          await page.screenshot({path:path.join(process.env.GUARDIAN_EYE_EVIDENCE_DIR, `zoom-${viewer.camera.name}.png`)});
        }
      }
    }
  }
  const snapshots = await startSnapshots(viewers);
  if (process.env.GUARDIAN_EYE_VERIFY_SNAPSHOTS) {
    const { execFile } = require('child_process');
    for (const viewer of viewers) {
      await new Promise((resolve, reject) => {
        const started = Date.now();
        execFile(process.execPath, [path.join(__dirname, 'eye-snapshot.cjs'), viewer.camera.name], (error, stdout) => {
          if (error) return reject(error);
          const lines = stdout.trim().split('\n');
          console.log(`${viewer.camera.label}: snapshot ${Date.now()-started} ms; saved ${lines[0]}`);
          resolve();
        });
      });
    }
  }
  await new Promise(resolve => page.once('close', resolve));
  snapshots.server.close();
  snapshots.clean();
  dashboard.close();
  await browser.close();
  return 0;
}

main().then(code => process.exitCode = code).catch(() => {
  console.error('Guardian Eye could not start; check the local settings and dependencies.');
  process.exitCode = 1;
});
