---
"e2e": patch
---

A run now exits with the cleanup error's code, usually 3, when a test passed but its cleanup failed. The list reporter shows the cleanup failure under the passed test and in the summary, so a CI job that goes red names the missing artifact instead of reporting a green summary.
