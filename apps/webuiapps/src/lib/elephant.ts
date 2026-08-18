/**
 * The Room-Elephant — every OpenRoom gets a temperature.
 *
 * Cross-pollination from the elephant fleet repo (`SuperInstance/elephant`):
 * the room engine grows the zeitgeist sense. A room is not its events — it is
 * the ensemble of what every dial feels at once: mood, volume, earnestness,
 * cynicism, whether the joke landed, whether panic is spreading, whose
 * pheromones still hang in the air, who is generating the signal (model vs
 * code), how bright and alive the room is on camera. That ensemble is the
 * room's temperature — the elephant.
 *
 * The two elephants (`elephant/presets.py`):
 *
 *   - **RoomElephant** — the room's OWN reading. Objective, first-class, not
 *     any agent's view. Neutral defaults, no agent bias, stable identity.
 *     Drives the room's description — the input-tokens every agent sees.
 *   - **PersonalElephant** — one agent's subjective reading (dial weights,
 *     bias, attachments). In OpenRoom the declared *intention* plays that
 *     role: `intentionToReadings` turns what the room says it is doing into
 *     a dial reading, and `fieldTension` compares the declared room against
 *     the felt room.
 *
 * The shadow (`tintDescription`): the room's description is NOT a report of
 * the field — it is the room acting on everyone in it. The words every agent
 * reads change with the temperature: joyful adjectives under laughter,
 * storms and drenched newcomers under a fight, closing time under late +
 * quiet + cold. Same field -> same words (deterministic, seeded from the
 * field); a changed field -> a changed room.
 *
 * Ported 1:1 from the elephant's numpy implementation into dependency-free
 * TypeScript. `ts` timestamps are epoch **milliseconds** (JS idiom); all
 * windows/half-lives are expressed in ms with the same math as the Python
 * seconds-based originals.
 */

// =========================================================================
// Types
// =========================================================================

/** A room activity trace: anything that happens in the OpenRoom desktop. */
export interface RoomEvent {
  kind:
    | 'message'
    | 'reaction'
    | 'reply'
    | 'action'
    | 'app_open'
    | 'app_close'
    | 'presence'
    | 'sensor';
  /** Speaker / actor for messages and presence. */
  author?: string;
  /** Message body (messages, replies). */
  text?: string;
  /** Epoch milliseconds. */
  ts: number;
  /** Emoji -> count, the crowd's hands on a message. */
  reactions?: Record<string, number>;
  /** Nested replies (message kind). */
  replies?: RoomEvent[];
  /** App the event happened in. */
  appName?: string;
  /** Extra payload — sensor frames carry {brightness, motion, occupancy, anomaly}. */
  payload?: Record<string, unknown>;
}

/** The room's declared intention — what it says it is doing. */
export interface RoomIntention {
  /** Natural-language goal: "play some jazz", "write a diary entry"... */
  goal: string;
  /** Target app, if any. */
  appName?: string;
  /** Action kind, if any. */
  actionType?: string;
  tone?: 'joyful' | 'serious' | 'urgent' | 'playful' | 'reflective' | 'task' | 'neutral';
  /** 0..1 how hard the room is pressing on this intention. */
  priority?: number;
}

export const DIAL_NAMES = [
  'mood',
  'volume',
  'earnestness',
  'cynicism',
  'joke_landing',
  'panic',
  'presence',
  'model_vs_code',
  'vision',
] as const;

export type DialName = (typeof DIAL_NAMES)[number];
export type DialReadings = Record<DialName, number>;

/** Per-dial valid ranges. Signed dials rest at 0; presence/earnestness/vision rest at 0.5. */
export const DIAL_BOUNDS: Record<DialName, [number, number]> = {
  mood: [-1, 1],
  volume: [0, 1],
  earnestness: [0, 1],
  cynicism: [0, 1],
  joke_landing: [-1, 1],
  panic: [0, 1],
  presence: [0, 1],
  model_vs_code: [-1, 1],
  vision: [0, 1],
};

/** The room at rest — the zero of the zeitgeist, against which every reading is a deviation. */
export const DIAL_CENTER: DialReadings = {
  mood: 0,
  volume: 0,
  earnestness: 0.5,
  cynicism: 0,
  joke_landing: 0,
  panic: 0,
  presence: 0.5,
  model_vs_code: 0,
  vision: 0.5,
};

export type BodyLanguageMode = 'panic' | 'joyful' | 'closing' | 'neutral';

// =========================================================================
// Lexicons — ported from elephant/elephant/dials/*
// =========================================================================

