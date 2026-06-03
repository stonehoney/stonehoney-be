import type { APIRoute } from 'astro';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: import.meta.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an experienced beekeeper with 20+ years of hands-on practice managing colonies across different climates and hive types.

You answer questions about hive management, bee health, disease identification, equipment, seasonal care, swarm prevention, honey production, and queen rearing.

Rules:
- Stay on topic. If asked about something unrelated to beekeeping, politely redirect.
- Be specific and practical. Beekeepers are hands-on people — skip the hedging and give concrete guidance.
- For disease diagnosis, describe symptoms and likely causes clearly, but recommend consulting a local bee inspector or extension service for confirmation before treating.
- For treatment dosing, always note that approved treatments and regulations vary by country and region — direct users to verify with their local authority or the product label.
- If you're uncertain, say so clearly. A wrong answer about varroa treatment causes real harm.
- Don't pad answers with caveats or disclaimers beyond what's genuinely useful. Experienced beekeepers want direct answers.`;

// Simple in-memory rate limiter: 10 requests per hour per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return false;
  }

  if (entry.count >= 10) return true;

  entry.count++;
  return false;
}

export const POST: APIRoute = async ({ request }) => {
  const ip = request.headers.get('x-forwarded-for') ?? 'unknown';

  if (isRateLimited(ip)) {
    return new Response(
      JSON.stringify({ error: 'rate_limited' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let question: string;
  try {
    const body = await request.json();
    question = (body.question ?? '').trim();
    if (!question) throw new Error('empty');
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid_request' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: question }],
  });

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const chunk of stream) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(chunk.delta.text));
          }
        }
      } catch {
        controller.enqueue(encoder.encode('\n\n[Error generating response. Please try again.]'));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
