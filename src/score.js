export const THRESHOLDS = Object.freeze({
  MIN_CONFIDENCE:       0.7,
  MIN_DURATION_SEC:     30,
  PULSE_HIGH:           100,  // > 100 bpm  → +2
  PULSE_ELEVATED:       91,   // 91-100 bpm → +1
  BREATHING_HIGH:       24,   // > 24 rpm   → +2
  BREATHING_ELEVATED:   21,   // 21-24 rpm  → +1
  HRV_LOW:              20,   // < 20 ms    → +1
  PULSE_ABOVE_BASELINE: 15,   // pulse >= baseline + 15 → +1
  HIGH_RISK_SCORE:      4,
});

export function scoreReading({
  pulseRate, breathingRate, hrvMs, confidence, durationSec,
  exercisedRecently, symptoms, baselinePulse,
}) {
  if (confidence < THRESHOLDS.MIN_CONFIDENCE)
    return { score: 0, valid: false, highRisk: false, reasons: ['confidence below threshold'] };
  if (durationSec < THRESHOLDS.MIN_DURATION_SEC)
    return { score: 0, valid: false, highRisk: false, reasons: ['measurement too short'] };
  if (exercisedRecently)
    return { score: 0, valid: false, highRisk: false, reasons: ['exercised recently — reading unreliable'] };

  let score = 0;
  const reasons = [];

  if (pulseRate > THRESHOLDS.PULSE_HIGH) {
    score += 2; reasons.push('elevated pulse (>100 bpm)');
  } else if (pulseRate >= THRESHOLDS.PULSE_ELEVATED) {
    score += 1; reasons.push('slightly elevated pulse (91–100 bpm)');
  }

  if (breathingRate > THRESHOLDS.BREATHING_HIGH) {
    score += 2; reasons.push('elevated breathing rate (>24 rpm)');
  } else if (breathingRate >= THRESHOLDS.BREATHING_ELEVATED) {
    score += 1; reasons.push('slightly elevated breathing rate (21–24 rpm)');
  }

  if (hrvMs != null && hrvMs < THRESHOLDS.HRV_LOW) {
    score += 1; reasons.push('low HRV (<20 ms)');
  }

  if (baselinePulse != null && pulseRate >= baselinePulse + THRESHOLDS.PULSE_ABOVE_BASELINE) {
    score += 1; reasons.push('pulse elevated above personal baseline');
  }

  if (symptoms) {
    score += 2; reasons.push('self-reported symptoms');
  }

  return { score, valid: true, highRisk: score >= THRESHOLDS.HIGH_RISK_SCORE, reasons };
}