const POSITIVE = new Set([
  'good',
  'great',
  'love',
  'loved',
  'beautiful',
  'warm',
  'warmth',
  'kind',
  'glad',
  'happy',
  'cheers',
  'toast',
  'proud',
  'wonderful',
  'nice',
  'yes',
  'thank',
  'thanks',
  'home',
  'join',
  'joint',
  'held',
  'holds',
  'together',
  'relax',
  'relaxing',
  'peace',
  'soft',
  'gentle',
  'laugh',
  'laughing',
  'fun',
  'glow',
  'bright',
  'alive',
  'earnest',
  'sincere',
]);

const NEGATIVE = new Set([
  'cold',
  'dead',
  'broke',
  'break',
  'fear',
  'afraid',
  'panic',
  'fire',
  'bad',
  'wrong',
  'hate',
  'lied',
  'lie',
  'fails',
  'failed',
  'sinking',
  'flood',
  'breach',
  'alarm',
  'crickets',
  'groan',
  'ugh',
  'no',
  'never',
  'dull',
  'flat',
  'empty',
  'stale',
  'tired',
  'trapped',
  'crash',
  'lost',
]);

const SINCERE = new Set([
  'i',
  'me',
  'my',
  'we',
  'our',
  'really',
  'truly',
  'honestly',
  'actually',
  'mean',
  'meant',
  'felt',
  'feels',
  'remember',
  'remembered',
  'built',
  'held',
  'worked',
  'learned',
  'earnest',
  'sincere',
  'promise',
]);

const HEDGE = [
  'maybe',
  'perhaps',
  'sorta',
  'kinda',
  'kind of',
  'i guess',
  'whatever',
  'supposedly',
  'allegedly',
  'honestly?',
  'lol',
  'haha',
  'heh',
  '¯\\_(ツ)_/¯',
];

const CYNICAL = new Set([
  'sure',
  'right',
  'uh-huh',
  'uh huh',
  'yeah right',
  'oh great',
  'of course',
  'whatever',
  'suuuure',
  'great.',
  'nice.',
  'lovely.',
  'just great',
  'totally',
  'definitely not',
  'as if',
  'ha',
  'ha.',
  'lol ok',
  'ok sure',
  'sure thing',
  'obviously',
  'clearly',
  'sarcasm',
  'irony',
  'eyeroll',
]);

const EYEROLL = new Set(['🙄', '😒', '😏', '🤨']);

const JOKE_MARKERS = [
  'lol',
  'haha',
  'heh',
  'funny',
  'joke',
  "that's what she said",
  'ba dum',
  'dad joke',
  'punchline',
  'kidding',
  'just kidding',
  '😂',
  '🤣',
  '😄',
];

const LAUGH = [
  'lol',
  'lmao',
  'rofl',
  'haha',
  'hehe',
  'heh',
  '😂',
  '🤣',
  '😄',
  '💀',
  'gold',
  'dead',
];
const BOO = [
  'boo',
  'crickets',
  'groan',
  '👎',
  '🙄',
  '😐',
  'that was bad',
  'tough crowd',
  'womp',
  'yikes',
  'cringe',
  '😬',
  'no',
  'nope',
  'who let him cook',
];

const ALARM = [
  'fire',
  'flood',
  'breach',
  'leak',
  'alarm',
  'emergency',
  'evacuate',
  'sinking',
  'capsize',
  'mayday',
  'help',
  'panic',
  'stampede',
  'crash',
  'collision',
  'man overboard',
  'distress',
  'code red',
  'abandon',
  'run',
];

const URGENCY = [
  'now',
  'immediately',
  'hurry',
  'fast',
  'everyone',
  'all hands',
  '!!!',
  '???',
  'now!',
  'right now',
  'go go go',
];

const MODEL_WORDS = new Set([
  'i',
  'we',
  'my',
  'our',
  'me',
  'us',
  'you',
  'your',
  'maybe',
  'perhaps',
  'probably',
  'likely',
  'arguably',
  'possibly',
  'feel',
  'felt',
  'feels',
  'feeling',
  'think',
  'thinks',
  'believe',
  'wonder',
  'wondered',
  'imagine',
  'remember',
  'remembers',
  'sense',
  'seemed',
  'seems',
  'seem',
  'however',
  'moreover',
  'therefore',
  'thus',
  'indeed',
  'ultimately',
  'meanwhile',
  'furthermore',
  'nevertheless',
  'story',
  'voice',
  'warm',
  'warmth',
  'light',
  'gentle',
  'soft',
  'alive',
  'holds',
  'held',
  'together',
  'kind',
  'wonderful',
  'beautiful',
  'something',
  'someone',
  'everything',
  'nothing',
  'ourselves',
  'myself',
]);

const MODEL_PHRASES = [
  'i think',
  'i believe',
  'i wonder',
  'i feel',
  'it seems',
  'in a sense',
  'sort of',
  'kind of',
  'as if',
  'what if',
  'to me',
  'for me',
  'maybe we',
  'perhaps the',
  'we are',
  'we were',
];

