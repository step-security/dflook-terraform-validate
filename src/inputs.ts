import { existsSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

export class InputError extends Error {}

export interface Inputs {
  /** Module to validate. */
  path: string
  /**
   * Workspace name made visible to the configuration.
   *
   * Validation evaluates `terraform.workspace`, so a configuration that branches
   * on it validates differently per workspace.
   */
  workspace: string
  /** Used only when discovering which version to run. */
  backendConfig?: string
  /** Used only when discovering which version to run. */
  backendConfigFile?: string
  workspaceRoot: string
}

function read(name: string, fallback = ''): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim()
}

/** Reads an input, keeping internal formatting but treating blank as absent. */
function readBlock(name: string): string | undefined {
  const value = process.env[`INPUT_${name.toUpperCase()}`]
  if (value === undefined || !value.trim()) return undefined
  return value
}

export function loadInputs(): Inputs {
  const workspaceRoot = resolve(process.env.GITHUB_WORKSPACE || process.cwd())
  const requested = read('path', '.') || '.'
  const path = resolve(workspaceRoot, requested)

  // The path comes from workflow input and has no business pointing outside the
  // checkout, so confine it rather than trusting the caller.
  const offset = relative(workspaceRoot, path)
  if (offset.startsWith('..') || isAbsolute(offset)) {
    throw new InputError(
      `path must stay inside the workspace, but '${requested}' resolves outside it`
    )
  }

  if (!existsSync(path)) {
    throw new InputError(`Path does not exist: "${requested}"`)
  }
  if (!statSync(path).isDirectory()) {
    throw new InputError(`path '${requested}' is not a directory`)
  }

  return {
    path,
    workspace: read('workspace', 'default') || 'default',
    backendConfig: readBlock('backend_config'),
    backendConfigFile: readBlock('backend_config_file'),
    workspaceRoot,
  }
}
