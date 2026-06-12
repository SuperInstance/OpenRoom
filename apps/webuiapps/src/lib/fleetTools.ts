/**
 * Fleet Service Tools — enables the LLM to control fleet services
 * via natural language commands dispatched as I2I bottles.
 *
 * Each tool maps a natural language intent → I2I bottle → fleet agent.
 */

import { dispatchRawBottle, AGENT_PORTS } from './i2iDispatcher';
import type { ToolDef } from './llmClient';

// =========================================================================
// Fleet Agent Endpoint Check
// =========================================================================

const FLEET_AGENTS: Record<string, { port: number; label: string }> = {
  'fleet-midi/chord': { port: 2160, label: 'Chord progression' },
  'fleet-midi/scale': { port: 2161, label: 'Scale analysis' },
  'fleet-midi/pattern': { port: 2162, label: 'Pattern voicing' },
  'fleet-midi/tempo': { port: 2163, label: 'Tempo control' },
  'fleet-midi/cc': { port: 2164, label: 'MIDI CC control' },
  'fleet-midi/expression': { port: 2165, label: 'Expression control' },
  'ghost-track': { port: 8767, label: 'Ghost Track event tracking' },
  'fleet-conductor': { port: 8769, label: 'Fleet Conductor orchestration' },
  'tts-render': { port: 8770, label: 'TTS voice output' },
  'persona-engine': { port: 8765, label: 'Persona/Audio engine' },
};

// =========================================================================
// Fleet Status Tool
// =========================================================================

export function getFleetStatusToolDefinition(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'fleet_status',
      description:
        'Query the current status of all fleet services (MIDI agents, ghost track, TTS, persona engine). Returns which agents are online and their current state.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  };
}

/**
 * Execute a fleet status check across all known agents.
 * Returns a markdown-formatted string of agent statuses.
 */
export async function executeFleetStatus(): Promise<string> {
  const results: string[] = [];

  for (const [key, agent] of Object.entries(FLEET_AGENTS)) {
    try {
      const res = await fetch(`http://localhost:${agent.port}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'status' }),
      });
      if (res.ok) {
        const data = await res.json();
        results.push(`✓ **${agent.label}** (${key}, :${agent.port}): ${JSON.stringify(data)}`);
      } else {
        results.push(`⚠ **${agent.label}** (${key}, :${agent.port}): HTTP ${res.status}`);
      }
    } catch {
      results.push(`✗ **${agent.label}** (${key}, :${agent.port}): Unreachable`);
    }
  }

  return results.length > 0
    ? `## Fleet Status\n\n${results.join('\n')}`
    : 'No fleet agents found.';
}

// =========================================================================
// Play Music Tool
// =========================================================================

export function getPlayMusicToolDefinition(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'play_music',
      description:
        'Play music through the fleet MIDI system. Specify a genre/style and optional parameters. Dispatches I2I bottles to the MIDI agents.',
      parameters: {
        type: 'object',
        properties: {
          genre: {
            type: 'string',
            description: 'Music genre or style — e.g. "jazz", "classical", "electronic", "ambient", "blues"',
          },
          tempo: {
            type: 'number',
            description: 'BPM tempo (60-200). Default 120.',
          },
          intensity: {
            type: 'number',
            description: 'Expression intensity 0.0-1.0. Default 0.5.',
          },
        },
        required: ['genre'],
      },
    },
  };
}

/**
 * Execute play_music by dispatching I2I bottles to fleet MIDI agents.
 */
export async function executePlayMusic(params: {
  genre: string;
  tempo?: number;
  intensity?: number;
}): Promise<string> {
  const { genre, tempo = 120, intensity = 0.5 } = params;
  const timestamp = Date.now();

  // Dispatch bottles to all MIDI agents
  const bottles = [
    {
      target: 'fleet-midi/chord',
      payload: {
        command: 'play',
        genre,
        chord_mode: genre === 'jazz' ? 'extended' : 'diatonic',
        source: 'ChatPanel/play_music',
      },
    },
    {
      target: 'fleet-midi/scale',
      payload: {
        command: 'set_scale',
        genre,
        source: 'ChatPanel/play_music',
      },
    },
    {
      target: 'fleet-midi/tempo',
      payload: {
        command: 'set_tempo',
        bpm: tempo,
        feel: tempo >= 140 ? 'fast' : tempo <= 80 ? 'slow' : 'moderate',
        source: 'ChatPanel/play_music',
      },
    },
    {
      target: 'fleet-midi/expression',
      payload: {
        command: 'set_expression',
        intensity,
        articulation: genre === 'jazz' ? 'swing' : 'legato',
        source: 'ChatPanel/play_music',
      },
    },
  ];

  const results: string[] = [];
  for (const bottle of bottles) {
    try {
      await dispatchRawBottle({
        type: 'TASK',
        source: 'ChatPanel/play_music',
        target: bottle.target,
        payload: bottle.payload,
        timestamp,
      });

      // Also try direct HTTP agent notification
      const port = AGENT_PORTS[bottle.target];
      if (port) {
        try {
          await fetch(`http://localhost:${port}/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bottle.payload),
          });
          results.push(`✓ ${bottle.target}: dispatched`);
        } catch (e) {
          results.push(`⚠ ${bottle.target}: bottle queued, agent notify failed`);
        }
      }
    } catch (e) {
      results.push(`✗ ${bottle.target}: failed`);
    }
  }

  return results.length > 0
    ? `## Music Playback\n\nPlaying **${genre}** (${tempo}BPM, intensity=${intensity}).\n\n${results.join('\n')}`
    : 'Failed to dispatch music commands.';
}

// =========================================================================
// Speak Text Tool (TTS via Piper on :8770)
// =========================================================================

export function getSpeakTextToolDefinition(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'speak_text',
      description:
        'Speak text aloud through the TTS system (Piper voice on port 8770).',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to speak aloud',
          },
        },
        required: ['text'],
      },
    },
  };
}

export async function executeSpeakText(params: { text: string }): Promise<string> {
  const { text } = params;
  try {
    const res = await fetch('http://localhost:8770/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const data = await res.json();
      return `✓ TTS: "${text.slice(0, 80)}..." → ${JSON.stringify(data)}`;
    }
    return `⚠ TTS returned HTTP ${res.status}`;
  } catch {
    return '✗ TTS agent unreachable on :8770';
  }
}

// =========================================================================
// Set Volume Tool
// =========================================================================

export function getSetVolumeToolDefinition(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'set_volume',
      description:
        'Set the volume of the music output (0.0 = silent, 1.0 = max). Dispatches to fleet expression/MIDI CC agents.',
      parameters: {
        type: 'object',
        properties: {
          volume: {
            type: 'number',
            description: 'Volume level 0.0 to 1.0',
          },
        },
        required: ['volume'],
      },
    },
  };
}

