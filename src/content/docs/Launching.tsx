import { CodeBlock } from '../../components/CodeBlock'

export function DocsLaunching() {
  return (
    <div className="space-y-4">
      <p>POST /x402/launch creates a fixed-supply ERC-20 token and its curve. Name and symbol are required. The creator and any first-buy tokens are assigned to the payer address in the authorization.</p>
      <CodeBlock label="Launch request body" code={JSON.stringify({ name: 'My agent token', symbol: 'AGENT', metadataURI: '', initialBuyUsdc: '0', minTokensOut: '0' }, null, 2)} />
      <ul className="docs-list">
        <li>Name: 1 to 32 UTF-8 bytes. Symbol: 1 to 10 UTF-8 bytes.</li>
        <li>metadataURI: optional, at most 256 bytes. Prepare the metadata before launching; the endpoint does not upload it.</li>
        <li>initialBuyUsdc: optional USDC decimal string. A first buy happens in the same transaction as creation.</li>
        <li>minTokensOut: your minimum for the first buy. If omitted in ordinary mode, the gateway derives it from the quote and slippageBps, default 100 (1%). State it explicitly in bound mode.</li>
      </ul>
      <p>The payment equals the live launch fee, launch relay fee, and first-buy USDC input. The 402 response contains the exact atomic amount to sign. Read <a className="underline" href="#docs/pricing">Pricing</a>; these docs do not set the fee.</p>
      <p>The token has 1 billion units with 18 decimals: 800 million for the curve and 200 million reserved for graduation. Name, symbol and the stored metadata URI cannot be changed after creation. Nobody reviews the creator's claims before launch.</p>
      <p>A successful response contains the token address, tokensOut and transaction hash. Save the receipt and verify the token's creator onchain. Do not assume a name or symbol identifies a unique token.</p>
    </div>
  )
}
