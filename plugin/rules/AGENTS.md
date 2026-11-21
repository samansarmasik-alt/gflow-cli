# Google Flow (`gflow`) Credit Safety Rule

When using the `gflow` CLI for video generation (`gflow video`, `gflow animate`) or any image generation that costs more than 0 credits (such as `-q 4k`):

1. ALWAYS run with `--dry-run --json` first to inspect the exact estimated credit cost and current balance.
2. ALWAYS tell the user the model, quality, aspect ratio, count/duration, estimated credit cost, and remaining balance, and ask for explicit confirmation before spending credits.
3. NEVER pass `--confirm-credits` without explicit user confirmation in the current conversation.
