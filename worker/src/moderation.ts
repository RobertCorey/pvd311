/**
 * AI moderation of a report's free text (Anthropic, tool-forced structured output).
 * Used twice: by POST /api/intake for in-flow UX (flags + wording polish + reporter note), and by the
 * engine before auto-approval so a client that skipped intake can't bypass review (hitl.ts).
 */
import Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES } from '../../shared/categories.js';
import type { Env } from './contracts.js';

export type IntakeFlag = 'spam' | 'abuse' | 'personal_info' | 'not_311' | 'emergency';
export interface ModerationResult { flags: IntakeFlag[]; polishedDescription: string | null; note: string | null; model: string | null }
export interface ModerationInput { category: string | null; description: string; address: string; extra: Record<string, string>; hasPhoto: boolean }

const TOOL: Anthropic.Tool = {
  name: 'review_report', description: 'Moderate and optionally tidy a resident 311 report.', strict: true,
  input_schema: {
    type: 'object', additionalProperties: false, required: ['flags', 'polishedDescription', 'note'],
    properties: {
      flags: { type: 'array', items: { type: 'string', enum: ['spam', 'abuse', 'personal_info', 'not_311', 'emergency'] } },
      polishedDescription: { type: ['string', 'null'], description: 'Cleaner wording with the SAME facts (≤600 chars), or null if already fine' },
      note: { type: ['string', 'null'], description: 'One short reporter-facing sentence if a flag needs explaining, else null' },
    },
  },
};
const SYSTEM = `You review a resident's Providence, RI 311 service request before it is filed with the city.
Flag: spam (nonsense/ads), abuse (harassment, threats, slurs, targeting a person), personal_info (names, phone numbers, plates of private individuals — except a plate on an ABANDONED vehicle, which the city needs), not_311 (not a city service issue), emergency (fire, injury, crime in progress, gas smell — should call 911).
polishedDescription: only if the text is hard to read; keep every fact, add none, plain and brief. Otherwise null.
note: one short sentence for the reporter only when a flag needs explaining (e.g. "This sounds like an emergency — please call 911."). Otherwise null.`;

const VALID: Set<string> = new Set(['spam', 'abuse', 'personal_info', 'not_311', 'emergency']);

/** Returns an empty result (no flags) when the key is missing or the text is trivially short. Never throws on model quirks. */
export async function moderate(env: Env, input: ModerationInput): Promise<ModerationResult> {
  const description = input.description.slice(0, 2000);
  if (!env.ANTHROPIC_API_KEY || description.trim().length < 3) return { flags: [], polishedDescription: null, note: null, model: null };
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const r = await client.messages.create({
    model: 'claude-opus-5', max_tokens: 4096, output_config: { effort: 'low' }, system: SYSTEM, tools: [TOOL], tool_choice: { type: 'tool', name: 'review_report' },
    messages: [{ role: 'user', content: JSON.stringify({
      category: input.category, categoryLabel: input.category ? CATEGORIES[input.category]?.label ?? null : null,
      description, address: input.address.slice(0, 300), extra: input.extra, hasPhoto: input.hasPhoto,
    }) }],
  });
  const block = r.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const out = (block?.input ?? {}) as { flags?: unknown; polishedDescription?: unknown; note?: unknown };
  const flags = (Array.isArray(out.flags) ? out.flags : []).map(String).filter((f) => VALID.has(f)) as IntakeFlag[];
  return {
    flags: [...new Set(flags)],
    polishedDescription: typeof out.polishedDescription === 'string' && out.polishedDescription ? out.polishedDescription.slice(0, 600) : null,
    note: typeof out.note === 'string' && out.note ? out.note.slice(0, 300) : null,
    model: r.model,
  };
}
