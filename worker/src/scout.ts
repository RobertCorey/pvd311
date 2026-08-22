/**
 * Agent scout — fills Step-3 portal controls that have no static mapping in shared/categories.ts.
 *
 * Instead of pre-crawling every case type (spammy: one orphaned draft per type), the submitter
 * dumps whatever conditional controls the portal renders for THIS report's case type and asks
 * Claude to pick values from the report's own content. Values are constrained to the control's
 * option list where one exists; free-text fields are filled only from facts present in the report.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Report } from '../../shared/types.js';

export interface PortalControl {
  id: string;
  label: string;
  tag: 'select' | 'input' | 'textarea';
  type: string | null;
  required: boolean;
  options?: string[];
  name?: string; // radio group
}

export interface ScoutInput {
  apiKey: string;
  model?: string;
  category: string;
  caseTypeName: string;
  report: Report & { id: string };
  controls: PortalControl[];
}

export interface ScoutResult {
  values: Record<string, string>;
  confidence: number; // 0..1
  notes: string;
}

const SYSTEM = `You fill in the remaining fields of a Providence, RI 311 service-request form on behalf of a resident.
You are given the resident's report (category, description, address, any structured answers) and the list of
form controls the city's portal rendered for this case type that we do not have a static mapping for.

Rules:
- For a select/radio control, choose EXACTLY one of its listed options (verbatim). Prefer the option the report supports.
  If nothing in the report supports a choice, pick the conservative catch-all ("Unknown", "Other (add to description)", etc.)
  and lower your confidence.
- For free-text controls, write a short factual value using ONLY information present in the report. Never invent
  plates, names, numbers, or details. If the report has nothing relevant, leave the control out of \`values\`
  unless it is required — then use a brief honest placeholder like "See description and photo".
- Never fill controls you were not given. Never fill anything labeled "Leave this field blank".
- confidence is your overall confidence (0-1) that a city clerk would consider every chosen value correct and non-junk.`;

const TOOL: Anthropic.Tool = {
  name: 'propose_field_values',
  description: 'Return the values to set on the unmapped portal controls.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['values', 'confidence', 'notes'],
    properties: {
      values: {
        type: 'array',
        description: 'One entry per control you are filling.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'value'],
          properties: {
            id: { type: 'string', description: 'Control id exactly as given' },
            value: { type: 'string', description: 'Option text (verbatim) for select/radio; short text otherwise' },
          },
        },
      },
      confidence: { type: 'number', description: '0-1 overall confidence' },
      notes: { type: 'string', description: 'One line: what you chose and why, or what was ambiguous' },
    },
  },
};

export async function scoutFields(input: ScoutInput): Promise<ScoutResult> {
  if (!input.apiKey) {
    throw new Error(
      `NEEDS_MAPPING: ${input.controls.length} unmapped control(s) for "${input.caseTypeName}" ` +
      `(${input.controls.map((c) => c.id).join(', ')}) and no ANTHROPIC_API_KEY for the scout`,
    );
  }
  const client = new Anthropic({ apiKey: input.apiKey });
  const r = input.report;
  const payload = {
    caseType: input.caseTypeName,
    category: input.category,
    description: r.description,
    address: r.address,
    hasPhoto: !!r.photo,
    structuredAnswers: r.extra ?? {},
    controls: input.controls.map((c) => ({
      id: c.id, label: c.label, kind: c.tag === 'select' ? 'select' : c.type === 'radio' ? 'radio' : c.tag === 'textarea' ? 'text' : c.type || 'text',
      required: c.required, options: c.options,
    })),
  };

  const response = await client.messages.create({
    model: input.model ?? 'claude-opus-5',
    max_tokens: 2048,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'propose_field_values' },
    messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
  });

  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!block) throw new Error(`Scout returned no tool call (stop_reason=${response.stop_reason})`);
  const parsed = block.input as { values: { id: string; value: string }[]; confidence: number; notes: string };

  // Keep only ids we asked about, and coerce select values onto a real option when the model paraphrased.
  const byId = new Map(input.controls.map((c) => [c.id, c]));
  const values: Record<string, string> = {};
  for (const { id, value } of parsed.values) {
    const c = byId.get(id);
    if (!c) continue;
    if (c.options?.length) {
      const exact = c.options.find((o) => o === value) ?? c.options.find((o) => o.toLowerCase() === value.toLowerCase());
      const loose = exact ?? c.options.find((o) => o.toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(o.toLowerCase()));
      if (!loose) continue;
      values[id] = loose;
    } else {
      values[id] = value.trim();
    }
  }
  return { values, confidence: Math.max(0, Math.min(1, parsed.confidence)), notes: parsed.notes };
}
