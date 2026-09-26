import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createHash } from 'crypto';
import sharp from 'sharp';
import {
  SmartSpectraSDK,
  breathingMetrics, cardioMetrics, faceMetrics, edaMetrics,
  decodeMetrics,
  ProcessingStatus, ValidationCode, PixelFormat,
} from '@smartspectra/node-sdk';
import { pool } from './src/db.js';
import { scoreReading } from './src/score.js';

// ── Express + WebSocket ───────────────────────────────────────────────────────

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static('public'));
app.use(express.json());

// ── SmartSpectra SDK setup ────────────────────────────────────────────────────

const apiKey = process.env.SMARTSPECTRA_API_KEY;
if (!apiKey) {
  console.error('SMARTSPECTRA_API_KEY not set. Get one at https://physiology.presagetech.com/auth/register');
  process.exit(1);
}

const sdk = new SmartSpectraSDK({
  apiKey,
  requestedMetrics: [...breathingMetrics, ...cardioMetrics, ...faceMetrics, ...edaMetrics],
});

const EXPRESSION_NAMES       = ['unspecified','angry','contempt','disgust','fear','happy','neutral','sad','surprise'];
const PROCESSING_STATUS_NAMES = Object.fromEntries(Object.entries(ProcessingStatus ?? {}).map(([k,v]) => [v,k]));
const VALIDATION_CODE_NAMES   = Object.fromEntries(Object.entries(ValidationCode   ?? {}).map(([k,v]) => [v,k]));

let latestStatus = 'Initializing...';

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

sdk.on('processingStatus', (status) => {
  const name = PROCESSING_STATUS_NAMES[status] ?? status;
  latestStatus = name;
  console.log(`\n[processingStatus] ${name}`);
  broadcast({ type: 'status', status: name });
});

sdk.on('validationStatus', (code, _ts, hint) => {
  const name = VALIDATION_CODE_NAMES[code] ?? code;
  console.log(`\n[validationStatus] ${name} — hint: "${hint}"`);
  broadcast({ type: 'validation', code: name, hint });
});

let metricsCount = 0;

sdk.on('metrics', (buf) => {
  const d = decodeMetrics(buf);
  if (Buffer.isBuffer(d)) return;
  metricsCount++;

  const pr    = d.cardio?.pulseRate?.at(-1);
  const apt   = d.cardio?.arterialPressureTrace?.at(-1);
  const hrv   = d.cardio?.hrv?.at(-1);
  const br    = d.breathing?.rate?.at(-1);
  const amp   = d.breathing?.amplitude?.at(-1);
  const ier   = d.breathing?.inhaleExhaleRatio?.at(-1);
  const apnea = d.breathing?.apnea?.at(-1);
  const blink = d.face?.blinking?.at(-1);
  const talk  = d.face?.talking?.at(-1);
  const expr  = d.face?.expression?.at(-1);
  const eda   = d.eda?.trace?.at(-1);

  let dominantExpression = null;
  if (expr?.scores?.length) {
    const top = [...expr.scores].sort((a,b) => b.confidence - a.confidence)[0];
    dominantExpression = { name: EXPRESSION_NAMES[top.type] ?? 'unknown', confidence: top.confidence };
  }

  const aptSamples   = d.cardio?.arterialPressureTrace ?? [];
  const upperSamples = d.breathing?.upperTrace ?? [];
  const traceWindow  = aptSamples.length
    ? aptSamples.slice(-60).map(s => s.value)
    : upperSamples.slice(-60).map(s => s.value);
  const traceLabel = aptSamples.length ? 'arterial-pressure' : 'chest-movement';

  const line = [
    pr  ? `pulse=${pr.value.toFixed(1)}bpm(${pr.confidence.toFixed(0)}%)`  : 'pulse=--',
    hrv ? `rmssd=${hrv.rmssd.toFixed(1)}`                                   : 'rmssd=--',
    br  ? `breath=${br.value.toFixed(1)}rpm(${br.confidence.toFixed(0)}%)` : 'breath=--',
  ].join('  ');
  process.stdout.write(`\r[#${String(metricsCount).padStart(4)}] ${line}   `);

  broadcast({
    type: 'metrics',
    ts: Date.now(),
    cardio: {
      pulseRate:             pr  ? { value: pr.value,  confidence: pr.confidence,  stable: pr.stable  } : null,
      arterialPressureTrace: apt ? { value: apt.value }                                                   : null,
      hrv: hrv ? { rmssd: hrv.rmssd, sdnn: hrv.sdnn, baevsky: hrv.baevsky, meanNn: hrv.meanNn,
                   confidence: hrv.confidence, stable: hrv.stable } : null,
    },
    breathing: {
      rate:              br    ? { value: br.value,    confidence: br.confidence, stable: br.stable } : null,
      amplitude:         amp   ? { value: amp.value }                                                  : null,
      inhaleExhaleRatio: ier   ? { value: ier.value }                                                  : null,
      apnea:             apnea ? { detected: apnea.detected }                                          : null,
    },
    face: {
      blinking:   blink ? { detected: blink.detected } : null,
      talking:    talk  ? { detected: talk.detected  } : null,
      expression: dominantExpression,
    },
    eda: eda ? { value: eda.value } : null,
    traceWindow,
    traceLabel,
  });
});

sdk.on('error', (code, message, retryable) => {
  console.error(`\nSDK error [${code}]: ${message} (retryable=${retryable})`);
  broadcast({ type: 'error', code, message, retryable });
});

