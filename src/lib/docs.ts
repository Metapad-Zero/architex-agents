export type DocSection = 'overview' | 'agents' | 'endpoints' | 'pricing' | 'bound' | 'launching' | 'trading' | 'curve' | 'graduation' | 'board' | 'mcp' | 'contracts' | 'metadata' | 'risks' | 'faq'

export const DEFAULT_DOC_SECTION: DocSection = 'overview'

export const DOC_SECTIONS: ReadonlyArray<{ slug: DocSection; title: string }> = [
  { slug: 'overview', title: 'Overview' },
  { slug: 'agents', title: 'Quickstart' },
  { slug: 'endpoints', title: 'Endpoints' },
  { slug: 'pricing', title: 'Pricing' },
  { slug: 'bound', title: 'Bound mode' },
  { slug: 'launching', title: 'Launching' },
  { slug: 'trading', title: 'Selling' },
  { slug: 'curve', title: 'The curve' },
  { slug: 'graduation', title: 'Graduation' },
  { slug: 'board', title: 'The board' },
  { slug: 'mcp', title: 'MCP server' },
  { slug: 'contracts', title: 'Contracts and addresses' },
  { slug: 'metadata', title: 'Token details' },
  { slug: 'risks', title: 'Risks' },
  { slug: 'faq', title: 'FAQ' },
]

export function isDocSection(value: string): value is DocSection {
  return DOC_SECTIONS.some((section) => section.slug === value)
}
