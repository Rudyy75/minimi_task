# Minimi temporal verification agent

Minimi recalls dated conversations and checks saved claims against current web evidence. Temporal resolution, comparisons, confidence, and final wording are deterministic; the optional model only extracts source-backed claims.

## Quick start

Requires Node.js 20.6 or newer.

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:3000`. The local SQLite database is created at `data/minimi.sqlite`; a fresh database receives three synthetic benchmark conversations. The benchmark buttons work without API keys and their fixture evidence is labelled as demo data.

To use live providers, copy `.env.example` to `.env` and set `TAVILY_API_KEY` and `OPENAI_API_KEY`. `OPENAI_MODEL` defaults to `gpt-6-luna`. Memory stays in the local SQLite database; only the question and selected search evidence go to configured providers.

## Checks

```sh
npm test
npm run build
npm run eval
```

The deterministic eval uses a fixed clock and fake search/model ports, then writes measured results to `artifacts/eval.json`. It does not call live providers.

`npm run eval:live` is an optional provider smoke check. It requires both keys and calls Tavily and OpenAI; it is intentionally separate from tests and CI.
