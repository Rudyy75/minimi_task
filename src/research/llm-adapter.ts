import { z } from "zod";

export interface LLMPort {
  complete(prompt: string, signal: AbortSignal): Promise<string>;
}

const responseSchema = z.object({ output: z.array(z.object({
  content: z.array(z.object({ text: z.string().optional() }).passthrough()).optional(),
}).passthrough()) }).passthrough();

export class OpenAIResponsesPort implements LLMPort {
  constructor(private readonly apiKey: string, private readonly model: string, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey || !model) throw new TypeError("OpenAI API key and model are required");
  }

  async complete(prompt: string, signal: AbortSignal): Promise<string> {
    const response = await this.fetcher("https://api.openai.com/v1/responses", {
      method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: prompt }), signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`OpenAI Responses API returned HTTP ${response.status}`);
    const parsed = responseSchema.parse(payload);
    const text = parsed.output.flatMap(({ content }) => content ?? []).map(({ text }) => text ?? "").join("").trim();
    if (!text) throw new Error("OpenAI Responses API returned no text");
    return text;
  }
}
