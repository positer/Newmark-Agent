type JsonSchema = Record<string, unknown>;

interface TypeBoxValidationError {
  keyword?: string;
  instancePath?: string;
  params?: Record<string, unknown>;
  message?: string;
}

interface TypeBoxValidator {
  Check(value: unknown): boolean;
  Errors(value: unknown): TypeBoxValidationError[];
}

type RegisteredSchema = {
  schema: JsonSchema;
  signature: string;
  validator?: TypeBoxValidator;
};

// TypeBox 1.x publishes `typebox/compile` as ESM-only. The desktop build emits
// a small CJS bundle so Electron 33's embedded Node 20 can load the compiler
// synchronously without failing the entire main-process import graph with
// ERR_REQUIRE_ESM. Keeping this dependency synchronous also lets registration
// reject malformed schemas before a tool is advertised or executed.
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const typeBoxCompilerPath = [
  path.join(__dirname, '..', 'typebox-compile.bundle.cjs'),
  path.join(__dirname, 'typebox-compile.bundle.cjs'),
].find(candidate => fs.existsSync(candidate));
if (!typeBoxCompilerPath) throw new Error('Bundled TypeBox compiler is missing from the Newmark runtime.');
const { Compile } = require(typeBoxCompilerPath) as {
  Compile(schema: JsonSchema): TypeBoxValidator;
};

/**
 * Close tool-argument object schemas while preserving intentionally free-form
 * object values (for example raw CDP params, which declare no properties).
 */
export function closeToolArgumentSchema(input: unknown): JsonSchema {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as JsonSchema;
  const schema: JsonSchema = { ...source };

  if (source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    schema.properties = Object.fromEntries(
      Object.entries(source.properties as Record<string, unknown>)
        .map(([name, value]) => [name, closeSchemaNode(value)]),
    );
    if (schema.additionalProperties === undefined) schema.additionalProperties = false;
  }
  if (source.items !== undefined) schema.items = closeSchemaNode(source.items);
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(source[key])) schema[key] = source[key].map(closeSchemaNode);
  }
  if (source.not !== undefined) schema.not = closeSchemaNode(source.not);
  return schema;
}

function closeSchemaNode(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(closeSchemaNode);
  if (!input || typeof input !== 'object') return input;
  const source = input as JsonSchema;
  const schema: JsonSchema = { ...source };
  if (source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    schema.properties = Object.fromEntries(
      Object.entries(source.properties as Record<string, unknown>)
        .map(([name, value]) => [name, closeSchemaNode(value)]),
    );
    if (schema.additionalProperties === undefined) schema.additionalProperties = false;
  }
  if (source.items !== undefined) schema.items = closeSchemaNode(source.items);
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(source[key])) schema[key] = source[key].map(closeSchemaNode);
  }
  if (source.not !== undefined) schema.not = closeSchemaNode(source.not);
  return schema;
}

export type ToolArgumentValidation =
  | { ok: true }
  | { ok: false; error: string };

/** Registers and compiles each distinct schema once so malformed tool
 * contracts are rejected before any model-authored call can execute. */
export class ToolArgumentValidatorRegistry {
  private readonly registered = new Map<string, RegisteredSchema>();

  register(name: string, inputSchema: unknown): JsonSchema {
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      throw new Error(`Invalid tool schema for ${name || '(missing tool name)'}: expected an object schema.`);
    }
    const schema = closeToolArgumentSchema(inputSchema);
    const signature = JSON.stringify(schema);
    const active = this.registered.get(name);
    if (!active || active.signature !== signature) {
      try {
        this.registered.set(name, { schema, signature, validator: Compile(schema) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid tool schema for ${name || '(missing tool name)'}: ${message}`);
      }
    }
    return schema;
  }

  validate(name: string, inputSchema: unknown, value: unknown): ToolArgumentValidation {
    const schema = this.register(name, inputSchema);
    const entry = this.registered.get(name)!;
    try {
      entry.validator ||= Compile(schema);
      if (entry.validator.Check(value)) return { ok: true };
      return { ok: false, error: formatValidationErrors(name, entry.validator.Errors(value)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Invalid arguments for ${name}: schema validation failed (${message}).` };
    }
  }
}

function formatValidationErrors(name: string, errors: TypeBoxValidationError[]): string {
  const details = errors.slice(0, 5).map(error => {
    const path = String(error.instancePath || '').replace(/^\//, '').replaceAll('/', '.');
    if (error.keyword === 'required') {
      const required = String(error.params?.requiredProperty || error.params?.required || path || 'property');
      return `${required} is required`;
    }
    if (error.keyword === 'additionalProperties') {
      const values = error.params?.additionalProperties;
      const fields = Array.isArray(values) ? values.map(String).join(', ') : String(values || path || 'unknown');
      return `additional field(s) not allowed: ${fields}`;
    }
    const location = path || 'arguments';
    const message = String(error.message || error.keyword || 'is invalid');
    return `${location} ${message}`;
  });
  return `Invalid arguments for ${name}: ${details.join('; ') || 'schema mismatch'}.`;
}
