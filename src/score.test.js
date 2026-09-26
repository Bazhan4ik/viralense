import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreReading } from './score.js';

const base = {
  pulseRate:        72,
  breathingRate:    16,
  hrvMs:            45,
  confidence:       0.85,
  durationSec:      45,
  exercisedRecently: false,
  symptoms:         false,
  baselinePulse:    null,
};

test('normal reading — score 0, valid, not high risk', () => {
  const r = scoreReading(base);
  assert.equal(r.score, 0);
  assert.equal(r.valid, true);
  assert.equal(r.highRisk, false);
  assert.deepEqual(r.reasons, []);
});

test('borderline at exactly score 4 — high risk', () => {
  // pulse 91-100 (+1) + breathing 21-24 (+1) + symptoms (+2) = 4
  const r = scoreReading({ ...base, pulseRate: 95, breathingRate: 22, symptoms: true });
  assert.equal(r.score, 4);
  assert.equal(r.highRisk, true);
  assert.equal(r.valid, true);
});

test('low-confidence reading — invalid, score 0', () => {
  const r = scoreReading({ ...base, confidence: 0.5 });
  assert.equal(r.valid, false);
  assert.equal(r.score, 0);
  assert.equal(r.highRisk, false);
  assert.ok(r.reasons[0].includes('confidence'));
});

test('exercised-recently reading — invalid, score 0 even with high pulse', () => {
  const r = scoreReading({ ...base, exercisedRecently: true, pulseRate: 130 });
  assert.equal(r.valid, false);
  assert.equal(r.score, 0);
  assert.equal(r.highRisk, false);
});

test('symptoms-only reading — score 2, valid, not high risk', () => {
  const r = scoreReading({ ...base, symptoms: true });
  assert.equal(r.score, 2);
  assert.equal(r.valid, true);
  assert.equal(r.highRisk, false);
  assert.ok(r.reasons.includes('self-reported symptoms'));
});
