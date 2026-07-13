import { join, basename, relative, sep } from 'path'
import { writeFile, readFile, readdir } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

import { encodeFNV64, updateStats, findWAV, readJSON, readJSONWithStringHashes, readTextMap, copyReadme } from './hoyo-voice-extractor/index.js'

const TEXT_MAP_MAP = {
  'Chinese(PRC)': 'TextMapCHS.json',
  English: 'TextMapEN.json',
  Japanese: 'TextMapJP.json',
  Korean: ['TextMapMainKR.json', 'TextMapKR_0.json', 'TextMapKR_1.json']
} as const

const LANGUAGES = Object.keys(TEXT_MAP_MAP) as Array<keyof typeof TEXT_MAP_MAP>

const RESULT_PATH = process.env.VOICE_RESULT_PATH || join(import.meta.dirname, 'result')
const WAV_PATH = join(RESULT_PATH, 'wav')
const STARRAIL_DATA = join(import.meta.dirname, 'StarRailData')
const execFileAsync = promisify(execFile)

const gameVersion = await (async () => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', STARRAIL_DATA, 'log', '-1', '--format=%s'])
    return stdout.match(/(?:Win|REL)(\d+\.\d+\.\d+)/)?.[1] || ''
  } catch {
    return ''
  }
})()

const VOICE_CONFIG = join(STARRAIL_DATA, 'ExcelOutput', 'VoiceConfig.json')
const TALK_SENTENCE_CONFIG = join(STARRAIL_DATA, 'ExcelOutput', 'TalkSentenceConfig.json')
const TAROT_FILES = join(STARRAIL_DATA, 'ExcelOutput', 'TarotFiles.json')
const TAROT_BOOK_SENTENCE = join(STARRAIL_DATA, 'ExcelOutput', 'TarotBookSentence.json')
const HEART_DIAL_TALK = join(STARRAIL_DATA, 'ExcelOutput', 'HeartDialTalk.json')
const VOICE_ATLAS = join(STARRAIL_DATA, 'ExcelOutput', 'VoiceAtlas.json')
const AVATAR_CONFIG = join(STARRAIL_DATA, 'ExcelOutput', 'AvatarConfig.json')
const AVATAR_CONFIG_LD = join(STARRAIL_DATA, 'ExcelOutput', 'AvatarConfigLD.json')
const PERFORMANCE_SKIP_CHARACTER = join(STARRAIL_DATA, 'ExcelOutput', 'PerformanceSkipCharacter.json')
const SOUND_BANK_LOOKUP = join(STARRAIL_DATA, 'Config', 'SoundBankLookUp.json')
const IDLE_LIVE_GACHA_AVATAR_TEXT = join(STARRAIL_DATA, 'ExcelOutput', 'IdleLiveGachaAvatarText.json')
const CHIMERA_TALK = join(STARRAIL_DATA, 'ExcelOutput', 'ChimeraTalk.json')
const MARBLE_SEAL_TALK = join(STARRAIL_DATA, 'ExcelOutput', 'MarbleSealTalk.json')
const FATE_BROADCAST = join(STARRAIL_DATA, 'ExcelOutput', 'FateBroadcast.json')

const voiceMap = {} as Record<string, Voice>
let duplicateCount = 0

const wavs = await findWAV(WAV_PATH)

for (const wav of wavs) {
  const lowerWav = wav.toLowerCase()
  const language = LANGUAGES.find(l => lowerWav.includes(l.toLowerCase())) || ''
  const base = basename(wav)
  const name = language ? `${language.toLowerCase()}/${base}` : base
  if (voiceMap[name]) {
    duplicateCount++
    const currentDepth = relative(WAV_PATH, wav).split(sep).length
    const existingDepth = relative(WAV_PATH, voiceMap[name].filename).split(sep).length
    if (currentDepth >= existingDepth) {
      continue
    }
  }

  voiceMap[name] = {
    filename: wav,
    inGameFilename: '',
    language,
    transcription: '',
    speaker: '',
    speakerSource: '',
    voiceType: '',
    voiceID: ''
  }
}

console.log(`${duplicateCount} duplicate wav references ignored`)
console.log(Object.keys(voiceMap).length, 'wavs found')

// --- Load text maps early for hash resolution ---
const textMap = await readTextMap(STARRAIL_DATA, TEXT_MAP_MAP)

// --- Helper: resolve a text hash to display text ---
const resolveTextHash = (hash: string, language: string): string => {
  const langKey = language as keyof typeof TEXT_MAP_MAP
  return textMap[langKey]?.[hash] || textMap['Chinese(PRC)']?.[hash] || ''
}

