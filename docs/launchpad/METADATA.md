# Token details (metadata)

The launchpad stores **one string** per token, at most 256 bytes, fixed at creation. That string is
`ipfs://<cid>`: the address of a small JSON file. The file names the token's image the same way.

Agents prepare and pin their own JSON and image, then pass the URI to the launch gateway or MCP
server. Production POST /api/metadata is retired and returns 410 regardless of credentials, Origin,
client headers or body. GET retains validated gateway discovery and display limits with enabled:false.
The read-only site has no upload form.

```
on-chain   ipfs://bafkrei…            (66 bytes)
             └─ JSON file              name, symbol, description, image, external_link, twitter, telegram
                  └─ ipfs://bafkrei…   the image, at most 256 KB
```

## Why it can be trusted

An IPFS address is a fingerprint of the content. Both files are kept to one IPFS block (256 KiB), and
the address of a one-block file is just a framed SHA-256 of its bytes (`src/lib/cid.ts`). So:

- **Nobody can swap it after launch.** Not the creator, not the pinning service, not a gateway, not us.
  The app hashes whatever a gateway returns and compares it with the address before using it. Pinata's
  own gateways have a "hot swap" feature that maps one address to other content; the check defeats it.
- **Gateway responses are checked.** The browser verifies the returned bytes against the expected
  content identifier before displaying them (`src/lib/ipfs.ts`).
- **Historical files can use our own domain.** `GET /api/ipfs/<cid>` (`server/ipfsProxy.ts`) serves
  only existing files carrying the account's Architex labels, verifies them, and uses immutable
  caching. Upload retirement does not delete those pins or disable the reader. Externally pinned
  files can use configured and public gateway fallbacks; visitors can therefore contact those
  gateways. This is not a general own-domain IPFS proxy.
- **Creators cannot track visitors.** Nothing is ever loaded from a host a creator chose. Images are
  fetched from gateways we pick, verified, and shown as `blob:` URLs. The earlier design loaded any
  `https` image URL, which let one creator log the IP of every visitor to the launch list.
- **Addresses the app cannot verify are ignored.** Older `Qm…` addresses, chunked files (`bafybei…`),
  paths and gateway links are not displayed. The token still shows its stamp, name and symbol, which
  always come from the chain, never from the file.

## The file

Written in one fixed key order with no spare whitespace, so the same details always give the same
bytes and the same address. Field names follow ERC-7572 plus the `twitter` / `telegram` keys other
launchpad tooling uses; `website` is accepted as an alias when reading.

| Field | Rule |
| --- | --- |
| `name`, `symbol` | Informational. The app shows the on-chain values |
| `description` | Plain text, 280 characters, no control characters |
| `image` | `ipfs://` + a one-block address. PNG, JPEG, WebP or GIF by its byte signature; SVG refused |
| `external_link` | A plain `https` link: no credentials, no port. Shown as its real host, in punycode |
| `twitter` | Always `https://x.com/<handle>` |
| `telegram` | Always `https://t.me/<name>` |

Everything in a file is a stranger's input. A field that fails its rule is dropped; the rest survives.
Links open with `rel="noopener noreferrer nofollow ugc"`, and the page says the text is the creator's.

The older prepareImage/saveDetails helpers remain local development utilities. The agents gateway
does not resize files or strip metadata; creators prepare supported bounded files before pinning them.

## Set-up (owner)

1. Historical account-scoped readers use PINATA_JWT. Read access is sufficient for the proxy;
   operator orphan deletion needs separate write access. Keep credentials in protected server
   configuration; none enables production uploads.

   ```bash
   vercel env add PINATA_JWT production
   ```

2. IPFS_GATEWAY optionally selects a gateway host for verified reads. Production normalization
   accepts a bare hostname or an HTTPS hostname with trailing slash, not credentials, paths or
   query parameters. Gateway discovery does not require a pinning key:

   ```bash
   vercel env add IPFS_GATEWAY production
   ```

3. GET /api/metadata always reports enabled:false in production and preserves gateway discovery.
   Vite development deliberately retains bounded memory-only uploads for testing, without
   third-party pins. It is not bundled or deployed.

## Pieces

| | |
| --- | --- |
| `src/lib/cid.ts` | One-block addresses: compute, parse, verify. Tested against IPFS's well-known addresses |
| `src/lib/tokenMetadata.ts` | The format: canonical writer, strict reader, link cleaning, image sniffing |
| `src/lib/ipfs.ts` | Verified reads through gateways: size cap, timeout, hash check, fallbacks |
| `src/lib/prepareImage.ts`, `saveDetails.ts` | Older local-development resize/save helpers, not the agents launch workflow |
| `server/metadataService.ts` | Status and bounded memory-development upload parser; its rate map is instance-local |
| `server/pinata.ts` | Historical account lookup and operator cleanup provider; production POST does not import it |
| `server/ipfsProxy.ts`, `api/ipfs/[cid].ts` | Our own verified, immutable file server; see above |
| `api/metadata.ts` | Production upload denial and gateway discovery; native Node imports carry `.js` extensions |
| `server/devMetadata.ts` | `vite dev` only: an in-memory pinning service and `/ipfs/` gateway, so the whole flow runs locally with no key |
| `scripts/metadata-cleanup.ts` | Lists pinned files no token points to; unpins them only with `--delete` |

## Abuse

An unpaid upload can incur storage costs without a launch. An optional Origin header and an
instance-local rate map do not bind uploads to the launch fee or create a global quota limit.
Production denies the writer at the public API boundary; local development uses memory only.

The cleanup script can report older historical orphan pins and optionally delete them with --delete.
It is an operator tool, not an automatic expiration service. Reviewed onchain references and account
quota monitoring remain relevant to existing storage. Moderation affects frontend display, not the
permissionless token or its stored URI.

## Historical testnet record

This older record does not establish agents mainnet deployment or current upload availability.

Token `0xd13a5676Acf317CDC2f8773982636Bc2653aEBE2` on Arc Testnet stores `ipfs://bafkreihn7n5m36k76bvaa6p2xs5zv4qcjvjtf2ngxlmtma27fklpnewu44`.
Its page on architex.fun fetched the details file and the image from our own domain only, verified both,
and rendered the image, the description, the links and the creator note.

One oddity: Pinata answered `400 File size must be greater than 0` to an 80-byte hand-built PNG, while
accepting a 52-byte JSON file and every image produced by a real encoder. Browsers always re-encode, so
users cannot hit it.

## Not done

- Details cannot be edited after launch. That is deliberate; it is what makes them trustworthy.
- The token contract does not expose its own `contractURI()` (ERC-7572). Adding it would let explorers
  describe a token without knowing the launchpad, but it touches reviewed code and needs a redeploy.
- A `tokenlist.json` of graduated tokens, which is where wallets read logos from.
