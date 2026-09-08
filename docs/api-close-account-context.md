# 关闭账号 Context 接口文档 (Close Account Context API)

## 📌 接口概述

该接口用于手动关闭并释放指定账号的 Playwright 浏览器上下文（Browser Context）和对应的 WebSocket 会话连接。可用于在无需重启服务的前提下，主动释放常驻内存占用（单 Context 约 500MB~700MB 内存）。

- **接口地址**：`/api/accounts/:index/close-context`
- **请求方法**：`POST`
- **鉴权方式**：WebUI Session Cookie 鉴权（需通过 `isAuthenticated` 中间件）
- **接口类型**：管理控制台 API

---

## 📥 请求参数

### 1. 路径参数 (Path Parameters)

| 参数名  | 类型      | 必填 | 示例 | 说明                                               |
| :------ | :-------- | :--- | :--- | :------------------------------------------------- |
| `index` | `integer` | 是   | `0`  | 目标账号在系统中的编号索引（非负整数，如 0, 1, 2） |

### 2. 请求头 (Request Headers)

| Header 名      | 必填 | 示例/取值          | 说明                              |
| :------------- | :--- | :----------------- | :-------------------------------- |
| `Content-Type` | 否   | `application/json` | 请求体数据格式                    |
| `Cookie`       | 是   | `connect.sid=...`  | 登录成功后获取的 Session 会话凭证 |

### 3. 请求体 (Request Body)

- 无需传递请求体（可为空）。

---

## ⚙️ 后端处理流程与核心逻辑

1. **系统繁忙检查**：若系统正在进行全局账号切换或故障恢复，返回 `409 Conflict` 阻止并发冲突。
2. **参数校验**：
   - 校验 `index` 是否为有效整数，非法返回 `400 Bad Request`。
   - 校验 `index` 是否在已配置账号列表中（`initialIndices`），不存在返回 `404 Not Found`。
3. **幂等性保障**：若目标账号未加载 Context 且未处于初始化中，直接返回 `200 OK` 及 `contextAlreadyClosed`，不做无谓操作。
4. **资源清理与释放**：
   - **请求队列终止**：主动清理该账号在途请求的消息队列（原因标为 `manual_context_closed`）。
   - **当前激活态重置**：若关闭的是当前激活账号（`currentAuthIndex === index`），将活跃账号索引复位为 `-1`。
   - **Context 关闭**：调用 `browserManager.closeContext(index)` 优雅关闭 Playwright 页面与上下文。
   - **WebSocket 断开**：调用 `connectionRegistry.closeConnectionByAuth(index)` 显式断开 WebSocket 连接。
   - **进程级释放**：若所有账号 Context 均已释放且无进行中的初始化，Playwright 浏览器进程将自动彻底关闭，释放全部系统内存。

---

## 📤 响应格式与状态码

### 1. 200 OK - 成功关闭 Context

```json
{
  "index": 0,
  "message": "closeContextSuccess"
}
```

### 2. 200 OK - Context 已经处于关闭状态（幂等）

```json
{
  "index": 1,
  "message": "contextAlreadyClosed"
}
```

### 3. 400 Bad Request - 无效的账号索引

```json
{
  "message": "errorInvalidIndex"
}
```

### 4. 401 Unauthorized - 未登录 / 鉴权失败

```json
{
  "message": "unauthorized"
}
```

### 5. 404 Not Found - 账号不存在

```json
{
  "message": "errorAccountNotFound"
}
```

### 6. 409 Conflict - 系统正忙于切换或恢复账号

```json
{
  "message": "systemBusySwitchingOrRecoveringAccounts"
}
```

### 7. 500 Internal Server Error - 关闭操作异常

```json
{
  "error": "Failed to close context: Target page, context or browser has been closed",
  "message": "closeContextFailed"
}
```

---

## 💻 调用示例

### 1. cURL 示例

```bash
# 关闭账号 #0 的 Context
curl -X POST "http://localhost:7860/api/accounts/0/close-context" \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=s%3AYourSessionCookieValueHere..."
```

### 2. JavaScript / Fetch 示例

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
      console.log(`账号 #${accountIndex} Context 关闭成功:`, data);
    } else {
      console.error(`关闭失败:`, data.message || data.error);
    }
  } catch (error) {
    console.error("网络请求异常:", error);
  }
}

// 调用关闭账号 #1 的 Context
closeAccountContext(1);
```

### 3. Python 示例

```python
import requests

session = requests.Session()
# 假设已经登录并获得了 session cookie
session.cookies.set("connect.sid", "s%3AYourSessionCookieValueHere...")

account_index = 0
url = f"http://localhost:7860/api/accounts/{account_index}/close-context"

response = session.post(url)
print("Status Code:", response.status_code)
print("Response JSON:", response.json())
```
