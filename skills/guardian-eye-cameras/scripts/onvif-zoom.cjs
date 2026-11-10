'use strict';

// Guardian Eye exposes source-side digital zoom through ONVIF on the local
// network. WS-Security UsernameToken PasswordDigest is required by the camera.
const http = require('http');
const {createHash, randomBytes} = require('crypto');
const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function soap(camera, credentials, operation) {
  const nonce = randomBytes(20), created = new Date().toISOString();
  const digest = createHash('sha1').update(nonce).update(created).update(credentials.password).digest('base64');
  const body = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><s:Header><wsse:Security s:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${escape(credentials.username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header><s:Body>${operation}</s:Body></s:Envelope>`;
  return new Promise((resolve, reject) => {
    const req = http.request({host:camera.address, port:camera.onvifPort || 8080, path:'/onvif/ptz_service', method:'POST', timeout:6000,
      headers:{'Content-Type':'application/soap+xml', 'Content-Length':Buffer.byteLength(body)}}, response => {
      const chunks = []; response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const xml = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200 || /<(?:\w+:)?Fault\b/.test(xml)) reject(new Error('ONVIF request failed'));
        else resolve(xml);
      });
      response.once('error', reject);
    });
    req.once('timeout', () => req.destroy(new Error('ONVIF timed out')));
    req.once('error', reject);
    req.end(body);
  });
}

async function read(camera, credentials) {
  const profile = escape(camera.onvifProfile || 'Profile000');
  const xml = await soap(camera, credentials, `<tptz:GetStatus><tptz:ProfileToken>${profile}</tptz:ProfileToken></tptz:GetStatus>`);
  const m = xml.match(/<(?:\w+:)?Zoom\b[^>]*\bx=["']([^"']+)["']/);
  if (!m || !Number.isFinite(Number(m[1]))) throw new Error('Zoom readback unavailable');
  return Number(m[1]);
}

async function move(camera, credentials, value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Uncalibrated zoom position');
  const profile = escape(camera.onvifProfile || 'Profile000');
  await soap(camera, credentials, `<tptz:AbsoluteMove><tptz:ProfileToken>${profile}</tptz:ProfileToken><tptz:Position><tt:Zoom x="${value}"/></tptz:Position></tptz:AbsoluteMove>`);
  return read(camera, credentials);
}

module.exports = {read, move};
