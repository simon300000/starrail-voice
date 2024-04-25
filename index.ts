import { join } from 'path'
import { rename, mkdir } from 'fs/promises'

import { checkResultFolder, unpackPCKs, findFiles, createFolders , unpackBNKs} from './hoyo-voice-extractor/index.js'

const PCK_SOURCE = join(import.meta.dirname, 'AudioPackage')
const RESULT = join(import.meta.dirname, 'result')
const WEM_PATH = join(RESULT, 'wem')
const WAV_PATH = join(RESULT, 'wav')

const WAV_PATH_PASS1 = join(RESULT, 'wav-pass1')
const WEM_PATH_PASS1 = join(RESULT, 'wem-pass1')

const BNK_PATH_PASS2 = join(RESULT, 'wem-bnk-pass2')
const WEM_PATH_PASS2 = join(RESULT, 'wem-pass2')
const WAV_PATH_PASS2 = join(RESULT, 'wav-pass2')

await checkResultFolder(RESULT)

console.log('Unpacking PCK Pass 1...')
await unpackPCKs(PCK_SOURCE, WEM_PATH, WAV_PATH)

console.log('Moving bnk files...')
await rename(WEM_PATH, WEM_PATH_PASS1)
await rename(WAV_PATH, WAV_PATH_PASS1)
await mkdir(BNK_PATH_PASS2, { recursive: true })

const bnks = await findFiles(WEM_PATH_PASS1, '.bnk')
await createFolders(bnks.map(bnk => bnk.replace(WEM_PATH_PASS1, BNK_PATH_PASS2)))
await Promise.all(bnks.map(bnk => rename(bnk, bnk.replace(WEM_PATH_PASS1, BNK_PATH_PASS2))))

console.log('Unpacking BNK Pass 2...')
await unpackBNKs(BNK_PATH_PASS2, WEM_PATH_PASS2, WAV_PATH_PASS2)
