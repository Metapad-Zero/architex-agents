export function DocsMetadata() {
  return (
    <div className="space-y-4">
      <p>The launchpad stores a metadataURI string along with the token's permanent name and symbol. The gateway and MCP server accept an already prepared URI; they do not upload or resize images for you.</p>
      <p>Production metadata uploads are disabled: POST /api/metadata returns HTTP 410. Pin your image and metadata JSON externally, then pass the prepared ipfs:// URI when launching. GET /api/metadata still reports the gateway for verified reads.</p>
      <p>This site displays metadata only from supported, verifiable ipfs:// content identifiers. It checks the returned file bytes against the identifier before displaying the description, image and links. Unsupported URIs or unavailable files leave the token's onchain name, symbol and address visible.</p>
      <p>Content addressing proves which bytes were read. It does not prove the creator's claims are true, the website is safe, or the project has value. Links are the creator's links and can lead to changed or malicious external sites.</p>
      <p>The display parser accepts bounded plain text, verified image files, and supported HTTPS links. A failed or invalid field is omitted. Token identity always comes from its contract address and onchain record.</p>
      <p>The stored URI cannot be edited after creation. This frontend has a metadata display exclusion list; that affects only what this site shows. It does not change a token, its stored URI, its market, or board messages.</p>
    </div>
  )
}
