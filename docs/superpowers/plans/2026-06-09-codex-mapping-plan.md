# Implementation Plan: Map Codex Model Names for both OpenAI and OpenAI Response (v1/responses) APIs

This plan implements a static model mapping layer (`CODEX_MODEL_MAP`) inside the `FormatConverter` class to correctly translate Codex model names (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`) into their corresponding supported Gemini model names for both standard OpenAI chat completion (`/v1/chat/completions`) and OpenAI Response API (`/v1/responses`) endpoints.

## Context
Codex clients use model names like `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`. These need to be mapped automatically to Google's supported Gemini models:
- `gpt-5.5` -> `models/gemini-3.5-flash`
- `gpt-5.4` -> `models/gemini-2.5-pro`
- `gpt-5.4-mini` -> `models/gemini-2.5-flash`

Codex clients utilize the OpenAI Response API format (`/v1/responses`). Therefore, we must perform the model mapping inside both `translateOpenAIToGoogle(...)` and `translateOpenAIResponseToGoogle(...)` format translation layers.

---

## Proposed Changes

### 1. Static Model Map Definition (`src/core/FormatConverter.js`)
Add `CODEX_MODEL_MAP` as a static member at the top of the `FormatConverter` class:
```javascript
    static CODEX_MODEL_MAP = {
        "gpt-5.4": "models/gemini-2.5-pro",
        "gpt-5.4-mini": "models/gemini-2.5-flash",
        "gpt-5.5": "models/gemini-3.5-flash",
    };
```

### 2. Map Models inside `translateOpenAIToGoogle` (`src/core/FormatConverter.js`)
Apply the mapping inside `translateOpenAIToGoogle` right after suffix parsing:
```javascript
        const { cleanModelName: parsedModelName, thinkingLevel: modelThinkingLevel } =
            FormatConverter.parseModelThinkingLevel(streamStrippedModel);

        const cleanModelName = FormatConverter.CODEX_MODEL_MAP[parsedModelName] || parsedModelName;

        if (cleanModelName !== parsedModelName) {
            this.logger.info(`[Adapter] Mapped Codex model "${parsedModelName}" to "${cleanModelName}"`);
        }
```

### 3. Map Models inside `translateOpenAIResponseToGoogle` (`src/core/FormatConverter.js`)
Apply the exact same mapping inside `translateOpenAIResponseToGoogle` right after suffix parsing:
```javascript
        const { cleanModelName: parsedModelName, thinkingLevel: modelThinkingLevel } =
            FormatConverter.parseModelThinkingLevel(streamStrippedModel);

        const cleanModelName = FormatConverter.CODEX_MODEL_MAP[parsedModelName] || parsedModelName;

        if (cleanModelName !== parsedModelName) {
            this.logger.info(`[Adapter] Mapped Codex model "${parsedModelName}" to "${cleanModelName}" (Response API)`);
        }
```

---

## Verification Plan

### Automated Verification
Verify the code syntax and ESLint formatting:
```bash
npx eslint src/core/FormatConverter.js
```

### Manual Verification
1. Run the development server:
   `npm run dev:server`
2. Send a mock OpenAI-format Chat Completion request using curl, passing `"model": "gpt-5.5"`.
3. Send a mock OpenAI Response API format request (`/v1/responses`) using curl, passing `"model": "gpt-5.5"`.
4. Verify in the logs that the adapter outputs corresponding mapping success logs.
