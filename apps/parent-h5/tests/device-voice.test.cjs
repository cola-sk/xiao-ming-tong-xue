const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { NextRequest, NextResponse } = require('next/server');
function loader(overrides = {}, env = {}, fetchImpl = async () => { throw Error('unexpected network'); }) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(__dirname, '..', file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(source, { exports: module.exports, module, process: { env }, Buffer, console, Date, URL, TextEncoder, AbortSignal, fetch: fetchImpl,
      require: name => {
        if (name in overrides) return overrides[name];
        if (name === 'server-only') return {};
        if (name === './neonDb' || name === '@/server/neonDb') return { getNeonSql: () => null, ensureNeonSchema: async () => {} };
        if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
        if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name) + '.ts');
        return require(name);
      },
    }, { filename: file }); return module.exports;
  } return load;
}
const req = body => new NextRequest('https://example.test/api/v1/ai/chat', { method: 'POST', body: JSON.stringify(body) });
const validWav = Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(40)]).toString('base64');
test('retry keeps the original audio, produces one message, and never resurrects played audio', async () => {
  const store = loader()('src/server/appDataStore.ts');
  const input = { id: 'retry-one', deviceId: 'child-one', direction: 'device_to_parent', senderName: 'Child', durationSec: 3, asrText: '', autoPlay: false, audioBase64: validWav, audioMime: 'audio/wav' };
  const [first, second] = await Promise.all([store.createChatMessage(input), store.createChatMessage({ ...input, audioBase64: 'changed' })]);
  assert.equal(first.id, second.id);
  assert.equal((await store.listChatMessages({ deviceId: 'child-one' })).length, 1);
  assert.equal((await store.getTransientChatAudio(input.id)).buffer.toString('base64'), validWav);
  await store.markChatMessagePlayed(input.id);
  assert.equal((await store.createChatMessage(input)).status, 'played');
  assert.equal(await store.getTransientChatAudio(input.id), null);
  await assert.rejects(store.createChatMessage({ ...input, deviceId: 'child-two' }), store.ChatMessageConflictError);
  await assert.rejects(store.createChatMessage({ ...input, direction: 'parent_to_device' }), store.ChatMessageConflictError);
});
test('ASR validates audio before calling the provider and returns its transcript', async () => {
  let calls = 0;
  const load = loader({ './doubaoVoice': { getDoubaoConfig: () => ({ apiKey: 'fixture-key' }) } }, {}, async (url, options) => {
    calls++; assert.match(url, /recognize\/flash$/); assert.equal(options.headers['X-Api-Key'], 'fixture-key');
    assert.equal(JSON.parse(options.body).audio.data, validWav);
    return new Response(JSON.stringify({ result: { text: '太阳为什么会发光？' } }), { headers: { 'X-Api-Status-Code': '20000000' } });
  });
  const asr = load('src/server/speechRecognition.ts');
  await assert.rejects(asr.transcribeDeviceAudio(validWav, 'audio/aac'), e => e.status === 400);
  await assert.rejects(asr.transcribeDeviceAudio('aGVsbG8=', 'audio/wav'), e => e.status === 400);
  assert.equal(calls, 0);
  assert.equal(await asr.transcribeDeviceAudio(validWav, 'audio/wav'), '太阳为什么会发光？');
});
test('ASR silence, denied credentials and broken connections remain actionable failures', async () => {
  for (const [status, code, expected] of [[200, '20000003', 422], [403, '45000000', 503], [200, '50000000', 502]]) {
    const asr = loader({ './doubaoVoice': { getDoubaoConfig: () => ({ apiKey: 'fixture' }) } }, {}, async () => new Response('{}', { status, headers: { 'X-Api-Status-Code': code } }))('src/server/speechRecognition.ts');
    await assert.rejects(asr.transcribeDeviceAudio(validWav, 'audio/wav'), e => e.status === expected);
  }
});
function ai(overrides = {}, env = { ARK_API_KEY: 'fixture' }, fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '因为太阳内部正在发生核聚变。' } }] }))) {
  return loader({
    '@/server/deviceAccess': { deviceAccess: async () => ({ deviceId: 'child' }) },
    '@/server/appDataStore': { getPetAiConfig: async () => ({}), appendAiChatLog: async x => ({ ...x, id: 'log' }) },
    '@/server/speechRecognition': { transcribeDeviceAudio: async () => '太阳为什么会发光？', SpeechRecognitionError: class extends Error {} },
    '@/server/doubaoVoice': { isDoubaoConfigured: () => true, synthesizeDoubaoTts: async () => ({ audioBase64: Buffer.from('ID3mp3-fixture').toString('base64') }) },
    ...overrides,
  }, env, fetchImpl)('src/app/api/v1/ai/chat/route.ts');
}
test('AI voice request uses ASR transcript, returns binary MP3 and logs text only', async () => {
  let log;
  const api = ai({ '@/server/appDataStore': { getPetAiConfig: async () => ({}), appendAiChatLog: async x => { log = x; return { id: 'log' }; } } });
  const response = await api.POST(req({ deviceId: 'child', audioBase64: validWav, audioMime: 'audio/wav', responseFormat: 'mp3' }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(decodeURIComponent(response.headers.get('X-Pet-Question')), '太阳为什么会发光？');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'ID3mp3-fixture');
  assert.equal(log.childText, '太阳为什么会发光？'); assert.equal(log.audioBase64, undefined);
});
test('AI never returns a fake MP3 when LLM or TTS fails or credentials are missing', async () => {
  const cases = [
    [ai({}, {}), 503],
    [ai({}, undefined, async () => new Response('{}', { status: 503 })), 502],
    [ai({ '@/server/doubaoVoice': { isDoubaoConfigured: () => false } }), 502],
  ];
  for (const [api, status] of cases) {
    const response = await api.POST(req({ deviceId: 'child', question: '你好', responseFormat: 'mp3' }));
    assert.equal(response.status, status); assert.match(response.headers.get('content-type'), /json/);
  }
});
test('AI authenticates before spending ASR or model calls', async () => {
  let called = false;
  const api = ai({ '@/server/deviceAccess': { deviceAccess: async () => ({ error: NextResponse.json({ error: 'denied' }, { status: 401 }) }) }, '@/server/speechRecognition': { transcribeDeviceAudio: async () => { called = true; }, SpeechRecognitionError: class extends Error {} } });
  assert.equal((await api.POST(req({ audioBase64: validWav, responseFormat: 'mp3' }))).status, 401); assert.equal(called, false);
});
