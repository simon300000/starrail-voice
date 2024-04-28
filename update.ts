import { join, basename } from 'path'
import { writeFile } from 'fs/promises'

import { encodeFNV64, updateStats, findWAV, readJSON, readTextMap, copyReadme } from './hoyo-voice-extractor/index.js'

const TEXT_MAP_MAP = {
  'Chinese(PRC)': 'TextMapCHS.json',
  English: 'TextMapEN.json',
  Japanese: 'TextMapJP.json',
  Korean: 'TextMapKR.json'
} as const

const LANGUAGES = Object.keys(TEXT_MAP_MAP) as Array<keyof typeof TEXT_MAP_MAP>

const RESULT_PATH = join(import.meta.dirname, 'result')
const RESULT_PASS1 = join(RESULT_PATH, 'wav-pass1')
const RESULT_PASS2 = join(RESULT_PATH, 'wav-pass2')
const STARRAIL_DATA = join(import.meta.dirname, 'StarRailData')

const VOICE_CONFIG = join(STARRAIL_DATA, 'ExcelOutput', 'VoiceConfig.json')
const TALK_SENTENCE_CONFIG = join(STARRAIL_DATA, 'ExcelOutput', 'TalkSentenceConfig.json')
const TALK_SENTENCE_MULTI_VOICE = join(STARRAIL_DATA, 'ExcelOutput', 'TalkSentenceMultiVoice.json')
const VOICE_ATLAS = join(STARRAIL_DATA, 'ExcelOutput', 'VoiceAtlas.json')

const voiceMap = {} as Record<string, Voice>

const wavs1 = await findWAV(RESULT_PASS1)
const wavs2 = await findWAV(RESULT_PASS2)

for (const wav of [...wavs1, ...wavs2]) {
  const language = LANGUAGES.find(l => wav.includes(l.toLowerCase())) || ''
  const base = basename(wav)
  const name = language ? `${language.toLowerCase()}/${base}` : base
  if (voiceMap[name]) {
    if (wav.includes('pass2')) {
      continue
    } else {
      console.log('Duplicate', name, wav, voiceMap[name].filename)
    }
  }

  voiceMap[name] = {
    filename: wav,
    inGameFilename: '',
    language,
    transcription: '',
    speaker: '',
    voiceType: '',
    voiceID: ''
  }
}

console.log(Object.keys(voiceMap).length, 'wavs found')

const talkSentenceConfig = await readJSON<TalkSentenceConfig>(TALK_SENTENCE_CONFIG)
const talkSentenceMultiVoiceConfig = await readJSON<TalkSentenceMultiVoiceConfig>(TALK_SENTENCE_MULTI_VOICE)

const voiceTalkConfigHash = Object.fromEntries(Object.values(talkSentenceConfig).flatMap(({ VoiceID, TalkSentenceID, TextmapTalkSentenceName: { Hash: TextmapTalkSentenceNameHash }, TalkSentenceText: { Hash: TalkSentenceTexthash } }) =>
  [VoiceID, ...talkSentenceMultiVoiceConfig[TalkSentenceID]?.VoiceIDList || []]
    .filter(voice => voice !== undefined)
    .map(voice => [voice, {
      TextmapTalkSentenceNameHash,
      TalkSentenceTexthash
    }])
) as [number, { TextmapTalkSentenceNameHash: number, TalkSentenceTexthash: number }][])


const voiceAtlas = await readJSON<VoiceAtlas>(VOICE_ATLAS)
const atlasList = Object.values(voiceAtlas).flatMap(characterAtlas => Object.values(characterAtlas))

const voiceAtlasHash = Object.fromEntries(atlasList.map(atlas => {
  if ('AudioID' in atlas) {
    return [atlas.AudioID, { textHash: atlas.Voice_M.Hash }]
  }
}).filter(Boolean) as [number, { textHash: number }][])

const voiceConfig = await readJSON<VoiceConfig>(VOICE_CONFIG)
const textMap = await readTextMap(STARRAIL_DATA, TEXT_MAP_MAP)

for (const { VoiceID, VoicePath, VoiceType } of Object.values(voiceConfig)) {
  const suffixes = ['', '_m', '_f']
  for (const language of LANGUAGES) {
    for (const suffix of suffixes) {
      const wem = `${language}/voice/${VoicePath}${suffix}.wem`
      const hash = encodeFNV64(wem)
      const wav = `${hash}.wav`
      const voice = voiceMap[wav]
      if (voice) {
        voice.inGameFilename = wem
        voice.voiceType = VoiceType || ''
        voice.voiceID = VoiceID.toString()
        voice.language = language
        const config = voiceTalkConfigHash[VoiceID]
        if (config) {
          voice.transcription = textMap[language][config.TalkSentenceTexthash] || ''
          voice.speaker = textMap['English'][config.TextmapTalkSentenceNameHash] || ''
        }
        const atlas = voiceAtlasHash[VoiceID]
        if (atlas) {
          voice.transcription = textMap[language][atlas.textHash] || ''
        }
      }
    }
  }
}

const metadata = Object.values(voiceMap)
  .map(({ filename, inGameFilename, transcription, language, speaker, voiceType }) => {
    return JSON.stringify({
      filename,
      inGameFilename,
      transcription,
      language,
      speaker,
      voiceType
    })
  })
  .join('\n')

await writeFile(join(RESULT_PATH, 'metadata.jsonl'), metadata)
await updateStats(voiceMap, 'README.md')

const huggingfaceMetadata = `---
task_categories:
- audio-classification
- automatic-speech-recognition
- text-to-speech
language:
- zh
- en
- ja
- ko
pretty_name: StarRail Voice
---`

await copyReadme('README.md', join(RESULT_PATH, 'README.md'), huggingfaceMetadata)

type Voice = {
  filename: string
  inGameFilename: string
  language: typeof LANGUAGES[number] | ''
  transcription: string
  speaker: string
  voiceType: string
  voiceID: string
}

type VoiceConfig = {
  [key: string]: {
    VoiceID: number
    IsPlayerInvolved?: boolean
    VoicePath: string
    VoiceType?: string
  }
}

type TalkSentenceConfig = {
  [key: string]: {
    TalkSentenceID: number
    VoiceID?: number
    TextmapTalkSentenceName: {
      Hash: number
    }
    TalkSentenceText: {
      Hash: number
    }
  }
}

type TalkSentenceMultiVoiceConfig = {
  [key: string]: {
    TalkSentenceID: number
    VoiceIDList: number[]
  }
}

type Atlas = {
  AvatarID: number
  VoiceID: number
  VoiceTitle: {
    Hash: number
  }
  Voice_M: {
    Hash: number
  }
  Voice_F: {
    Hash: number
  }
  IsBattleVoice: boolean
  UnlockDesc: {
    Hash: number
  }
  SortID: number
} & ({ AudioID: number, AudioEvent: '' } | { AudioEvent: string })

type VoiceAtlas = {
  [key: string]: {
    [key: string]: Atlas
  }
}