// --- Load data configs ---
const voiceConfig = await readJSON<VoiceConfig>(VOICE_CONFIG)
const talkSentenceConfig = await readJSONWithStringHashes<TalkSentenceConfig>(TALK_SENTENCE_CONFIG)
const ambientTalkVoiceIDs = new Set(
  Object.values(voiceConfig)
    .filter(({ VoicePath }) => /^vo_ambient_.*_talk_/.test(VoicePath))
    .map(({ VoiceID }) => VoiceID)
)

const tarotFiles = await readJSONWithStringHashes<{ [key: string]: TarotSentence }>(TAROT_FILES)
const tarotBookSentences = await readJSONWithStringHashes<{ [key: string]: TarotSentence }>(TAROT_BOOK_SENTENCE)
const heartDialTalks = await readJSONWithStringHashes<{ [key: string]: HeartDialTalk }>(HEART_DIAL_TALK)

const voiceAtlas = await readJSONWithStringHashes<VoiceAtlas>(VOICE_ATLAS)
const avatarConfigMain = await readJSONWithStringHashes<AvatarConfig>(AVATAR_CONFIG)
// Collaboration avatars (Saber 1014, Archer 1015) live only in AvatarConfigLD.
// Merge it so their VoiceAtlas/event annotations resolve to a speaker name.
// Both files are arrays, so concatenate — an object spread would collide on index.
const avatarConfigLD = await readJSONWithStringHashes<AvatarConfig>(AVATAR_CONFIG_LD).catch(() => [] as unknown as AvatarConfig)
const avatarConfig = [...Object.values(avatarConfigMain), ...Object.values(avatarConfigLD)] as unknown as AvatarConfig
const performanceSkipCharacters = await readJSON<PerformanceSkipCharacter[]>(PERFORMANCE_SKIP_CHARACTER)

// --- Build speaker name mappings ---
const avatarNames = Object.fromEntries(Object.values(avatarConfig).flatMap(({ AvatarID, AvatarName }) => {
  const name = textMap.English[AvatarName?.Hash || '']
  return name ? [[AvatarID, name]] : []
})) as Record<string, string>

// Official path aliases -> speaker names. AvatarVOTag is the direct voice-path
// tag. PerformanceSkipCharacter adds explicit TalkSentenceName -> avatar icon
// links for internal names such as Mydeimos and Anaxagoras.
const speakersByPathAlias = new Map<string, Set<string>>()
const addSpeakerAlias = (alias: string, speaker: string) => {
  const speakers = speakersByPathAlias.get(alias.toLowerCase()) || new Set<string>()
  speakers.add(speaker)
  speakersByPathAlias.set(alias.toLowerCase(), speakers)
}

for (const { AvatarID, AvatarVOTag } of Object.values(avatarConfig)) {
  if (AvatarVOTag && avatarNames[AvatarID]) {
    addSpeakerAlias(AvatarVOTag, avatarNames[AvatarID])
  }
}

for (const { TalkSentenceName, IconPath } of performanceSkipCharacters) {
  const avatarID = IconPath.match(/\/Avatar\/(\d+)\.png$/)?.[1]
  const alias = TalkSentenceName.match(/^TalkSentenceName_(.+)$/)?.[1]
  const speaker = avatarID ? avatarNames[avatarID] : ''
  if (alias && speaker) {
    addSpeakerAlias(alias, speaker)
  }
}

// TarotBook VoicePaths use the generic `player` tag, while AvatarConfig uses
// gendered tags such as `playerboy` and `playergirl`. All official player
// avatars resolve to the same display name (`{NICKNAME}`), so add the generic
// alias only when that official name is unique.
const playerSpeakers = new Set(Object.values(avatarConfig).flatMap(({ AvatarID, AvatarVOTag }) =>
  AvatarVOTag && /^player(?:boy|girl)/i.test(AvatarVOTag) && avatarNames[AvatarID]
    ? [avatarNames[AvatarID]]
    : []
))
if (playerSpeakers.size === 1) {
  addSpeakerAlias('player', [...playerSpeakers][0])
}

function resolveSpeakerFromPath(voicePath: string): string {
  const segments = voicePath.toLowerCase().split('_')
  const speakers = new Set(segments.flatMap(segment => {
    const aliases = speakersByPathAlias.get(segment)
    return aliases?.size === 1 ? [...aliases] : []
  }))

  // A VoicePath may contain several character tags (for example, a team-up
  // line). Only use the path when the official alias mapping is unique.
  if (speakers.size === 1) {
    return [...speakers][0]
  }
  return ''
}

