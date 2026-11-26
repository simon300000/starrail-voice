# Agent guidance

This repository extracts and annotates game voice audio. Work within this repository and its selected source revision; sibling checkouts and submodules are separate change scopes.

## Task routing

- Extraction or annotation: [pipeline reference](docs/pipeline.md), `index.ts`, `update.ts`, and the local `hoyo-voice-extractor` implementation.
- Apple Silicon ASR audits only: [ASR audit](docs/asr-audit.md). ASR is diagnostic evidence; final metadata needs game config or TextMap support.
- Dataset use and limitations: the root README. Publishing behavior: `parquet.py`.

## Local workflow

`npm run build` builds HoyoDown, native tools and TypeScript; `npm run watch` watches TypeScript. Check `package.json` for the current commands. Extraction defaults to `AudioPackage/`, output to `result/`; `VOICE_SOURCE_PATH` and `VOICE_RESULT_PATH` override those paths. Source metadata lives in `StarRailData/`.

Use a separate output directory for extraction checks. Metadata updates can rewrite results and README statistics. `parquet.py` uploads to Hugging Face; it is not a local validation command.

## Completion and boundaries

Preserve source identity, unknown fields and existing user changes. Do not substitute ASR text for authored metadata or hand-edit game-data dumps. Keep generated audio and build output out of code changes.

Complete the requested change and relevant local verification, repairing regressions caused by it. For documentation-only edits, check referenced paths and commands; a full extraction/build is unnecessary. Report what was checked and any gaps. Downloads, publication, deletion of existing datasets, commits and pushes require authorization for that operation; do not ask again when it is already provided.
