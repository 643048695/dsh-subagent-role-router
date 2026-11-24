import test from 'node:test';
import assert from 'node:assert/strict';
import { isTeamAgent, isExemptAgent } from '../lib/index.js';

// The installed rc.5 Session exposes seq as the NEXT log offset (log.length),
// rather than as the sequence of the last event. Keep the real host convention
// covered as well as the older inclusive-cursor fixtures.
test('next-offset host cursor reads only the appended tail of a long session', () => {
  const events = Array.from({ length: 10000 }, (_, seq) => ({
    seq,
    type: seq === 1 ? 'subagent/descriptor' : 'turn/start',
    data: seq === 1 ? { label: 'worker', persona: '' } : {}
  }));
  let reads = 0;
  let snapshots = 0;
  const session = {
    header: { origin: 'subagent' },
    inheritedEventCount: 0,
    get seq() { return events.length; },
    eventAt(seq) { reads += 1; return events[seq]; },
    snapshotEvents() { snapshots += 1; throw new Error('do not copy the long log'); }
  };
  const agent = { session };
  assert.equal(isTeamAgent(agent), false);
  const cold = reads;
  assert.ok(cold <= events.length + 2, 'the initial projection reads the log at most once');
  for (let i = 0; i < 20; i += 1) {
    events.push({ seq: events.length, type: 'tool/result', data: {} });
    assert.equal(isTeamAgent(agent), false);
  }
  assert.ok(reads - cold <= 60, '20 appends need only a bounded number of tail reads, not 20 full scans');
  events.push({ seq: events.length, type: 'subagent/descriptor', data: { label: 'protected-worker', persona: 'AgentTeams' } });
  assert.equal(isTeamAgent(agent), true);
  assert.equal(isExemptAgent({ getSection: () => ({ exemptRules: [{ match: 'label', pattern: 'protected-' }] }) }, agent), true);
  assert.equal(snapshots, 0);
});