function resolveSideSpeakerFromPath(voicePath: string): string {
  const segments = voicePath.split('_')
  if (!/^side/i.test(segments[0] || '')) return ''

  // Side VoicePaths use a positional schema:
  //   side-family_mission_speaker_sequence[_state]
  // The third segment is the speaker even when the path has no numeric sequence
  // (for example, side1_tp_serval_song) or has an extra state segment (for
  // example, side4_wsw_chimera_jiaoruo_001).
  const speakerAlias = segments[2]
  if (!speakerAlias) return ''

  const officialSpeakers = speakersByPathAlias.get(speakerAlias.toLowerCase())
  if (officialSpeakers?.size === 1) {
    return [...officialSpeakers][0]
  }

  // Internal NPC tags such as guyun, jianshi, and minerJ have no official
  // AvatarVOTag mapping. Their structural position is still unambiguous, so
  // preserve the original tag instead of attributing the line to another
  // recognizable character elsewhere in the path.
  return speakerAlias
}

// --- Build VoiceID -> text/speaker (resolve ambiguity by TEXT comparison) ---
// Store ALL hashes per VoiceID
const voiceTextHashes = new Map<number, { transcriptionHashes: Set<string>, speakerHashes: Set<string> }>()

const addVoiceHashes = (voiceID: number | undefined, speakerHash: string | undefined, transcriptionHash: string | undefined) => {
  if (!voiceID) return
  let entry = voiceTextHashes.get(voiceID)
  if (!entry) {
    entry = { transcriptionHashes: new Set(), speakerHashes: new Set() }
    voiceTextHashes.set(voiceID, entry)
  }
  if (speakerHash) entry.speakerHashes.add(speakerHash)
  if (transcriptionHash) entry.transcriptionHashes.add(transcriptionHash)
}

for (const { VoiceID, TextmapTalkSentenceName, TalkSentenceText } of Object.values(talkSentenceConfig)) {
  const speakerHash = TextmapTalkSentenceName?.Hash
  // Ambient NPC TalkSentenceText is commonly a paraphrase, situation prompt,
  // or unrelated display text rather than a verbatim audio transcription.
  const transcriptionHash = VoiceID && ambientTalkVoiceIDs.has(VoiceID) ? undefined : TalkSentenceText?.Hash
  addVoiceHashes(VoiceID, speakerHash, transcriptionHash)
}
console.log(`TalkSentenceConfig ambient talk VoiceIDs excluded from transcription: ${ambientTalkVoiceIDs.size}`)

// Add supplementary text hashes
const addSupplementaryHashes = <T extends { VoiceID: number }>(rows: T[], getHash: (row: T) => string | undefined) => {
  for (const row of rows) {
    const transcriptionHash = getHash(row)
    if (transcriptionHash && row.VoiceID) {
      addVoiceHashes(row.VoiceID, undefined, transcriptionHash)
    }
  }
}

addSupplementaryHashes(Object.values(tarotFiles), row => row.Sentence?.Hash)
addSupplementaryHashes(Object.values(tarotBookSentences), row => row.Sentence?.Hash)
addSupplementaryHashes(Object.values(heartDialTalks), row => row.SDFText?.Hash)

// Resolve hashes to text, detecting genuine ambiguity (different texts, not just different hashes)
const voiceTextByID = new Map<number, { transcription: string, speaker: string }>()
let ambiguousTextCount = 0
let ambiguousSpeakerCount = 0

for (const [voiceID, hashes] of voiceTextHashes) {
  const resolvedTranscriptions = new Set<string>()
  for (const hash of hashes.transcriptionHashes) {
    const text = resolveTextHash(hash, 'Chinese(PRC)')
    if (text) resolvedTranscriptions.add(text)
  }

  const resolvedSpeakers = new Set<string>()
  for (const hash of hashes.speakerHashes) {
    const name = textMap['English']?.[hash] || textMap['Chinese(PRC)']?.[hash]
    if (name) resolvedSpeakers.add(name)
  }

  const result: { transcription: string, speaker: string } = { transcription: '', speaker: '' }

  if (resolvedTranscriptions.size === 1) {
    result.transcription = [...resolvedTranscriptions][0]
  } else if (resolvedTranscriptions.size > 1) {
    ambiguousTextCount++
  }

  if (resolvedSpeakers.size === 1) {
    result.speaker = [...resolvedSpeakers][0]
  } else if (resolvedSpeakers.size > 1) {
    ambiguousSpeakerCount++
  }

  voiceTextByID.set(voiceID, result)
}

