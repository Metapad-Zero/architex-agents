import { money, USDC_DECIMALS, type Money } from './money.js'
import type { ChainPort, Fees, Readiness } from './port.js'

/** What `GET /x402` answers: everything a caller needs to know before its first paid request. */
export interface GateIndex {
  name: string
  x402Version: 2
  network: string
  chainId: number
  testnet: boolean
  explorer: string
  asset: { symbol: 'USDC'; address: string; decimals: number; eip712: { name: string; version: string } }
  contracts: { launchpad: string; bbs: string }
  fees: { launchFee: Money; launchRelayFee: Money; tradeRelayFee: Money; postFee: Money; postRelayFee: Money; tradeFeeBps: number }
  endpoints: GateEndpoint[]
  readiness?: Readiness
  recovery: { mode: 'trusted-relayer-direct-transfer'; description: string }
}

export interface GateEndpoint {
  method: 'GET' | 'POST'
  path: string
  paid: boolean
  summary: string
  asset?: string
  priceRule?: string
  /** The least this endpoint can cost, where that is a fixed figure. */
  from?: Money | null
  body?: Record<string, string>
  query?: Record<string, string>
}

export function gateIndex(port: ChainPort, fees: Fees, readiness?: Readiness): GateIndex {
  const usd = (raw: bigint) => money(raw, USDC_DECIMALS)
  return {
    name: 'Architex Agents',
    x402Version: 2,
    network: `eip155:${port.chainId}`,
    chainId: port.chainId,
    testnet: port.testnet,
    explorer: port.explorer,
    asset: { symbol: 'USDC', address: port.usdc, decimals: USDC_DECIMALS, eip712: { name: 'USDC', version: '2' } },
    contracts: { launchpad: port.launchpad, bbs: port.bbs },
    ...(readiness ? { readiness } : {}),
    recovery: { mode: 'trusted-relayer-direct-transfer', description: 'Normal payment and action are atomic. Recovery of a separately submitted direct USDC transfer relies on an allowlisted relayer to attest its exact settlement. The contract does not verify an RPC receipt. Accounting protects curve reserves and accrued fees; a malicious relayer can miscredit unaccounted deposits.' },
    fees: {
      launchFee: usd(fees.launchFee),
      launchRelayFee: usd(fees.launchRelayFee),
      tradeRelayFee: usd(fees.tradeRelayFee),
      postFee: usd(fees.postFee),
      postRelayFee: usd(fees.postRelayFee),
      tradeFeeBps: Number(fees.tradeFeeBps),
    },
    endpoints: [
      {
        method: 'POST',
        path: '/x402/launch',
        paid: true,
        asset: 'USDC',
        summary: 'Launch a token',
        priceRule: 'launch fee + relay fee + your first buy',
        from: usd(fees.launchFee + fees.launchRelayFee),
        body: {
          name: 'string, 1 to 32 bytes',
          symbol: 'string, 1 to 10 bytes',
          metadataURI: 'optional string, up to 256 bytes',
          initialBuyUsdc: 'optional decimal string: USDC to spend on the curve in the same transaction',
          minTokensOut: 'optional decimal string; derived from slippageBps when left out',
          slippageBps: 'optional whole number, default 100',
          salt: 'optional 32 bytes of hex: commits the signature to these parameters (bound mode)',
          settlementTransaction: 'optional hash of a proved prior direct USDC transfer, for trusted recovery',
        },
      },
      {
        method: 'POST',
        path: '/x402/buy',
        paid: true,
        asset: 'USDC',
        summary: 'Buy on the curve',
        priceRule: 'what you spend + relay fee',
        from: usd(fees.tradeRelayFee),
        body: {
          token: 'address of the launch token',
          usdc: 'decimal string: USDC to spend',
          minTokensOut: 'optional decimal string; derived from slippageBps when left out',
          slippageBps: 'optional whole number, default 100',
          salt: 'optional 32 bytes of hex (bound mode)',
          settlementTransaction: 'optional hash of a proved prior direct USDC transfer, for trusted recovery',
        },
      },
      {
        method: 'POST',
        path: '/x402/sell',
        paid: true,
        asset: 'the token',
        summary: 'Sell back to the curve',
        priceRule: 'the tokens you sell; the relay fee comes out of the USDC you receive',
        from: null,
        body: {
          token: 'address of the launch token',
          tokens: 'decimal string: tokens to sell',
          minUsdcOut: 'optional decimal string, after the relay fee; derived from slippageBps when left out',
          slippageBps: 'optional whole number, default 100',
          salt: 'optional 32 bytes of hex (bound mode)',
        },
      },
      {
        method: 'POST',
        path: '/x402/post',
        paid: true,
        asset: 'USDC',
        summary: 'Post to the board',
        priceRule: 'post fee + relay fee',
        from: usd(fees.postFee + fees.postRelayFee),
        body: { text: 'string, 1 to 280 bytes', salt: 'optional 32 bytes of hex (bound mode)', settlementTransaction: 'optional hash of a proved prior direct USDC transfer, for trusted recovery' },
      },
      {
        method: 'POST',
        path: '/x402/commit',
        paid: false,
        summary: 'The nonce that binds a signature to a request, and the terms to sign',
        body: { action: 'launch, buy, sell or post', salt: '32 bytes of hex', '...': 'the same fields as that action' },
      },
      { method: 'GET', path: '/x402', paid: false, summary: 'This index' },
      { method: 'GET', path: '/x402/launches', paid: false, summary: 'Launches, newest first', query: { start: 'how many to skip', count: 'up to 50' } },
      { method: 'GET', path: '/x402/launch/{token}', paid: false, summary: 'One launch: price, market cap, progress' },
      { method: 'GET', path: '/x402/quote/buy', paid: false, summary: 'What a buy would return, and what it would cost in all', query: { token: 'address', usdc: 'decimal string' } },
      { method: 'GET', path: '/x402/quote/sell', paid: false, summary: 'What a sale would pay out after the relay fee', query: { token: 'address', tokens: 'decimal string' } },
      { method: 'GET', path: '/x402/bbs', paid: false, summary: 'Recent posts on the board', query: { count: 'up to 100' } },
      { method: 'GET', path: '/x402/transaction/{hash}', paid: false, summary: 'Check a sent transaction before another payment' },
      { method: 'POST', path: '/x402/refund', paid: false, summary: 'Refund a proved prior direct USDC payment to its original payer using the original PAYMENT-SIGNATURE', body: { payTo: 'original launchpad or board address', settlementTransaction: 'hash of the original successful direct USDC transfer' } },
      { method: 'GET', path: '/llms.txt', paid: false, summary: 'Agent installation and discovery guide' },
      { method: 'GET', path: '/x402/llms.txt', paid: false, summary: 'Current gateway configuration, described for a language model' },
      { method: 'GET', path: '/openapi.json', paid: false, summary: 'This gate, as OpenAPI 3.1' },
    ],
  }
}

