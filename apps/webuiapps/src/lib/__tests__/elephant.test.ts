import { describe, it, expect } from 'vitest';
import {
  RoomElephant,
  RoomField,
  DIAL_CENTER,
  EMPTY_ROOM_READINGS,
  roomFieldFromEvents,
  tintDescription,
  classify,
  intentionToReadings,
  fieldTension,
  VISION_DEADBAND,
} from '../elephant';
import type { RoomEvent } from '../elephant';

// =========================================================================
// Helpers
// =========================================================================

const now = 1_752_000_000_000; // arbitrary epoch ms

function msg(author: string, text: string, ts: number, extra: Partial<RoomEvent> = {}): RoomEvent {
  return { kind: 'message', author, text, ts, ...extra };
}

/** A warm busy room: laughter, jokes that land, many authors, the crowd's hands. */
function warmRoomEvents(): RoomEvent[] {
  return [
    msg('alice', 'love this joke 😂', now, { reactions: { '😂': 5, '👍': 2 } }),
    msg('bob', 'haha yes gold 😂', now + 200),
    msg('carol', 'hahaha this is great 😂', now + 400),
    msg('alice', 'lol so funny 😂', now + 600),
    msg('bob', "haha that's so good 😂", now + 800),
    msg('carol', 'love it, keep them coming 😂', now + 1000),
  ];
}

/** A cold idle room: two clipped flat messages, long ago, no reactions. */
function coldRoomEvents(): RoomEvent[] {
  // messages spread hours apart: nothing within the 60s density window -> quiet
  return [
    msg('dave', 'no. this is broken.', now - 86_400_000),
    msg('erin', 'it failed again.', now - 79_200_000),
  ];
}

// =========================================================================
// roomFieldFromEvents — warm vs cold
// =========================================================================

describe('roomFieldFromEvents', () => {
  it('a warm busy room reads warm: positive mood, landing jokes, high presence', () => {
    const field = roomFieldFromEvents(warmRoomEvents());
    expect(field.readings.mood).toBeGreaterThan(0.5);
    expect(field.readings.joke_landing).toBeGreaterThan(0.8);
    expect(field.readings.presence).toBeGreaterThan(0.5);
    expect(field.warmth()).toBeGreaterThan(0.15);
  });

  it('a warm busy room is classified joyful', () => {
    const field = roomFieldFromEvents(warmRoomEvents());
    expect(classify(field)).toBe('joyful');
  });

  it('a cold idle room reads cold: flat mood, quiet, thin presence', () => {
    const field = roomFieldFromEvents(coldRoomEvents());
    expect(field.readings.mood).toBeLessThan(-0.5);
    expect(field.readings.volume).toBeLessThan(0.1);
    expect(field.warmth()).toBeLessThan(-0.05);
  });

  it('a cold room is tighter: concentration (κ) higher than a warm room', () => {
    const cold = roomFieldFromEvents(coldRoomEvents());
    const warm = roomFieldFromEvents(warmRoomEvents());
    expect(cold.concentration()).toBeGreaterThan(warm.concentration());
  });

  it("empty events yield the dials' own rests", () => {
    const field = roomFieldFromEvents([]);
    expect(field.readings).toEqual(EMPTY_ROOM_READINGS);
  });

  it('a joke that gets booed reads negative joke_landing', () => {
    const events = [
      msg('alice', 'that was my best joke', now, { reactions: { '👎': 4, '🙄': 2 } }),
      msg('bob', 'crickets. tough crowd.', now + 300),
      msg('carol', 'yikes 😬', now + 500),
    ];
    const field = roomFieldFromEvents(events);
    expect(field.readings.joke_landing).toBeLessThan(0);
  });

  it('alarm words with a reply cascade read as panic', () => {
    const events = [
      msg('alice', 'fire! everyone out now!', now, {
        replies: [
          msg('bob', 'evacuate!', now + 100),
          msg('carol', 'run!', now + 200),
          msg('dave', 'go go go!', now + 300),
        ],
      }),
    ];
    const field = roomFieldFromEvents(events);
    expect(field.readings.panic).toBeGreaterThanOrEqual(0.5);
    expect(classify(field)).toBe('panic');
  });

  it('nested replies keep their weight: a reply-to-a-reply still ripples up the cascade', () => {
    // The alarm is one deep chain; the deepest reply carries 40 reactions.
    // Only a recursive reply tree lets that heat reach the panic dial — a
    // flattened tree drops it (panic would read ~0.41 and miss the panic
    // band entirely).
    const events = [
      msg('alice', 'fire!', now, {
        replies: [
          msg('bob', 'evacuate!', now + 100, {
            replies: [msg('carol', 'run!', now + 200, { reactions: { '🔥': 40 } })],
          }),
        ],
      }),
    ];
    const field = roomFieldFromEvents(events);
    expect(field.readings.panic).toBeGreaterThanOrEqual(0.5);
  });

  it('pathological reply depth cannot overflow the stack', () => {
    // Corrupted/malicious event data: a 100k-deep reply chain must not
    // crash the browser tab — the builder caps the tree depth.
    let leaf: RoomEvent = msg('z', 'deep', now + 999999);
    for (let i = 0; i < 100_000; i++) {
      leaf = msg('a', 'fire', now + i, { replies: [leaf] });
    }
    const field = roomFieldFromEvents([leaf]);
    expect(Number.isFinite(field.warmth())).toBe(true);
    expect(field.readings.panic).toBeGreaterThanOrEqual(0);
  });

  it('reads model_vs_code: prose rooms read model, commit-shaped rooms read code', () => {
    const prose = roomFieldFromEvents([
      msg('alice', 'i think maybe we should feel our way forward, softly', now),
    ]);
    const code = roomFieldFromEvents([
      msg('bot', 'feat: fix merge conflict in pipeline; refactor diff --git', now),
    ]);
    expect(prose.readings.model_vs_code).toBeGreaterThan(0);
    expect(code.readings.model_vs_code).toBeLessThan(0);
  });

  it('code symbol regex matches braces, brackets, parens, and semicolons', () => {
    // Regression lock: the ported class must be [{}()\[\];] — braces,
    // parens, BOTH brackets, semicolons — exactly the Python original.
    const field = roomFieldFromEvents([msg('bot', 'fn foo([x]) { return x; }', now)]);
    expect(field.readings.model_vs_code).toBeLessThan(0);
  });
});