console.log(`VoiceIDs with text data: ${voiceTextByID.size}`)
console.log(`  Ambiguous text: ${ambiguousTextCount}, ambiguous speaker: ${ambiguousSpeakerCount}`)

// --- VoiceAtlas processing ---
const isAtlas = (value: unknown): value is Atlas => typeof value === 'object' && value !== null && 'VoiceID' in value
const atlasList = Object.values(voiceAtlas).flatMap(value => {
  if (isAtlas(value)) return [value]
  return Object.values(value).filter(isAtlas)
})

// AudioID entries — keyed by AudioID (matches VoiceConfig VoiceID)
const voiceAtlasByAudioID = new Map<number, { textHash: string, speaker: string }>()
for (const atlas of atlasList) {
  if ('AudioID' in atlas && atlas.AudioID) {
    voiceAtlasByAudioID.set(atlas.AudioID, {
      textHash: atlas.Voice_M.Hash,
      speaker: avatarNames[atlas.AvatarID] || ''
    })
  }
}
console.log(`VoiceAtlas AudioID entries: ${voiceAtlasByAudioID.size}`)

// AudioEvent entries — matched via SoundBankLookUp → an event-exclusive BNK →
// the BNK's single Wwise source ID. A source is accepted only when every step
// is unambiguous; shared banks and multi-source banks are intentionally skipped.
type WavAnnotation = { textHash: string, speaker: string }
const annotationsByWavFilename = new Map<string, WavAnnotation[]>()

