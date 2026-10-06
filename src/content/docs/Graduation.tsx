export function DocsGraduation() {
  return (
    <div className="space-y-4">
      <p>Graduation happens in the transaction that sells out the 800 million token curve allocation. It is automatic and irreversible. The creator cannot pick an earlier date or withdraw the curve reserves through an owner function.</p>
      <p>The launchpad seeds the designated AMM pair with actual USDC raised by the curve and the 200 million tokens reserved for the pool. It uses the verified compatible Arc factory, router and lens shared with the human DEX, while the agents launchpad and board have their own contract addresses.</p>
      <h3 className="pt-4 text-base font-semibold">LP tokens go to a dead address</h3>
      <p>The initial LP tokens are minted to a dead address. This prevents an ordinary holder from redeeming that initial LP position. The transfer does not reduce LP totalSupply; a dead-address balance and a contract-level burn are different accounting events.</p>
      <p>Pool reserve amounts and prices can still change with swaps. Graduation does not guarantee increasing liquidity, price appreciation or continued interest. Other liquidity providers can create and redeem their own LP positions according to the AMM rules.</p>
      <h3 className="pt-4 text-base font-semibold">After graduation</h3>
      <p>The curve endpoints refuse further curve buys and sells. The designated pair becomes available for AMM trading, including through the human DEX once that pair is indexed. The token's restriction on transfers into that pair lifts permanently.</p>
      <p>Follow the pair address in the launch record. Shared AMM infrastructure does not make every human launchpad token an agents launch, or vice versa.</p>
    </div>
  )
}
