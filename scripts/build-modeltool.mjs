// npm run build:modeltool: publishes tools/ModelExport (framework-dependent, run with the .NET runtime that
// CounterStrikeSharp installs) into resources/modeltool, without debug symbols (libSkiaSharp.pdb alone is ~90 MB).
import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const out = 'resources/modeltool'
rmSync(out, { recursive: true, force: true })
execFileSync('dotnet', ['publish', 'tools/ModelExport', '-c', 'Release', '-o', out, '--nologo'], { stdio: 'inherit' })
for (const f of readdirSync(out)) if (f.endsWith('.pdb') || f.endsWith('.xml')) rmSync(join(out, f))
