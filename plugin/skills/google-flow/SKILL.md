---
name: google-flow
description: Generate images (0 credits / free by default) and videos via Google AI Flow using the `gflow` CLI. Manages Google Chrome CDP auth, aspect ratios, models, quality, batch counts, SQLite asset IDs (`img_0001`, `vid_0001`), prompt history, remixing, and image-to-video animation with strict credit confirmation guards.
---

# Google Flow (`gflow`) Skill

Use the `gflow` CLI whenever the user asks to generate images or videos with Google AI Flow, manage generated media by ID, remix previous outputs, or animate an image into video.

Always pass `--json` when invoking `gflow` so you can reliably parse IDs, file paths, credit estimates, and errors.

## 1. Mandatory Credit Safety Rule (CRITICAL)

- **Video generation (`gflow video`, `gflow animate`) ALWAYS costs credits.**
- **High-tier image upscaling (e.g. `-q 4k`) may also cost credits.**
- **NEVER pass `--confirm-credits` without explicit user approval in the current turn.**

### Required Workflow for Video or Any Paid Generation
1. First run with `--dry-run --json` (never generates anything):
   ```bash
   gflow video -p "<prompt>" -m veo-3.1-lite -a 16:9 -q 720p --dry-run --json
   ```
2. Read `plan.estimatedCredits`, `plan.creditFormula`, `plan.currentBalance`, `plan.modelDisplayName`, `plan.aspectRatio`, `plan.quality`, and `plan.duration` from the JSON output.
3. Ask the user clearly before proceeding:
   - State the model, resolution, aspect ratio, duration, count.
   - State the exact estimated credit cost (e.g., `10 kredi`) and remaining balance if known.
   - Wait for the user's explicit "yes / onayla" reply.
4. Only after the user approves, run the exact same command with `--confirm-credits --json`.

If `gflow` exits with code `2` (`CONFIRMATION_REQUIRED`), stop immediately and present the credit cost to the user for approval.

## 2. Preflight: Session & Auth Check

Before the first live generation in a session, check auth status:
```bash
gflow auth status --json
```
- If `ok: false` (exit code `3`), tell the user to run `gflow auth login` (or run it for them so the isolated Chrome window opens for their Google sign-in), wait until they sign in, then continue.
- Never attempt to bypass Google login, CAPTCHAs, or bot checks.

## 3. Generating Free Images (`gflow image`)

Default image generation uses `nano-banana` at `standard` quality (**0 credits**):
```bash
gflow image \
  -p "Detailed visual prompt here" \
  -m nano-banana \
  -a 16:9 \
  -n 2 \
  -q standard \
  --project "my-project" \
  --tag "concept,v1" \
  --json
```

### Supported Parameters
- `--model, -m`: `nano-banana` (0 kredi, hızlı), `nano-banana-pro` (yüksek detay), `imagen-4` (fotogerçekçi)
- `--aspect, -a`: `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `3:2`, `2:3` (aliases: `kare`, `yatay`, `dikey`)
- `--count, -n`: `1` to `4`
- `--quality, -q`: `low`, `standard`, `medium`, `high`, `1k`, `2k`, `4k` (note: `4k` costs credits and requires user confirmation!)
- `--negative`: things to exclude
- `--ref <pathOrId>`: attach a local file path OR a previously generated asset ID like `img_0001`
- `--agent-mode`: enable Google Flow Agent Mode (default is OFF — Flow Agent is automatically turned off for direct generation)
- `--headed` / `--visible`: open Chrome visibly (default is headless in background)
- `--ttl <duration>`: optional auto-expiration for unmoved files (e.g. `24h`, `7d`)
- `--project`, `--tag`, `--note`, `-o/--out`

### Auto-Prune / Cleanup (`gflow prune`)
- Auto-prune is **OFF by default** (`autoPruneEnabled: false`).
- Only deletes expired files that are still at their original output path (never deletes files moved elsewhere or marked favorite unless `--include-favorites`).
- Commands: `gflow prune --older-than 7d --dry-run --json`, `gflow prune --enable-auto 168`, `gflow prune --disable-auto`.

Always report back to the user:
- Each generated asset's **ID** (e.g. `img_0001`, `img_0002`)
- Clickable `file:///` link to the saved image file(s)
- Model, aspect ratio, and credits spent (`0 kredi`)

## 4. Generating Videos (`gflow video` & `gflow animate`)

Remember: **Always dry-run first and ask the user for credit approval!**

- Text-to-video:
  ```bash
  gflow video -p "Slow cinematic drone shot..." -m veo-3.1-lite -a 16:9 -q 720p --dry-run --json
  ```
- Image-to-video from a catalog ID (`img_0001`):
  ```bash
  gflow animate img_0001 -p "Gentle camera push-in, leaves swaying in wind" -m veo-3.1-lite --dry-run --json
  ```
- Supported video models: `veo-3.1-lite` (~10 kredi), `veo-3.1-fast` (~20 kredi), `veo-3.1-quality` (~100 kredi), `omni-flash-1.2` (1-3 kredi/sn).
- Supported video aspect ratios: `16:9`, `9:16`, `1:1`.

## 5. Catalog, History, ID Lookup & Remixing

Every generated file is stored in SQLite (`~/.gflow/catalog.sqlite`) with sequential IDs (`img_0001`, `vid_0001`) and full lineage:

- **List recent assets:** `gflow list --limit 20 --json` (filters: `--type`, `--project`, `--tag`, `--model`, `--favorites`)
- **Inspect an ID (prompt, model, file, parent/children):** `gflow show img_0001 --json`
- **Search by prompt/tag/note/project:** `gflow search "istanbul" --json`
- **Remix an existing ID (keeps original settings, links `parentId`):**
  ```bash
  gflow remix img_0001 --append-prompt "warm golden hour lighting" -a 9:16 --use-as-ref --json
  ```
- **Tag / favorite / add note:**
  ```bash
  gflow tag img_0001 --add hero,final --note "YouTube kapak" --favorite --json
  ```
- **Export a project or favorites with `manifest.json`:**
  ```bash
  gflow export -o ./exports/kapak --project youtube --favorites --json
  ```
- **Usage statistics:** `gflow stats --json`

## 6. Diagnostics, Agent Schema & UI Calibration

- Self-describing agent schema (all commands, enums, exit codes, reference upload rules in one JSON/Markdown call): `gflow schema` or `gflow schema --markdown`
- Upload local files or catalog IDs as reference images: `gflow image -p "..." --ref C:/path/to/ref.png --ref img_0001 --json` (or comma-separated `--ref a.png,img_0001`)
- Check setup health (Node, Chrome, CDP, SQLite, auth): `gflow doctor --json`
- List models (or scrape live models from open Flow tab): `gflow models --json` / `gflow models --live --json`
- If Google Flow updates its web UI and selectors fail, run `gflow calibrate --json` while the Flow workspace is open in Chrome.
