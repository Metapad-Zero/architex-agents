import { http, createConfig } from 'wagmi'
import { arc, arcTestnet } from 'viem/chains'
import { activeChain, arcNetwork } from './chain'

// Development only. `import.meta.env.DEV` is a compile-time constant, so in a production build this
// whole branch is dead code and never reaches the bundle.
if (import.meta.env.DEV) {
  void import('./tracing').then((tracing) => tracing.registerChain(activeChain.id, activeChain.rpc))
}

// Read-only: this app has no wallet-connect UI, only public reads. No connectors are configured.
export const config =
  arcNetwork === 'mainnet'
    ? createConfig({
        chains: [arc],
        connectors: [],
        transports: { [arc.id]: http(activeChain.rpc) },
      })
    : createConfig({
        chains: [arcTestnet],
        connectors: [],
        transports: { [arcTestnet.id]: http(activeChain.rpc) },
      })

export const ARC_CHAIN_ID = activeChain.id
