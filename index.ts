import { join } from 'path'

import { checkResultFolder, unpackPCKs } from './hoyo-voice-extractor/index.js'

const PCK_SOURCE = process.env.VOICE_SOURCE_PATH || join(import.meta.dirname, 'AudioPackage')
const RESULT = process.env.VOICE_RESULT_PATH || join(import.meta.dirname, 'result')
const WEM_PATH = join(RESULT, 'wem')
const WAV_PATH = join(RESULT, 'wav')

await checkResultFolder(RESULT)

await unpackPCKs(PCK_SOURCE, WEM_PATH, WAV_PATH)
