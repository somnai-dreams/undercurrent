import { stat } from 'node:fs/promises'
import type { Provider, Result } from './data.ts'
import { installIntegration, nativeHomes } from './install.ts'
import type { Installation, InstallScope } from './install.ts'
import { findProject, initializePolicy } from './project.ts'
import { errorText } from './validation.ts'

export type SetupOptions = { global: boolean; hosts: 'auto' | 'codex' | 'claude' | 'both' }
export async function setup(home: string, cwd: string, options: SetupOptions, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Result<{ config: string; installations: Installation[] }>> {
  const homes = nativeHomes(env)
  if (!homes.ok) return homes
  const providers: Provider[] = []
  switch (options.hosts) {
    case 'codex': providers.push('codex'); break
    case 'claude': providers.push('claude'); break
    case 'both': providers.push('codex', 'claude'); break
    case 'auto':
      for (const provider of ['codex', 'claude'] as const) {
        if (Bun.which(provider, { PATH: env['PATH'] ?? '' }) !== null) { providers.push(provider); continue }
        try { if ((await stat(homes.value[provider])).isDirectory()) providers.push(provider) }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return { ok: false, error: { kind: 'io', message: `Cannot inspect ${provider} installation: ${errorText(error)}` } }
        }
      }
  }
  if (providers.length === 0) return { ok: false, error: { kind: 'invalid-input', message: 'No Codex or Claude installation found. Install a native host first, or select --host codex|claude|both explicitly.' } }
  let scope: InstallScope
  if (options.global) scope = { kind: 'global', homes: homes.value }
  else {
    const project = await findProject(home, cwd)
    if (!project.ok) return project
    scope = { kind: 'project', root: project.value.root }
  }
  const initialized = await initializePolicy(home, cwd, options.global, { join: 'auto', allow: [{ kind: 'self' }] })
  if (!initialized.ok) return initialized
  const installations: Installation[] = []
  for (const provider of providers) {
    const installed = await installIntegration(home, scope, provider)
    if (!installed.ok) return { ok: false, error: { ...installed.error, message: `${provider} setup failed: ${installed.error.message} Configuration and earlier completed installations were kept; rerun setup after resolving the error.` } }
    installations.push(installed.value)
  }
  return { ok: true, value: { config: initialized.value, installations } }
}
