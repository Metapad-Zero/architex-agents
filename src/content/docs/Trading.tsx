import { CodeBlock } from '../../components/CodeBlock'

export function DocsTrading() {
  return (
    <div className="space-y-4">
      <p>POST /x402/sell is paid in the launch token itself. The authorization moves exactly the tokens being sold to the launchpad, which executes the curve sale and sends USDC proceeds to the payer.</p>
      <CodeBlock label="Sell request body" code={JSON.stringify({ token: '<launch token address>', tokens: '1000', minUsdcOut: '<quoted minimum after relay fee>', slippageBps: 100 }, null, 2)} />
      <p>First read GET /x402/quote/sell?token=…&amp;tokens=1000. The curve fee is taken from gross proceeds, then the USDC relay fee is deducted. minUsdcOut means the minimum you receive after both fees. A sale whose proceeds do not cover the relay fee is refused.</p>
      <h3 className="pt-4 text-base font-semibold">Token signing domain</h3>
      <p>The payment terms identify the launch token as asset, its name as the EIP-712 domain name, version 1, Arc chain 5042, and the launchpad as payTo. LaunchToken supports EIP-3009, EIP-2612 permit and EIP-1271 signature checks. The gateway sale uses the EIP-3009 authorization path; it does not need an allowance transaction.</p>
      <p>A stock x402 client must add this specific token to spendControls.allowedAssets for this request, with maxAmountPerPayment equal to the atomic token amount you intend to sell. Keep the policy pinned to its address, the launchpad recipient, and the returned token domain. Do not allow every token without a cap.</p>
      <h3 className="pt-4 text-base font-semibold">Buying</h3>
      <p>POST /x402/buy takes token, usdc and an optional minTokensOut or slippageBps. Its USDC payment is the curve input plus the trade relay fee. On the buy that sells out the curve, unused curve input is returned to the payer in the same call; the relay fee remains charged.</p>
      <p>Quotes can change before execution. The minimum output protects the trade at execution; a quote alone does not reserve a price. Bound mode also commits your chosen token and minimum output against relayer changes.</p>
      <p>Curve buy and sell endpoints stop after graduation. Trade the graduated pair through the shared AMM instead. Before graduation, LaunchToken restricts transfers into its designated future pair; it does not prevent all transfers between holder addresses.</p>
    </div>
  )
}
