import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Stage 1: collection ───────────────────────────────────────────────────────
const COLLECTION_SYSTEM = `You are a warm, friendly intake assistant for Presley Angle, a top-rated realtor at EPM Real Estate in Cape Girardeau, Missouri.

Your job: have a brief, natural conversation to learn the visitor's real estate needs so Presley can reach out prepared.

Rules:
- Keep each message to 1-2 sentences. Warm and human — not salesy, not formal.
- Ask only ONE question per turn.
- No bullet points, no bold, no markdown formatting in your responses.
- Collect these five things naturally through conversation:
  1. Are they buying, selling, or referring a client?
  2. Location or neighborhood of interest
  3. Timeline (urgent, within a few months, or just exploring)
  4. Budget range (buyers) or estimated home value (sellers)
  5. Their name and best contact — phone number or email address

When you have all five, respond with EXACTLY this format and nothing else:
LEAD_COMPLETE|||[Name] is [buying/selling/referring a client]. [2-3 sentence summary of their situation.] Best contact: [phone or email].

If someone asks about specific properties, pricing, or market data, say: "That's a great question for Presley — I'll make sure she knows you asked!"`;

// ── Stage 2: agent ────────────────────────────────────────────────────────────
const AGENT_SYSTEM = `You are a lead quality and response agent for Presley Angle, a realtor at EPM Real Estate in Cape Girardeau, Missouri (direct line: (573) 803-8567).

You receive a raw lead summary from a chat intake conversation. Your job has two steps:

STEP 1 — VALIDATE. Check every field is present AND specific enough to act on:
  - Intent: buying, selling, or referring (must be explicit)
  - Location: an actual neighborhood, city, or address — "Cape Girardeau area" is too vague
  - Timeline: a real timeframe — "soon" or "eventually" is too vague; need months/season/year
  - Budget or value: a dollar figure or range — "affordable" is too vague
  - Contact: full name + phone OR email — first name only is too vague

If anything is missing or too vague, call request_clarification with a single warm, natural follow-up question. Do not list multiple questions.

STEP 2 — DRAFT (only when all fields pass). Call finalize_lead with:
  a. A clean 2-3 sentence lead summary for Presley's records
  b. A subject line for the client email
  c. A confirmation email FROM Presley TO the client:
     - Warm, personal, genuine — Presley's voice (local, down-to-earth, not corporate)
     - Reference their specific situation by detail (neighborhood, timeline, budget)
     - Tell them she'll reach out within a few hours or by next business morning
     - Keep it to 4-5 sentences, no bullet points
     - Sign: Presley Angle | (573) 803-8567 | EPM Real Estate, Cape Girardeau
  d. A briefing FOR Presley (use short bullets):
     - Contact name and info
     - Situation in one sentence
     - Estimated deal value
     - Urgency: Hot / Warm / Exploratory
     - 2-3 suggested opening questions for her first call`;

const AGENT_TOOLS = [
  {
    name: 'finalize_lead',
    description: 'Called when all lead fields are validated and emails are drafted',
    input_schema: {
      type: 'object',
      properties: {
        lead_summary:          { type: 'string', description: 'Clean 2-3 sentence summary for records' },
        client_email_subject:  { type: 'string' },
        client_email_body:     { type: 'string', description: 'Email from Presley to the client' },
        presley_briefing:      { type: 'string', description: 'Pre-call briefing with talking points' },
      },
      required: ['lead_summary', 'client_email_subject', 'client_email_body', 'presley_briefing'],
    },
  },
  {
    name: 'request_clarification',
    description: 'Called when a required field is missing or too vague to act on',
    input_schema: {
      type: 'object',
      properties: {
        clarifying_question: { type: 'string', description: 'One warm follow-up question for the visitor' },
      },
      required: ['clarifying_question'],
    },
  },
];

async function runAgent(rawSummary) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1200,
    system: AGENT_SYSTEM,
    tools: AGENT_TOOLS,
    messages: [{ role: 'user', content: `Lead summary from intake:\n\n${rawSummary}` }],
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) return { isComplete: false, clarifyingQuestion: null };

  if (toolUse.name === 'request_clarification') {
    return { isComplete: false, clarifyingQuestion: toolUse.input.clarifying_question };
  }

  const { lead_summary, client_email_subject, client_email_body, presley_briefing } = toolUse.input;
  return {
    isComplete: true,
    leadSummary:        lead_summary,
    clientEmailSubject: client_email_subject,
    clientEmailBody:    client_email_body,
    presleyBriefing:    presley_briefing,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let messages;
  try {
    ({ messages } = JSON.parse(event.body));
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) {
      return { statusCode: 400, body: 'Invalid request' };
    }
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  try {
    // ── Stage 1: collection turn ──────────────────────────────────
    const collection = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: COLLECTION_SYSTEM,
      messages,
    });

    const text = collection.content[0]?.type === 'text'
      ? collection.content[0].text.trim()
      : '';

    if (!text.startsWith('LEAD_COMPLETE|||')) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
        body: JSON.stringify({ reply: text, complete: false }),
      };
    }

    // ── Stage 2: validate + draft ─────────────────────────────────
    const rawSummary = text.replace('LEAD_COMPLETE|||', '').trim();
    const result = await runAgent(rawSummary);

    if (!result.isComplete) {
      // Agent found a gap — continue the conversation
      const question = result.clarifyingQuestion
        ?? 'Could you share a bit more detail so Presley can reach out fully prepared?';
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
        body: JSON.stringify({ reply: question, complete: false }),
      };
    }

    // ── Complete: show client the drafted email ────────────────────
    const chatReply =
      `Presley's been notified — here's the note she'll be sending you:\n\n` +
      `"${result.clientEmailBody}"`;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
      body: JSON.stringify({
        reply:              chatReply,
        complete:           true,
        summary:            result.leadSummary,
        clientEmailSubject: result.clientEmailSubject,
        clientEmailBody:    result.clientEmailBody,
        presleyBriefing:    result.presleyBriefing,
      }),
    };

  } catch (err) {
    console.error('Chat error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
      body: JSON.stringify({ error: 'Something went wrong. Please try again.' }),
    };
  }
};
