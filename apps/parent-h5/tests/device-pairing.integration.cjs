// Run against a local Next server: PAIRING_INTEGRATION=1 node --test tests/device-pairing.integration.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const enabled = process.env.PAIRING_INTEGRATION === '1';
test('HTTP + PostgreSQL pairing, concurrent claim, device scoping and revocation', { skip: !enabled }, async () => {
  process.loadEnvFile('.env.local');
  const origin = process.env.PAIRING_TEST_ORIGIN || 'http://localhost:5190';
  const deviceId = `pairing_test_${randomBytes(8).toString('hex')}`;
  const setupSecret = randomBytes(32).toString('hex');
  let cookie;
  async function call(path, body, options = {}) {
    const response = await fetch(`${origin}/api/v1/${path}`, {
      method: options.method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', Origin: origin, ...(options.parent ? { Cookie: cookie } : {}), ...(options.token ? { 'X-Pet-Device-Token': options.token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    return { status: response.status, json, response };
  }
  const sql = require('@neondatabase/serverless').neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  try {
    const login = await call('auth', { username: process.env.PET_FAMILY_USERNAME, password: process.env.PET_FAMILY_PASSWORD });
    assert.equal(login.status, 200);
    cookie = login.response.headers.get('set-cookie').split(';')[0];
    const start = await call('device/pairing/start', { deviceId, setupSecret });
    assert.equal(start.status, 200); assert.match(start.json.code,/^\d{8}$/);
    const code = start.json.code;
    assert.equal((await call('device/pairing/poll', { deviceId, setupSecret })).json.status,'pending');
    assert.equal((await call('device/pairing/poll', { deviceId, setupSecret: randomBytes(32).toString('hex') })).status,401);
    assert.equal((await call('device/pairing/claim', { code })).status,401);
    const results = await Promise.all([call('device/pairing/claim', { code, alias:'Integration device' },{ parent:true }),call('device/pairing/claim', { code, alias:'Other claim' },{ parent:true })]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    assert.equal(results.find(r=>r.status===200).json.device.id,deviceId);
    const delivery = await call('device/pairing/poll',{ deviceId, setupSecret });
    assert.equal(delivery.status,200); const token = delivery.json.token;
    assert.match(token,/^[a-f0-9]{64}$/);
    assert.equal((await call('device/pairing/poll',{ deviceId, setupSecret })).json.token,token);
    assert.equal((await call('device/sync',{ deviceId,event:'heartbeat',firmwareVersion:'pairing-integration' },{ token })).status,200);
    assert.equal((await call('device/sync',{ deviceId:'other_device',event:'heartbeat' },{ token })).status,403);
    assert.equal((await call('chat/messages?deviceId=all',undefined,{ token })).status,403);
    assert.equal((await call('chat/messages?deviceId='+deviceId,undefined,{ token })).status,200);
    assert.equal((await call('chat/messages',{deviceId,direction:'parent_to_device',asrText:'forbidden'},{token})).status,403);
    if (process.env.PET_DEVICE_TOKEN) assert.equal((await call('device/sync',{deviceId},{token:process.env.PET_DEVICE_TOKEN})).status,401);
    const rows = await sql`SELECT token_hash FROM device_credentials WHERE device_id = ${deviceId}`;
    assert.equal(rows.length,1); assert.notEqual(rows[0].token_hash,token);
    assert.equal((await call('device/status?deviceId='+deviceId,undefined,{parent:true,method:'DELETE'})).status,200);
    assert.equal((await call('device/sync',{deviceId},{token})).status,401);
    assert.equal((await call('device/pairing/poll',{deviceId,setupSecret})).status,401);
  } finally {
    await sql`DELETE FROM device_pairing_sessions WHERE device_id = ${deviceId}`;
    await sql`DELETE FROM device_credentials WHERE device_id = ${deviceId}`;
    await sql`DELETE FROM devices WHERE id = ${deviceId}`;
  }
});
