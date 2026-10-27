---
"e2e": patch
---

A run now exits with the cleanup error's code, usually 3, when a test's cleanup failed. The list reporter shows the cleanup failure under the test and in the summary, so a CI job that goes red names the cleanup failure instead of reporting a green summary.
