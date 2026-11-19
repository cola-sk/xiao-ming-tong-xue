const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.join(__dirname, '..');
function loader(overrides = {}, clock = Date) {
  const cache = new Map();
  const env = { NODE_ENV: 'test', PET_SESSION_SECRET: 'test-session-secret-'.repeat(3), PET_FAMILY_USERNAME: 'parent', PET_FAMILY_PASSWORD: 'test-password-123' };
  function load(file) {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(source, {
      exports: module.exports, module, process: { env }, Buffer, console, Date: clock, URL, TextEncoder,
      crypto: require('node:crypto').webcrypto,
      require: name => {
        if (name in overrides) return overrides[name];
        if (name === 'server-only') return {};
        if (name === './neonDb' || name === '@/server/neonDb') return { getNeonSql: () => null, ensureNeonSchema: async () => {} };
        if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
        if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name) + '.ts');
        return require(name);
      },
    }, { filename: file });
    return module.exports;
  }
  return load;
}
const secret = 'ab'.repeat(32);
const other = 'cd'.repeat(32);
const req = (url, body, token) => new (require('next/server').NextRequest)(`https://example.test${url}`, {
  method: body === undefined ? 'GET' : 'POST', headers: token === undefined ? {} : { 'x-pet-device-token': token },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('physical code approval issues a unique token only to the setup proof; delivery survives retry', async () => {
  const api = loader()('src/server/devicePairing.ts');
  const started = await api.startPairing('device_one', secret);
  assert.match(started.code, /^\d{8}$/);
  assert.equal((await api.startPairing('device_one', secret)).code, started.code);
  await assert.rejects(api.startPairing('device_one', other), e => e.status === 409);
  assert.equal((await api.pollPairing('device_one', secret)).status, 'pending');
  await assert.rejects(api.pollPairing('device_one', other), e => e.status === 401);
  const [a,b] = await Promise.allSettled([api.claimPairing(started.code, 'One', 'Child'), api.claimPairing(started.code, 'Two', 'Other')]);
  assert.equal([a,b].filter(r => r.status === 'fulfilled').length, 1);
  const received = await api.pollPairing('device_one', secret);
  assert.equal(received.status, 'paired'); assert.match(received.token, /^[a-f0-9]{64}$/);
  assert.notEqual(received.token, secret);
  assert.equal((await api.pollPairing('device_one', secret)).token, received.token);
  assert.equal(await api.authenticateDeviceToken(received.token), 'device_one');
  assert.equal(await api.authenticateDeviceToken(secret), null);
  assert.equal(await api.authenticateDeviceToken('shared-legacy-token'), null);
  await assert.rejects(api.startPairing('device_one', secret), e => e.status === 409);
  const second = await api.startPairing('device_two', other); await api.claimPairing(second.code, '', '');
  assert.notEqual((await api.pollPairing('device_two', other)).token, received.token);
});

test('expiry, revoked tokens, revoked deliveries and rebinding fail closed', async () => {
  let now = Date.now();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const api = loader({}, Clock)('src/server/devicePairing.ts');
  const first = await api.startPairing('device_expire', secret);
  now += 600001;
  await assert.rejects(api.claimPairing(first.code, '', ''), e => e.status === 409);
  await assert.rejects(api.pollPairing('device_expire', secret), e => e.status === 410);
  const next = await api.startPairing('device_expire', other); await api.claimPairing(next.code, '', '');
  const token = (await api.pollPairing('device_expire', other)).token;
  await api.revokeDeviceCredential('device_expire');
  assert.equal(await api.authenticateDeviceToken(token), null);
  await assert.rejects(api.pollPairing('device_expire', other), e => e.status === 401);
  const rebound = await api.startPairing('device_expire', secret); await api.claimPairing(rebound.code, '', '');
  assert.notEqual((await api.pollPairing('device_expire', secret)).token, token);
  await api.limitPairing('bad-claims', 1);
  await assert.rejects(api.limitPairing('bad-claims', 1), e => e.status === 429);
});

test('all device routes validate credentials before reading or writing business data', async () => {
  const accessed = [];
  const reject = async () => ({ deviceId: null, error: require('next/server').NextResponse.json({ error: 'invalid' }, { status: 401 }) });
  const load = loader({
    '@/server/deviceAccess': { deviceAccess: reject },
    '@/server/appDataStore': new Proxy({}, { get: (_, key) => async () => { accessed.push(key); throw Error('unauthorized access'); } }),
    '@/server/deviceStore': { upsertDeviceHeartbeat: async () => { accessed.push('heartbeat'); } },
    '@/server/doubaoVoice': {}, '../../../../server/doubaoVoice': {},
    '@/server/audioStore': { getAudioByMd5: async () => { accessed.push('audio'); } },
  });
  for (const [route, method, body, params] of [
    ['device/sync','POST',{ deviceId: 'other' }], ['chat/messages','POST',{ deviceId:'other', direction:'device_to_parent', asrText:'test' }],
    ['chat/messages','GET'], ['ai/chat','POST',{ deviceId:'other' }], ['schedules','GET'], ['tts','POST',{text:'test'}],
    ['chat/messages/[id]/audio','GET',undefined,{ id:'other' }], ['audio/[md5]','GET',undefined,{ md5:'test' }],
  ]) {
    const response = await load(`src/app/api/v1/${route}/route.ts`)[method](req(`/api/v1/${route}`, body, secret), { params });
    assert.equal(response.status,401,route);
  }
  assert.deepEqual(accessed, []);
});

test('device access rejects impersonation and missing/revoked credentials; household config needs no shared token', async () => {
  const load = loader(); const api = load('src/server/devicePairing.ts');
  const started = await api.startPairing('device_scope',secret); await api.claimPairing(started.code,'','');
  const token = (await api.pollPairing('device_scope',secret)).token;
  const { deviceAccess } = load('src/server/deviceAccess.ts');
  assert.equal((await deviceAccess(req('/test',undefined,token),'device_scope')).deviceId,'device_scope');
  assert.equal((await deviceAccess(req('/test',undefined,token),'other')).error.status,403);
  assert.equal((await deviceAccess(req('/test',undefined,'bad'))).error.status,401);
  assert.equal((await deviceAccess(req('/test'))).deviceId,null);
  assert.equal(load('src/server/familyAuth.ts').authConfigured(),true);
  await api.revokeDeviceCredential('device_scope');
  assert.equal((await deviceAccess(req('/test',undefined,token))).error.status,401);
});

test('message audio and playback acknowledgements stay scoped to their device', async () => {
  const api = loader()('src/server/appDataStore.ts');
  await api.createChatMessage({ id:'message_a', deviceId:'device_a', direction:'parent_to_device', senderName:'Parent', durationSec:3, asrText:'test', autoPlay:false, audioBase64:Buffer.from('audio').toString('base64'), audioMime:'audio/wav' });
  assert.ok(await api.getTransientChatAudio('message_a','device_a'));
  assert.equal(await api.getTransientChatAudio('message_a','device_b'),null);
  await api.markChatMessagePlayed('message_a','device_b');
  assert.ok(await api.getTransientChatAudio('message_a','device_a'));
  await api.markChatMessagePlayed('message_a','device_a');
  assert.equal(await api.getTransientChatAudio('message_a','device_a'),null);
});
