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
const TEXTMAPS = Object.values(TEXT_MAP_MAP) as Array<typeof TEXT_MAP_MAP[typeof LANGUAGES[number]]>

const RESULT_PATH = join(import.meta.dirname, 'result')
const STARRAIL_DATA = join(import.meta.dirname, 'StarRailData')

const VOICE_CONFIG = join(STARRAIL_DATA, 'ExcelOutput', 'VoiceConfig.json')
const TALK_SENTENCE_CONFIG = join(STARRAIL_DATA, 'ExcelOutput', 'TalkSentenceConfig.json')

const voiceMap = {} as Record<string, Voice>

const wavs = await findWAV(RESULT_PATH)

for (const wav of wavs) {
  const language = LANGUAGES.find(l => wav.includes(l.toLowerCase())) || ''
  const base = basename(wav)
  const name = language ? `${language.toLowerCase()}/${base}` : base
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

const voiceHash = Object.fromEntries(Object.values(talkSentenceConfig).map(({ VoiceID, TextmapTalkSentenceName: { Hash: TextmapTalkSentenceNameHash }, TalkSentenceText: { Hash: TalkSentenceTexthash } }) => {
  if (VoiceID) {
    return [VoiceID, {
      TextmapTalkSentenceNameHash,
      TalkSentenceTexthash
    }]
  }
}).filter(Boolean) as [number, { TextmapTalkSentenceNameHash: number, TalkSentenceTexthash: number }][])


const voiceConfig = await readJSON<VoiceConfig>(VOICE_CONFIG)
const textMap = await readTextMap(STARRAIL_DATA, TEXT_MAP_MAP)

for (const { VoiceID, VoicePath, VoiceType } of Object.values(voiceConfig)) {
  for (const language of LANGUAGES) {
    const wem = `${language}/voice/${VoicePath}.wem`
    const hash = encodeFNV64(wem)
    const wav = `${hash}.wav`
    const voice = voiceMap[wav]
    if (voice) {
      voice.inGameFilename = wem
      voice.voiceType = VoiceType || ''
      voice.voiceID = VoiceID.toString()
      const config = voiceHash[VoiceID]
      if (config) {
        voice.transcription = textMap[language][config.TalkSentenceTexthash] || ''
        voice.speaker = textMap['English'][config.TextmapTalkSentenceNameHash] || ''
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
