---
'@e2e-dev/html-reporter': minor
---

**Breaking:** requires e2e 0.24.1 or later. The reporter imports `ReportFile` and uses `reportFiles`, which the `reporters-public-api` release adds in e2e 0.24.1; a 0.24.0 install would break.
