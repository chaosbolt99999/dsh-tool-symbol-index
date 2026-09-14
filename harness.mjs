/**
 * Test harness for `symbol-index.mjs`.
 *
 * Three jobs, in the order the plan asks for them:
 *  1. a mock `ctx.fs` that mirrors the real service's contract (resolve / stat /
 *     listDir / readText / processPath, `type` not `kind`),
 *  2. the HOST'S OWN JSON-Schema subset checker and value validator — imported
 *     from the harness checkout rather than re-implemented, so a schema the
 *     running registry would reject cannot pass here,
 *  3. the fixture replay against the real vendored checkout — the decisive test.
 *
 * Job 2 used to be a local re-implementation. It checked *values* against a
 * schema and never checked the *schema* against the enforced subset, so it
 * passed `status: { enum: [...] }` — a node with no `type` — which the real
 * registry rejects at mount. A fresh preset session found that in one call
 * (§4.4); no amount of byte-identical deployment validation could. The real
 * checker is importable from source: Node strips the types itself
 * (`node --experimental-strip-types`, the default on this Node), and the module
 * imports only `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-session`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The harness checkout whose `@deepseek-ai/dsh-tools` is the authority on the subset. */
export const HARNESS_CHECKOUT = process.env.DSH_CHECKOUT ?? '/home/chaosbolt/deepseek-harness'

const jsonSchemaModule = await import(
  pathToFileURL(join(HARNESS_CHECKOUT, 'packages/core/tools/src/json-schema.ts')).href
)

/** The registry's own assertion, unwrapped: throws when the schema is outside the subset. */
export function assertSupportedJsonSchema(schema) {
  return jsonSchemaModule.assertSupportedJsonSchema(schema)
}

/**
 * The registry's own value validation, with the harness's original argument
 * order (schema, value) — a thin wrapper, not a re-implementation.
 * @returns array of violation strings (empty means valid).
 */
export function validateSubset(schema, value, path = 'value') {
  return jsonSchemaModule.validateJsonSchemaValue(schema, value, path)
}

/** Build an FsTarget-shaped object for a real path. */
function target(path) {
  const canonical = resolvePath(path)
  return { targetKey: canonical, path: canonical }
}

/** A `ctx.fs` equivalent backed by the real filesystem, matching the host contract. */
export const realFs = {
  async resolve(path, opts = {}) {
    const base = opts.cwd === undefined ? process.cwd() : opts.cwd
    const joined = path.startsWith('/') ? path : join(base, path)
    return target(joined)
  },
  processPath(t) {
    return t.path
  },
  async stat(t) {
    try {
      const info = statSync(t.path)
      return {
        version: String(info.mtimeMs),
        type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        size: info.isFile() ? info.size : undefined,
      }
    } catch {
      return undefined
    }
  },
  async listDir(t) {
    return readdirSync(t.path, { withFileTypes: true })
      .map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: target(join(t.path, entry.name)),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  },
  async readText(t) {
    return readFileSync(t.path, 'utf8')
  },
}

/**
 * Structural validation of a SCHEMA against the enforced subset — the missing
 * check that let a bare `enum` reach a real mount. Mirrors
 * `assertSupportedJsonSchema`: every schema node must declare exactly one of
 * `type`/`oneOf` when it carries properties/required/additionalProperties/
 * items/enum/const, required names must be declared properties, supported
 * keywords only, and annotations must have the right types.
 * @returns array of violation strings (empty means the schema is legal).
 */
export function validateSchemaSubset(node, path = 'schema') {
  const problems = []
  const SUPPORTED = [
    'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
    'description', 'title', 'default', 'examples',
  ]
  const SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    problems.push(`${path} must be a schema object`)
    return problems
  }
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.includes(key)) problems.push(`${path}.${key} is not a supported keyword`)
  }
  for (const key of ['description', 'title']) {
    if (Object.hasOwn(node, key) && typeof node[key] !== 'string') problems.push(`${path}.${key} must be a string`)
  }
  if (Object.hasOwn(node, 'examples') && !Array.isArray(node.examples)) {
    problems.push(`${path}.examples must be an array`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    problems.push(`${path} cannot declare both type and oneOf`)
    return problems
  }
  if (!hasType && !hasOneOf) {
    for (const key of SIBLINGS) {
      if (Object.hasOwn(node, key)) problems.push(`${path}.${key} requires type or oneOf`)
    }
    return problems
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      problems.push(`${path}.oneOf must be an array of at least two schemas`)
    } else {
      node.oneOf.forEach((entry, index) => problems.push(...validateSchemaSubset(entry, `${path}.oneOf[${index}]`)))
    }
    return problems
  }
  const SCALARS = ['string', 'number', 'integer', 'boolean', 'null']
  if (!SCALARS.includes(node.type) && node.type !== 'object' && node.type !== 'array') {
    problems.push(`${path}.type ${JSON.stringify(node.type)} is not a supported type`)
    return problems
  }
  if (Object.hasOwn(node, 'enum') && !SCALARS.includes(node.type)) {
    problems.push(`${path}.enum requires a scalar type`)
  }
  if (node.type === 'object') {
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      problems.push(`${path}.additionalProperties must be a boolean`)
    }
    const properties = node.properties ?? {}
    if (Object.hasOwn(node, 'properties') && (typeof properties !== 'object' || Array.isArray(properties))) {
      problems.push(`${path}.properties must be an object`)
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required)) problems.push(`${path}.required must be an array`)
      else {
        for (const name of node.required) {
          if (!Object.hasOwn(properties, name)) problems.push(`${path}.required names undeclared property "${name}"`)
        }
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      problems.push(...validateSchemaSubset(sub, `${path}.properties.${key}`))
    }
  }
  if (node.type === 'array') {
    if (Object.hasOwn(node, 'items')) problems.push(...validateSchemaSubset(node.items, `${path}.items`))
  }
  return problems
}

/** Prove a value survives a JSON round trip unchanged (the registry's losslessness rule). */
export function isLosslessJson(value) {
  try {
    return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value)
  } catch {
    return false
  }
}

/** Assert BOTH registration schemas are inside the enforced subset the registry accepts. */
export function assertRegistrationSchemas(tool) {
  assertSupportedJsonSchema(tool.parameters)
  assertSupportedJsonSchema(tool.output.schema)
}

/** A mock agent scope context that captures registrations. */
export function mockContext(fs = realFs, captured = {}) {
  const disposers = []
  const context = {
    effect(callback, label) {
      const disposer = callback()
      disposers.push({ label, disposer })
      return () => {}
    },
    tools: {
      register(definition) {
        captured.tool = definition
        captured.all = (captured.all ?? []).concat([definition])
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        captured.sections = (captured.sections ?? []).concat([section])
        return () => {}
      },
    },
    fs,
  }
  return { ctx: context, captured, disposers }
}

/** A minimal `exec` for `execute(args, exec)`. */
export function mockExec(cwd) {
  return {
    signal: undefined,
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  }
}

/** Load the plugin with a given config and return its captured tool. */
export async function loadTool(modulePath, config = {}) {
  const module = await import(pathToFileURL(modulePath).href)
  const validated = module.Config['~standard'].validate(config)
  if (validated.issues !== undefined) {
    throw new Error('config rejected: ' + JSON.stringify(validated.issues))
  }
  const { ctx, captured } = mockContext()
  module.apply(ctx, validated.value)
  return { tool: captured.tool, sections: captured.sections, module, capturedAll: captured.all ?? [captured.tool] }
}
