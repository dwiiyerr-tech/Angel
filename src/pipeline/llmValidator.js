import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const LLMResponseSchema = z.object({
  verdict: z.enum(['BUY', 'WATCH', 'PASS']),
  confidence: z.number().min(0).max(100),
  selected_candidate_id: z.number().nullable().optional(),
  selected_mint: z.string().nullable().optional(),
  thesis: z.array(z.string()).max(5).optional(),
  missing_confirmation: z.array(z.string()).max(3).optional(),
  reason: z.string().max(1000).optional(),
  risks: z.array(z.string()).max(10).optional(),
  suggested_tp_percent: z.number().min(0).max(1000).optional(),
  suggested_sl_percent: z.number().min(-100).max(0).optional(),
});

export function validateLLMResponse(raw) {
  try {
    const input = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // Providers occasionally return otherwise-valid responses with more
    // explanatory bullets than requested. Bound those fields before strict
    // validation instead of discarding a potentially valid BUY decision.
    const data = input && typeof input === 'object' ? {
      ...input,
      thesis: Array.isArray(input.thesis) ? input.thesis.slice(0, 5) : input.thesis,
      missing_confirmation: Array.isArray(input.missing_confirmation)
        ? input.missing_confirmation.slice(0, 3)
        : input.missing_confirmation,
      risks: Array.isArray(input.risks) ? input.risks.slice(0, 10) : input.risks,
    } : input;
    const parsed = LLMResponseSchema.safeParse(data);
    
    if (!parsed.success) {
      logParseError(raw, parsed.error);
      return { valid: false, errors: parsed.error };
    }
    
    return { valid: true, data: parsed.data };
  } catch (err) {
    logParseError(raw, err.message);
    return { valid: false, errors: err.message };
  }
}

function logParseError(raw, error) {
  try {
    const logDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logEntry = {
      timestamp: new Date().toISOString(),
      error: error,
      raw: raw
    };
    fs.appendFileSync(
      path.join(logDir, 'llm_parse_errors.jsonl'), 
      JSON.stringify(logEntry) + '\n'
    );
  } catch (e) {
    console.error('Failed to log parse error:', e);
  }
}
