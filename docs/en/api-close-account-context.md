# Close Account Context API Documentation

## 📌 Overview

This endpoint allows administrators to manually close and release the Playwright browser context and WebSocket connection for a specific account without restarting the proxy server. Closing inactive or unneeded contexts releases significant memory resources (approx. 500MB~700MB per browser context).

- **Endpoint**: `/api/accounts/:index/close-context`
- **Method**: `POST`
- **Authentication**: WebUI Session Cookie (`isAuthenticated` middleware)
- **Scope**: Management Console API

---

## 📥 Request Parameters

### 1. Path Parameters

| Parameter | Type      | Required | Example | Description                                                              |
| :-------- | :-------- | :------- | :------ | :----------------------------------------------------------------------- |
| `index`   | `integer` | Yes      | `0`     | Target account index in the system (non-negative integer, e.g., 0, 1, 2) |

### 2. Request Headers

| Header Name    | Required | Example/Value      | Description                             |
| :------------- | :------- | :----------------- | :-------------------------------------- |
| `Content-Type` | No       | `application/json` | Request payload format                  |
| `Cookie`       | Yes      | `connect.sid=...`  | Authenticated session cookie from WebUI |

### 3. Request Body

- No request body required (can be empty).

---

## ⚙️ Backend Logic & Execution Flow

1. **System Busy Check**: If the system is currently switching accounts or performing recovery, returns `409 Conflict` to prevent race conditions.
2. **Parameter Validation**:
   - Validates that `index` is an integer (returns `400 Bad Request` if invalid).
   - Validates that `index` exists in `initialIndices` (returns `404 Not Found` if not found).
3. **Idempotency**: If the context for the account is not loaded and not currently initializing, returns `200 OK` with `contextAlreadyClosed` immediately.
4. **Resource Release Pipeline**:
   - **Flush Message Queues**: Proactively terminates any pending request message queues for this account (tagged with `manual_context_closed`).
   - **Reset Active State**: If the closed account is currently active (`currentAuthIndex === index`), resets `requestHandler.currentAuthIndex` to `-1`.
   - **Close Context**: Calls `browserManager.closeContext(index)` to cleanly close Playwright pages and browser context.
   - **Disconnect WebSocket**: Calls `connectionRegistry.closeConnectionByAuth(index)` to explicitly terminate the WebSocket session.
   - **Clean Browser Process Exit**: If all account contexts are closed and no background initializations are pending, the Playwright browser process automatically shuts down completely, freeing all system memory.

---

## 📤 Response Status Codes & Examples

### 1. 200 OK - Context Successfully Closed

```json
{
  "index": 0,
  "message": "closeContextSuccess"
}
```

### 2. 200 OK - Context Already Closed (Idempotent)

```json
{
  "index": 1,
  "message": "contextAlreadyClosed"
}
```

### 3. 400 Bad Request - Invalid Account Index

```json
{
  "message": "errorInvalidIndex"
}
```

### 4. 401 Unauthorized - Authentication Required

```json
{
  "message": "unauthorized"
}
```

### 5. 404 Not Found - Account Not Found

```json
{
  "message": "errorAccountNotFound"
}
```

### 6. 409 Conflict - System Busy (Switching/Recovering)

```json
{
  "message": "systemBusySwitchingOrRecoveringAccounts"
}
```

### 7. 500 Internal Server Error - Closure Failed

```json
{
  "error": "Failed to close context: Target page, context or browser has been closed",
  "message": "closeContextFailed"
}
```

---

## 💻 Code Examples

### 1. cURL Example

```bash
# Close context for account #0
curl -X POST "http://localhost:7860/api/accounts/0/close-context" \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=s%3AYourSessionCookieValueHere..."
```

### 2. JavaScript / Fetch Example

```javascript
async function closeAccountContext(accountIndex) {
  try {
    const response = await fetch(`/api/accounts/${accountIndex}/close-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });
    const data = await response.json();
    if (response.ok) {
      console.log(`Account #${accountIndex} context closed successfully:`, data);
    } else {
      console.error(`Failed to close context:`, data.message || data.error);
    }
  } catch (error) {
    console.error("Network error:", error);
  }
}

// Close context for account #1
closeAccountContext(1);
```

### 3. Python Example

```python
import requests

session = requests.Session()
# Assuming session cookie has been set after login
session.cookies.set("connect.sid", "s%3AYourSessionCookieValueHere...")

account_index = 0
url = f"http://localhost:7860/api/accounts/{account_index}/close-context"

response = session.post(url)
print("Status Code:", response.status_code)
print("Response JSON:", response.json())
```
