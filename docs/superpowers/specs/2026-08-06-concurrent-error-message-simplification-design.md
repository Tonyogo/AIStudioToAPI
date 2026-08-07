# Spec: 调度器极值错误提示简化与对齐

**日期:** 2026-08-06
**状态:** 已批准 (Approved)

---

## 1. 需求与背景

在 `AccountScheduler.js` 的 `getNextAuthIndex` 中，原来的错误分类判断要求 `busyOnlineAccountCount >= onlineAccountCount` 时才抛出 `All available accounts are busy at maximum concurrency limit`。

这导致当在线 WebSocket 账号处于处理请求状态、或因冷启动/冷却期尚未有空闲账号可分发时（例如 `busyOnlineAccountCount < onlineAccountCount` 但 Phase 1 和 Phase 2 均未选出可用账号），程序跌落到了末尾，抛出了 `No active context connection available`（无活跃连接）。但这与事实不符（因为在线连接存在，只是所有在线账号均在忙碌中）。

本设计旨在简化并统一该错误分类提示，只要存在在线账号连接，分发未成功统一抛出 `All available accounts are busy`，更加精确且简洁。

---

## 2. 详细设计

### 2.1 修改 `getNextAuthIndex` 的错误分类（`src/concurrent/AccountScheduler.js`）

在 `getNextAuthIndex` 结尾，简化错误判断：

```javascript
// Error classification: If online connected accounts exist, any dispatch failure means all accounts are busy
if (onlineAccountCount > 0) {
    const error = new Error("All available accounts are busy");
    error.statusCode = 503;
    error.statusText = "UNAVAILABLE";
    throw error;
}

const error = new Error("No active context connection available");
error.statusCode = 503;
error.statusText = "UNAVAILABLE";
throw error;
```

---

## 3. 验证方案

1. 更新 `test/concurrent/account_scheduler.test.js` 中的错误测试断言，匹配简化的报错信息 `All available accounts are busy`。
2. 运行 `npx jest test/concurrent/` 确保所有 63+ 门测试 PASS。
3. 运行 `npm run lint:js` 确保 0 Error。
