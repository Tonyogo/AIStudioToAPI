# Task 2 Report: In-Flight Request Tracking and Max Concurrency Control

## Summary
Successfully implemented in-flight request tracking, max concurrency capping (max 2 requests per account), load spreading via ascending `inFlightCount` sorting, and proper 503 `UNAVAILABLE` error handling when all online accounts are busy at their concurrency limits.

## Changes Made
1. **`src/concurrent/AccountScheduler.js`**:
   - Added `this.inFlightMap = new Map()` and `this.maxInFlightPerAccount = 2` in the constructor.
   - Implemented `getInFlightCount(authIndex)`, `acquireInFlight(authIndex)`, and `releaseInFlight(authIndex)` methods.
   - Updated `getNextAuthIndex(modelName)` to:
     - Filter out candidate accounts whose in-flight count reaches or exceeds `maxInFlightPerAccount` (`2`).
     - Sort candidate accounts primarily by `inFlightCount` ascending (to spread concurrency load), secondary by usage ascending, and tertiary by Round-Robin relative order.
     - Properly throw a `503` error with `statusText: "UNAVAILABLE"` when all online accounts are busy at maximum concurrency.

2. **`test/concurrent/account_scheduler.test.js`**:
   - Added comprehensive unit tests covering:
     - In-flight request tracking and increment/decrement behavior (`acquireInFlight`, `releaseInFlight`, `getInFlightCount`).
     - `getNextAuthIndex` load spreading prioritizing accounts with lower in-flight counts.
     - Throwing a 503 `UNAVAILABLE` error when all available online accounts are at their max concurrency limit (2/2).

## Verification
- Ran `npx jest test/concurrent/account_scheduler.test.js` and all 20 tests passed successfully.
- Verified file paths:
  - `/Users/yogo/WebstormProjects/AIStudioToAPI/src/concurrent/AccountScheduler.js`
  - `/Users/yogo/WebstormProjects/AIStudioToAPI/test/concurrent/account_scheduler.test.js`
