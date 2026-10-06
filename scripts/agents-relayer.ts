/** Build for Node with Bun, then run the output as one systemd-managed process. Never scale one EOA across instances. */
import { createGate } from '../server/x402/gate.js'
import { createRelayerServer, relayOrigin } from '../server/x402/relayHttp.js'
import { viemPort } from '../server/x402/viemPort.js'

const token = process.env.RELAYER_SERVICE_TOKEN?.trim()
if (!token || token.length < 32) throw new Error('RELAYER_SERVICE_TOKEN must contain at least 32 characters.')
if (process.env.RELAYER_MODE !== 'single-process') throw new Error('RELAYER_MODE=single-process is required. Run one instance with an exclusively assigned relayer key.')
if (!process.env.RELAYER_PRIVATE_KEY) throw new Error('RELAYER_PRIVATE_KEY is required on the dedicated service.')
const publicOrigin = relayOrigin(process.env.GATE_PUBLIC_ORIGIN)
const configuredPort = process.env.RELAYER_PORT || '8787'
if (!/^\d{1,5}$/.test(configuredPort) || Number(configuredPort) < 1 || Number(configuredPort) > 65535) throw new Error('RELAYER_PORT must be 1 to 65535.')
const port = viemPort(process.env)
const ready = await port.readiness()
if (!ready.relay.ready) throw new Error(ready.relay.reason || 'The dedicated relayer is not ready.')
const server = createRelayerServer({ gate: createGate(() => port), token, publicOrigin })
server.listen(Number(configuredPort), '127.0.0.1', () => console.info('Architex dedicated relayer listening on loopback', { port: Number(configuredPort), chainId: port.chainId, relayer: ready.relay.address }))
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { server.close(() => process.exit(0)) })
