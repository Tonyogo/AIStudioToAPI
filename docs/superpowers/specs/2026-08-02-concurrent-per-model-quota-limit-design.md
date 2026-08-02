# 模型单账号每日上限限额与调度过滤设计规范

**日期:** 2026-08-02  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

为了防止某些模型（如 `gemini-2.5-pro`）在单个 Google 账号上过度使用导致触发 Google 官方账号封禁或额度耗尽，系统需要在 `configs/models.json` 中支持为每个模型配置单账号每日上限（`dailyLimit`）。

在并发模式下，`AccountScheduler` 需实时结合 `ModelUsageTracker` 的统计数与模型的 `dailyLimit` 配置，在调度时自动过滤掉当天（北京时间 15:00 周期内）已达到上限的账号。当所有可用账号均达到上限时，返回标准的 HTTP 429 `RESOURCE_EXHAUSTED` 错误。

---

## 2. 详细设计

### 2.1 模型的 `dailyLimit` 配置 (`configs/models.json`)

在 `configs/models.json` 对应模型节点添加可选整数字段 `dailyLimit`：

```json
{
  "name": "models/gemini-2.5-pro",
  "displayName": "Gemini 2.5 Pro",
  "dailyLimit": 50,
  "inputTokenLimit": 1048576,
  "outputTokenLimit": 65536
}
```

* **缺省处理**：若模型未配置 `dailyLimit` 字段，或值为 `null` / `0` / `< 0`，则代表无使用上限（`Infinity`）。

### 2.2 模型的 `dailyLimit` 提取与匹配 (`AccountScheduler.js`)

在 `AccountScheduler.js` 中新增辅助方法 `getModelDailyLimit(modelName)`：

1. 接受传入的标准模型名 `modelName`（如 `gemini-2.5-pro`）。
2. 在注入的 `this.modelList` 中查找 `name.replace("models/", "") === modelName` 或 `name === modelName` 的配置。
3. 若存在配置且 `typeof dailyLimit === "number" && dailyLimit > 0`，返回 `dailyLimit`；否则返回 `Infinity`。

### 2.3 限额过滤与 429 配额耗尽报错算法 (`AccountScheduler.js`)

更新 `getNextAuthIndex(modelName)` 调度逻辑：

1. **提取上限**：`const limit = this.getModelDailyLimit(modelName);`
2. **过滤已达上限账号**：
   - 获取所有在线 (`hasConnection(i) === true`) 且已激活 (`getAccountStatus(i) === "ACTIVATED"`) 的账号列表。
   - 过滤条件：仅保留 `tracker.getUsage(i, modelName) < limit` 的账号。
3. **最小使用量优先分发**：
   - 对未达上限的候选账号，按 `usageCount` 升序挑选最小用量的账号；用量相同时按 Round-Robin 顺时针选取。
4. **降级同步激活处理**：
   - 若当前无可用 `ACTIVATED` 账号，对未达到上限（`usage < limit`）的在线 `INACTIVE` 账号按用量最少顺序执行同步激活。
5. **全账号配额耗尽响应 (429 RESOURCE_EXHAUSTED)**：
   - 若存在在线账号，但**所有在线账号针对该模型的用量均已 `>= limit`**，抛出 HTTP 状态码为 **429** 的 Error：
     ```javascript
     const error = new Error(
         `All accounts reached daily limit of ${limit} requests for model "${modelName}"`
     );
     error.statusCode = 429;
     error.statusText = "RESOURCE_EXHAUSTED";
     throw error;
     ```

### 2.4 请求拦截器与错误格式透传 (`ConcurrentRequestHandler.js`)

1. 在 `ConcurrentRequestHandler.js` 的 `handleGeminiRequest` 中：
   - 当 `await this.scheduler.getNextAuthIndex(cleanModelName)` 捕获到 429 异常时：
   - 返回标准的 Gemini 429 JSON 错误结构：
     ```json
     {
       "error": {
         "code": 429,
         "message": "All accounts reached daily limit of 50 requests for model \"gemini-2.5-pro\"",
         "status": "RESOURCE_EXHAUSTED"
       }
     }
     ```

---

## 3. 受影响文件

* `configs/models.json`：可选增加 `dailyLimit` 配置示例。
* `src/concurrent/AccountScheduler.js`：实现 `getModelDailyLimit` 提取、限额过滤与 429 配额耗尽报错。
* `src/concurrent/index.js`：向 `AccountScheduler` 传递 `modelList` 数组。
* `src/concurrent/ConcurrentRequestHandler.js`：确保正确处理并透传 429 配额耗尽错误。
* `test/concurrent/account_scheduler.test.js`：增加 `dailyLimit` 过滤与 429 报错单元测试。
