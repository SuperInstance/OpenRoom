/**
 * I2I Vessel Configuration
 *
 * Defines paths for the I2I vessel protocol. The vessel lives at /tmp/i2i-vessel/
 * and is shared between all OpenRoom components and fleet agents.
 *
 * Directory structure:
 *   /tmp/i2i-vessel/
 *     bottles/outgoing/   ← bottles dispatched from OpenRoom to fleet agents
 *     harbor/incoming/    ← incoming responses from fleet agents
 *     opensmile-bridge/   ← OpenSMILE bridge communication
 */

export const VESSEL_BASE = '/tmp/i2i-vessel';
export const VESSEL_OUTGOING = `${VESSEL_BASE}/bottles/outgoing`;
export const VESSEL_INCOMING = `${VESSEL_BASE}/harbor/incoming`;
