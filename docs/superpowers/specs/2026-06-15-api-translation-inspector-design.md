---
name: api-translation-inspector
description: Design for the API Translation Inspector to inspect OpenAI Response API inputs/outputs and their translated Gemini counterparts.
metadata:
  type: project
---

# Design Spec: API Translation Inspector

This specification details the end-to-end design for capturing, storing, and visualizing transaction payloads for the OpenAI Response API (`/v1/responses`). It captures original Client Requests, translated Gemini Requests, returned raw Gemini SSE/JSON Responses, and converted outgoing Client Responses.

## 1. Requirements

- **File-Based Transaction Logging**: All transactions write payloads as separate JSON files to `data/debug/` to ensure full debugging capability without high memory consumption.
- **SSE Stream Capture**: For real SSE streams, buffers are accumulated dynamically on the fly and persisted to disk when the stream closes normally or prematurely (STREAM_END or exception).
- **Frontend Inspection Portal**: An inspector button on the existing "Usage Stats" Request Records table launches a dialog presenting all four translated states side-by-side.
- **One-Click Purge Integration**: Deleting/clearing debug snapshots also triggers a clean deletion of all transaction JSON payloads to ensure disk sanitation.

---

## 2. Backend Capture & File Layout

When an API request starts, the system creates four files under `data/debug/`:

- `transaction_<requestId>_open_req.json` (OpenAI client request body)
- `transaction_<requestId>_gem_req.json` (Gemini request body)
- `transaction_<requestId>_gem_res.json` (Gemini response payload or SSE aggregated chunks)
- `transaction_<requestId>_open_res.json` (OpenAI response body or SSE aggregated chunks)

### 2.1 File Helper in `RequestHandler.js`

```javascript
_saveTransactionPayload(requestId, type, data) {
    try {
        const debugDir = path.join(process.cwd(), "data", "debug");
        if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
        }
        const filePath = path.join(debugDir, `transaction_${requestId}_${type}.json`);

        let contentToWrite = data;
        if (typeof data === "object" && data !== null) {
            contentToWrite = JSON.stringify(data, null, 2);
        } else if (typeof data === "string") {
            try {
                contentToWrite = JSON.stringify(JSON.parse(data), null, 2);
            } catch {
                // Raw text fallback (e.g. aggregated SSE line stream)
            }
        }
        fs.writeFileSync(filePath, contentToWrite || "", "utf-8");
    } catch (err) {
        this.logger.debug(`[Debug] Failed to save transaction payload: ${err.message}`);
    }
}
```

---

## 3. SSE Stream Accumulation Logic

For streaming calls, we log the complete cumulative response payload when the stream terminates.

### 3.1 Real Stream Accumulation (`_streamOpenAIResponseAPIResponse`)

During stream processing, the incoming Google chunks and outgoing translated chunks are collected inside `streamState`:

```javascript
// On Google chunk:
streamState.gemResponseAccumulator = (streamState.gemResponseAccumulator || "") + message.data;

// On translated SSE chunk write:
streamState.openResponseAccumulator = (streamState.openResponseAccumulator || "") + responseAPIChunk;

// On STREAM_END:
this._saveTransactionPayload(requestId, "gem_res", streamState.gemResponseAccumulator);
this._saveTransactionPayload(requestId, "open_res", streamState.openResponseAccumulator);
```

### 3.2 Fake Stream Accumulation (`processOpenAIResponse`)

```javascript
// On Google accumulated body:
this._saveTransactionPayload(requestId, "gem_res", fullBody);

// On outgoing translated OpenAI chunk:
this._saveTransactionPayload(requestId, "open_res", translatedChunk);
```

---

## 4. API Router Endpoints (`src/routes/StatusRoutes.js`)

We expose a single authenticated router to query transaction logs:
`GET /api/transactions/:id`

Returns:

```json
{
  "open_req": { ... },
  "gem_req": { ... },
  "gem_res": "...",
  "open_res": "..."
}
```

---

## 5. UI Integration & Visual Layout

### 5.1 Request Records Table Action Item

An actions column with a magnifying glass search icon will be added to the tabular Request Records component in the Statistics tab.

### 5.2 Modal Layout Structure

A dual-column split overlay viewport within a fullscreen-capable Element Plus `el-dialog`:

- **Left Column**: Request-side payloads (Client Request vs Converted Gemini Request).
- **Right Column**: Response-side payloads (Gemini Raw response vs Client Translated response).

Both columns will utilize dark syntax highlighting style cards with raw copy-to-clipboard abilities.

---

## 6. One-Click Disk Sanitation

We modify the existing `DELETE /api/snapshots` (and item delete `DELETE /api/snapshots/:id`) endpoints to look for and delete any associated payload transactions:

- `toDelete` files array will filter files starting with `transaction_` matching the ID or index.
- One-click "Purge All" deletes all files starting with `transaction_` under `data/debug/`.
