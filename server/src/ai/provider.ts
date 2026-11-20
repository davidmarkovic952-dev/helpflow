import type { Config } from '../config.js';

export interface LlmCall { system: string; user: string; json?: boolean; maxTokens?: number }
export type Llm = (c: LlmCall) => Promise<string>;

/** LLM klijent sa vremenskim ograničenjem. Bez alata/funkcija — model ne može ništa da "uradi", samo da predloži tekst. */
export function createLlm(cfg: Config, fetcher: typeof fetch = fetch): Llm | null {
  if (cfg.AI_PROVIDER === 'gemini') {
    return async ({ system, user, json, maxTokens = 800 }) => {
      const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_MODEL}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.GEMINI_API_KEY! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) }
        })
      });
      if (!res.ok) throw new Error(`LLM ${res.status}`);
      const d = await res.json();
      return d?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
    };
  }
  if (cfg.AI_PROVIDER === 'anthropic') {
    return async ({ system, user, maxTokens = 800 }) => {
      const res = await fetcher('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.ANTHROPIC_MODEL, max_tokens: maxTokens, temperature: 0.2, system, messages: [{ role: 'user', content: user }] })
      });
      if (!res.ok) throw new Error(`LLM ${res.status}`);
      const d = await res.json();
      return (d.content || []).map((c: { text?: string }) => c.text || '').join('');
    };
  }
  return null;
}