try {
  const soundBankLookup = await readJSON<SoundBankLookup>(SOUND_BANK_LOOKUP)
  const eventToBanks = new Map<number, number[]>()
  const eventsByBank = new Map<number, Set<number>>()
  for (const event of soundBankLookup.Events) {
    const banks = new Set([
      ...event.Bank,
      ...event.CondBank.flatMap(condition => condition.Banks),
    ])
    eventToBanks.set(event.ID, [...banks])
    for (const bankId of banks) {
      const eventIDs = eventsByBank.get(bankId) || new Set<number>()
      eventIDs.add(event.ID)
      eventsByBank.set(bankId, eventIDs)
    }
  }

  // Build BNK index: bank ID -> Wwise source IDs. DIDX lists embedded media;
  // HIRC type 2 (CAkSound) carries the source ID for streamed/external media,
  // which is how the VoBanks WAV filenames are produced.
  const wemDir = join(RESULT_PATH, 'wem')
  const bankToSources = new Map<number, Set<number>>()

  const walkDir = async (dir: string): Promise<string[]> => {
    const results: string[] = []
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...await walkDir(fullPath))
      } else if (entry.name.endsWith('.bnk')) {
        results.push(fullPath)
      }
    }
    return results
  }

  const bnkFiles = await walkDir(wemDir)
  console.log(`BNK files found: ${bnkFiles.length}`)

  for (const bnkPath of bnkFiles) {
    try {
      const bnkData = await readFile(bnkPath)
      let bankId: number | undefined
      let bankVersion: number | undefined
      const sources = new Set<number>()
      let pos = 0
      while (pos + 8 <= bnkData.length) {
        const sectionId = bnkData.subarray(pos, pos + 4).toString()
        const sectionSize = bnkData.readUInt32LE(pos + 4)
        const sectionStart = pos + 8
        const sectionEnd = sectionStart + sectionSize
        if (sectionEnd > bnkData.length) break

        if (sectionId === 'BKHD' && sectionSize >= 8) {
          bankVersion = bnkData.readUInt32LE(sectionStart)
          bankId = bnkData.readUInt32LE(sectionStart + 4)
        }

        if (sectionId === 'DIDX') {
          const count = Math.floor(sectionSize / 12)
          for (let i = 0; i < count; i++) {
            const sourceId = bnkData.readUInt32LE(sectionStart + i * 12)
            if (sourceId) sources.add(sourceId)
          }
        }

        // The checked-in audio uses Wwise bank version 135. Restrict parsing
        // to that known layout instead of assuming offsets for other versions.
        if (sectionId === 'HIRC' && bankVersion === 135 && sectionSize >= 4) {
          let objectPos = sectionStart
          const objectCount = bnkData.readUInt32LE(objectPos)
          objectPos += 4

          for (let i = 0; i < objectCount && objectPos + 5 <= sectionEnd; i++) {
            const objectType = bnkData[objectPos]
            const objectSize = bnkData.readUInt32LE(objectPos + 1)
            const objectEnd = objectPos + 5 + objectSize
            if (objectSize < 4 || objectEnd > sectionEnd) break

            // Object data starts after type, size, and object ID. For CAkSound
            // v135 it begins with plugin ID (u32), stream type (u8), then the
            // Wwise source ID (u32).
            const objectData = objectPos + 9
            if (objectType === 2 && objectData + 9 <= objectEnd) {
              const sourceId = bnkData.readUInt32LE(objectData + 5)
              if (sourceId) sources.add(sourceId)
            }
            objectPos = objectEnd
          }
        }

        pos = sectionEnd
      }

      if (bankId !== undefined && sources.size > 0) {
        const existing = bankToSources.get(bankId) || new Set<number>()
        for (const sourceId of sources) existing.add(sourceId)
        bankToSources.set(bankId, existing)
      }
    } catch { /* skip unreadable BNKs */ }
  }
  console.log(`Indexed ${bankToSources.size} BNK banks`)

  // Compute FNV-32 for Atlas AudioEvent strings
  const { fnv1 } = await import('./hoyo-voice-extractor/fnvjs/src/index.js')
  const fnv32 = (s: string) => Number(fnv1(s.toLowerCase(), 32))

  const addEventAnnotation = (eventId: number, annotation: WavAnnotation): number => {
    const banks = eventToBanks.get(eventId)
    if (!banks) return 0
    let matched = 0

    for (const bankId of banks) {
      const eventIDs = eventsByBank.get(bankId)
      const sources = bankToSources.get(bankId)
      if (eventIDs?.size !== 1 || !eventIDs.has(eventId) || sources?.size !== 1) continue

      const wavName = `${[...sources][0]}.wav`
      const annotations = annotationsByWavFilename.get(wavName) || []
      if (!annotations.some(existing => existing.textHash === annotation.textHash && existing.speaker === annotation.speaker)) {
        annotations.push(annotation)
        annotationsByWavFilename.set(wavName, annotations)
        matched++
      }
    }
    return matched
  }

  // Collect every text-bearing event so both the exclusive-bank pass and the
  // reverse-unique pass below can draw from the same annotation set.
  const textEventAnnotations = new Map<number, WavAnnotation[]>()
  const addTextEvent = (eventId: number, annotation: WavAnnotation) => {
    const list = textEventAnnotations.get(eventId) || []
    if (!list.some(existing => existing.textHash === annotation.textHash && existing.speaker === annotation.speaker)) {
      list.push(annotation)
      textEventAnnotations.set(eventId, list)
    }
  }

  let bnkMatchedCount = 0
  for (const atlas of atlasList) {
    if (!('AudioEvent' in atlas) || !atlas.AudioEvent) continue
    const eventId = fnv32(atlas.AudioEvent)
    const speaker = avatarNames[atlas.AvatarID] || ''
    const annotation = { textHash: atlas.Voice_M.Hash, speaker }
    addTextEvent(eventId, annotation)
    bnkMatchedCount += addEventAnnotation(eventId, annotation)
  }
  console.log(`VoiceAtlas AudioEvent entries matched via exclusive BNK sources: ${bnkMatchedCount}`)

  // --- Add supplementary event-path text sources ---
  // These configs have event names + text hashes that map through SoundBankLookUp → BNK
  const supplementaryEventSources: { file: string, eventField: string, textHashField: string }[] = [
    { file: IDLE_LIVE_GACHA_AVATAR_TEXT, eventField: 'VoiceID', textHashField: 'AvatarText' },
    { file: CHIMERA_TALK, eventField: 'EvPath', textHashField: 'TalkContent' },
    { file: MARBLE_SEAL_TALK, eventField: 'VoiceEvt', textHashField: 'Talk' },
  ]

  for (const { file, eventField, textHashField } of supplementaryEventSources) {
    try {
      const suppData = await readJSONWithStringHashes<Record<string, unknown>[]>(file)
      const suppValues: Record<string, unknown>[] = Array.isArray(suppData) ? suppData as unknown as Record<string, unknown>[] : Object.values(suppData) as unknown as Record<string, unknown>[]
      let suppMatched = 0

      for (const row of suppValues) {
        const eventStr = row[eventField] as string | undefined
        const textHashObj = row[textHashField] as { Hash: string } | undefined
        if (!eventStr || !textHashObj?.Hash) continue

        const eventId = fnv32(eventStr)
        const annotation = { textHash: textHashObj.Hash, speaker: '' }
        addTextEvent(eventId, annotation)
        suppMatched += addEventAnnotation(eventId, annotation)
      }
      if (suppMatched > 0) console.log(`  ${file.split('/').pop()}: ${suppMatched} matched`)
    } catch { /* skip unavailable files */ }
  }

  // FateBroadcast.json has obfuscated column names, so detect fields by shape:
  // the `Ev_vo_…` string is the event, the sole `{ Hash }` object is the text.
  // 22/22 events resolve to exclusive single-source banks and are net-new. The
  // speaker is left blank — the event token "owlbert" is not an official
  // AvatarVOTag, so naming the speaker would be a guess.
  try {
    const fateRows = await readJSONWithStringHashes<Record<string, unknown>[]>(FATE_BROADCAST)
    let fateMatched = 0
    for (const row of Object.values(fateRows)) {
      const values = Object.values(row)
      const eventStr = values.find((v): v is string => typeof v === 'string' && v.startsWith('Ev_'))
      const textHashObj = values.find((v): v is { Hash: string } =>
        typeof v === 'object' && v !== null && 'Hash' in v)
      if (!eventStr || !textHashObj?.Hash) continue

      const eventId = fnv32(eventStr)
      const annotation = { textHash: textHashObj.Hash, speaker: '' }
      addTextEvent(eventId, annotation)
      fateMatched += addEventAnnotation(eventId, annotation)
    }
    if (fateMatched > 0) console.log(`  FateBroadcast.json: ${fateMatched} matched`)
  } catch { /* skip unavailable file */ }

  // --- Reverse-unique event matching ---
  // The exclusive-bank pass above only fires when a bank carries exactly one
  // event. Some voice sources live only in banks shared by several events, so
  // that pass skips them. This pass instead keys on the SOURCE: if a Wwise
  // source is reachable from exactly one event across all of its banks, and
  // that event has text, the link is still unambiguous. Verified 95%+ accurate
  // against fresh whisper transcriptions on a Chinese sample.
  const sourceToEvents = new Map<number, Set<number>>()
  for (const [eventId, banks] of eventToBanks) {
    for (const bankId of banks) {
      const sources = bankToSources.get(bankId)
      if (!sources) continue
      for (const sourceId of sources) {
        const events = sourceToEvents.get(sourceId) || new Set<number>()
        events.add(eventId)
        sourceToEvents.set(sourceId, events)
      }
    }
  }

  let reverseMatched = 0
  for (const [sourceId, events] of sourceToEvents) {
    if (events.size !== 1) continue
    const eventId = [...events][0]
    const annotations = textEventAnnotations.get(eventId)
    if (!annotations) continue

    const wavName = `${sourceId}.wav`
    const existing = annotationsByWavFilename.get(wavName)
    if (existing) continue // already matched by the exclusive-bank pass

    annotationsByWavFilename.set(wavName, annotations)
    reverseMatched++
  }
  console.log(`Reverse-unique source→event matches: ${reverseMatched}`)

} catch (e) {
  console.log('VoiceAtlas AudioEvent/BNK processing skipped:', (e as Error).message?.slice(0, 100))
}

