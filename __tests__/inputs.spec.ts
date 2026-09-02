import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InputError, loadInputs } from '../src/inputs.js'

let workspace: string

const INPUTS = ['PATH', 'WORKSPACE', 'BACKEND_CONFIG', 'BACKEND_CONFIG_FILE'].map(
  (name) => `INPUT_${name}`
)

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'validate-ws-'))
  process.env.GITHUB_WORKSPACE = workspace
  for (const name of INPUTS) delete process.env[name]
})

afterEach(() => {
  delete process.env.GITHUB_WORKSPACE
  for (const name of INPUTS) delete process.env[name]
})

describe('defaults', () => {
  it('matches the documented defaults', () => {
    const inputs = loadInputs()
    expect(inputs.path).toBe(workspace)
    expect(inputs.workspace).toBe('default')
    expect(inputs.backendConfig).toBeUndefined()
    expect(inputs.backendConfigFile).toBeUndefined()
  })
})

describe('resolving path', () => {
  it('resolves a subdirectory', () => {
    mkdirSync(join(workspace, 'infra'))
    process.env.INPUT_PATH = 'infra'
    expect(loadInputs().path).toBe(join(workspace, 'infra'))
  })

  it('rejects a path that does not exist', () => {
    process.env.INPUT_PATH = 'absent'
    expect(() => loadInputs()).toThrow(/Path does not exist: "absent"/)
  })

  it('rejects a file', () => {
    writeFileSync(join(workspace, 'main.tf'), '')
    process.env.INPUT_PATH = 'main.tf'
    expect(() => loadInputs()).toThrow(/is not a directory/)
  })
})

/**
 * path arrives from workflow input, so it must not be able to reach outside the
 * checkout even though the caller is usually trusted.
 */
describe('confining path to the workspace', () => {
  it.each([
    ['a parent traversal', '../elsewhere'],
    ['a nested traversal', 'infra/../../elsewhere'],
    ['an absolute path', '/etc'],
  ])('rejects %s', (_label, value) => {
    process.env.INPUT_PATH = value
    expect(() => loadInputs()).toThrow(InputError)
    expect(() => loadInputs()).toThrow(/stay inside the workspace/)
  })
})

/**
 * Validation evaluates `terraform.workspace`, so a configuration that branches
 * on it validates differently per workspace. An empty value would leave that
 * expression evaluating to nothing.
 */
describe('workspace', () => {
  it('takes the given name', () => {
    process.env.INPUT_WORKSPACE = 'staging'
    expect(loadInputs().workspace).toBe('staging')
  })

  it('falls back to default when blank', () => {
    process.env.INPUT_WORKSPACE = '   '
    expect(loadInputs().workspace).toBe('default')
  })
})

describe('the version discovery inputs', () => {
  it('keeps newlines in backend_config', () => {
    process.env.INPUT_BACKEND_CONFIG = 'bucket=state\nkey=terraform.tfstate'
    expect(loadInputs().backendConfig).toBe('bucket=state\nkey=terraform.tfstate')
  })

  it.each([
    ['backend_config', 'INPUT_BACKEND_CONFIG', 'backendConfig'],
    ['backend_config_file', 'INPUT_BACKEND_CONFIG_FILE', 'backendConfigFile'],
  ])('treats a blank %s as absent', (_label, variable, field) => {
    process.env[variable] = '  \n  '
    expect(loadInputs()[field as 'backendConfig']).toBeUndefined()
  })
})
