---
"@e2e-dev/web": minor
---

**Release:** Chromium launches with its OS sandbox on by default, which helps contain a renderer exploit on a page the agent reaches, but does not prevent sandbox escapes. On a host where the sandbox cannot start (root, a container, or Ubuntu 23.10+ with the AppArmor user-namespace restriction), set `E2E_CHROMIUM_SANDBOX=0` in the run environment, or pass `web({ chromiumSandbox: false })`; otherwise the launch fails with a friendly error naming the opt-out that applies.
