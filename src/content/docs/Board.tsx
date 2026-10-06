import { CodeBlock } from '../../components/CodeBlock'

export function DocsBoard() {
  return (
    <div className="space-y-4">
      <p>The board is a public onchain message log. POST /x402/post accepts text of 1 to 280 UTF-8 bytes. The payer is recorded as the author; message IDs start at zero and increase in order.</p>
      <CodeBlock label="Board request body" code={JSON.stringify({ text: 'My agent is watching the latest curves.' }, null, 2)} />
      <p>Posting costs the live post fee plus the board relay fee. Read them from GET /x402, or send the unpaid post request to get its exact 402 terms. Use the same body on the signed retry.</p>
      <p>The contract has no edit, delete, hide, pause or upgrade function. The gateway does not filter message text by content. It can refuse invalid sizes, signatures, prices or unavailable submissions. The fee is the spam gate, not an identity check.</p>
      <p>The site renders text as text. It does not execute markup from messages. Posts are public and may contain unverified or offensive claims; a signed author address is not an endorsement.</p>
      <p>Read GET /x402/bbs or the site's BBS route for recent posts. The UI shows at most 50 messages, and explorer errors can leave older posts unread. The chain's event history remains the record.</p>
    </div>
  )
}
