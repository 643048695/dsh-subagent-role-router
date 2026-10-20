// Load the plugin's own schema module and prove the new role-pool fields are
// accepted, defaulted and round-trippable — independent of the live process,
// which still has the previous module cached until it reloads.
import assert from 'node:assert/strict'
import test from 'node:test'

const url = new URL('../lib/index.js', import.meta.url)
const mod = await import(url.href)
const Config = mod.Config

// Every settings field is declared volatile, so a resolved config carries live
// `{ get() }` references instead of plain values. Read through the reference.
const read = (value) => {
  const v = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}

test('schema: role pool fields exist with the documented defaults', () => {
  const resolved = Config({})
  assert.deepEqual(read(resolved.exploreModels), [])
  assert.deepEqual(read(resolved.planModels), [])
  assert.deepEqual(read(resolved.patchModels), [])
  assert.equal(read(resolved.roleSlotCooldownSeconds), 15)
})

test('schema: a pool entry without reasoningEffort is accepted (UI shape)', () => {
  // The settings card serialises an entry that names no effort WITHOUT the key.
  // MODEL_ENTRY would reject this; POOL_ENTRY must not.
  const resolved = Config({
    exploreModels: [{ provider: 'p', model: 'm' }],
    planModels: [{ provider: 'p', model: 'm', reasoningEffort: 'high' }],
    patchModels: ['bare-model']
  })
  assert.deepEqual(read(resolved.exploreModels), [{ provider: 'p', model: 'm', reasoningEffort: '' }])
  assert.deepEqual(read(resolved.planModels), [{ provider: 'p', model: 'm', reasoningEffort: 'high' }])
  assert.deepEqual(read(resolved.patchModels), ['bare-model'])
})

test('schema: cooldown 0 survives (0 means disabled, not "unset")', () => {
  assert.equal(read(Config({ roleSlotCooldownSeconds: 0 }).roleSlotCooldownSeconds), 0)
  assert.equal(read(Config({ roleSlotCooldownSeconds: 3600 }).roleSlotCooldownSeconds), 3600)
})

test('schema: the old single-value fields still resolve, for migration', () => {
  const resolved = Config({ roleMode: true, patchProvider: 'legacy', patchModel: 'legacy-m', patchEffort: 'low' })
  assert.equal(read(resolved.patchProvider), 'legacy')
  assert.equal(read(resolved.patchModel), 'legacy-m')
  assert.equal(read(resolved.patchEffort), 'low')
  assert.deepEqual(read(resolved.patchModels), [])
})

test('resolveRolePool is exported and prefers the pool over the legacy triple', () => {
  assert.equal(typeof mod.resolveRolePool, 'function')
  const section = {
    patchProvider: 'legacy', patchModel: 'legacy-m', patchEffort: 'low',
    patchModels: [{ provider: 'a', model: 'a1' }, { provider: 'b', model: 'b2' }]
  }
  // An absent effort is OMITTED, not set to "": that is what the dispatch path
  // expects (it must not inherit the previous route's thinking level).
  assert.deepEqual(read(mod.resolveRolePool(section, 'patch')), [
    { provider: 'a', model: 'a1' },
    { provider: 'b', model: 'b2' }
  ])
  assert.deepEqual(read(mod.resolveRolePool({ patchProvider: 'legacy', patchModel: 'legacy-m', patchEffort: 'low' }, 'patch')), [
    { provider: 'legacy', model: 'legacy-m', reasoningEffort: 'low' }
  ])
  assert.deepEqual(read(mod.resolveRolePool({}, 'patch')), [])
})
