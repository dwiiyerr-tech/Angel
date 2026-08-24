import { processCandidateFromSignals } from '../pipeline/orchestrator.js';
import { setCandidateHandler as setPumpportalHandler } from '../signals/pumpportal.js';
import { setCandidateHandler as setPregradHandler } from '../signals/pumpfunPregrad.js';
import { setCandidateHandler as setFeeClaimHandler, startWebsocket as startFeeClaimWebsocket } from '../signals/feeClaim.js';
import { ensureFastHunterSchema, isFastHunterSignal, processFastResearchCandidate } from './fastHunter.js';

let started = false;

export async function routeSignalFastAware(signals) {
  if (isFastHunterSignal(signals)) return processFastResearchCandidate(signals);
  return processCandidateFromSignals(signals);
}

export function startFastHunterRuntime() {
  if (started) return;
  started = true;
  ensureFastHunterSchema();

  // startAngel() initially wires these handlers to the legacy/full pipeline.
  // Replace only the signal entrypoint after startup; the wrapper delegates every
  // non-Research/non-fast route straight back to the existing orchestrator.
  setPumpportalHandler(routeSignalFastAware);
  setPregradHandler(routeSignalFastAware);
  setFeeClaimHandler(routeSignalFastAware);

  // The fee-claim listener already uses confirmed Solana logs, reconnects after
  // disconnects, and requires only the configured RPC WebSocket endpoint.
  startFeeClaimWebsocket();

  console.log('[fast-hunter] Research Fast Hunter V1 active for pumpportal_graduated + pumpfun_pregrad; Solana fee WS enabled');
}
