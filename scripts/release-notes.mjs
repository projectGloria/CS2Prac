// Prints the GitHub release body for a tag: docs/release-notes/<tag>/RELEASE_NOTES.md with its relative image paths
// turned into raw.githubusercontent.com links pinned to the tag (a release body can't load repo-relative images).
// Usage: node scripts/release-notes.mjs v1.2.3 > body.md   (prints nothing when the tag has no notes file)
import { existsSync, readFileSync } from 'node:fs'

const tag = process.argv[2]
if (!tag) throw new Error('usage: node scripts/release-notes.mjs <tag>')
const src = `docs/release-notes/${tag}/RELEASE_NOTES.md`
if (existsSync(src)) {
  const base = `https://raw.githubusercontent.com/projectGloria/CS2Prac/${tag}`
  const body = readFileSync(src, 'utf8')
    .replaceAll('../../../assets/', `${base}/assets/`)
    .replace(/(src="|\]\()([\w-]+\.(?:png|jpg|gif|webp))/g, `$1${base}/docs/release-notes/${tag}/$2`)
  process.stdout.write(body)
}