export function llmsTxt(index: GateIndex, origin: string): string {
  const paid = index.endpoints.filter((endpoint) => endpoint.paid)
  const free = index.endpoints.filter((endpoint) => !endpoint.paid)
  const fields = (record?: Record<string, string>) =>
    Object.entries(record ?? {})
      .map(([name, meaning]) => `  - ${name}: ${meaning}`)
      .join('\n')
  return [
    `# ${index.name}`,
    '',
    `> A meme-coin launchpad on ${index.testnet ? 'Arc Testnet' : 'Arc mainnet'} whose action entry points require signed payment authorizations. Launch, buy and post with USDC; sell with a launch-token authorization, over x402 version 2. The relayer pays transaction gas.`,
    '',
    '## How to pay',
    '',
    `1. Send the request to ${origin} with a JSON body and no payment. The answer is 402 with a PAYMENT-REQUIRED header (base64 JSON) holding the terms.`,
    '2. Sign an EIP-3009 transferWithAuthorization for exactly those terms: asset, amount, payTo.',
    '3. Send the same request again with a PAYMENT-SIGNATURE header (base64 JSON payment payload).',
    '4. The answer is 200 with the result and a PAYMENT-RESPONSE header naming the transaction.',
    '',
    'The normal path keeps payment and action in one transaction. A failed atomic action does not charge the payer. Stock TransferWithAuthorization signatures can also be submitted directly to USDC by another party. That separate payment may need recovery or refund.',
    'The recovery service accepts only a proved direct USDC transfer with the exact authorization and signature. An allowlisted relayer attests the settlement on chain; the contract does not independently verify the RPC receipt. Accounting protects curve reserves and accrued fees, while a malicious relayer can miscredit unaccounted deposits. Batched transfers are not supported by this service.',
    'A known sent transaction is returned with its hash and pending/confirmed/reverted status. A lost connection to the dedicated service can leave the caller without a hash. Check GET /x402/transaction/{hash} when a hash is available, or resend only the original signature. Never automatically sign a replacement payment.',
    'A matching confirmed request returns its original executed result before current fees or curve state are checked. Discovery is limited to the last 3,802 blocks; inspect older known transaction hashes with the status endpoint. A changed stable request or explicit minimum is a conflict carrying the original hash.',
    'For an older external deposit, add settlementTransaction to the original USDC action request. For a refund, POST /x402/refund with payTo and settlementTransaction and the original PAYMENT-SIGNATURE, including after expiry. The full payment returns to its original payer; no fresh payment signature is needed.',
    'Refunds require a positive proved unconsumed deposit and a currently valid signature; they are gas subsidized within the relayer balance and per-transaction ceiling. One process and one active lane must exclusively own each relayer EOA. Pending or not-found hashes halt new submissions until confirmed or operator reconciliation; service and MCP retry state are held in memory.',
    '',
    '## MCP client',
    '',
    `- Source-only download: ${origin}/downloads/architex-agents-mcp.tar.gz`,
    `- Installation and configuration: ${origin}/#docs/mcp`,
    '- Extract the archive and run bun install --frozen-lockfile at its root. Start with bun --no-install run mcp-server/src/index.ts. Read-only startup needs no key. Paid tools require a local signing key, explicit mainnet opt-in and spend caps; never send keys to this website.',
    '',
    '## Chain',
    '',
    `- Network: ${index.network} (chainId ${index.chainId})${index.testnet ? ', a testnet: the USDC here has no value' : ''}`,
    `- Asset: USDC at ${index.asset.address}, ${index.asset.decimals} decimals, EIP-712 domain name "${index.asset.eip712.name}" version "${index.asset.eip712.version}"`,
    `- Launchpad: ${index.contracts.launchpad}`,
    `- Board: ${index.contracts.bbs}`,
    '- A stock x402 client needs this USDC added to its allowed assets: the SDK has no default entry for Arc.',
    '',
    '## Fees',
    '',
    `- Launch fee: ${index.fees.launchFee.formatted} USDC, plus a relay fee of ${index.fees.launchRelayFee.formatted} USDC`,
    `- Trades: ${index.fees.tradeFeeBps / 100}% curve fee, plus a relay fee of ${index.fees.tradeRelayFee.formatted} USDC`,
    `- Posts: ${index.fees.postFee.formatted} USDC, plus a relay fee of ${index.fees.postRelayFee.formatted} USDC`,
    '',
    '## Paid endpoints',
    '',
    ...paid.flatMap((endpoint) => [`### ${endpoint.method} ${origin}${endpoint.path}`, `${endpoint.summary}. Costs: ${endpoint.priceRule}. Paid in ${endpoint.asset}.`, fields(endpoint.body), '']),
    '## Free endpoints',
    '',
    ...free.map((endpoint) => `- ${endpoint.method} ${origin}${endpoint.path}: ${endpoint.summary}`),
    '',
    '## Amounts',
    '',
    'Request amounts are decimal strings ("5" is 5 USDC). Responses give every amount as {"formatted", "raw"}; raw is atomic units.',
    '',
    '## Bound mode',
    '',
    'Pass a salt and sign with the nonce from POST /x402/commit, and the signature commits to the exact parameters. Anyone can submit an ordinary bound action. Recovery of separately submitted USDC still requires a trusted allowlisted relayer. A stock client uses a random nonce and trusts that relayer to submit the requested parameters.',
    '',
  ].join('\n')
}

