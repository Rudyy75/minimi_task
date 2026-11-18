import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponsesPort } from "../src/research/llm-adapter.js";

test("OpenAI Responses adapter sends authenticated prompts and returns validated output text", async () => {
  const port = new OpenAIResponsesPort("test-key", "test-model", (async (input, init) => {
    assert.equal(input, "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    assert.equal((JSON.parse(String(init?.body)) as { model: string; input: string }).model, "test-model");
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] });
  }) as typeof fetch);
  assert.equal(await port.complete("say hello", new AbortController().signal), "hello");
  const broken = new OpenAIResponsesPort("test-key", "test-model", (async () => Response.json({ output: [] })) as typeof fetch);
  await assert.rejects(() => broken.complete("prompt", new AbortController().signal), /no text/);
});
