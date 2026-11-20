---
"@e2e-dev/acp": patch
"@e2e-dev/limrun": patch
---

- acp: `e2e` peer floor `>=0.21.4` to `>=0.22.0`, the first version exporting the `e2e/agent` rules and tools it imports.
- limrun: mobile peer floor `>=0.11.1` to `>=0.12.9`, the first mobile release versioned with Limrun on driver 0.21.40; 0.12.0 still passes driver 0.21.25, which Limrun rejects before opening the provider client.