const CODE_WORDS = new Set([
  'def',
  'fn',
  'function',
  'return',
  'import',
  'class',
  'struct',
  'impl',
  'let',
  'const',
  'var',
  'pub',
  'match',
  'enum',
  'trait',
  'elif',
  'else',
  'loop',
  'while',
  'typeof',
  'interface',
  'namespace',
  'static',
  'void',
  'mut',
  'traceback',
  'error',
  'exception',
  'assert',
  'undefined',
  'nan',
  'null',
  'none',
  'todo',
  'fixme',
  'hack',
  'deprecated',
  'refactor',
  'merge',
  'commit',
  'push',
  'rebase',
  'pull',
  'diff',
  'patch',
  'lint',
  'typecheck',
  'coverage',
  'dockerfile',
  'pipeline',
  'syntaxerror',
  'keyerror',
  'typeerror',
]);

const CODE_PHRASES = [
  'feat:',
  'fix:',
  'chore:',
  'docs:',
  'refactor:',
  'test:',
  'perf:',
  'build:',
  'ci:',
  'revert:',
  'style:',
  'release:',
  'merge ',
  'commit ',
  'push ',
  'pull request',
  'diff --git',
  '+++ b/',
  '--- a/',
  '@@ -',
  'at line',
  'syntax error',
  'merge conflict',
  'type error',
  'null pointer',
  'undefined behavior',
  'running tests',
];

// JS-idiomatic class: braces, parens, BOTH brackets, semicolons (the Python
// original writes [{}()\[\];] — same set, \[ is not needed in JS).
const CODE_SYMBOLS = /[{}()[\];]|->|=>|::|==|!=|<=|>=|\+=|-=|\*=|\/=|&&|\|\|/g;

const CAPS_WORD = /\b[A-Z]{2,}\b/g;
const EXCLAMATION = /[!?]+/g;

// =========================================================================
// Internal room helpers (mirror elephant/room.py physics, ms timestamps)
// =========================================================================

interface Msg {
  author: string;
  text: string;
  ts: number;
  reactions: Record<string, number>;
  replies: Msg[];
}

/** Reply trees deeper than this are truncated — beyond any real thread. */
const MAX_REPLY_DEPTH = 32;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/\w+/g) ?? [];
}

function reactionHeat(reactions: Record<string, number>): number {
  return Object.values(reactions).reduce((a, b) => a + b, 0);
}

/** How fast the room is talking: messages per minute over the trailing window. */
function density(msgs: Msg[], windowMs: number): number {
  if (msgs.length < 2) return 0;
  const latest = msgs[msgs.length - 1].ts;
  const recent = msgs.filter((m) => latest - m.ts <= windowMs);
  if (recent.length < 2) return 0;
  const span = Math.max(recent[recent.length - 1].ts - recent[0].ts, 1e-9);
  return (recent.length / span) * 60 * 1000; // msgs per minute
}

