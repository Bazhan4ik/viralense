import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import sharp from 'sharp';
import {
  SmartSpectraSDK,
  breathingMetrics, cardioMetrics, faceMetrics, edaMetrics,
  decodeMetrics,
  ProcessingStatus, ValidationCode, PixelFormat,
} from '@smartspectra/node-sdk';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('public'));

const apiKey = process.env.SMARTSPECTRA_API_KEY;
if (!apiKey) {
  console.error('Error: SMARTSPECTRA_API_KEY environment variable not set.');
  console.error('Get a key at https://physiology.presagetech.com/auth/register');
  process.exit(1);
}

const sdk = new SmartSpectraSDK({
  apiKey,
  requestedMetrics: [...breathingMetrics, ...cardioMetrics, ...faceMetrics, ...edaMetrics],
});

const EXPRESSION_NAMES = ['unspecified','angry','contempt','disgust','fear','happy','neutral','sad','surprise'];

let latestStatus = 'Initializing...';

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// Map enum numbers to readable names
const PROCESSING_STATUS_NAMES = Object.fromEntries(
  Object.entries(ProcessingStatus ?? {}).map(([k, v]) => [v, k])
);
const VALIDATION_CODE_NAMES = Object.fromEntries(
  Object.entries(ValidationCode ?? {}).map(([k, v]) => [v, k])
);

sdk.on('processingStatus', (status) => {
  const name = PROCESSING_STATUS_NAMES[status] ?? status;
  latestStatus = name;
  console.log(`\n[processingStatus] ${name} (${status})`);
  broadcast({ type: 'status', status: name });
});

sdk.on('validationStatus', (code, timestampUs, hint) => {
  const name = VALIDATION_CODE_NAMES[code] ?? code;
  console.log(`\n[validationStatus] ${name} (${code}) — hint: "${hint}"`);
  broadcast({ type: 'validation', code: name, hint });
});

let metricsCount = 0;

sdk.on('metrics', (buf) => {
  const d = decodeMetrics(buf);
  if (Buffer.isBuffer(d)) {
    console.log('[metrics] decodeMetrics returned a Buffer — skipping');
    return;
  }

  metricsCount++;

  // Log raw structure on first packet and every 30 packets after
  if (metricsCount === 1 || metricsCount % 30 === 0) {
    try {
      const raw = typeof d.toJSON === 'function' ? d.toJSON() : JSON.parse(JSON.stringify(d, replaceLong));
      console.log(`\n[metrics #${metricsCount}] top-level keys:`, Object.keys(raw));
      console.log('[metrics] cardio keys:',    Object.keys(raw.cardio    ?? {}));
      console.log('[metrics] breathing keys:', Object.keys(raw.breathing ?? {}));
      console.log('[metrics] face keys:',      Object.keys(raw.face      ?? {}));
      console.log('[metrics] eda keys:',       Object.keys(raw.eda       ?? {}));
    } catch (e) {
      console.log('[metrics] could not stringify:', e.message);
    }
  }

  // Cardio
  const pr  = d.cardio?.pulseRate?.at(-1);
  const apt = d.cardio?.arterialPressureTrace?.at(-1);
  const hrv = d.cardio?.hrv?.at(-1);

  // Breathing
  const br         = d.breathing?.rate?.at(-1);
  const amp        = d.breathing?.amplitude?.at(-1);
  const ier        = d.breathing?.inhaleExhaleRatio?.at(-1);
  const apnea      = d.breathing?.apnea?.at(-1);
  const upperTrace = d.breathing?.upperTrace?.at(-1);
  const lowerTrace = d.breathing?.lowerTrace?.at(-1);

  // Face
  const blink = d.face?.blinking?.at(-1);
  const talk  = d.face?.talking?.at(-1);
  const expr  = d.face?.expression?.at(-1);
  let dominantExpression = null;
  if (expr?.scores?.length) {
    const top = [...expr.scores].sort((a, b) => b.confidence - a.confidence)[0];
    dominantExpression = { name: EXPRESSION_NAMES[top.type] ?? 'unknown', confidence: top.confidence };
  }

  // EDA
  const eda = d.eda?.trace?.at(-1);

  // Sparkline: prefer arterial pressure trace, fall back to upper breathing trace
  const aptSamples   = d.cardio?.arterialPressureTrace ?? [];
  const upperSamples = d.breathing?.upperTrace ?? [];
  const traceWindow  = aptSamples.length
    ? aptSamples.slice(-60).map(s => s.value)
    : upperSamples.slice(-60).map(s => s.value);
  const traceLabel = aptSamples.length ? 'arterial-pressure' : 'chest-movement';

  // Terminal summary — print every packet
  const line = [
    pr          ? `pulse=${pr.value.toFixed(1)}bpm(${pr.confidence.toFixed(0)}%)`                           : 'pulse=--',
    apt         ? `apt=${apt.value.toFixed(4)}`                                                              : 'apt=--',
    hrv         ? `rmssd=${hrv.rmssd.toFixed(1)}`                                                           : 'rmssd=--',
    br          ? `breath=${br.value.toFixed(1)}bpm(${br.confidence.toFixed(0)}%)`                          : 'breath=--',
    upperTrace  ? `upper=${upperTrace.value.toFixed(4)}`                                                     : 'upper=--',
    amp         ? `amp=${amp.value.toFixed(3)}`                                                              : 'amp=--',
    blink       ? `blink=${blink.detected}`                                                                  : 'blink=--',
    talk        ? `talk=${talk.detected}`                                                                    : 'talk=--',
    dominantExpression ? `expr=${dominantExpression.name}(${dominantExpression.confidence.toFixed(0)}%)` : 'expr=--',
    eda         ? `eda=${eda.value.toFixed(4)}`                                                              : 'eda=--',
  ].join('  ');
  process.stdout.write(`\r[#${String(metricsCount).padStart(4)}] ${line}   `);

  const payload = {
    type: 'metrics',
    ts: Date.now(),
    cardio: {
      pulseRate:             pr  ? { value: pr.value,  confidence: pr.confidence,  stable: pr.stable  } : null,
      arterialPressureTrace: apt ? { value: apt.value }                                                   : null,
      hrv: hrv ? { rmssd: hrv.rmssd, sdnn: hrv.sdnn, baevsky: hrv.baevsky, meanNn: hrv.meanNn, confidence: hrv.confidence, stable: hrv.stable } : null,
    },
    breathing: {
      rate:              br         ? { value: br.value,         confidence: br.confidence, stable: br.stable } : null,
      amplitude:         amp        ? { value: amp.value }                                                       : null,
      inhaleExhaleRatio: ier        ? { value: ier.value }                                                       : null,
      apnea:             apnea      ? { detected: apnea.detected }                                               : null,
      upperTrace:        upperTrace ? { value: upperTrace.value }                                                 : null,
      lowerTrace:        lowerTrace ? { value: lowerTrace.value }                                                 : null,
    },
    face: {
      blinking:   blink ? { detected: blink.detected } : null,
      talking:    talk  ? { detected: talk.detected  } : null,
      expression: dominantExpression,
    },
    eda: eda ? { value: eda.value } : null,
    traceWindow,
    traceLabel,
  };

  broadcast(payload);
});

