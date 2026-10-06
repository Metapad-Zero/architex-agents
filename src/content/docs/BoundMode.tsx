export function DocsBoundMode() {
  return (
    <div className="space-y-4">
      <p>A stock x402 client signs an ordinary EIP-3009 payment with a random nonce. That signature binds the payer, recipient, asset, amount and validity window. It does not commit the HTTP action body, such as the token name or trade minimum.</p>
      <p>For ordinary payments, the contract permits an allowlisted relayer to supply the action parameters. It still sends token outputs, refunds and sale proceeds only to the payer. You trust that relayer to use the parameters you requested.</p>
      <h3 className="pt-4 text-base font-semibold">Commit the action parameters</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>Choose a fresh random 32-byte salt and the exact launch, buy, sell or post parameters. Set the minimum output explicitly for a trade or first buy.</li>
        <li>Send those fields, action and salt to the free POST /x402/commit endpoint.</li>
        <li>Verify its returned nonce against the deployed contract's launchNonce, buyNonce, sellNonce or postNonce helper. Do not accept a helper response blindly if you are removing parameter trust.</li>
        <li>Sign the payment authorization with that commitment as nonce, using the exact asset, recipient, amount and domain.</li>
        <li>Retry the paid endpoint with the unchanged body, salt and signed payment. A mismatched parameter or nonce reverts.</li>
      </ol>
      <p>The ordinary stock wrapper creates its own random nonce. Adding salt to a body alone does not make that wrapper use bound mode; you need a signer/client that uses the contract commitment. A bound action's normal path can be submitted by anyone, with outputs still directed to the payer.</p>
      <p>Bound helpers return a nonce with the reserved prefix 0x4152435458424e44 (ARCTXBND) and 192 commitment bits. A marked nonce must match the actual parameters even when an allowlisted relayer submits it. Use the helper's return value rather than an ordinary full hash.</p>
      <h3 className="pt-4 text-base font-semibold">Recovery remains trusted</h3>
      <p>USDC accepts a TransferWithAuthorization signature submitted directly to its token contract. Someone who sees the authorization can settle it before the launchpad action runs. The used nonce and an unaccounted contract balance do not prove this exact payment occurred.</p>
      <p>The separate recovery path requires an allowlisted relayer to verify the exact prior USDC settlement offchain. Recovery can finish the action using that already received payment. This trust remains even when the action parameters are bound. Keep the settlement and action receipts for inspection.</p>
      <p>The contract does not verify historical receipt inclusion. A dishonest relayer can miscredit unaccounted deposits, including another payer's stranded payment. Contract accounting protects live curve reserves and accrued fees, but does not protect those stranded deposits from that relayer.</p>
      <p>If the action cannot complete, POST /x402/refund can return the original payment to its payer. Supply payTo and the verified direct-USDC settlementTransaction, and reuse the original PAYMENT-SIGNATURE. No new payment is charged. The refund still requires an allowlisted relayer and a signature that is valid now; revocation by an EIP-1271 wallet can prevent recovery even though expired authorizations are accepted.</p>
      <p>Bound mode limits parameter changes. It does not guarantee relayer uptime, eliminate contract or USDC risk, or make a separately settled payment atomic with the later action.</p>
    </div>
  )
}
