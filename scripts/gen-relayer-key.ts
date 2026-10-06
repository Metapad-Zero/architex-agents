// Creates the x402 gateway's relayer key once and stores it in the gitignored .env.local.
// Prints the public address only. The relayer submits signed authorizations and pays gas;
// it never holds anyone's funds (settlement and the action are one transaction).
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const file = new URL('../.env.local', import.meta.url)
const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
const found = current.match(/^RELAYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m)?.[1] as `0x${string}` | undefined
const key = found ?? generatePrivateKey()
if (!found) appendFileSync(file, `${current.endsWith('\n') || current === '' ? '' : '\n'}RELAYER_PRIVATE_KEY=${key}\n`)
console.log(`${found ? 'existing' : 'created'} relayer address: ${privateKeyToAccount(key).address}`)
