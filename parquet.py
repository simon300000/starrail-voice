import json
from datasets import Dataset, Audio
from huggingface_hub import HfApi

audioFolderDir = 'result/'

api = HfApi()

print('Uploading README.md')

api.upload_file(
    path_or_fileobj=audioFolderDir + "README.md",
    path_in_repo="README.md",
    repo_id="simon3000/starrail-voice",
    repo_type="dataset"
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
