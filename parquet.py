import argparse
import json
from pathlib import Path

from datasets import Dataset, Audio
from huggingface_hub import HfApi

audioFolderDir = 'result/'

parser = argparse.ArgumentParser()
parser.add_argument('--speaker-archives-dir', type=Path, default=Path(audioFolderDir) / 'speaker-archives')
parser.add_argument('--speaker-archives-repo-dir', default='speaker-archives')
parser.add_argument('--skip-speaker-archives', action='store_true')
args = parser.parse_args()

api = HfApi()

print('Uploading README.md')

api.upload_file(
    path_or_fileobj=audioFolderDir + "README.md",
    path_in_repo="README.md",
    repo_id="simon3000/starrail-voice",
    repo_type="dataset"
)

print('Uploading result.json')

api.upload_file(
    path_or_fileobj='result.json',
    path_in_repo='result.json',
    repo_id='simon3000/starrail-voice',
    repo_type='dataset'
)

print('Loading metadata.jsonl')

with open(audioFolderDir+ 'metadata.jsonl', 'r', encoding='utf-8') as json_file:
    voiceList = [json.loads(line) for line in json_file]

print('Creating dataset')

dataset = Dataset.from_dict({
    "audio": [voice['filename'] for voice in voiceList],
    "ingame_filename": [voice['inGameFilename'] for voice in voiceList],
    "transcription": [voice['transcription'] for voice in voiceList],
    "language": [voice['language'] for voice in voiceList],
    "speaker": [voice['speaker'] for voice in voiceList],
    "voice_type": [voice['voiceType'] for voice in voiceList],
    }).cast_column("audio", Audio())

print('Pushing dataset')

dataset.push_to_hub("starrail-voice", max_shard_size="5GB")

if not args.skip_speaker_archives:
    archives = sorted(args.speaker_archives_dir.rglob('*.zip'))
    if not args.speaker_archives_dir.is_dir():
        raise SystemExit(f'Speaker archive directory does not exist: {args.speaker_archives_dir}')
    if archives:
        print(f'Uploading {len(archives)} speaker archives to {args.speaker_archives_repo_dir}/')
        api.upload_folder(
            folder_path=args.speaker_archives_dir,
            path_in_repo=args.speaker_archives_repo_dir.strip('/'),
            repo_id='simon3000/starrail-voice',
            repo_type='dataset',
        )
    else:
        print('No speaker archives to upload')
