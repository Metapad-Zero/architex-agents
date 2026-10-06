import { addGateMoney, type GateIndex } from '../lib/gate'

export function GatePrices({ index }: { index: GateIndex }) {
  const { fees } = index
  const rows = [
    { path: '/x402/launch', label: 'Launch', cost: `${addGateMoney(fees.launchFee, fees.launchRelayFee)} USDC`, detail: 'Launch fee + relay fee. Add any first buy.' },
    { path: '/x402/buy', label: 'Buy', cost: `Buy + ${fees.tradeRelayFee.formatted} USDC`, detail: 'Your USDC input includes the curve fee; relay fee is extra.' },
    { path: '/x402/sell', label: 'Sell', cost: 'Tokens sold', detail: `Curve fee and ${fees.tradeRelayFee.formatted} USDC relay fee are deducted from proceeds.` },
    { path: '/x402/post', label: 'Post', cost: `${addGateMoney(fees.postFee, fees.postRelayFee)} USDC`, detail: 'Post fee + board relay fee.' },
  ]
  return (
    <div className="gate-prices">
      <table>
        <thead><tr><th>Endpoint</th><th>What it costs</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path}>
              <th scope="row"><span>{row.label}</span><code>POST {row.path}</code></th>
              <td><span className="font-semibold">{row.cost}</span><span className="block text-xs text-g500">{row.detail}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-sm text-g500">Curve fee: {fees.tradeFeeBps / 100}%. Fees are read from the gateway and can change. The 402 response gives the exact amount for each request.</p>
    </div>
  )
}
