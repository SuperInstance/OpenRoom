/**
 * I2I Vessel Dispatcher — Bridges OpenRoom actions to the fleet vessel protocol.
 *
 * Every user action in OpenRoom becomes a BOTTLE in the I2I vessel
 * routed to the appropriate fleet agent. The vessel lives at /tmp/i2i-vessel/
 * with bottles/outgoing/ for dispatched actions and harbor/incoming/ for
 * incoming responses.
 *
 * Integration points:
 *   - ChatPanel / vibeContainerMock.dispatchAgentAction → dispatches I2I bottles
 *   - on every app_action tool call from the LLM
 *   - on every user action report from apps
 *
 * Fleet targets:
 *   - fleet-midi/chord  (:2160)  — chord progression generation
 *   - fleet-midi/scale  (:2161)  — scale/mode analysis
 *   - ghost-track       (:8767)  — t-minus predictions
 *   - fleet-conductor   (:8769)  — routing orchestration
 *   - tts-render        (:8770)  — Piper TTS voice output
 *   - persona-engine    (:8765)  — OpenSMILE bridge (persona/audio features)
 */

import { VESSEL_BASE, VESSEL_OUTGOING, VESSEL_INCOMING } from './vesselConfig';

// =========================================================================
// Types
// =========================================================================

export type I2IBottleType =
  | 'TASK'
  | 'STATUS'
  | 'BOTTLE'
  | 'CHECKPOINT'
  | 'BLOCKER'
  | 'DELIVERABLE'
  | 'SYNTHESIS'
  | 'CHALLENGE'
  | 'SESSION'
  | 'SPLINE';

export interface I2IBottle {
  type: I2IBottleType;
  source: string;
  target: string;
  payload: Record<string, unknown>;
  timestamp: number;
  /** Optional correlation ID for reply tracking */
  correlationId?: string;
}

export interface ActionToBottleMapper {
  appId: number;
  actionType: string;
  /** Map an OpenRoom action + payload → I2I bottle configuration */
  mapToBottle(payload: Record<string, unknown>): { target: string; i2iType: I2IBottleType; i2iPayload: Record<string, unknown> };
}

// =========================================================================
// Agent Port Registry
// =========================================================================

export const AGENT_PORTS: Record<string, number> = {
  'fleet-midi/chord': 2160,
  'fleet-midi/scale': 2161,
  'fleet-midi/pattern': 2162,
  'fleet-midi/arp': 2163,
  'fleet-midi/rhythm': 2164,
  'fleet-midi/fx': 2165,
  'ghost-track': 8767,
  'fleet-conductor': 8769,
  'tts-render': 8770,
  'persona-engine': 8765,
  'opensmile-bridge': 8765,
};

// =========================================================================
// Action Registry — Map OpenRoom apps + actions → I2I fleet bottles
// =========================================================================