// =========================================================================
// Vision dial — the 9th sense from sensor frames
// =========================================================================

describe('vision dial', () => {
  it('reads visual energy from sensor frames', () => {
    const field = roomFieldFromEvents([
      {
        kind: 'sensor',
        ts: now,
        payload: { brightness: 0.9, motion: 0.8, occupancy: 0.7, anomaly: 0 },
      },
    ]);
    expect(field.readings.vision).toBeCloseTo(0.815, 3);
  });

  it('anomaly spikes push the reading toward 1.0', () => {
    const field = roomFieldFromEvents([
      {
        kind: 'sensor',
        ts: now,
        payload: { brightness: 0.9, motion: 0.8, occupancy: 0.7, anomaly: 1 },
      },
    ]);
    expect(field.readings.vision).toBeCloseTo(0.9075, 3);
  });

  it('accepts the plato 16-dim room-state vector form', () => {
    const field = roomFieldFromEvents([
      {
        kind: 'sensor',
        ts: now,
        payload: { data: [0.9, 0.8, 0.7, 0, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0] },
      },
    ]);
    expect(field.readings.vision).toBeCloseTo(0.815, 3);
  });

  it('the deadband skips frames that barely changed', () => {
    const frame = {
      kind: 'sensor' as const,
      ts: now,
      payload: { brightness: 0.9, motion: 0.8, occupancy: 0.7 },
    };
    const field = roomFieldFromEvents([frame, { ...frame, ts: now + 1000 }]);
    // only the first frame survives the deadband
    expect(field.readings.vision).toBeCloseTo(0.815, 3);
    expect(VISION_DEADBAND).toBe(0.05);
  });

  it('the deadband compares frames in time order, not arrival order', () => {
    // The room log hands events in arrival order; wall-clock order differs.
    // Time order (hot, quiet, hot, hot, quiet, hot) deadbands only the
    // adjacent duplicate and reads 0.8705. Arrival order (hot, hot, quiet,
    // hot, hot, quiet) would also collapse the first run and read 0.8613 —
    // the deadband must run on time, not on arrival.
    const hot = { brightness: 0.9, motion: 0.8, occupancy: 0.7, anomaly: 1 };
    const quiet = { brightness: 0.9, motion: 0.8, occupancy: 0.7 };
    const field = roomFieldFromEvents([
      { kind: 'sensor' as const, ts: now, payload: hot },
      { kind: 'sensor' as const, ts: now + 2000, payload: hot },
      { kind: 'sensor' as const, ts: now + 1000, payload: quiet },
      { kind: 'sensor' as const, ts: now + 3000, payload: hot },
      { kind: 'sensor' as const, ts: now + 5000, payload: hot },
      { kind: 'sensor' as const, ts: now + 4000, payload: quiet },
    ]);
    expect(field.readings.vision).toBeCloseTo(0.8705, 3);
  });

  it('unreadable frames rest at neutral — no camera, no visual opinion', () => {
    const field = roomFieldFromEvents([{ kind: 'sensor', ts: now, payload: { foo: 1 } }]);
    expect(field.readings.vision).toBe(0.5);
  });

  it('accepts plato field-name spellings inside payload.data', () => {
    const field = roomFieldFromEvents([
      {
        kind: 'sensor',
        ts: now,
        payload: {
          data: { motion_level: 0.8, occupancy: 0.7, brightness: 0.9, anomaly_score: 0.5 },
        },
      },
    ]);
    // 0.4*0.9 + 0.35*0.8 + 0.25*0.7 = 0.815, then anomaly bonus 0.5*0.5*(1-0.815)
    expect(field.readings.vision).toBeCloseTo(0.8613, 3);
  });
});

