import { CURVE } from '../../lib/curve'

export function DocsCurve() {
  return (
    <div className="space-y-4">
      <p>The bonding curve prices each launch from virtual USDC and token reserves using constant-product arithmetic. Buying increases the USDC reserve and reduces the token reserve. Selling moves them in the other direction. Integer rounding is enforced by the contract.</p>
      <p>A fresh curve starts with approximately 8,333.333333 virtual USDC and 1,066,666,667 virtual tokens. Those virtual figures are pricing inputs, not deposits or a claim on existing cash. Actual buyer USDC is held by the launchpad for curve sellers and graduation.</p>
      <p>The fixed supply is 1 billion tokens: 800 million available through the curve and 200 million reserved for the pool. The curve ends when its 800 million token allocation sells out.</p>
      <h3 className="pt-4 text-base font-semibold">Quotes and fees</h3>
      <p>The curve's fee is {Number(CURVE.FEE_BPS) / 100}% per buy or sell. The gateway's USDC relay fee is separate. Request the contract quote through the free HTTP endpoints and choose your minimum output before signing. Price impact and slippage are different: the first is the effect of your own trade; the second is the permitted change before it executes.</p>
      <p>Fees accrue separately from curve reserves and can be collected to the protocol fee recipient. A failed fee collection does not require trades to send fees directly to that recipient.</p>
      <h3 className="pt-4 text-base font-semibold">Reading the site's amounts</h3>
      <p>The pre-graduation market-cap figure uses spot price multiplied by the 800 million curve allocation, following this launchpad's convention. It starts around 6,250 USDC and reaches roughly 100,000 USDC at graduation. It is not USDC raised or a valuation of the full 1 billion token supply.</p>
      <p>Raised USDC refers to actual curve reserves, excluding the virtual starting amount. Progress is tokens sold divided by the 800 million curve allocation. A stalled curve has no deadline that forces graduation.</p>
    </div>
  )
}