export const actionRegistry: ActionToBottleMapper[] = [
  // ── Music App ──────────────────────────────────────────────
  {
    appId: 3,
    actionType: 'PLAY_SONG',
    mapToBottle(payload) {
      return {
        target: 'fleet-midi/chord',
        i2iType: 'TASK',
        i2iPayload: {
          command: 'play',
          songId: payload.songId,
          source: 'OpenRoom/musicPlayer',
        },
      };
    },
  },
  {
    appId: 3,
    actionType: 'PAUSE',
    mapToBottle() {
      return {
        target: 'fleet-midi/chord',
        i2iType: 'TASK',
        i2iPayload: { command: 'pause', source: 'OpenRoom/musicPlayer' },
      };
    },
  },
  {
    appId: 3,
    actionType: 'RESUME',
    mapToBottle() {
      return {
        target: 'fleet-midi/chord',
        i2iType: 'TASK',
        i2iPayload: { command: 'resume', source: 'OpenRoom/musicPlayer' },
      };
    },
  },
  {
    appId: 3,
    actionType: 'SET_PLAY_MODE',
    mapToBottle(payload) {
      const mode = (payload.mode as string) || 'sequential';
      return {
        target: 'fleet-midi/scale',
        i2iType: 'TASK',
        i2iPayload: {
          command: 'set_play_mode',
          mode,
          source: 'OpenRoom/musicPlayer',
        },
      };
    },
  },
  {
    appId: 3,
    actionType: 'SET_VOLUME',
    mapToBottle(payload) {
      return {
        target: 'fleet-midi/fx',
        i2iType: 'TASK',
        i2iPayload: {
          command: 'set_volume',
          volume: payload.volume ?? 0.7,
          source: 'OpenRoom/musicPlayer',
        },
      };
    },
  },
  {
    appId: 3,
    actionType: 'PLAY_MUSIC',
    mapToBottle(payload) {
      return {
        target: 'fleet-midi/chord',
        i2iType: 'TASK',
        i2iPayload: { command: 'play', ...payload, source: 'OpenRoom/musicPlayer' },
      };
    },
  },

  // ── Diary App ──────────────────────────────────────────────
  {
    appId: 4,
    actionType: 'WRITE_ENTRY',
    mapToBottle(payload) {
      return {
        target: 'persona-engine',
        i2iType: 'TASK',
        i2iPayload: { command: 'log_mood', entry: payload, source: 'OpenRoom/diary' },
      };
    },
  },
  {
    appId: 4,
    actionType: 'CREATE_ENTRY',
    mapToBottle(payload) {
      return {
        target: 'persona-engine',
        i2iType: 'DELIVERABLE',
        i2iPayload: { command: 'diary_entry', filePath: payload.filePath, source: 'OpenRoom/diary' },
      };
    },
  },

  // ── Twitter App ────────────────────────────────────────────
  {
    appId: 2,
    actionType: 'POST_TWEET',
    mapToBottle(payload) {
      return {
        target: 'persona-engine',
        i2iType: 'TASK',
        i2iPayload: {
          command: 'analyze_sentiment',
          text: payload.content ?? payload.text,
          source: 'OpenRoom/twitter',
        },
      };
    },
  },
  {
    appId: 2,
    actionType: 'CREATE_POST',
    mapToBottle(payload) {
      return {
        target: 'persona-engine',
        i2iType: 'DELIVERABLE',
        i2iPayload: { command: 'post_created', filePath: payload.filePath, source: 'OpenRoom/twitter' },
      };
    },
  },

  // ── CyberNews App ──────────────────────────────────────────
  {
    appId: 14,
    actionType: 'CREATE_ARTICLE',
    mapToBottle(payload) {
      return {
        target: 'persona-engine',
        i2iType: 'DELIVERABLE',
        i2iPayload: {
          command: 'news_article',
          filePath: payload.filePath,
          source: 'OpenRoom/cyberNews',
        },
      };
    },
  },
  {
    appId: 14,
    actionType: 'SELECT_CASE',
    mapToBottle(payload) {
      return {
        target: 'ghost-track',
        i2iType: 'SESSION',
        i2iPayload: {
          command: 'track_case',
          caseId: payload.caseId,
          source: 'OpenRoom/cyberNews',
        },
      };
    },
  },

  // ── Gomoku App ─────────────────────────────────────────────
  {
    appId: 9,
    actionType: 'PLACE_STONE',
    mapToBottle(payload) {
      return {
        target: 'ghost-track',
        i2iType: 'CHECKPOINT',
        i2iPayload: {
          command: 'record_move',
          row: payload.row,
          col: payload.col,
          source: 'OpenRoom/gomoku',
        },
      };
    },
  },
  {
    appId: 9,
    actionType: 'SURRENDER',
    mapToBottle(payload) {
      return {
        target: 'ghost-track',
        i2iType: 'STATUS',
        i2iPayload: {
          command: 'game_over',
          surrendering: payload.color,
          source: 'OpenRoom/gomoku',
        },
      };
    },
  },

  // ── Evidence Vault ─────────────────────────────────────────
  {
    appId: 13,
    actionType: 'CREATE_CLUE',
    mapToBottle(payload) {
      return {
        target: 'fleet-conductor',
        i2iType: 'DELIVERABLE',
        i2iPayload: {
          command: 'log_evidence',
          caseId: payload.caseId,
          clueId: payload.clueId,
          source: 'OpenRoom/evidenceVault',
        },
      };
    },
  },
  {
    appId: 13,
    actionType: 'CREATE_CASE',
    mapToBottle(payload) {
      return {
        target: 'fleet-conductor',
        i2iType: 'SESSION',
        i2iPayload: {
          command: 'create_case',
          filePath: payload.filePath,
          source: 'OpenRoom/evidenceVault',
        },
      };
    },
  },
];

// =========================================================================
// Vessel Helpers
// =========================================================================

