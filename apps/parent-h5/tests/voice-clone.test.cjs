const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');

function load(file, mocks, extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const context = { exports, module: { exports }, require: name => {
    if (name in mocks) return mocks[name];
    return require(name);
  }, process, Buffer, AbortSignal, console, Error, ...extra };
  vm.runInNewContext(code, context, { filename: file });
  return context.module.exports;
}

const next = { NextResponse: { json: (body, options) => ({ body, status: options?.status || 200 }) } };
const request = body => ({ json: async () => body });
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]).toString('base64');
const mp3 = Buffer.from('ID3sample').toString('base64');
const base = { speakerId: 'S_valid123', speakerRole: '妈妈', audioFormat: 'wav', audioBase64: wav };

function route(provider = {}, store = {}) {
  return load('src/app/api/v1/voice-clone/route.ts', {
    'next/server': next,
    '@/server/doubaoVoice': {
      isDoubaoConfigured: () => true,
      uploadDoubaoVoiceClone: async p => ({ speakerId: p.speakerId }),
      getDoubaoVoiceCloneStatus: async speakerId => ({ speakerId, status: 2 }),
      ...provider,
    },
    '@/server/appDataStore': {
      saveVoiceCloneProfile: async p => ({ id: 'clone_1', ...p }),
      updateVoiceCloneStatus: async () => {},
      listVoiceCloneProfiles: async () => [],
      deleteVoiceCloneProfileById: async () => {},
      ...store,
    },
  });
}

test('uploads real WAV/MP3 formats and keeps unknown training state pending', async () => {
  const seen = [];
  const api = route({ uploadDoubaoVoiceClone: async p => { seen.push(p.audioFormat); return { speakerId: p.speakerId }; } });
  const a = await api.POST(request(base));
  const b = await api.POST(request({ ...base, audioFormat: 'mp3', audioBase64: mp3 }));
  assert.equal(a.status, 200); assert.equal(a.body.profile.status, 'training');
  assert.equal(b.status, 200); assert.deepEqual(seen, ['wav', 'mp3']);
});

test('rejects missing pre-provisioned ID, mismatched formats and invalid base64', async () => {
  const api = route();
  for (const body of [{ ...base, speakerId: '' }, { ...base, audioFormat: 'mp3' }, { ...base, audioBase64: '!!!' }]) {
    assert.equal((await api.POST(request(body))).status, 400);
  }
});

test('upstream failure is visible and does not save a profile', async () => {
  let saved = false;
  const api = route({ uploadDoubaoVoiceClone: async () => { throw new Error('provider failed'); } }, { saveVoiceCloneProfile: async () => { saved = true; } });
  const response = await api.POST(request(base));
  assert.equal(response.status, 502); assert.equal(saved, false); assert.match(response.body.error, /provider failed/);
});

test('status query persists the provider result', async () => {
  let status;
  const api = route({ getDoubaoVoiceCloneStatus: async speakerId => ({ speakerId, status: 3 }) }, { updateVoiceCloneStatus: async (_id, value) => { status = value; } });
  const response = await api.GET({ nextUrl: new URL('http://localhost/api/v1/voice-clone?speakerId=S_valid123') });
  assert.equal(response.status, 200); assert.equal(status, 'failed');
});

test('V3 client sends documented endpoints and rejects business errors', async () => {
  const calls = [];
  const previous = process.env.DOUBAO_SPEECH_API_KEY;
  process.env.DOUBAO_SPEECH_API_KEY = 'test-only';
  try {
    const api = load('src/server/doubaoVoice.ts', { 'server-only': {}, 'node:crypto': crypto, './audioStore': {} }, {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ speaker_id: 'S_valid123', status: 2 }) };
      },
    });
    await api.uploadDoubaoVoiceClone({ speakerId: 'S_valid123', audioBase64: mp3, audioFormat: 'mp3' });
    await api.getDoubaoVoiceCloneStatus('S_valid123');
    assert.match(calls[0].url, /\/api\/v3\/tts\/voice_clone$/);
    assert.equal(JSON.parse(calls[0].options.body).audio.format, 'mp3');
    assert.ok(calls[0].options.headers['X-Api-Request-Id']);
    assert.match(calls[1].url, /\/api\/v3\/tts\/get_voice$/);
    const failed = load('src/server/doubaoVoice.ts', { 'server-only': {}, 'node:crypto': crypto, './audioStore': {} }, {
      fetch: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ code: 45001109, message: 'invalid audio' }) }),
    });
    await assert.rejects(failed.getDoubaoVoiceCloneStatus('S_valid123'), /invalid audio/);
  } finally {
    if (previous === undefined) delete process.env.DOUBAO_SPEECH_API_KEY; else process.env.DOUBAO_SPEECH_API_KEY = previous;
  }
});

test('reports accepted training when profile storage fails without retrying provider', async () => {
  let uploads = 0;
  const api = route({ uploadDoubaoVoiceClone: async p => { uploads++; return { speakerId: p.speakerId }; } }, { saveVoiceCloneProfile: async () => { throw new Error('database down'); } });
  const response = await api.POST(request(base));
  assert.equal(response.status, 500); assert.equal(uploads, 1);
  assert.match(response.body.error, /音频已提交/);
  assert.match(response.body.error, /S_valid123/);
});

test('TTS rejects an unready clone before generating audio', async () => {
  let syntheses = 0;
  const api = load('src/app/api/v1/tts/route.ts', {
    'next/server': next,
    '../../../../server/doubaoVoice': {
      isDoubaoConfigured: () => true,
      getDoubaoVoiceCloneStatus: async () => ({ status: 1 }),
      synthesizeDoubaoTts: async () => { syntheses++; return {}; },
    },
  });
  const response = await api.POST(request({ text: '你好', voiceType: 'S_valid123', isClonedVoice: true }));
  assert.equal(response.status, 409); assert.equal(syntheses, 0);
});