// --- Main matching loop ---
// Build alternative FNV hash index (bare VoicePath, without language/voice prefix)
const altHashToVoiceID = new Map<string, number>()
for (const { VoiceID, VoicePath } of Object.values(voiceConfig)) {
  for (const suffix of ['', '_m', '_f']) {
    const altPath = `${VoicePath}${suffix}.wem`
    altHashToVoiceID.set(encodeFNV64(altPath), VoiceID)
  }
}

for (const { VoiceID, VoicePath, VoiceType } of Object.values(voiceConfig)) {
  const suffixes = ['', '_m', '_f']
  for (const language of LANGUAGES) {
    for (const suffix of suffixes) {
      const wem = `${language}/voice/${VoicePath}${suffix}.wem`
      const hash = encodeFNV64(wem)
      const wav = `${hash}.wav`
      const key = `${language.toLowerCase()}/${wav}`
      const voice = voiceMap[key]
      if (voice) {
        voice.inGameFilename = wem
        voice.voiceType = VoiceType || ''
        voice.voiceID = VoiceID.toString()
        voice.language = language
        const config = voiceTextByID.get(VoiceID)
        if (config) {
          if (config.transcription) {
            voice.transcription = config.transcription
          }
          if (config.speaker) {
            voice.speaker = config.speaker
            voice.speakerSource = 'path1-talk-sentence'
          }
        }
        // VoiceAtlas AudioID lookup (AudioID == VoiceID from VoiceConfig)
        const atlas = voiceAtlasByAudioID.get(VoiceID)
        if (atlas) {
          if (!voice.transcription) {
            voice.transcription = resolveTextHash(atlas.textHash, voice.language)
          }
          if (!voice.speaker) {
            voice.speaker = atlas.speaker
            if (atlas.speaker) voice.speakerSource = 'path2-voice-atlas-audio-id'
          }
        }
      }
    }
  }
}

