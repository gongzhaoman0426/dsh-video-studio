import { parse } from 'yaml'
import { z } from 'zod'

const metadataSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1),
})

/** Metadata is the sole source of registration names; DSH receives instructions without frontmatter. */
export function parseBundledSkill(raw: string): { name: string; description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!frontmatter) throw new Error('Bundled skill must start with YAML frontmatter')
  const metadata = metadataSchema.parse(parse(frontmatter[1]!))
  const content = raw.slice(frontmatter[0].length).trim()
  if (!content) throw new Error(`Bundled skill ${metadata.name} has no instructions`)
  return { ...metadata, content }
}