// =========================================================================
// RoomElephant — the room's own objective reading
// =========================================================================

describe('RoomElephant', () => {
  it('an empty room rests at the first-class neutral defaults', () => {
    const elephant = new RoomElephant('desktop');
    expect(elephant.identity).toBe('desktop');
    expect(elephant.read([]).readings).toEqual(DIAL_CENTER);
  });

  it('reads the objective field for a room with life', () => {
    const elephant = new RoomElephant();
    const events = warmRoomEvents();
    expect(elephant.read(events).warmth()).toBeCloseTo(roomFieldFromEvents(events).warmth(), 6);
  });

  it('the same room reads the same field for any reader — objective, first-class', () => {
    const events = warmRoomEvents();
    const a = new RoomElephant('a').read(events);
    const b = new RoomElephant('b').read(events);
    expect(a.distance(b)).toBeCloseTo(0, 9);
  });
});

// =========================================================================
// tintDescription — the shadow
// =========================================================================

describe('tintDescription', () => {
  it('a joyful room tints the description with laughter', () => {
    const field = roomFieldFromEvents(warmRoomEvents());
    const tinted = tintDescription(field, 'The Tap is a wooden bar by the harbor.');
    expect(tinted).toContain('Laughter reverberates into the words');
    expect(tinted).toContain('The Tap is a wooden bar by the harbor.');
  });

  it('tint changes the description: a neutral room reads differently', () => {
    const neutral = new RoomField({ ...DIAL_CENTER });
    const tinted = tintDescription(neutral, 'The Tap is a wooden bar by the harbor.');
    expect(tinted).not.toContain('Laughter reverberates');
  });

  it('is deterministic: same field, same words', () => {
    const field = roomFieldFromEvents(warmRoomEvents());
    const base = 'The Tap is a wooden bar by the harbor.';
    expect(tintDescription(field, base)).toBe(tintDescription(field, base));
  });

  it('seed override stays deterministic', () => {
    const field = new RoomField({ ...DIAL_CENTER });
    const a = tintDescription(field, 'x', { seed: 42 });
    const b = tintDescription(field, 'x', { seed: 42 });
    expect(a).toBe(b);
  });

  it('closing time: late + quiet + cold flips the light', () => {
    const field = new RoomField({ mood: -0.5, volume: 0.1, earnestness: 0.4, presence: 0.3 });
    const tinted = tintDescription(field, 'The Tap is a wooden bar by the harbor.', { hour: 23 });
    expect(tinted).toMatch(/disco lights|fluorescents|exit/);
  });

  it('a warm laughing room at 11pm is still the warm bar (joy beats closing)', () => {
    const field = roomFieldFromEvents(warmRoomEvents());
    expect(classify(field, 23)).toBe('joyful');
  });

  it('panic overrides everything', () => {
    const field = new RoomField({ mood: 1, joke_landing: 1, presence: 1, panic: 0.8 });
    const tinted = tintDescription(field, 'The Tap is a wooden bar by the harbor.');
    expect(classify(field)).toBe('panic');
    expect(tinted).toContain('drenched');
  });
});

// =========================================================================
// intentionToReadings — the bridge
// =========================================================================