// --- Second pass: try alternative hash for unmatched wavs ---
for (const key of Object.keys(voiceMap)) {
  const voice = voiceMap[key]
  if (voice.inGameFilename) continue

  const baseWav = basename(voice.filename)
  const hash = baseWav.replace('.wav', '')
  const altVoiceID = altHashToVoiceID.get(hash)
  if (altVoiceID) {
    const vcEntry = (voiceConfig as VoiceConfigEntry[]).find(v => v.VoiceID === altVoiceID)
    if (vcEntry) {
      voice.inGameFilename = `(alt:${vcEntry.VoicePath}.wem)`
      voice.voiceType = vcEntry.VoiceType || ''
      voice.voiceID = String(vcEntry.VoiceID)
      voice.language = voice.language || 'Chinese(PRC)'

      const config = voiceTextByID.get(altVoiceID)
      if (config) {
        if (config.transcription) voice.transcription = config.transcription
        if (config.speaker) {
          voice.speaker = config.speaker
          voice.speakerSource = 'path1-talk-sentence'
        }
      }

      const atlas = voiceAtlasByAudioID.get(altVoiceID)
      if (atlas) {
        if (!voice.transcription) voice.transcription = resolveTextHash(atlas.textHash, voice.language)
        if (!voice.speaker) {
          voice.speaker = atlas.speaker
          if (atlas.speaker) voice.speakerSource = 'path2-voice-atlas-audio-id'
        }
      }
    }
  }
}

// --- Third pass: official event annotations via BNK source filename ---
for (const key of Object.keys(voiceMap)) {
  const voice = voiceMap[key]
  const baseWav = basename(voice.filename)
  const annotations = annotationsByWavFilename.get(baseWav)
  if (!annotations) continue

  const transcriptions = new Set(annotations.flatMap(annotation => {
    const text = resolveTextHash(annotation.textHash, voice.language)
    return text ? [text] : []
  }))
  const speakers = new Set(annotations.flatMap(annotation => annotation.speaker ? [annotation.speaker] : []))

  // Different official annotations can reuse one source. Do not select one
  // when the texts or speakers disagree.
  if (!voice.transcription && transcriptions.size === 1) {
    voice.transcription = [...transcriptions][0]
  }
  if (!voice.speaker && speakers.size === 1) {
    voice.speaker = [...speakers][0]
    voice.speakerSource = 'path3-voice-atlas-event-bnk'
  }
}

// --- Fourth pass: structural Side speaker or exact official VoicePath alias ---
let path4SpeakerCount = 0

for (const voice of Object.values(voiceMap)) {
  if (voice.speaker) continue
  if (!voice.inGameFilename) continue
  const match = voice.inGameFilename.match(/\/voice\/(.+)\.wem$/)
  if (match) {
    const voicePath = match[1].replace(/(_m|_f)$/, '')
    // `vo_syss` is a TarotBook path: its first character tag is the book/page
    // subject, not the speaker. It must be resolved from its final role tag in
    // path 5 and must never fall through this whole-path uniqueness heuristic.
    if (voicePath.toLowerCase().startsWith('vo_syss_')) continue
    const speaker = /^side/i.test(voicePath)
      ? resolveSideSpeakerFromPath(voicePath)
      : resolveSpeakerFromPath(voicePath)
    if (speaker) {
      voice.speaker = speaker
      voice.speakerSource = 'path4-unique-official-alias'
      path4SpeakerCount++
    }
  }
}