let lastFrameMs = 0;
sdk.on('videoOutput', async (buf, width, height, _stride, pixelFormat) => {
  const now = Date.now();
  if (now - lastFrameMs < 100) return; // 10 fps cap
  lastFrameMs = now;

  const fmtMap = {
    [PixelFormat.kRGB]:  { channels: 3 },
    [PixelFormat.kBGR]:  { channels: 3, swap: true },
    [PixelFormat.kRGBA]: { channels: 4 },
    [PixelFormat.kBGRA]: { channels: 4, swap: true },
  };
  const fmt = fmtMap[pixelFormat] ?? { channels: 3 };

  try {
    let s = sharp(buf, { raw: { width, height, channels: fmt.channels } });
    if (fmt.swap) s = s.toColorspace('srgb');
    const jpeg = await s.jpeg({ quality: 70 }).toBuffer();
    const msg  = JSON.stringify({ type: 'frame', data: jpeg.toString('base64') });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  } catch { /* skip frame on conversion error */ }
});

sdk.useCamera({ fps: 30, width: 1280, height: 720 });
sdk.start();
console.log('SmartSpectra SDK started — measuring from webcam.');

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', status: latestStatus }));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashUser(userId) {
  const salt = process.env.HASH_SALT ?? '';
  return createHash('sha256').update(userId + salt).digest('hex');
}

function validateReading(body) {
  const { userId, lat, lng, pulseRate, breathingRate, confidence, durationSec,
          exercisedRecently, symptoms } = body ?? {};
  if (!userId || typeof userId !== 'string')
    return 'userId must be a non-empty string';
  if (typeof lat !== 'number' || lat < -90 || lat > 90)
    return 'lat must be a number in [-90, 90]';
  if (typeof lng !== 'number' || lng < -180 || lng > 180)
    return 'lng must be a number in [-180, 180]';
  if (typeof pulseRate !== 'number' || pulseRate <= 0)
    return 'pulseRate must be a positive number';
  if (typeof breathingRate !== 'number' || breathingRate <= 0)
    return 'breathingRate must be a positive number';
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1)
    return 'confidence must be a number in [0, 1]';
  if (typeof durationSec !== 'number' || durationSec < 0)
    return 'durationSec must be a non-negative number';
  if (typeof exercisedRecently !== 'boolean')
    return 'exercisedRecently must be a boolean';
  if (typeof symptoms !== 'boolean')
    return 'symptoms must be a boolean';
  return null;
}

// ── API ───────────────────────────────────────────────────────────────────────

app.post('/readings', async (req, res) => {
  const validErr = validateReading(req.body);
  if (validErr) return res.status(400).json({ error: validErr });

  const { userId, lat, lng, pulseRate, breathingRate, confidence, durationSec,
          exercisedRecently, symptoms, hrvMs, baselinePulse } = req.body;

  const result = scoreReading({
    pulseRate, breathingRate, confidence, durationSec,
    exercisedRecently, symptoms,
    hrvMs:         hrvMs        ?? null,
    baselinePulse: baselinePulse ?? null,
  });

  if (!result.highRisk) {
    return res.json({ highRisk: false, score: result.score, reasons: result.reasons });
  }

  // Round to ~100 m before storing
  const roundedLat = Math.round(lat * 1000) / 1000;
  const roundedLng = Math.round(lng * 1000) / 1000;
  const userHash   = hashUser(userId);

  try {
    const dedup = await pool.query(
      `SELECT 1 FROM risk_events
       WHERE user_hash = $1 AND time > NOW() - INTERVAL '12 hours'
       LIMIT 1`,
      [userHash],
    );

    if (dedup.rows.length === 0) {
      await pool.query(
        `INSERT INTO risk_events (time, user_hash, location, score, pulse_rate, breathing_rate, hrv_ms)
         VALUES (NOW(), $1, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4, $5, $6, $7)`,
        [userHash, roundedLat, roundedLng, result.score, pulseRate, breathingRate, hrvMs ?? null],
      );
    }
  } catch (e) {
    console.error('[db] insert error:', e.message);
    return res.status(500).json({ error: 'Database error' });
  }

  return res.json({ highRisk: true, score: result.score, reasons: result.reasons });
});

app.get('/risk-areas', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ST_Y(ST_SnapToGrid(location::geometry, 0.005)) AS lat,
        ST_X(ST_SnapToGrid(location::geometry, 0.005)) AS lng,
        COUNT(DISTINCT user_hash)                       AS people,
        AVG(score)                                      AS "avgScore",
        MAX(time)                                       AS "lastSeen"
      FROM risk_events
      WHERE time > NOW() - INTERVAL '7 days'
      GROUP BY ST_SnapToGrid(location::geometry, 0.005)
      HAVING COUNT(DISTINCT user_hash) >= 1
    `);
    res.json(rows.map(r => ({
      lat:      r.lat,
      lng:      r.lng,
      people:   Number(r.people),
      avgScore: parseFloat(r.avgScore),
      lastSeen: r.lastSeen,
    })));
  } catch (e) {
    console.error('[db] risk-areas error:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => console.log(`Viralense running at http://localhost:${PORT}`));

process.on('uncaughtException', (err) => {
  console.error('\n[crash] Uncaught exception:', err.message);
  console.error('[crash] This is usually a native SDK frame-size mismatch. Restart the server.');
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\nStopping...');
  await sdk.stopAsync();
  await sdk.destroy();
  process.exit(0);
});
