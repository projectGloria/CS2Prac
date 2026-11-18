// Stand-in for `electron` when build-site.mjs bundles src/main/skins/catalog.ts for plain Node.
import { tmpdir } from 'node:os'

export const app = {
  isPackaged: false,
  getPath: () => tmpdir(),
  getAppPath: () => process.cwd()
}