// --- Fifth pass: positional speaker tag ---
//   • `vo_syss`: this is a TarotBook path. Resolve ONLY the final role tag,
//     because the first character tag is the book/page subject. This also maps
//     the generic `player` role to the official `{NICKNAME}` display name.
//   • every other family, e.g. `side2_yunli_argenti_<n>`: select the LAST tag.
//     This direction agrees with every independently labeled current candidate.
// For non-TarotBook paths, fire only on at least two distinct official tags.
let path5SpeakerCount = 0
for (const voice of Object.values(voiceMap)) {
  if (!voice.inGameFilename) continue
  const match = voice.inGameFilename.match(/\/voice\/(.+)\.wem$/)
  if (!match) continue
  const path = match[1].replace(/(_m|_f)$/, '')
  const stem = path.replace(/_\d+$/, '')
  const lowerStem = stem.toLowerCase()

  const tagSpeakers = lowerStem.split('_').flatMap(segment => {
    const aliases = speakersByPathAlias.get(segment)
    return aliases?.size === 1 ? [[segment, [...aliases][0]] as const] : []
  })
  const isSystemStory = lowerStem.startsWith('vo_syss_')
  let chosen: readonly [string, string] | undefined
  if (isSystemStory) {
    const finalAlias = lowerStem.split('_').at(-1) || ''
    const finalSpeakers = speakersByPathAlias.get(finalAlias)
    if (finalSpeakers?.size === 1) {
      chosen = [finalAlias, [...finalSpeakers][0]] as const
    }
  } else {
    const distinct = new Set(tagSpeakers.map(([, speaker]) => speaker))
    if (tagSpeakers.length >= 2 && distinct.size >= 2) {
      chosen = tagSpeakers[tagSpeakers.length - 1]
    }
  }
  if (!chosen || voice.speaker) continue

  voice.speaker = chosen[1]
  voice.speakerSource = 'path5-positional-final-alias'
  path5SpeakerCount++
}

// Normalize the player placeholder into a stable gendered dataset label. Some
// legacy/BNK rows have no `_m`/`_f` inGameFilename; keep those as `player`
// rather than retaining the unresolved `{NICKNAME}` placeholder.
let playerMaleCount = 0
let playerFemaleCount = 0
let playerUngenderedCount = 0
for (const voice of Object.values(voiceMap)) {
  if (voice.speaker !== '{NICKNAME}') continue
  if (/_m\.wem$/i.test(voice.inGameFilename)) {
    voice.speaker = 'player_m'
    playerMaleCount++
  } else if (/_f\.wem$/i.test(voice.inGameFilename)) {
    voice.speaker = 'player_f'
    playerFemaleCount++
  } else {
    voice.speaker = 'player'
    playerUngenderedCount++
  }
}

console.log(`Player speaker labels: player_m=${playerMaleCount}, player_f=${playerFemaleCount}, player=${playerUngenderedCount}`)
console.log(`Speaker path fallback assignments: path 4=${path4SpeakerCount}, path 5=${path5SpeakerCount}`)

// --- Output ---
await writeFile(join(import.meta.dirname, 'result.json'), JSON.stringify(voiceMap))

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
if (gameVersion) {
  const readme = await readFile('README.md', 'utf-8')
  await writeFile('README.md', readme.replace(/Last update at `([^`]+)`(?:, game version `[^`]+`)?/, `Last update at \`$1\`, game version \`${gameVersion}\``))
}

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

// --- Types ---
type Voice = {
  filename: string
  inGameFilename: string
  language: typeof LANGUAGES[number] | ''
  transcription: string
  speaker: string
  speakerSource: SpeakerSource | ''
  voiceType: string
  voiceID: string
}

type SpeakerSource =
  | 'path1-talk-sentence'
  | 'path2-voice-atlas-audio-id'
  | 'path3-voice-atlas-event-bnk'
  | 'path4-unique-official-alias'
  | 'path5-positional-final-alias'

type VoiceConfigEntry = {
  VoiceID: number
  IsPlayerInvolved?: boolean
  VoicePath: string
  VoiceType?: string
}

type VoiceConfig = VoiceConfigEntry[]

type AvatarConfig = {
  [key: string]: {
    AvatarID: number
    AvatarVOTag?: string
    AvatarName?: { Hash: string }
  }
}

type PerformanceSkipCharacter = {
  TalkSentenceName: string
  IconPath: string
}

type TalkSentenceConfig = {
  [key: string]: {
    TalkSentenceID: number
    VoiceID?: number
    TextmapTalkSentenceName?: { Hash: string }
    TalkSentenceText?: { Hash: string }
  }
}

type TarotSentence = {
  VoiceID: number
  Sentence?: { Hash: string }
}

type HeartDialTalk = {
  VoiceID: number
  SDFText?: { Hash: string }
}

type Atlas = {
  AvatarID: number
  VoiceID: number
  VoiceTitle: { Hash: string }
  Voice_M: { Hash: string }
  Voice_F: { Hash: string }
  IsBattleVoice: boolean
  UnlockDesc: { Hash: string }
  SortID: number
} & ({ AudioID: number, AudioEvent: '' } | { AudioEvent: string })

type VoiceAtlas = {
  [key: string]: Atlas | { [key: string]: Atlas }
}

type SoundBankLookup = {
  Events: {
    ID: number
    Bank: number[]
    CondBank: { Banks: number[], Condition: { Group: number, Value: number, IsState: boolean }[] }[]
  }[]
}