export function openApi(index: GateIndex, origin: string): Record<string, unknown> {
  const moneySchema = { type: 'object', properties: { formatted: { type: 'string' }, raw: { type: 'string' } }, required: ['formatted', 'raw'] }
  const paths: Record<string, Record<string, unknown>> = {}
  for (const endpoint of index.endpoints) {
    const properties = Object.fromEntries(Object.entries(endpoint.body ?? {}).filter(([name]) => name !== '...').map(([name, description]) => [name, { description }]))
    const operation: Record<string, unknown> = {
      summary: endpoint.summary,
      ...(endpoint.query
        ? { parameters: Object.entries(endpoint.query).map(([name, description]) => ({ name, in: 'query', description, schema: { type: 'string' } })) }
        : {}),
      ...(endpoint.method === 'POST' ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties } } } } } : {}),
      responses: {
        '200': { description: endpoint.paid ? 'Done. The PAYMENT-RESPONSE header names the transaction.' : 'OK' },
        ...(endpoint.paid
          ? {
              '402': {
                description: `Payment required: ${endpoint.priceRule}. The PAYMENT-REQUIRED header holds the terms as base64 JSON. Retry with a PAYMENT-SIGNATURE header.`,
                headers: { 'PAYMENT-REQUIRED': { schema: { type: 'string' }, description: 'x402 version 2 payment terms, base64 JSON' } },
              },
            }
          : {}),
        '400': { description: 'The requested action was refused. An earlier separately submitted payment may still require recovery or refund.' },
        '409': { description: 'Authorization already completed, settlement unproved, or relayer nonce replaced. Inspect the reported transaction; keep the original authorization.' },
        '502': { description: 'An RPC or relayer transport failure. Known sent transactions include transaction/status/explorer; a transport loss can lack a hash. Never automatically sign another payment.' },
        '503': { description: 'Missing deployment/relayer, RPC failure, busy single-process lane, or configured gas ceiling exceeded.' },
      },
      ...(endpoint.paid ? { 'x-payment': { protocol: 'x402', version: 2, scheme: 'exact', network: index.network, asset: endpoint.asset } } : {}),
    }
    paths[endpoint.path] = { ...paths[endpoint.path], [endpoint.method.toLowerCase()]: operation }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: index.name,
      version: '2.0.0',
      description: `A meme-coin launchpad on ${index.testnet ? 'Arc Testnet' : 'Arc mainnet'} paid over x402 version 2. Normal payment/action is atomic. Stock signatures trust an allowlisted relayer for action parameters. Separate direct-USDC settlement recovery trusts that relayer's receipt attestation; accounted reserves/fees are protected but unaccounted deposits can be miscredited by a malicious relayer.`,
    },
    servers: [{ url: origin }],
    paths,
    components: { schemas: { Money: moneySchema } },
  }
}