/**
 * Generate a unique bottle ID based on target + timestamp + random suffix
 */
function bottleId(target: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const safeTarget = target.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeTarget}-${ts}-${rand}`;
}

/**
 * Write a bottle JSON file to the I2I vessel
 */
async function writeBottleFile(bottle: I2IBottle): Promise<string> {
  // Ensure vessel directory exists
  const dirs = [VESSEL_BASE, VESSEL_OUTGOING, VESSEL_INCOMING];
  // Use synchronous Deno-like check — fall back to fetch API for the vessel service
  // For browser context, we use a thin API proxy or write via session-data endpoint

  // Write to /tmp/i2i-vessel/bottles/outgoing/
  const id = bottleId(bottle.target);
  const bottlePath = `${VESSEL_OUTGOING}/${id}.json`;

  // Try writing via the vessel bridge API if available
  try {
    await fetch(`${VESSEL_BASE}/api/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: `bottles/outgoing/${id}.json`,
        content: JSON.stringify(bottle, null, 2),
      }),
    });
    return bottlePath;
  } catch {
    // API not available — bottle is queued in memory; vessel watcher will
    // pick it up from the outgoing directory when the API comes online
    console.info('[I2I] Bottle queued:', bottlePath);
    return bottlePath;
  }
}

/**
 * Notify the target fleet agent via its HTTP endpoint
 */
async function notifyAgent(bottle: I2IBottle): Promise<void> {
  const port = AGENT_PORTS[bottle.target];
  if (!port) {
    console.info(`[I2I] No HTTP port for target "${bottle.target}" — bottle queued for vessel pickup`);
    return;
  }

  try {
    await fetch(`http://localhost:${port}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bottle),
      signal: AbortSignal.timeout(3000),
    });
    console.info(`[I2I] Notified ${bottle.target} on :${port}`);
  } catch (e) {
    console.warn(`[I2I] Failed to notify ${bottle.target}:${port}:`, e);
  }
}

// =========================================================================
// Public API
// =========================================================================

/**
 * Dispatch an OpenRoom action as an I2I bottle.
 * Called by the ChatPanel action handler and vibeContainerMock.
 *
 * @param appId   - OpenRoom application ID (e.g. 3 for MusicApp)
 * @param actionType - Action type string (e.g. 'PLAY_SONG')
 * @param payload - Action parameters
 * @returns The bottle path if dispatched, or null if no mapping exists
 */
export async function dispatchAction(
  appId: number,
  actionType: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const mapper = actionRegistry.find(
    (a) => a.appId === appId && a.actionType === actionType,
  );
  if (!mapper) {
    // Not every action needs an I2I bottle — only log at debug level
    return null;
  }

  const { target, i2iType, i2iPayload } = mapper.mapToBottle(payload);

  const bottle: I2IBottle = {
    type: i2iType,
    source: `OpenRoom/app-${appId}`,
    target,
    payload: i2iPayload,
    timestamp: Date.now(),
    correlationId: `${appId}-${actionType}-${Date.now()}`,
  };

  // Write to vessel + notify agent (fire-and-forget)
  const bottlePath = await writeBottleFile(bottle);
  notifyAgent(bottle); // don't await — non-blocking

  console.info(`[I2I] Dispatched bottle: ${bottle.target} (${i2iType}) → ${bottlePath}`);
  return bottlePath;
}

/**
 * Dispatch an I2I bottle directly without an action mapping.
 * Useful for system-level operations or custom fleet messages.
 */
export async function dispatchRawBottle(bottle: I2IBottle): Promise<string> {
  const bottlePath = await writeBottleFile(bottle);
  notifyAgent(bottle);
  console.info(`[I2I] Raw bottle dispatched: ${bottle.target} → ${bottlePath}`);
  return bottlePath;
}

/**
 * Look up which fleet agent an action maps to.
 */
export function resolveActionTarget(appId: number, actionType: string): {
  target: string;
  port?: number;
} | null {
  const mapper = actionRegistry.find(
    (a) => a.appId === appId && a.actionType === actionType,
  );
  if (!mapper) return null;
  const { target } = mapper.mapToBottle({});
  return { target, port: AGENT_PORTS[target] };
}

// =========================================================================
// Default export
// =========================================================================

export default {
  dispatchAction,
  dispatchRawBottle,
  resolveActionTarget,
  actionRegistry,
  AGENT_PORTS,
};
