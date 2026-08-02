### Task 1 Report: Automatically Sync currentAuthIndex and Maintain Baseline = 2 ACTIVATED Accounts in AccountScheduler

- **Implementation**:
  - Updated `AccountScheduler.js` to automatically sync `browserManager._currentAuthIndex` to `"ACTIVATED"` upon request handling if it is online and currently `"INACTIVE"`.
  - Added baseline = 2 check in `getNextAuthIndex` so that when total activated accounts `< 2`, available inactive candidates exist, and the 30s activation cooldown is satisfied, a baseline activation is triggered.
- **Testing**:
  - Added comprehensive tests in `test/concurrent/account_scheduler.test.js` covering `currentAuthIndex` auto-sync and baseline = 2 maintenance.
  - Verified all tests in the concurrent test suite pass successfully.
- **Commit**:
  - Committed changes forcibly with `git add -f test/concurrent/account_scheduler.test.js && git add src/concurrent/AccountScheduler.js && git commit -m "feat(concurrent): auto-sync currentAuthIndex and maintain baseline = 2 ACTIVATED accounts in AccountScheduler"`.
