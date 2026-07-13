# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

`starrail-voice` is a dataset generation pipeline that extracts voice audio from **Honkai: Star Rail** game files, annotates each clip with speaker/transcription/language metadata by cross-referencing game data configs, and publishes the result to Hugging Face at `simon3000/starrail-voice`.

## Commands

```bash
npm run build          # Compile TypeScript (tsc -b, ESNext target/module)
npm run watch          # Watch mode (tsc -b -w)

npx tsx index.ts       # Stage 1: Extract audio from .pck archives → .wav files
npx tsx update.ts      # Stage 2: Annotate .wav files with metadata → metadata.jsonl
python3 parquet.py     # Stage 3: Upload dataset to Hugging Face Hub
```

No tests, no linter, no CI are configured.

## Architecture: 3-Stage Pipeline

### Stage 1 — Audio Extraction (`index.ts`)
- Reads `.pck` files from `AudioPackage/` (gitignored, not in repo).
- **Pass 1**: `quickbms.exe` + `wwise_pck_extractor.bms` unpacks `.pck` → `.wem`, then `vgmstream-cli.exe` converts `.wem` → `.wav`. Output: `result/wav-pass1/`.
- `.bnk` files found during pass 1 are moved to `result/wem-bnk-pass2/`.
- **Pass 2**: `bnkextr.exe` unpacks `.bnk` → `.wem`, then vgmstream converts to `.wav`. Output: `result/wav-pass2/`.

### Stage 2 — Metadata Annotation (`update.ts`)
1. Collects all `.wav` files from both pass directories into a `voiceMap` keyed by `language/basename`.
2. Reads game data from the `StarRailData` submodule:
   - `VoiceConfig.json` — maps VoiceID → VoicePath (the in-game audio path like `english/voice/{path}_m.wem`)
   - `TalkSentenceConfig.json` — maps VoiceID → text hashes for transcription and speaker name
   - `VoiceAtlas.json` — supplementary text hashes for voice lines
   - `TextMap/{CHS,EN,JP,KR}.json` — hash → localized string tables
3. **Matching algorithm**: For each voice config entry, computes the **FNV-1 64-bit hash** of the expected Wwise path (lowercased, e.g. `english/voice/somepath_m.wem`), zero-padded to 16 hex chars. This hash matches the `.wav` filename produced during extraction.
4. Writes `result/metadata.jsonl` (JSONL, one object per line: `filename`, `inGameFilename`, `transcription`, `language`, `speaker`, `voiceType`) and `result/README.md`.

### Stage 3 — Hugging Face Upload (`parquet.py`)
- Reads `metadata.jsonl`, wraps audio paths with `datasets.Audio()` feature, pushes to `simon3000/starrail-voice` with 5GB max shard size.

## Submodule Tree (2-level nested)

```
starrail-voice/
├── hoyo-voice-extractor/   (GitHub: simon300000/hoyo-voice-extractor)
│   ├── fnvjs/              (GitHub: simon300000/fnvjs — FNV hash library)
│   └── Wwise-Unpacker/     (GitHub: simon300000/Wwise-Unpacker — Windows .exe tools)
└── StarRailData/           (GitLab: Dimbreath/turnbasedgamedata, shallow clone)
```

`hoyo-voice-extractor` is the shared library consumed by both `index.ts` and `update.ts`. It exports the core utilities: `unpackPCKs`, `unpackBNKs`, `encodeFNV64`, `readTextMap`, `findWAV`, `findJSON`, `readJSON`, `updateStats`, `copyReadme`. The low-level spawn wrappers (`unpackPCK`, `convertWEM`, `unpackBNK`) live in `tools.ts`.

## Key Technical Details

- **ESM modules**: `"type": "module"` in `package.json`. Uses `import.meta.dirname` (Node 21+).
- **Windows-only extraction**: `quickbms.exe`, `vgmstream-cli.exe`, `bnkextr.exe` are Windows binaries. The pipeline cannot run on macOS/Linux natively.
- **No runtime npm dependencies**: All imports come from the submodule via relative paths.
- **FNV-1 64-bit matching**: The glue between extracted audio files and game metadata. Audio files are named `{fnv1_64_hash}.wav`. The hash is computed over the lowercased Wwise audio path (e.g. `english/voice/{VoicePath}_m.wem`).
- **WEM→WAV conversion is single-threaded**: `parallelExecute` defaults to 2× CPU count for most tasks, but `convertWEMs` hardcodes concurrency of 1.
- **TypeScript strict mode** enabled, `esModuleInterop: true`, `skipLibCheck: true`.

## macOS Whisper Evidence

Only on macOS running Apple Silicon, use `mlx-whisper` for local ASR audits
instead of the PyTorch/OpenAI Whisper MPS path. This is a macOS-only rule;
other platforms should keep using their appropriate existing Whisper runtime.
Use the model exactly as
`mlx-community/whisper-large-v3-turbo`; keep the default Hugging Face download
address and cache behavior, and do not set `HF_ENDPOINT` or a model mirror.
Network proxy variables are acceptable when required. If the default Xet
transfer stalls behind a proxy, `HF_HUB_DISABLE_XET=1` may be used because it
changes only the transfer backend, not the download address.

For isolated Chinese WAV checks, use `language="zh"`, `temperature=0.0`, and
`condition_on_previous_text=False`. Run many files in one Python process so
the MLX model is loaded only once. Whisper output is evidence for finding or
rejecting associations only: never copy it directly into final metadata.
Final transcription and speaker values must still be supported by game config
or TextMap evidence; leave uncertain fields blank.
