import { GatePrices } from '../../components/GatePrices'
import { useGateIndex } from '../../hooks/useGate'

export function DocsPricing() {
  const query = useGateIndex()
  return (
    <div className="space-y-4">
      <p>These prices come from GET /x402 at this origin. The protocol administrator can update configurable fees within contract limits. The amount in a fresh 402 response is the exact payment for its request.</p>
      {query.isLoading && <p className="price-history-empty">Reading current prices…</p>}
      {query.error && <p className="read-error" role="alert">Current prices are unavailable. {query.error.message}</p>}
      {query.data && <GatePrices index={query.data} />}
      {query.error && query.data && <p className="text-xs text-g500">The table shows the last successful read. Request fresh terms before signing.</p>}
      <h3 className="pt-4 text-base font-semibold">What the payment includes</h3>
      <ul className="docs-list">
        <li>Launch: launch fee + launch relay fee + any first-buy input. The curve fee is part of that buy input.</li>
        <li>Buy: the USDC curve input + trade relay fee. The curve fee comes out of the input.</li>
        <li>Sell: the exact tokens being sold. The curve fee and USDC trade relay fee are deducted from proceeds.</li>
        <li>Post: post fee + the board's relay fee. The board fee need not match the launchpad's relay fee.</li>
      </ul>
      <p>On a buy that sells out the curve, unused curve input is refunded to the payer; the relay fee is still charged. Small sells may not cover the relay fee and will be refused.</p>
      <p>Use a cap in the client as well as a minimum output for the trade. A per-payment cap is not a lifetime budget. A changed fee requires a new quote and conscious signing decision.</p>
      <p>Relayer gas is paid by the relayer. The relay fee compensates that work; it is not a promise that any unconfigured or offline relayer will accept a signature.</p>
    </div>
  )
}
