import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, configuredProviders, settingsSnapshot } from '../src/config.ts'

test('DSH settings default to explicit settings source and keep credentials out of provider metadata', () => {
  const config = Config({ ark: { apiKey: 'test-only-key', imageModel: 'image-example', videoModel: 'video-example' }, tts: { apiKey: 'test-only-voice', model: 'tts-example', voice: 'narrator' } })
  assert.equal(settingsSnapshot(config).source, 'settings')
  const providers = configuredProviders(config, { DSH_VIDEO_ARK_API_KEY: 'ignored-environment-key', DSH_VIDEO_ARK_VIDEO_MODEL: 'ignored-model' })
  assert.deepEqual(providers.map(p => p.configured), [true, true])
  assert.equal(providers[0].models.video, 'video-example')
  assert.ok(!JSON.stringify(providers).includes('test-only-key'))
  assert.ok(!JSON.stringify(providers).includes('test-only-voice'))
  assert.ok(!JSON.stringify(providers).includes('ignored-environment-key'))
  assert.equal(configuredProviders(Config({}), { DSH_VIDEO_ARK_API_KEY: 'environment-key', DSH_VIDEO_ARK_VIDEO_MODEL: 'environment-model' })[0].configured, false, 'An empty settings key must not silently fall back to another account')
})

test('environment mode is explicit and preserves the existing server configuration route', () => {
  const providers = configuredProviders(Config({ source: 'environment', ark: { apiKey: 'ignored-key', videoModel: 'ignored-model' } }), {
    DSH_VIDEO_ARK_API_KEY: 'environment-key', DSH_VIDEO_ARK_VIDEO_MODEL: 'environment-model',
    DSH_VIDEO_TTS_API_KEY: 'voice-key', DSH_VIDEO_TTS_MODEL: 'voice-model', DSH_VIDEO_TTS_VOICE: 'voice',
  })
  assert.equal(providers[0].models.video, 'environment-model')
  assert.equal(providers[1].models.audio, 'voice-model')
  assert.deepEqual(providers.map(p => p.configured), [true, true])
})

test('settings schema rejects invalid durations, source modes and endpoints with embedded credentials', () => {
  for (const value of [[], [0], [1.5], [121]]) assert.throws(() => Config({ ark: { videoDurations: value } }))
  assert.throws(() => Config({ source: 'mixed' } as never))
  for (const baseUrl of ['file:///tmp/api', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret']) assert.throws(() => Config({ ark: { baseUrl } }))
  assert.deepEqual(settingsSnapshot(Config({})).ark.videoDurations, [5, 10])
})
