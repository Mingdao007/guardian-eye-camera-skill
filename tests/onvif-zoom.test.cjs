'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {createHash} = require('crypto');
const zoom = require('../skills/guardian-eye-cameras/scripts/onvif-zoom.cjs');

test('ONVIF zoom uses a valid digest and verifies position by readback', async () => {
  const credential = {username:'test-user', password:'test-password'};
  let position = 0, requests = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8'); requests++;
      try {
        assert.equal(body.includes(credential.password), false);
        const field = name => body.match(new RegExp(`<wsse:${name}[^>]*>([^<]+)</wsse:${name}>`))[1];
        const created = body.match(/<wsu:Created>([^<]+)<\/wsu:Created>/)[1];
        const expected = createHash('sha1').update(Buffer.from(field('Nonce'), 'base64')).update(created).update(credential.password).digest('base64');
        assert.equal(field('Password'), expected);
        const move = body.match(/<tt:Zoom x="([0-9.]+)"/);
        if (move) position = Number(move[1]);
        res.writeHead(200, {'Content-Type':'application/soap+xml'});
        res.end(`<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body><tt:Zoom x="${position}"/></s:Body></s:Envelope>`);
      } catch (error) { res.writeHead(500).end(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const camera = {address:'127.0.0.1', onvifPort:server.address().port};
    assert.equal(await zoom.read(camera, credential), 0);
    assert.equal(await zoom.move(camera, credential, 0.2), 0.2);
    assert.equal(requests, 3);
    await assert.rejects(() => zoom.move(camera, credential, 1.1));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