describe('intentionToReadings', () => {
  it('a joyful intention reads joyful', () => {
    const r = intentionToReadings({ goal: 'have fun', tone: 'joyful' });
    expect(r.mood).toBeGreaterThan(0.2);
    expect(r.joke_landing).toBeGreaterThan(0.2);
  });

  it('an urgent intention reads urgent', () => {
    const r = intentionToReadings({ goal: 'handle this now', tone: 'urgent', priority: 1 });
    expect(r.panic).toBeGreaterThan(0.3);
    expect(r.volume).toBeGreaterThan(0.3);
  });

  it('a task intention leans code', () => {
    const r = intentionToReadings({
      goal: 'refactor the pipeline',
      tone: 'task',
      appName: 'Chess',
    });
    expect(r.model_vs_code).toBeLessThan(-0.2);
  });

  it('alarm words in the goal raise panic', () => {
    const r = intentionToReadings({ goal: 'fire emergency in the server room', tone: 'neutral' });
    expect(r.panic).toBeGreaterThan(0.3);
  });

  it('priority is clamped to [0,1] and readings stay in bounds', () => {
    const r = intentionToReadings({ goal: 'fire drill', tone: 'urgent', priority: 99 });
    for (const name of Object.keys(r) as (keyof typeof r)[]) {
      expect(r[name]).toBeGreaterThanOrEqual(-1);
      expect(r[name]).toBeLessThanOrEqual(1);
    }
    expect(r.panic).toBeLessThanOrEqual(1);
  });

  it('a neutral intention rests near the room-at-rest baseline', () => {
    const r = intentionToReadings({ goal: 'open the desktop', tone: 'neutral', priority: 0 });
    expect(r.mood).toBeCloseTo(DIAL_CENTER.mood, 9);
    expect(r.panic).toBeCloseTo(DIAL_CENTER.panic, 9);
  });

  it('every tone bends the readings the way it declares', () => {
    const playful = intentionToReadings({ goal: 'crack a joke', tone: 'playful' });
    expect(playful.joke_landing).toBeGreaterThan(0.2);

    const serious = intentionToReadings({ goal: 'review the contract', tone: 'serious' });
    expect(serious.earnestness).toBeGreaterThan(DIAL_CENTER.earnestness);
    expect(serious.cynicism).toBe(0); // clamped at the dial's floor — no sneer

    const reflective = intentionToReadings({ goal: 'journal my day', tone: 'reflective' });
    expect(reflective.earnestness).toBeGreaterThan(DIAL_CENTER.earnestness);
    expect(reflective.volume).toBeLessThan(0.3);
  });

  it('warm goal words and action types move the dials', () => {
    const warm = intentionToReadings({ goal: 'throw a party', tone: 'neutral' });
    expect(warm.mood).toBeGreaterThan(0.2);

    const message = intentionToReadings({
      goal: 'hi',
      tone: 'neutral',
      actionType: 'send_message',
    });
    expect(message.presence).toBeGreaterThan(DIAL_CENTER.presence);

    const create = intentionToReadings({ goal: 'write', tone: 'neutral', actionType: 'create' });
    expect(create.mood).toBeGreaterThan(DIAL_CENTER.mood);
  });

  it('creative apps lean model, task apps lean code', () => {
    const creative = intentionToReadings({ goal: 'write', tone: 'neutral', appName: 'Diary' });
    expect(creative.model_vs_code).toBeGreaterThan(0);
  });
});

// =========================================================================
// fieldTension — declared intention vs felt temperature
// =========================================================================

describe('fieldTension', () => {
  it('a room that declares joy but feels cold has a big warm plunge', () => {
    const declared = new RoomField(intentionToReadings({ goal: 'have fun', tone: 'joyful' }));
    const felt = roomFieldFromEvents(coldRoomEvents());
    const tension = fieldTension(declared, felt);
    expect(tension.plunge).toBeGreaterThan(0.4);
    expect(tension.gap).toBeGreaterThan(0);
  });

  it('identical fields have zero gap', () => {
    const field = roomFieldFromEvents(warmRoomEvents());
    expect(field.distance(new RoomField(field.readings))).toBeCloseTo(0, 9);
    expect(new RoomField({}).distance(new RoomField({}))).toBe(0);
  });

  it('serializes warmth, kappa and readings', () => {
    const field = roomFieldFromEvents(warmRoomEvents());
    const json = field.toJSON();
    expect(json.warmth).toBeCloseTo(field.warmth(), 9);
    expect(json.kappa).toBeCloseTo(field.concentration(), 9);
    expect(json.readings).toEqual(field.readings);
    expect(field.toString()).toMatch(/^RoomField\(warmth=/);
  });
});
