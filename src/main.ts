import { mkdirSync, mkdtempSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, relative } from 'path'
import { pathToFileURL } from 'url'
import * as core from '@actions/core'
import {
  acquire,
  candidateVersions,
  formatAnnotation,
  getBackendType,
  getOpenTofuVersions,
  getTerraformVersions,
  initWithoutBackend,
  isRemoteExecution,
  isValid,
  loadModule,
  parseValidateReport,
  resolveVersion,
  runPreRunCommands,
  runTool,
  validateAnnotations,
  writeCredentials,
} from '@core'
import type { TerraformModule } from '@core'
import { InputError, loadInputs } from './inputs.js'
import type { Inputs } from './inputs.js'
import { validateSubscription } from './subscription.js'

const VALIDATE_FAILED = 'validate-failed'

/**
 * Publishes why the step failed.
 *
 * Both spellings are set because the documented contract carries the hyphenated
 * and the underscored name, and consumers depend on either one.
 */
function setFailureReason(reason: string): void {
  core.setOutput('failure-reason', reason)
  core.setOutput('failure_reason', reason)
}

function openTofuRequested(): boolean {
  return process.env.OPENTOFU_VERSION !== undefined || process.env.OPENTOFU === 'true'
}

interface Prepared {
  binary: string
  env: NodeJS.ProcessEnv
  dataDir: string
  backendType: string
  module: TerraformModule
}

/**
 * Installs the tool and prepares the environment.
 *
 * `TF_WORKSPACE` is set rather than selected. Validation evaluates
 * `terraform.workspace` but never initializes a backend, so there is no
 * workspace to select — the name is simply made visible to the configuration.
 * For a remote or cloud backend it is forced to `default`, because the real
 * workspace is decided remotely and pretending otherwise would validate against
 * a name that will not be used.
 */
async function prepare(inputs: Inputs): Promise<Prepared> {
  const tempDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'terraform-validate-'))
  const dataDir = join(tempDir, 'terraform-data-dir')
  const pluginCache = join(homedir(), '.terraform.d', 'plugin-cache')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(pluginCache, { recursive: true })

  writeCredentials({
    cloudTokens: process.env.TERRAFORM_CLOUD_TOKENS,
    httpCredentials: process.env.TERRAFORM_HTTP_CREDENTIALS,
    sshKey: process.env.TERRAFORM_SSH_KEY,
  })

  const openTofu = openTofuRequested()
  const module = loadModule(inputs.path, openTofu)
  const terraform = await getTerraformVersions()
  const tofu = openTofu ? await getOpenTofuVersions(process.env.GITHUB_TOKEN) : undefined

  const resolution = resolveVersion(
    { modulePath: inputs.path, workspaceRoot: inputs.workspaceRoot, openTofu },
    { module, versions: candidateVersions(terraform, tofu), env: process.env }
  )

  if (!resolution) {
    throw new Error('No release matched the version constraints in effect')
  }

  core.info(
    `Using ${resolution.version.product} ${resolution.version} because ${resolution.reason}`
  )
  const binary = await acquire(resolution.version)

  const backendType = getBackendType(module)
  if (backendType) core.info(`Detected ${backendType} backend`)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TF_DATA_DIR: dataDir,
    TF_PLUGIN_CACHE_DIR: pluginCache,
    TF_IN_AUTOMATION: 'true',
    TF_WORKSPACE: isRemoteExecution(backendType) ? 'default' : inputs.workspace,
  }

  await runPreRunCommands(process.env.TERRAFORM_PRE_RUN)

  return { binary, env, dataDir, backendType, module }
}

export async function run(): Promise<number> {
  await validateSubscription()

  let inputs: Inputs
  try {
    inputs = loadInputs()
  } catch (error) {
    if (error instanceof InputError) {
      core.error(error.message)
      return 1
    }
    throw error
  }

  try {
    const prepared = await prepare(inputs)

    // Validation needs providers installed to check attribute names, but has no
    // business reading state. Failure is tolerated on purpose: a configuration
    // broken enough to fail init is exactly what validation should describe, and
    // stopping here would replace useful diagnostics with a generic init error.
    const init = await initWithoutBackend({
      binary: prepared.binary,
      modulePath: inputs.path,
      dataDir: prepared.dataDir,
      env: prepared.env,
    })

    if (init.exitCode !== 0) {
      core.info('Initialization did not complete; validating anyway.')
    }

    const result = await runTool(prepared.binary, ['validate', '-json'], {
      cwd: inputs.path,
      env: prepared.env,
      silent: true,
    })

    // Path the annotations are reported against, relative to the repository.
    const base = relative(inputs.workspaceRoot, inputs.path) || '.'

    let report
    try {
      report = parseValidateReport(result.stdout)
    } catch (error) {
      // No usable report, so fall back to plain validate. Its output is for a
      // human rather than for annotations, but showing nothing would be worse.
      core.debug(error instanceof Error ? error.message : String(error))

      const plain = await runTool(prepared.binary, ['validate'], {
        cwd: inputs.path,
        env: prepared.env,
        silent: false,
      })

      if (plain.stdout.trim()) core.info(plain.stdout.trimEnd())
      if (plain.stderr.trim()) core.error(plain.stderr.trimEnd())

      if (plain.exitCode === 0) {
        core.info('The configuration is valid')
        return 0
      }

      setFailureReason(VALIDATE_FAILED)
      return 1
    }

    for (const annotation of validateAnnotations(report, base)) {
      // Written directly so the position parameters reach the runner intact.
      core.info(formatAnnotation(annotation))
    }

    if (isValid(report)) {
      core.info('Success! The configuration is valid')
      return 0
    }

    setFailureReason(VALIDATE_FAILED)

    const errors = report.error_count ?? 0
    const warnings = report.warning_count ?? 0
    core.error(
      `The configuration is not valid: ${errors} ${errors === 1 ? 'error' : 'errors'}` +
        (warnings > 0 ? `, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : '')
    )
    return 1
  } catch (error) {
    core.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

/**
 * Only self-start when invoked directly, so the module can still be imported by
 * a test. `import.meta.url` is the ESM equivalent of the `require.main` check.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  run()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      core.setFailed(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