export async function executeSetVolume(params: { volume: number }): Promise<string> {
  const { volume } = params;
  const clamped = Math.max(0, Math.min(1, volume));

  const timestamp = Date.now();
  const ccValue = Math.round(clamped * 127);

  try {
    await dispatchRawBottle({
      type: 'TASK',
      source: 'ChatPanel/set_volume',
      target: 'fleet-midi/cc',
      payload: { command: 'set_cc', cc: 7, value: ccValue, source: 'ChatPanel/set_volume' },
      timestamp,
    });
    await dispatchRawBottle({
      type: 'TASK',
      source: 'ChatPanel/set_volume',
      target: 'fleet-midi/expression',
      payload: { command: 'set_expression', intensity: clamped, source: 'ChatPanel/set_volume' },
      timestamp,
    });

    await fetch(`http://localhost:2164/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'set_cc', cc: 7, value: ccValue }),
    });
    await fetch(`http://localhost:2165/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'set_expression', intensity: clamped }),
    });

    return `✓ Volume set to ${clamped.toFixed(2)} (MIDI CC 7 = ${ccValue})`;
  } catch (e) {
    return `✗ Volume control failed: ${e}`;
  }
}

// =========================================================================
// Check if a function name is a fleet tool
// =========================================================================

export const FLEET_TOOL_NAMES = new Set([
  'fleet_status',
  'play_music',
  'speak_text',
  'set_volume',
]);

export function isFleetTool(name: string): boolean {
  return FLEET_TOOL_NAMES.has(name);
}

export function getFleetToolDefinitions(): ToolDef[] {
  return [
    getFleetStatusToolDefinition(),
    getPlayMusicToolDefinition(),
    getSpeakTextToolDefinition(),
    getSetVolumeToolDefinition(),
  ];
}

/**
 * Execute a named fleet tool with the given parameters.
 */
export async function executeFleetTool(
  name: string,
  params: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'fleet_status':
      return executeFleetStatus();
    case 'play_music':
      return executePlayMusic(params as { genre: string; tempo?: number; intensity?: number });
    case 'speak_text':
      return executeSpeakText(params as { text: string });
    case 'set_volume':
      return executeSetVolume(params as { volume: number });
    default:
      return `error: unknown fleet tool "${name}"`;
  }
}
