# Implementation Plan: Optimize safeParseJSON for Plain Text Tool Outputs

Make `safeParseJSON` inside `translateOpenAIResponseToGoogle` smarter by checking if the input text actually looks like JSON before attempting to parse it. This prevents warning logs from flooding the console when clients return plain text outputs.

## Context
When Codex or other clients execute a tool, they may return a plain text output like `"Chunk ID: 123"` instead of a JSON string. Currently, `safeParseJSON` blindly runs `JSON.parse` on all string outputs, triggering a warning log:
`[Adapter] Failed to parse JSON for unparsed_output: Unexpected token 'C', ...`
Even though the system successfully falls back to `{ unparsed_output: value }`, the warning log floods the console. We will optimize `safeParseJSON` to skip `JSON.parse` for non-JSON strings and log any real parsing failures as `debug` instead of `warn`.

---

## Proposed Changes

### 1. Optimize `safeParseJSON` inside `translateOpenAIResponseToGoogle` (`src/core/FormatConverter.js`)
Read `src/core/FormatConverter.js` and locate `safeParseJSON` inside `translateOpenAIResponseToGoogle` (around line 2946).
Modify it to check if the string starts with `{` or `[` before running `JSON.parse`, and demote any parse errors to `this.logger.debug`:
```javascript
        const safeParseJSON = (value, fallbackKey) => {
            if (value && typeof value === "object") {
                return value;
            }

            if (typeof value !== "string") {
                return { [fallbackKey]: value };
            }

            const trimmed = value.trim();
            if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
                // Clearly plain text, not JSON. Skip parse and return fallback directly.
                return { [fallbackKey]: value };
            }

            try {
                return JSON.parse(trimmed || "{}");
            } catch (e) {
                this.logger.debug(`[Adapter] Failed to parse JSON for ${fallbackKey}: ${e.message}`);
                return { [fallbackKey]: value };
            }
        };
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
2. Send a mock OpenAI Response API format request (`/v1/responses`) containing a `function_call_output` with a plain text output `"Chunk ID: 123"`.
3. Verify that the request completes successfully and NO warning logs are printed to the console.