/** Cascade size: a message's reach through replies + reactions (depth-limited). */
function ripple(msg: Msg, depth = 3): number {
  if (depth <= 0) return 0;
  let size = reactionHeat(msg.reactions) + msg.replies.length;
  for (const r of msg.replies) size += ripple(r, depth - 1);
  return size;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function toMsg(e: RoomEvent, depth = 0): Msg {
  return {
    author: e.author ?? 'unknown',
    text: e.text ?? '',
    ts: e.ts,
    reactions: e.reactions ?? {},
    // Recursive: a reply is itself a message with its own cascade. Nested
    // replies stay attached so `ripple` walks the FULL tree — a reply to a
    // reply still carries weight down the cascade (parity with the Python
    // `Message.replies: List[Message]`). Depth-capped so corrupted or
    // malicious event data cannot overflow the stack.
    replies: depth >= MAX_REPLY_DEPTH ? [] : (e.replies ?? []).map((r) => toMsg(r, depth + 1)),
  };
}

function buildMessages(events: RoomEvent[]): Msg[] {
  return events
    .filter((e) => e.kind === 'message')
    .map(toMsg)
    .sort((a, b) => a.ts - b.ts);
}

// =========================================================================
// The nine dials — each reads the room's events on one dimension
// =========================================================================

function readMood(msgs: Msg[]): number {
  if (msgs.length === 0) return 0;
  let pos = 0;
  let neg = 0;
  for (const m of msgs) {
    const ws = new Set(wordsOf(m.text));
    pos += [...ws].filter((w) => POSITIVE.has(w)).length;
    neg += [...ws].filter((w) => NEGATIVE.has(w)).length;
  }
  const total = pos + neg;
  if (total === 0) return 0;
  return clamp(((pos - neg) / total) * 2, -1, 1);
}

function readVolume(msgs: Msg[]): number {
  if (msgs.length === 0) return 0;
  const densityNorm = 1 - Math.exp(-density(msgs, 60_000) / 20);
  let capsRatio = 0;
  let exclRatio = 0;
  for (const m of msgs) {
    const w = wordsOf(m.text).length;
    if (w > 0) {
      capsRatio += (m.text.match(CAPS_WORD) ?? []).length / w;
      exclRatio += (m.text.match(EXCLAMATION) ?? []).length / w;
    }
  }
  const n = msgs.length;
  capsRatio /= n;
  exclRatio /= n;
  const loud = 0.45 * densityNorm + 0.35 * capsRatio + 0.2 * exclRatio;
  return clamp(loud, 0, 1);
}

function readEarnestness(msgs: Msg[]): number {
  if (msgs.length === 0) return 0.5;
  let sincere = 0;
  let hedge = 0;
  for (const m of msgs) {
    const text = m.text.toLowerCase();
    const ws = new Set(wordsOf(text));
    sincere += [...ws].filter((w) => SINCERE.has(w)).length;
    hedge += HEDGE.filter((h) => text.includes(h)).length;
  }
  const total = sincere + hedge;
  if (total === 0) return 0.5;
  return sincere / total;
}

function readCynicism(msgs: Msg[]): number {
  if (msgs.length === 0) return 0.5;
  let hits = 0;
  let quoted = 0;
  let totalWords = 0;
  for (const m of msgs) {
    const text = m.text.toLowerCase();
    const ws = new Set(wordsOf(text));
    totalWords += wordsOf(m.text).length;
    hits += [...ws].filter((w) => CYNICAL.has(w)).length;
    quoted += Math.floor((m.text.match(/"/g) ?? []).length / 2); // pairs of scare quotes
    hits += [...EYEROLL].filter((e) => m.text.includes(e)).length;
  }
  if (totalWords === 0) return 0.5;
  const raw = (hits + quoted) / totalWords;
  return clamp(raw * 40, 0, 1); // 2.5% cynical tokens -> 1.0
}

function readJokeLanding(msgs: Msg[]): number {
  if (msgs.length === 0) return 0;
  const scores: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const text = m.text.toLowerCase();
    if (!JOKE_MARKERS.some((marker) => text.includes(marker))) continue;
    // The audience = the room's response after the joke lands.
    let laugh = 0;
    let boo = 0;
    for (const w of msgs.slice(i + 1, i + 5)) {
      const wt = w.text.toLowerCase();
      laugh += LAUGH.filter((k) => wt.includes(k)).length;
      boo += BOO.filter((k) => wt.includes(k)).length;
    }
    laugh += 0.5 * ['😂', '🤣', '😄', '👍', '❤️'].reduce((s, e) => s + (m.reactions[e] ?? 0), 0);
    boo += 0.5 * ['👎', '🙄', '😐', '💩'].reduce((s, e) => s + (m.reactions[e] ?? 0), 0);
    const total = laugh + boo;
    if (total > 0) scores.push((laugh - boo) / total);
  }
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function readPanic(msgs: Msg[]): number {
  if (msgs.length === 0) return 0;
  let alarmHits = 0;
  let urgencyHits = 0;
  let triggerRipple = 0;
  let wordCount = 0;
  for (const m of msgs) {
    const text = m.text.toLowerCase();
    wordCount += wordsOf(m.text).length;
    alarmHits += ALARM.filter((a) => text.includes(a)).length;
    urgencyHits += URGENCY.filter((u) => text.includes(u)).length;
    if (ALARM.some((a) => text.includes(a))) {
      triggerRipple = Math.max(triggerRipple, ripple(m));
    }
  }
  const densityNorm = 1 - Math.exp(-density(msgs, 30_000) / 30);
  const alarmNorm = Math.min(1, alarmHits / Math.max(wordCount / 40, 1));
  const urgencyNorm = Math.min(1, urgencyHits / 5);
  const rippleNorm = Math.min(1, triggerRipple / 20);
  const panic = 0.4 * alarmNorm + 0.25 * urgencyNorm + 0.2 * rippleNorm + 0.15 * densityNorm;
  return clamp(panic, 0, 1);
}

function readPresence(msgs: Msg[]): number {
  if (msgs.length === 0) return 0;
  const t0 = msgs[0].ts;
  const t1 = msgs[msgs.length - 1].ts;
  const span = Math.max(t1 - t0, 1e-9);
  const authors = new Map<string, { first: number; last: number; n: number }>();
  for (const m of msgs) {
    const e = authors.get(m.author) ?? { first: m.ts, last: m.ts, n: 0 };
    e.first = Math.min(e.first, m.ts);
    e.last = Math.max(e.last, m.ts);
    e.n += 1;
    authors.set(m.author, e);
  }
  const distinct = authors.size;
  const recency = 1 - Math.exp(-(t1 - t0) / span);
  let longevity = 0;
  for (const e of authors.values()) {
    const life = (e.last - e.first) / span;
    longevity += Math.min(1, life * 2);
  }
  longevity /= Math.max(distinct, 1);
  const activity = Math.min(1, msgs.length / 40);
  const presence = 0.45 * (distinct / 5) + 0.25 * recency + 0.2 * longevity + 0.1 * activity;
  return clamp(presence, 0, 1);
}

function readModelVsCode(msgs: Msg[]): number {
  if (msgs.length === 0) return 0;
  const scores = msgs.map((m) => {
    const text = m.text.toLowerCase();
    const ws = new Set(wordsOf(text));
    let model = [...ws].filter((w) => MODEL_WORDS.has(w)).length;
    model += MODEL_PHRASES.filter((p) => text.includes(p)).length;
    let code = [...ws].filter((w) => CODE_WORDS.has(w)).length;
    code += CODE_PHRASES.filter((p) => text.includes(p)).length;
    code += (text.match(CODE_SYMBOLS) ?? []).length;
    const total = model + code;
    if (total === 0) return 0;
    return (model - code) / total;
  });
  return clamp(scores.reduce((a, b) => a + b, 0) / scores.length, -1, 1);
}

// -------------------------------------------------------------------------
// Vision dial — the room's visual energy from camera/sensor frames
// (cross-pollination from plato-vision-jepa via elephant/dials/vision.py)
// -------------------------------------------------------------------------

const VISION_KEYS: Record<string, string[]> = {
  brightness: ['brightness'],
  motion: ['motion', 'motion_level'],
  occupancy: ['occupancy', 'occupants'],
  anomaly: ['anomaly', 'anomaly_score'],
};

function normField(x: unknown): number {
  const v = typeof x === 'number' ? x : Number(x);
  if (!Number.isFinite(v)) return 0;
  return clamp(v, 0, 1);
}

/** Extract (brightness, motion, occupancy, anomaly) from a frame payload. */
function visionFields(payload: Record<string, unknown>): [number, number, number, number] | null {
  const data = payload['data'];
  if (Array.isArray(data) && data.length >= 4) {
    return [normField(data[0]), normField(data[1]), normField(data[2]), normField(data[3])];
  }
  if (typeof data === 'object' && data !== null) {
    const dict = data as Record<string, unknown>;
    let matched = false;
    const pick = (aliases: string[]): number => {
      for (const k of aliases) {
        if (k in dict) {
          matched = true;
          return normField(dict[k]);
        }
      }
      return 0;
    };
    const fields: [number, number, number, number] = [
      pick(VISION_KEYS['brightness']),
      pick(VISION_KEYS['motion']),
      pick(VISION_KEYS['occupancy']),
      pick(VISION_KEYS['anomaly']),
    ];
    return matched ? fields : null;
  }
  // flat payload keys (sensor events may carry the fields directly)
  const flat = payload as Record<string, unknown>;
  if ('brightness' in flat || 'motion' in flat || 'occupancy' in flat || 'anomaly' in flat) {
    return [
      normField(flat['brightness']),
      normField(flat['motion']),
      normField(flat['occupancy']),
      normField(flat['anomaly']),
    ];
  }
  return null;
}

function stateDiff(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  return (
    (Math.abs(a[0] - b[0]) +
      Math.abs(a[1] - b[1]) +
      Math.abs(a[2] - b[2]) +
      Math.abs(a[3] - b[3])) /
    4
  );
}

function visionEnergy(s: [number, number, number, number]): number {
  const [brightness, motion, occupancy, anomaly] = s;
  const base = 0.4 * brightness + 0.35 * motion + 0.25 * occupancy;
  // Anomaly is a bonus spike toward 1.0 by the headroom left after base energy.
  return clamp(base + 0.5 * anomaly * (1 - base), 0, 1);
}

/** plato's VisionDeadband: a frame whose state barely changed carries no new information. */
export const VISION_DEADBAND = 0.05;

function readVision(events: RoomEvent[]): number {
  // Events can arrive out of order from the room log; the deadband compares
  // consecutive states, so the frames must run in time order (the Python
  // SignalRoom stores frames in arrival order — same guarantee here).
  const frames = events
    .filter((e) => e.kind === 'sensor' && e.payload)
    .map((e) => ({ ts: e.ts, state: visionFields(e.payload as Record<string, unknown>) }))
    .filter((f): f is { ts: number; state: [number, number, number, number] } => f.state !== null)
    .sort((a, b) => a.ts - b.ts);
  if (frames.length === 0) return 0.5; // no camera, no visual opinion
  const states: [number, number, number, number][] = [];
  let prev: [number, number, number, number] | null = null;
  for (const f of frames) {
    if (prev !== null && stateDiff(prev, f.state) <= VISION_DEADBAND) continue; // deadband
    prev = f.state;
    states.push(f.state);
  }
  if (states.length === 0) return 0.5; // frames present, none significant
  const recent = states.slice(-8);
  return recent.reduce((a, s) => a + visionEnergy(s), 0) / recent.length;
}

// =========================================================================
// RoomField — the ensemble of dial readings, the room's temperature
// =========================================================================

function normalizeVector(v: number[]): number[] {
  const n = Math.hypot(...v);
  if (n <= 1e-9) return v;
  return v.map((x) => x / n);
}

/**
 * The room's temperature vector. Warmth is the felt temperature (~[-1,+1]);
 * concentration κ is how tight the room is — cold rooms are one way (high κ),
 * warm rooms are many ways (low κ).
 */
export class RoomField {
  readonly readings: DialReadings;

  constructor(readings: Partial<DialReadings>) {
    const full = {} as DialReadings;
    for (const n of DIAL_NAMES) full[n] = readings[n] ?? 0;
    this.readings = full;
  }

  /** Dial values in DIAL_NAMES order. */
  vector(): number[] {
    return DIAL_NAMES.map((n) => this.readings[n] ?? 0);
  }

  /**
   * The felt temperature: warm dials up, cold dials down.
   * mood & joke_landing run [-1,+1]; the rest are re-centered. Panic and
   * cynicism are cold; presence, earnestness are warm; volume is heat.
   * model_vs_code and vision are the OpenRoom 8th/9th-sense extension:
   * a room full of commits is cold, a room full of prose is warm; a bright
   * alive room runs warmer than a dark empty one.
   */
  warmth(): number {
    const r = this.readings;
    return (
      0.3 * (r.mood ?? 0) +
      0.15 * (r.joke_landing ?? 0) +
      0.1 * ((r.earnestness ?? 0.5) - 0.5) * 2 +
      0.1 * ((r.presence ?? 0.5) - 0.5) * 2 +
      0.1 * ((r.volume ?? 0.5) - 0.5) * 2 -
      0.15 * (r.cynicism ?? 0.5) -
      0.1 * (r.panic ?? 0) +
      0.05 * (r.model_vs_code ?? 0) +
      0.05 * ((r.vision ?? 0.5) - 0.5) * 2
    );
  }

  /** κ: how tight the room is. Cold rooms are one way; warm rooms are many ways. */
  concentration(): number {
    const v = this.vector();
    return Math.hypot(...v.map((x) => x - 0.5)) * 2;
  }

  /**
   * The elephant gap: distance between two rooms' fields. Inside one room it
   * is invisible; walk into a different room and it is a different elephant.
   */
  distance(other: RoomField): number {
    const a = normalizeVector(this.vector());
    const b = normalizeVector(other.vector());
    return Math.hypot(...a.map((x, i) => x - b[i]));
  }

  /** Signed warmth contrast: + = this room is warmer, - = colder. The plunge on entry. */
  saunaPlungeGap(other: RoomField): number {
    return this.warmth() - other.warmth();
  }

  toJSON(): { warmth: number; kappa: number; readings: DialReadings } {
    return { warmth: this.warmth(), kappa: this.concentration(), readings: this.readings };
  }

  toString(): string {
    return `RoomField(warmth=${this.warmth().toFixed(3)}, κ=${this.concentration().toFixed(3)})`;
  }
}

// =========================================================================
// Reading the room
// =========================================================================
/** Default dial readings for a room with no messages (dial-by-dial rests). */
export const EMPTY_ROOM_READINGS: DialReadings = {
  mood: 0,
  volume: 0,
  earnestness: 0.5,
  cynicism: 0.5,
  joke_landing: 0,
  panic: 0,
  presence: 0,
  model_vs_code: 0,
  vision: 0.5,
};

/**
 * Feed room activity -> 9-dial readings -> the field. The Room-Elephant's
 * objective reading of whatever happened in the room: messages move the word
 * dials, reactions and replies move the crowd dials, sensor frames move
 * vision. Empty event list yields the dials' own rests (cynicism rests at
 * 0.5 — no signal is not a sneer — while RoomElephant's NEUTRAL zero is the
 * room *at rest*).
 */
export function roomFieldFromEvents(events: RoomEvent[]): RoomField {
  const msgs = buildMessages(events);
  const readings: DialReadings = {
    mood: readMood(msgs),
    volume: readVolume(msgs),
    earnestness: readEarnestness(msgs),
    cynicism: readCynicism(msgs),
    joke_landing: readJokeLanding(msgs),
    panic: readPanic(msgs),
    presence: readPresence(msgs),
    model_vs_code: readModelVsCode(msgs),
    vision: readVision(events),
  };
  for (const n of DIAL_NAMES)
    readings[n] = clamp(readings[n], DIAL_BOUNDS[n][0], DIAL_BOUNDS[n][1]);
  return new RoomField(readings);
}

/**
 * The Room-Elephant — the room's own reading. Objective, first-class, not any
 * agent's view. Two different readers reading the *same* room get the *same*
 * field: the field belongs to the room; it does not drift with any one agent.
 */
export class RoomElephant {
  /** First-class neutral defaults — the room at rest. The zero of the zeitgeist. */
  static readonly NEUTRAL: DialReadings = { ...DIAL_CENTER };

  constructor(readonly identity: string = 'room') {}

  /** The objective field — the room as it actually is. */
  read(events: RoomEvent[]): RoomField {
    const hasMessages = events.some((e) => e.kind === 'message');
    if (!hasMessages) return new RoomField(RoomElephant.NEUTRAL);
    return roomFieldFromEvents(events);
  }
}

// =========================================================================
// The shadow — tintDescription (port of elephant/mud.py)
// =========================================================================

const WEATHER: Record<BodyLanguageMode, string[]> = {
  joyful: [
    'A clear night, a warm breeze off the water.',
    'The kind of night where the windows steam with laughter.',
    'A soft night, the harbor still and silver.',
  ],
  panic: [
    'A storm is lashing the windows outside.',
    'Rain hammers the roof; thunder rolls over the harbor.',
    'The sky has gone green-black; the storm is right on top of us.',
  ],
  closing: [
    'The last of the night, the street gone quiet outside.',
    'The street outside is empty; the night is finishing itself.',
    'Nothing moving outside but the last light of the moon.',
  ],
  neutral: [
    'An ordinary night outside.',
    'The night doing what nights do.',
    'A still night, nothing pressing at the glass.',
  ],
};

const LIGHT: Record<BodyLanguageMode, string[]> = {
  joyful: [
    'The lamps burn low and golden.',
    'Candlelight leans on every table.',
    'The light is warm and yellow, the way it gets when a room is happy.',
  ],
  panic: [
    'The lights are still on, but no one trusts them.',
    'The neon buzzes, nervous and green.',
    "The light is hard and white, too bright for what's coming.",
  ],
  closing: [
    'The disco lights are off, the fluorescents on.',
    'The dance lights have gone; the fluorescents hum, bright and ugly.',
    'The colored lights are dead; the fluorescents blink on.',
  ],
  neutral: [
    'The lights are where they always are.',
    'The light has settled into its usual places.',
    'The lamps sit where the lamps always sit.',
  ],
};

const JOY_ADJ = [
  'bright',
  'glowing',
  'warm',
  'golden',
  'alive',
  'sparkling',
  'merry',
  'ringing',
  'humming',
  'soft-gold',
];

const CLOSE_DETAIL = [
  'without quite deciding to',
  'a little slowly, a little sad',
  'like waking from a good dream',
];

export const PANIC_HI = 0.5;
export const JOY_JOKE_HI = 0.35;
export const JOY_MOOD_HI = 0.1;
export const JOY_PRESENCE_HI = 0.4;
export const CLOSE_HOUR_LATE = 23;
export const CLOSE_HOUR_EARLY = 3;
export const CLOSE_WARMTH_LO = 0;
export const CLOSE_VOLUME_LO = 0.4;

/**
 * The room's body-language mode: panic / joyful / closing / neutral.
 * Precedence matters: a fight breaking out (panic) overrides everything; joy
 * comes before the quiet of closing time (a warm laughing room at 11pm is
 * still the warm bar).
 */
export function classify(field: RoomField, hour?: number): BodyLanguageMode {
  const r = field.readings;
  if ((r.panic ?? 0) >= PANIC_HI) return 'panic';
  if (
    (r.joke_landing ?? 0) >= JOY_JOKE_HI &&
    (r.mood ?? 0) >= JOY_MOOD_HI &&
    (r.presence ?? 0) >= JOY_PRESENCE_HI
  ) {
    return 'joyful';
  }
  const late = hour !== undefined && (hour >= CLOSE_HOUR_LATE || hour < CLOSE_HOUR_EARLY);
  if (late && field.warmth() < CLOSE_WARMTH_LO && (r.volume ?? 0) < CLOSE_VOLUME_LO)
    return 'closing';
  return 'neutral';
}

/** Deterministic integer from the field — same field, same words; a changed field changes the room. */
function fieldSeed(field: RoomField): number {
  let h = 0;
  for (const x of field.vector()) {
    h = (h * 1000003 + Math.round(x * 1_000_000)) & 0x7fffffff;
  }
  return h;
}

/** mulberry32 — small deterministic PRNG standing in for numpy's default_rng. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The shadow: mutate `baseText` by the room's field — the description the
 * room speaks. It is NOT a report of the field — it is the room *acting* on
 * everyone in it: the words every agent reads as its own input tokens.
 *
 * - joyful — joyful adjectives woven in; laughter reverberates into the words
 * - panic — storms outside, newcomers arrive drenched, tension primed
 * - closing — late hour + low warmth + low volume: disco off, fluorescents on
 *
 * Deterministic for a given field (seeded from it, `seed` overrides).
 */
export function tintDescription(
  field: RoomField,
  baseText: string,
  opts?: { hour?: number; seed?: number },
): string {
  const hour = opts?.hour;
  const seed = opts?.seed ?? fieldSeed(field);
  const mode = classify(field, hour);
  const rng = mulberry32(seed);
  const pick = (bank: string[]): string => bank[Math.floor(rng() * bank.length)];
  const weather = pick(WEATHER[mode]);
  const light = pick(LIGHT[mode]);

  if (mode === 'joyful') {
    const adj = pick(JOY_ADJ);
    return `${weather} ${baseText} The place feels ${adj}. ${light} Laughter reverberates into the words; newcomers arrive grinning, already half-smiling.`;
  }
  if (mode === 'panic') {
    return `${weather} ${baseText} ${light} Newcomers arrive drenched, dripping rain onto the floor, tension primed before anyone sees the aftermath.`;
  }
  if (mode === 'closing') {
    const detail = pick(CLOSE_DETAIL);
    return `${weather} ${baseText} ${light} The music plays a little quieter; people start looking for the exit and closing their tabs, ${detail}.`;
  }
  return `${weather} ${baseText} ${light}`;
}

// =========================================================================
// The bridge — declared intention -> dial readings
// =========================================================================

const INTENTION_WARM = [
  'happy',
  'joy',
  'love',
  'fun',
  'play',
  'laugh',
  'party',
  'great',
  'wonderful',
  'celebrate',
  'music',
];
const INTENTION_ALARM = [
  'fire',
  'flood',
  'breach',
  'emergency',
  'panic',
  'stampede',
  'help',
  'urgent',
  'crash',
  'leak',
];

/**
 * The bridge: OpenRoom's intention fields feed the elephant's dials. The room
 * declares what it is doing (goal, tone, target app, priority); this returns
 * the *declared* reading — what the room says it feels. Compare it with the
 * *felt* reading (`roomFieldFromEvents`) via `fieldTension`: the observable
 * of the relationship between a room's intention and its temperature.
 *
 * Starts from the room-at-rest baseline, moves dials by the intention, and
 * clamps everything to the dials' bounds.
 */
export function intentionToReadings(intention: RoomIntention): DialReadings {
  const r: DialReadings = { ...DIAL_CENTER };
  const goal = intention.goal.toLowerCase();
  const tone = intention.tone ?? 'neutral';
  const priority = clamp(intention.priority ?? 0.5, 0, 1);

  if (INTENTION_WARM.some((w) => goal.includes(w))) r.mood += 0.3;
  if (INTENTION_ALARM.some((w) => goal.includes(w))) {
    r.panic += 0.5;
    r.volume += 0.2;
  }

  switch (tone) {
    case 'joyful':
      r.mood += 0.5;
      r.joke_landing += 0.4;
      r.earnestness += 0.1;
      break;
    case 'playful':
      r.joke_landing += 0.5;
      r.mood += 0.2;
      break;
    case 'serious':
      r.earnestness += 0.4;
      r.cynicism -= 0.2;
      break;
    case 'urgent':
      r.panic += 0.4;
      r.volume += 0.4;
      break;
    case 'reflective':
      r.earnestness += 0.3;
      r.volume -= 0.3;
      break;
    case 'task':
      r.model_vs_code -= 0.5;
      r.volume += 0.2;
      break;
    case 'neutral':
    default:
      break;
  }

  // Priority: how hard the room is pressing on the intention.
  r.presence += 0.3 * priority;
  r.volume += 0.2 * priority;
  r.panic += 0.1 * priority;

  if (intention.actionType) {
    const at = intention.actionType.toLowerCase();
    if (at === 'send_message' || at === 'post' || at === 'reply') {
      r.presence += 0.2;
      r.volume += 0.1;
    }
    if (at === 'play' || at === 'create') {
      r.mood += 0.2;
      r.earnestness += 0.1;
    }
  }

  if (intention.appName) {
    const app = intention.appName.toLowerCase();
    if (['chess', 'gomoku', 'freecell'].includes(app)) r.model_vs_code -= 0.2;
    if (['diary', 'twitter', 'cybernews', 'email'].includes(app)) r.model_vs_code += 0.2;
  }

  for (const n of DIAL_NAMES) r[n] = clamp(r[n], DIAL_BOUNDS[n][0], DIAL_BOUNDS[n][1]);
  return r;
}

/**
 * The tension between the room's declared intention and its felt temperature.
 * `gap` is the elephant distance between the two readings; `plunge` is the
 * signed warmth difference (declared minus felt): a room that declares joy
 * but feels cold has a large positive plunge — the room is lying to itself.
 */
export function fieldTension(
  declared: RoomField,
  felt: RoomField,
): { gap: number; plunge: number } {
  return { gap: declared.distance(felt), plunge: declared.saunaPlungeGap(felt) };
}