function replaceLong(key, val) {
  // protobufjs Long objects -> number
  if (val && typeof val === 'object' && typeof val.toNumber === 'function') return val.toNumber();
  return val;
}

sdk.on('error', (code, message, retryable) => {
  console.error(`SDK error [${code}]: ${message} (retryable=${retryable})`);
  broadcast({ type: 'error', code, message, retryable });
});

// Stream video frames to browser — throttled to 10fps to keep WebSocket light
let lastFrameMs = 0;
sdk.on('videoOutput', async (buf, width, height, stride, pixelFormat) => {
  const now = Date.now();
  if (now - lastFrameMs < 100) return; // 10fps cap
  lastFrameMs = now;

  // Map SDK pixel format to sharp channel order
  const fmtMap = {
    [PixelFormat.kRGB]:  { channels: 3, space: 'rgb' },
    [PixelFormat.kBGR]:  { channels: 3, space: 'bgr' },
    [PixelFormat.kRGBA]: { channels: 4, space: 'rgba' },
    [PixelFormat.kBGRA]: { channels: 4, space: 'bgra' },
  };
  const fmt = fmtMap[pixelFormat] ?? { channels: 3, space: 'rgb' };

  try {
    let sharpInput = sharp(buf, {
      raw: { width, height, channels: fmt.channels },
    });
    // sharp needs RGB order; swap BGR
    if (fmt.space === 'bgr' || fmt.space === 'bgra') {
      sharpInput = sharpInput.toColorspace('srgb');
    }
    const jpeg = await sharpInput.jpeg({ quality: 70 }).toBuffer();
    const b64 = jpeg.toString('base64');
    const msg = JSON.stringify({ type: 'frame', data: b64 });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  } catch (e) {
    // non-fatal — skip frame on conversion error
  }
});

sdk.useCamera({ fps: 30, width: 1280, height: 720 });
sdk.start();
console.log('SmartSpectra SDK started — measuring from webcam.');

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', status: latestStatus }));
});

server.listen(3000, () => {
  console.log('Viralense running at http://localhost:3000');
});

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
