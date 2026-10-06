import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { devMetadata } from './server/devMetadata'
import { devGate } from './server/x402/devGate'

// Sirv treats a .gz pathname as HTTP content encoding. This archive is a downloadable file.
function mcpDownload(): Plugin {
  let publicArchive = ''
  let previewArchive = ''
  const mount = (middlewares: Connect.Server, file: string) => {
    middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== '/downloads/architex-agents-mcp.tar.gz') return next()
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' })
        return res.end()
      }
      void (async () => {
        const details = await stat(file)
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': 'attachment; filename="architex-agents-mcp.tar.gz"',
          'Content-Encoding': 'identity',
          'Content-Length': details.size,
          'Cache-Control': 'no-store',
        })
        if (req.method === 'HEAD') return res.end()
        const stream = createReadStream(file)
        res.on('close', () => stream.destroy())
        stream.on('error', next).pipe(res)
      })().catch(next)
    })
  }
  return {
    name: 'architex-mcp-download',
    apply: 'serve',
    configResolved(config) {
      publicArchive = path.resolve(config.publicDir, 'downloads/architex-agents-mcp.tar.gz')
      previewArchive = path.resolve(config.root, config.build.outDir, 'downloads/architex-agents-mcp.tar.gz')
    },
    configureServer(server) { mount(server.middlewares, publicArchive) },
    configurePreviewServer(server) { mount(server.middlewares, previewArchive) },
  }
}

export default defineConfig({
  plugins: [react(), nodePolyfills(), devMetadata(), devGate(), mcpDownload()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'wagmi/chains',
      'wagmi/connectors',
      'viem',
      'viem/chains',
      'connectkit',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  server: {
    allowedHosts: true,
    cors: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('/node_modules/viem/') ||
            id.includes('/node_modules/wagmi/') ||
            id.includes('/node_modules/@wagmi/') ||
            id.includes('/node_modules/@tanstack/')
          ) {
            return 'vendor-web3'
          }
          if (id.includes('/node_modules/@circle-fin/') || id.includes('/node_modules/@solana/')) {
            return 'vendor-cctp'
          }
        },
      },
    },
  },
})
