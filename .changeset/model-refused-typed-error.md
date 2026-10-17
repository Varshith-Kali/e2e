---
"e2e": patch
---

`agent.extract` (and every other model call) now fails with a typed, non-retryable `MODEL_REFUSED` when the model refuses the request (finish reason `content-filter`), instead of misreporting the refusal as `MODEL_PROVIDER_FAILED: model provider failed: No output generated.` and burning retries on a prompt that is refused by construction. The message names the step, the model, and the finish reason, and the run exits 2 rather than 3. Also fixed: the SDK's renamed no-output error (`NoOutputGeneratedError` in AI SDK v7) is recognized again, so empty non-refusal output maps back to `MODEL_OUTPUT_INVALID` instead of `MODEL_PROVIDER_FAILED`.
