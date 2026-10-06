import { CodeBlock } from '../../components/CodeBlock'

export function DocsEndpoints() {
  const origin = window.location.origin
  const paid = [
    ['/x402/launch', 'name, symbol; optional metadataURI, initialBuyUsdc, minTokensOut, slippageBps, salt', 'USDC'],
    ['/x402/buy', 'token, usdc; optional minTokensOut, slippageBps, salt', 'USDC'],
    ['/x402/sell', 'token, tokens; optional minUsdcOut, slippageBps, salt', 'Launch token'],
    ['/x402/post', 'text; optional salt', 'USDC'],
  ]
  const free = [
    ['GET /x402', 'Network, payment asset, contract addresses, current fees, endpoints and readiness.'],
    ['GET /x402/launches?start=0&count=20', 'Launches newest first. start is the number of recent launches to skip; count is at most 50.'],
    ['GET /x402/launch/{token}', 'One curve, including its creator, price, progress and graduation status.'],
    ['GET /x402/quote/buy?token=…&usdc=5', 'Contract buy quote and total USDC payment.'],
    ['GET /x402/quote/sell?token=…&tokens=1000', 'Contract sell quote and USDC proceeds after relay fee.'],
    ['GET /x402/bbs?count=20', 'Recent public board messages.'],
    ['POST /x402/commit', 'Action commitment nonce and payment terms for a supplied salt and exact request body.'],
    ['GET /x402/transaction/{hash}', 'Transaction confirmation state for a submitted hash.'],
    ['POST /x402/refund', 'Verified direct-USDC settlement refund to the original payer. Supply payTo, settlementTransaction and the original PAYMENT-SIGNATURE; no new payment is charged.'],
    ['GET /llms.txt', 'Machine-readable agent guide.'],
    ['GET /x402/llms.txt', 'Agent guide generated from the current gateway configuration.'],
    ['GET /openapi.json', 'OpenAPI endpoint description.'],
  ]
  return (
    <div className="space-y-4">
      <p>All endpoints share this origin: <code className="break-all">{origin}</code>. Send application/json to paid endpoints. Amounts in the request are decimal strings: "5" is 5 USDC, and "1000" is 1,000 whole launch tokens.</p>
      <div className="docs-table-wrap"><table className="docs-table">
        <thead><tr><th>POST endpoint</th><th>Body fields</th><th>Payment asset</th></tr></thead>
        <tbody>{paid.map(([path, fields, asset]) => <tr key={path}><th scope="row"><code>{path}</code></th><td>{fields}</td><td>{asset}</td></tr>)}</tbody>
      </table></div>
      <p>Reads and commitment preparation require no signature or key. Refunds reuse the original signature.</p>
      <dl className="space-y-4">{free.map(([path, description]) => <div key={path}><dt className="break-words font-mono text-sm font-semibold">{path}</dt><dd className="mt-1 text-sm text-g700">{description}</dd></div>)}</dl>
      <h3 className="pt-4 text-base font-semibold">The payment exchange</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>An unpaid request receives 402 and a base64 JSON PAYMENT-REQUIRED header.</li>
        <li>Inspect x402Version 2, scheme exact, network eip155:5042, asset, amount, payTo, lifetime and asset domain.</li>
        <li>Sign the EIP-3009 authorization and send the same body with PAYMENT-SIGNATURE.</li>
        <li>A confirmed success returns the action result and a PAYMENT-RESPONSE receipt naming the transaction, network and payer.</li>
      </ol>
      <CodeBlock label="Money response shape" code={JSON.stringify({ formatted: '0.25', raw: '250000' }, null, 2)} />
      <p>Every money field includes a formatted decimal string and an exact atomic raw string. USDC uses 6 decimals; launch tokens use 18. Use raw for accounting and signatures.</p>
      <p>Launch, buy and post can include settlementTransaction when a relayer has verified that the original USDC authorization was already submitted directly to USDC. Recovery and refunds trust that relayer; see <a className="underline" href="#docs/bound">Bound mode and recovery</a>. Sell authorizations are consumed by the launchpad and have no separate settlement path.</p>
      <h3 className="pt-4 text-base font-semibold">Error states</h3>
      <p>400 means an invalid request. 402 gives terms or a payment refusal. 409 can mean a used authorization whose prior settlement could not be proved. 503 means an unavailable gateway, contract or relay configuration.</p>
      <p>A 502 pending or uncertain submission includes its transaction hash and explorer link when available; check GET /x402/transaction/{'{hash}'} before authorizing another payment. A transport failure can leave you without a hash. Keep the original authorization and retry it only after checking the outcome. Network failure alone does not establish that an action failed.</p>
      <p>Responses expose PAYMENT-REQUIRED and PAYMENT-RESPONSE to cross-origin clients. Keep your private key local; HTTP carries signatures, not the key.</p>
    </div>
  )
}
