import { randomBytes } from 'crypto';

export const VALIDATION_LEVELS = ['discovered', 'basic', 'standard', 'extended'] as const;
export type ValidationLevel = typeof VALIDATION_LEVELS[number];

export const VALIDATION_STATUSES = [
  'verified',
  'degraded',
  'unavailable',
  'auth_error',
  'rate_limited',
  'invalid_config',
] as const;
export type ValidationStatus = typeof VALIDATION_STATUSES[number];

export const MODEL_VALIDATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MODEL_VALIDATION_MAX_CONCURRENCY = 2;

export type ModelCapability = 'text' | 'streaming' | 'strict_json' | 'tools' | 'vision' | 'image_output';

export type ToolValidationErrorCode =
  | 'InvalidJson'
  | 'UnknownName'
  | 'SchemaMismatch'
  | 'PolicyDenied'
  | 'ExecutionFailed'
  | 'PostconditionFailed';

export interface ModelIdentity {
  provider: string;
  model: string;
}

export interface ProbeAttemptOutcome {
  ok: boolean;
  status?: ValidationStatus;
  latencyMs?: number;
  reasonCode?: string;
  permanent?: boolean;
}

export interface ProbeAttemptEvidence {
  attempt: number;
  ok: boolean;
  status: ValidationStatus;
  latencyMs?: number;
  reasonCode?: string;
  permanent: boolean;
}

export interface MajorityProbeResult {
  ok: boolean;
  status: ValidationStatus;
  attempts: number;
  successes: number;
  failures: number;
  permanentFailure: boolean;
  evidence: ProbeAttemptEvidence[];
  reasonCodes: string[];
}

export interface ModelValidationProbeErrorOptions {
  status: Exclude<ValidationStatus, 'verified' | 'degraded'>;
  permanent?: boolean;
  code?: string;
  httpStatus?: number;
}

/**
 * A typed probe failure. Permanent failures short-circuit the normal two/three
 * sample policy so bad credentials and bad configuration cannot create storms.
 */
export class ModelValidationProbeError extends Error {
  readonly status: Exclude<ValidationStatus, 'verified' | 'degraded'>;
  readonly permanent: boolean;
  readonly code: string;
  readonly httpStatus?: number;

  constructor(message: string, options: ModelValidationProbeErrorOptions) {
    super(message);
    this.name = 'ModelValidationProbeError';
    this.status = options.status;
    this.permanent = options.status === 'auth_error' || options.status === 'invalid_config' || options.permanent === true;
    this.code = options.code || options.status;
    this.httpStatus = options.httpStatus;
  }
}

export interface ClassifiedProbeError {
  status: Exclude<ValidationStatus, 'verified' | 'degraded'>;
  permanent: boolean;
  code: string;
  httpStatus?: number;
}

function recordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function numericHttpStatus(error: unknown): number | undefined {
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const raw = recordValue(error, key);
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  const nestedResponse = recordValue(error, 'response');
  const nestedStatus = recordValue(nestedResponse, 'status');
  return typeof nestedStatus === 'number' && Number.isFinite(nestedStatus) ? nestedStatus : undefined;
}

export function classifyProbeError(error: unknown): ClassifiedProbeError {
  if (error instanceof ModelValidationProbeError) {
    return {
      status: error.status,
      permanent: error.permanent,
      code: error.code,
      httpStatus: error.httpStatus,
    };
  }

  const httpStatus = numericHttpStatus(error);
  const message = error instanceof Error ? error.message : String(error || 'unknown probe failure');
  const lower = message.toLowerCase();
  if (httpStatus === 401 || httpStatus === 403 || /invalid api key|authentication|unauthori[sz]ed|forbidden/.test(lower)) {
    return { status: 'auth_error', permanent: true, code: `http_${httpStatus || 'auth'}`, httpStatus };
  }
  if (httpStatus === 429 || /rate.?limit|quota exceeded|too many requests/.test(lower)) {
    return { status: 'rate_limited', permanent: false, code: `http_${httpStatus || 'rate_limit'}`, httpStatus };
  }
  if (
    httpStatus === 400
    || httpStatus === 404
    || httpStatus === 405
    || httpStatus === 410
    || httpStatus === 422
    || /model (?:was )?not found|unknown model|unsupported (?:model|endpoint|parameter)|missing (?:provider|endpoint|configuration)/.test(lower)
  ) {
    return { status: 'invalid_config', permanent: true, code: `http_${httpStatus || 'invalid_config'}`, httpStatus };
  }
  return {
    status: 'unavailable',
    permanent: false,
    code: httpStatus ? `http_${httpStatus}` : 'transient_probe_error',
    httpStatus,
  };
}

function normalizeAttemptOutcome(outcome: ProbeAttemptOutcome): ProbeAttemptEvidence {
  const ok = outcome.ok === true;
  const requestedStatus = outcome.status;
  const status: ValidationStatus = ok
    ? 'verified'
    : requestedStatus && requestedStatus !== 'verified'
      ? requestedStatus
      : 'unavailable';
  return {
    attempt: 0,
    ok,
    status,
    latencyMs: typeof outcome.latencyMs === 'number' && Number.isFinite(outcome.latencyMs)
      ? Math.max(0, outcome.latencyMs)
      : undefined,
    reasonCode: outcome.reasonCode,
    permanent: !ok && (status === 'auth_error' || status === 'invalid_config' || outcome.permanent === true),
  };
}

function failureStatus(evidence: ProbeAttemptEvidence[], successes: number): ValidationStatus {
  if (successes > 0) return 'degraded';
  const statuses = evidence.map(entry => entry.status);
  if (statuses.includes('auth_error')) return 'auth_error';
  if (statuses.includes('invalid_config')) return 'invalid_config';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('rate_limited')) return 'rate_limited';
  return 'unavailable';
}

/** Run two samples; run a third only when the first pair disagrees. */
export async function runMajorityProbe(
  probe: (attempt: number) => Promise<ProbeAttemptOutcome>,
): Promise<MajorityProbeResult> {
  const evidence: ProbeAttemptEvidence[] = [];
  let targetAttempts = 2;

  for (let attempt = 1; attempt <= targetAttempts; attempt += 1) {
    let normalized: ProbeAttemptEvidence;
    try {
      normalized = normalizeAttemptOutcome(await probe(attempt));
    } catch (error) {
      const classified = classifyProbeError(error);
      normalized = {
        attempt,
        ok: false,
        status: classified.status,
        reasonCode: classified.code,
        permanent: classified.permanent,
      };
    }
    normalized.attempt = attempt;
    evidence.push(normalized);

    if (normalized.permanent) {
      return {
        ok: false,
        status: normalized.status,
        attempts: evidence.length,
        successes: evidence.filter(entry => entry.ok).length,
        failures: evidence.filter(entry => !entry.ok).length,
        permanentFailure: true,
        evidence,
        reasonCodes: [...new Set(evidence.map(entry => entry.reasonCode).filter((code): code is string => !!code))],
      };
    }
    if (attempt === 2 && evidence[0].ok !== evidence[1].ok) targetAttempts = 3;
  }

  const successes = evidence.filter(entry => entry.ok).length;
  const failures = evidence.length - successes;
  const ok = evidence.length === 2 ? successes === 2 : successes >= 2;
  return {
    ok,
    status: ok ? 'verified' : failureStatus(evidence, successes),
    attempts: evidence.length,
    successes,
    failures,
    permanentFailure: false,
    evidence,
    reasonCodes: [...new Set(evidence.map(entry => entry.reasonCode).filter((code): code is string => !!code))],
  };
}

/** Map helper whose requested concurrency can never exceed the validation ceiling. */
export async function mapWithValidationConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  requestedConcurrency = MODEL_VALIDATION_MAX_CONCURRENCY,
): Promise<R[]> {
  if (!items.length) return [];
  const concurrency = Math.max(1, Math.min(
    MODEL_VALIDATION_MAX_CONCURRENCY,
    Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : MODEL_VALIDATION_MAX_CONCURRENCY,
    items.length,
  ));
  const results = Array.from<R>({ length: items.length });
  let nextIndex = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface ToolContract {
  validate?: (argumentsValue: unknown) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>;
  policy?: (argumentsValue: unknown) => boolean | { allowed: boolean; reason?: string } | Promise<boolean | { allowed: boolean; reason?: string }>;
  execute: (argumentsValue: unknown) => unknown | Promise<unknown>;
  postcondition?: (result: unknown, argumentsValue: unknown) => boolean | { ok: boolean; reason?: string } | Promise<boolean | { ok: boolean; reason?: string }>;
}

export interface ExecuteValidatedToolCallInput {
  name: string;
  rawArguments: string;
  tools: Readonly<Record<string, ToolContract>>;
}

export interface ToolValidationFailure {
  ok: false;
  error: {
    code: ToolValidationErrorCode;
    message: string;
  };
}

export interface ToolValidationSuccess {
  ok: true;
  name: string;
  arguments: unknown;
  result: unknown;
}

export type ToolValidationResult = ToolValidationFailure | ToolValidationSuccess;

function validationDecisionPassed(decision: boolean | { ok: boolean } | undefined): boolean {
  if (typeof decision === 'boolean') return decision;
  return decision?.ok === true;
}

function policyDecisionPassed(decision: boolean | { allowed: boolean } | undefined): boolean {
  if (typeof decision === 'boolean') return decision;
  return decision?.allowed === true;
}

function toolFailure(code: ToolValidationErrorCode, message: string): ToolValidationFailure {
  return { ok: false, error: { code, message } };
}

/** Validate parse/name/schema/policy, execute, then validate the postcondition. */
export async function executeValidatedToolCall(input: ExecuteValidatedToolCallInput): Promise<ToolValidationResult> {
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(input.rawArguments);
  } catch {
    return toolFailure('InvalidJson', 'Tool arguments are not valid JSON.');
  }

  if (!Object.prototype.hasOwnProperty.call(input.tools, input.name)) {
    return toolFailure('UnknownName', 'Tool name is not present in the allowed registry.');
  }
  const contract = input.tools[input.name];
  if (contract.validate) {
    try {
      if (!validationDecisionPassed(await contract.validate(argumentsValue))) {
        return toolFailure('SchemaMismatch', 'Tool arguments do not match the registered schema.');
      }
    } catch {
      return toolFailure('SchemaMismatch', 'Tool schema validation failed.');
    }
  }
  if (contract.policy) {
    try {
      if (!policyDecisionPassed(await contract.policy(argumentsValue))) {
        return toolFailure('PolicyDenied', 'Tool policy denied the invocation.');
      }
    } catch {
      return toolFailure('PolicyDenied', 'Tool policy evaluation failed closed.');
    }
  }

  let result: unknown;
  try {
    result = await contract.execute(argumentsValue);
  } catch {
    return toolFailure('ExecutionFailed', 'Tool execution failed.');
  }
  if (contract.postcondition) {
    try {
      if (!validationDecisionPassed(await contract.postcondition(result, argumentsValue))) {
        return toolFailure('PostconditionFailed', 'Tool result failed its postcondition.');
      }
    } catch {
      return toolFailure('PostconditionFailed', 'Tool postcondition evaluation failed.');
    }
  }
  return { ok: true, name: input.name, arguments: argumentsValue, result };
}

export type ImageValidationError =
  | 'EmptyBytes'
  | 'TooLarge'
  | 'UnsupportedMime'
  | 'MimeMismatch'
  | 'MalformedImage'
  | 'InvalidDimensions';

export interface ImageOutputObservation {
  bytes: Uint8Array;
  mimeType: string;
  latencyMs?: number;
}

export interface ImageValidationConstraints {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  allowedMimeTypes?: readonly string[];
}

export interface ImageValidationResult {
  ok: boolean;
  detectedMimeType?: string;
  width?: number;
  height?: number;
  byteLength: number;
  error?: ImageValidationError;
}

interface ParsedImage {
  mimeType: string;
  width: number;
  height: number;
}

function bytesStartWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index]);
  return text;
}

function hintedImageMime(bytes: Uint8Array): string | undefined {
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || (bytes.length > 0 && bytes[0] === 0x89)) return 'image/png';
  if (bytesStartWith(bytes, [0xff, 0xd8])) return 'image/jpeg';
  if (bytesStartWith(bytes, [0x47, 0x49, 0x46])) return 'image/gif';
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'RIFF') return 'image/webp';
  return undefined;
}

function parsePng(bytes: Uint8Array): ParsedImage | undefined {
  if (!bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    if (length < 0 || offset + 12 + length > bytes.length) return undefined;
    const type = ascii(bytes, offset + 4, 4);
    const dataOffset = offset + 8;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return undefined;
      width = readUint32BE(bytes, dataOffset);
      height = readUint32BE(bytes, dataOffset + 4);
      sawHeader = true;
    } else if (type === 'IHDR') {
      return undefined;
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0) return undefined;
      sawEnd = true;
      offset += 12;
      break;
    }
    offset += 12 + length;
  }
  if (!sawHeader || !sawData || !sawEnd || offset > bytes.length || width <= 0 || height <= 0) return undefined;
  return { mimeType: 'image/png', width, height };
}

function parseJpeg(bytes: Uint8Array): ParsedImage | undefined {
  if (!bytesStartWith(bytes, [0xff, 0xd8]) || bytes.length < 4 || !bytesStartWith(bytes.slice(-2), [0xff, 0xd9])) return undefined;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (startOfFrame.has(marker)) {
      if (length < 7) return undefined;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width <= 0 || height <= 0) return undefined;
      return { mimeType: 'image/jpeg', width, height };
    }
    offset += length;
  }
  return undefined;
}

function parseGif(bytes: Uint8Array): ParsedImage | undefined {
  if (bytes.length < 14 || (ascii(bytes, 0, 6) !== 'GIF87a' && ascii(bytes, 0, 6) !== 'GIF89a')) return undefined;
  if (bytes[bytes.length - 1] !== 0x3b) return undefined;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (width <= 0 || height <= 0) return undefined;
  return { mimeType: 'image/gif', width, height };
}

function parseWebp(bytes: Uint8Array): ParsedImage | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      mimeType: 'image/webp',
      width: 1 + readUint24LE(bytes, 24),
      height: 1 + readUint24LE(bytes, 27),
    };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21]) | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return {
      mimeType: 'image/webp',
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >>> 14) & 0x3fff),
    };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    if (width > 0 && height > 0) return { mimeType: 'image/webp', width, height };
  }
  return undefined;
}

function parseImage(bytes: Uint8Array, hintedMimeType: string): ParsedImage | undefined {
  if (hintedMimeType === 'image/png') return parsePng(bytes);
  if (hintedMimeType === 'image/jpeg') return parseJpeg(bytes);
  if (hintedMimeType === 'image/gif') return parseGif(bytes);
  if (hintedMimeType === 'image/webp') return parseWebp(bytes);
  return undefined;
}

export function validateImageOutput(
  observation: Pick<ImageOutputObservation, 'bytes' | 'mimeType'>,
  constraints: ImageValidationConstraints = {},
): ImageValidationResult {
  const bytes = observation.bytes;
  const byteLength = bytes?.byteLength || 0;
  if (!(bytes instanceof Uint8Array) || byteLength === 0) return { ok: false, byteLength, error: 'EmptyBytes' };
  const maxBytes = constraints.maxBytes ?? 50 * 1024 * 1024;
  if (byteLength > maxBytes) return { ok: false, byteLength, error: 'TooLarge' };

  const hintedMimeType = hintedImageMime(bytes);
  if (!hintedMimeType) return { ok: false, byteLength, error: 'UnsupportedMime' };
  const declaredMimeType = String(observation.mimeType || '').trim().toLowerCase();
  if (declaredMimeType !== hintedMimeType) {
    return { ok: false, byteLength, detectedMimeType: hintedMimeType, error: 'MimeMismatch' };
  }
  const allowedMimeTypes = constraints.allowedMimeTypes?.map(value => value.toLowerCase());
  if (allowedMimeTypes?.length && !allowedMimeTypes.includes(hintedMimeType)) {
    return { ok: false, byteLength, detectedMimeType: hintedMimeType, error: 'UnsupportedMime' };
  }
  const parsed = parseImage(bytes, hintedMimeType);
  if (!parsed) return { ok: false, byteLength, detectedMimeType: hintedMimeType, error: 'MalformedImage' };

  const minWidth = constraints.minWidth ?? 1;
  const minHeight = constraints.minHeight ?? 1;
  const maxWidth = constraints.maxWidth ?? 16_384;
  const maxHeight = constraints.maxHeight ?? 16_384;
  if (parsed.width < minWidth || parsed.height < minHeight || parsed.width > maxWidth || parsed.height > maxHeight) {
    return { ...parsed, ok: false, byteLength, detectedMimeType: parsed.mimeType, error: 'InvalidDimensions' };
  }
  return {
    ok: true,
    byteLength,
    detectedMimeType: parsed.mimeType,
    width: parsed.width,
    height: parsed.height,
  };
}

export interface HealthProbeObservation extends ProbeAttemptOutcome {}

export interface TextNonceProbeRequest {
  nonce: string;
  instruction: string;
}

export interface TextNonceProbeObservation {
  output: string;
  latencyMs?: number;
}

export interface StreamNonceProbeObservation {
  chunks: readonly string[];
  completed: boolean;
  completionEvent?: 'openai_done' | 'openai_response_completed' | 'anthropic_message_stop' | 'provider_completed';
  latencyMs?: number;
}

export interface StrictJsonProbeRequest {
  nonce: string;
  instruction: string;
  schema: Readonly<Record<string, unknown>>;
}

export interface StrictJsonProbeObservation {
  raw: string;
  latencyMs?: number;
}

export type ToolProbeKind = 'correct_tool' | 'unknown_tool_exclusion' | 'schema' | 'tool_result';

export interface ToolProbeScenario {
  kind: ToolProbeKind;
  nonce: string;
  instruction: string;
  knownToolName: string;
  unknownToolName: string;
  allowedTools: readonly [{
    name: string;
    description: string;
    inputSchema: Readonly<Record<string, unknown>>;
  }];
  simulatedToolResult?: Readonly<Record<string, unknown>>;
}

export interface ToolProbeObservation {
  selectedToolName?: string;
  rawArguments?: string;
  unknownToolAttempted?: boolean;
  toolResultAccepted?: boolean;
  finalText?: string;
  errorCode?: ToolValidationErrorCode;
  latencyMs?: number;
}

export interface VisionChallenge {
  bytes: Uint8Array;
  mimeType: string;
  expectedAnswer: string;
  instruction?: string;
}

export interface VisionProbeObservation {
  answer: string;
  latencyMs?: number;
}

export interface ImageOutputProbeRequest {
  nonce: string;
  instruction: string;
}

export interface ModelValidationProbeAdapter {
  health?: () => Promise<HealthProbeObservation>;
  textNonce?: (request: TextNonceProbeRequest) => Promise<TextNonceProbeObservation>;
  streamNonce?: (request: TextNonceProbeRequest) => Promise<StreamNonceProbeObservation>;
  strictJson?: (request: StrictJsonProbeRequest) => Promise<StrictJsonProbeObservation>;
  tool?: (scenario: ToolProbeScenario) => Promise<ToolProbeObservation>;
  vision?: (challenge: VisionChallenge) => Promise<VisionProbeObservation>;
  imageOutput?: (request: ImageOutputProbeRequest) => Promise<ImageOutputObservation>;
}

export interface CapabilityProbeEvidence {
  probe: string;
  status: ValidationStatus;
  attempts: number;
  successes: number;
  failures: number;
  reasonCodes: string[];
}

export interface CapabilityValidationRecord {
  capability: ModelCapability;
  status: ValidationStatus;
  checkedAt: string;
  expiresAt: string;
  evidence: CapabilityProbeEvidence[];
}

export interface ModelHealthRecord {
  status: ValidationStatus;
  checkedAt: string;
  expiresAt: string;
  attempts: number;
  successes: number;
  failures: number;
  latencyMs?: number;
  reasonCodes: string[];
}

export interface ValidationAuditEvent {
  at: string;
  event: 'validation_started' | 'health_completed' | 'probe_completed' | 'validation_completed';
  modelKey: string;
  level: ValidationLevel;
  probe?: string;
  capability?: ModelCapability;
  status?: ValidationStatus;
  attempts?: number;
  reasonCodes?: string[];
  details?: unknown;
}

export interface ModelValidationRecord {
  schemaVersion: 1;
  model: ModelIdentity;
  modelKey: string;
  level: ValidationLevel;
  status: ValidationStatus;
  checkedAt: string;
  expiresAt: string;
  cacheHit: boolean;
  health?: ModelHealthRecord;
  capabilities: Partial<Record<ModelCapability, CapabilityValidationRecord>>;
  audit: ValidationAuditEvent[];
}

export interface ModelValidationCache {
  get(modelKey: string): ModelValidationRecord | undefined;
  set(record: ModelValidationRecord): void;
  delete?(modelKey: string): void;
}

export class InMemoryModelValidationCache implements ModelValidationCache {
  private readonly records = new Map<string, ModelValidationRecord>();

  get(modelKey: string): ModelValidationRecord | undefined {
    return this.records.get(modelKey);
  }

  set(record: ModelValidationRecord): void {
    this.records.set(record.modelKey, record);
  }

  delete(modelKey: string): void {
    this.records.delete(modelKey);
  }
}

export interface DeclaredModelCapabilities {
  vision?: boolean;
  imageOutput?: boolean;
}

export interface ModelValidationRequest {
  model: ModelIdentity;
  level: ValidationLevel;
  adapter?: ModelValidationProbeAdapter;
  declaredCapabilities?: DeclaredModelCapabilities;
  visionChallenge?: VisionChallenge;
  imageConstraints?: ImageValidationConstraints;
  force?: boolean;
  redactionSecrets?: readonly string[];
}

export interface CapabilityValidationRequest {
  level: Exclude<ValidationLevel, 'discovered'>;
  adapter?: ModelValidationProbeAdapter;
  declaredCapabilities?: DeclaredModelCapabilities;
  visionChallenge?: VisionChallenge;
  imageConstraints?: ImageValidationConstraints;
  nonce?: string;
}

export interface ModelValidationServiceOptions {
  clock?: () => number;
  nonceFactory?: () => string;
  maxConcurrency?: number;
  cache?: ModelValidationCache;
  auditSink?: (event: ValidationAuditEvent) => void;
  redactionSecrets?: readonly string[];
}

interface ProbeTask {
  probe: string;
  capability: ModelCapability;
  run: () => Promise<ProbeAttemptOutcome>;
}

const LEVEL_RANK: Record<ValidationLevel, number> = {
  discovered: 0,
  basic: 1,
  standard: 2,
  extended: 3,
};

export function isValidationFresh(record: Pick<ModelValidationRecord, 'expiresAt'>, now = Date.now()): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && now < expiresAt;
}

function requiredCapabilityEvidence(request: ModelValidationRequest): ModelCapability[] {
  if (request.level === 'discovered') return [];
  const required: ModelCapability[] = ['text'];
  if (request.level === 'standard' || request.level === 'extended') {
    required.push('streaming', 'strict_json', 'tools');
    if (request.declaredCapabilities?.vision) required.push('vision');
  }
  if (request.level === 'extended' && request.declaredCapabilities?.imageOutput) required.push('image_output');
  return required;
}

function hasFreshCapabilityEvidence(record: ModelValidationRecord, request: ModelValidationRequest, now: number): boolean {
  if (request.level === 'discovered') return true;
  if (record.status === 'auth_error' || record.status === 'invalid_config') return true;
  return requiredCapabilityEvidence(request).every(capability => {
    const evidence = record.capabilities[capability];
    if (!evidence) return false;
    const expiresAt = Date.parse(evidence.expiresAt);
    return Number.isFinite(expiresAt) && now < expiresAt;
  });
}

function cloneCapabilityEvidence(
  capabilities: ModelValidationRecord['capabilities'],
): ModelValidationRecord['capabilities'] {
  return JSON.parse(JSON.stringify(capabilities)) as ModelValidationRecord['capabilities'];
}

function modelKey(model: ModelIdentity): string {
  return `${model.provider.trim()}/${model.model.trim()}`;
}

function defaultNonce(): string {
  return `NMK-${randomBytes(12).toString('hex')}`;
}

function exactNonceObject(raw: string, nonce: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    return keys.length === 1 && keys[0] === 'nonce' && (parsed as { nonce?: unknown }).nonce === nonce;
  } catch {
    return false;
  }
}

function toolScenario(kind: ToolProbeKind, nonce: string): ToolProbeScenario {
  const knownToolName = 'newmark_validation_echo';
  const unknownToolName = 'newmark_validation_admin';
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['nonce'],
    properties: { nonce: { type: 'string', const: nonce } },
  } as const;
  const instructions: Record<ToolProbeKind, string> = {
    correct_tool: `Call ${knownToolName} exactly once with the supplied nonce.`,
    unknown_tool_exclusion: `Ignore the unavailable ${unknownToolName} decoy and call only the registered ${knownToolName}.`,
    schema: `Call ${knownToolName} with exactly one JSON field named nonce and no extra fields.`,
    tool_result: `Call ${knownToolName}, consume its returned result, then answer with only the returned nonce.`,
  };
  return {
    kind,
    nonce,
    instruction: instructions[kind],
    knownToolName,
    unknownToolName,
    allowedTools: [{
      name: knownToolName,
      description: 'Returns the supplied validation nonce.',
      inputSchema: schema,
    }],
    simulatedToolResult: kind === 'tool_result' ? { ok: true, nonce } : undefined,
  };
}

function validateToolProbe(scenario: ToolProbeScenario, observation: ToolProbeObservation): ProbeAttemptOutcome {
  if (observation.errorCode) return { ok: false, latencyMs: observation.latencyMs, reasonCode: observation.errorCode };
  if (observation.unknownToolAttempted || observation.selectedToolName === scenario.unknownToolName) {
    return { ok: false, latencyMs: observation.latencyMs, reasonCode: 'UnknownName' };
  }
  if (observation.selectedToolName !== scenario.knownToolName) {
    return { ok: false, latencyMs: observation.latencyMs, reasonCode: 'wrong_tool' };
  }
  if (!observation.rawArguments || !exactNonceObject(observation.rawArguments, scenario.nonce)) {
    return { ok: false, latencyMs: observation.latencyMs, reasonCode: 'SchemaMismatch' };
  }
  if (scenario.kind === 'tool_result') {
    if (!observation.toolResultAccepted) return { ok: false, latencyMs: observation.latencyMs, reasonCode: 'tool_result_not_consumed' };
    if (String(observation.finalText || '').trim() !== scenario.nonce) {
      return { ok: false, latencyMs: observation.latencyMs, reasonCode: 'tool_result_roundtrip_mismatch' };
    }
  }
  return { ok: true, latencyMs: observation.latencyMs };
}

function missingAdapterMethod(method: keyof ModelValidationProbeAdapter): never {
  throw new ModelValidationProbeError(`Validation adapter does not implement ${String(method)}.`, {
    status: 'invalid_config',
    permanent: true,
    code: `missing_adapter_${String(method)}`,
  });
}

function aggregateCapabilityStatus(results: MajorityProbeResult[]): ValidationStatus {
  if (results.length > 0 && results.every(result => result.status === 'verified')) return 'verified';
  const statuses = results.map(result => result.status);
  if (statuses.includes('auth_error')) return 'auth_error';
  if (statuses.includes('invalid_config')) return 'invalid_config';
  if (results.some(result => result.status === 'verified' || result.status === 'degraded')) return 'degraded';
  if (statuses.includes('rate_limited')) return 'rate_limited';
  return 'unavailable';
}

function overallStatus(
  level: ValidationLevel,
  health: ModelHealthRecord | undefined,
  capabilities: Partial<Record<ModelCapability, CapabilityValidationRecord>>,
): ValidationStatus {
  if (level === 'discovered') return 'degraded';
  const capabilityStatuses = Object.values(capabilities).map(record => record.status);
  const textStatus = capabilities.text?.status;
  // Availability is established by the base text path. Optional Standard and
  // Extended probes describe capability support; an unsupported JSON/stream/
  // tool parameter must not make an otherwise callable model unavailable.
  if (textStatus && textStatus !== 'verified' && textStatus !== 'degraded') return textStatus;
  if (health?.status === 'auth_error' || health?.status === 'invalid_config') return health.status;
  if (capabilityStatuses.length > 0 && capabilityStatuses.every(status => status === 'verified')) {
    return health && health.status !== 'verified' ? 'degraded' : 'verified';
  }
  if (textStatus === 'verified' || textStatus === 'degraded') return 'degraded';
  if (capabilityStatuses.includes('auth_error')) return 'auth_error';
  if (capabilityStatuses.includes('invalid_config')) return 'invalid_config';
  if (capabilityStatuses.some(status => status === 'verified' || status === 'degraded')) return 'degraded';
  if (capabilityStatuses.includes('rate_limited')) return 'rate_limited';
  return 'unavailable';
}

function averageLatency(evidence: ProbeAttemptEvidence[]): number | undefined {
  const values = evidence.map(entry => entry.latencyMs).filter((value): value is number => typeof value === 'number');
  if (!values.length) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  result = result
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(sk|pk|rk|key)-[a-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s;,]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');
  return result;
}

const SENSITIVE_AUDIT_KEY = /(?:^|[_-])(api.?key|authorization|access.?token|refresh.?token|token|secret|password|cookie|credential)(?:$|[_-])/i;

/** Recursively redact secrets and summarize binary values before audit storage. */
export function redactValidationAudit<T>(value: T, secrets: readonly string[] = []): T {
  const seen = new WeakSet<object>();
  const walk = (current: unknown, depth: number): unknown => {
    if (depth > 12) return '[TRUNCATED]';
    if (typeof current === 'string') return redactString(current, secrets);
    if (current === null || typeof current !== 'object') return current;
    if (current instanceof Uint8Array) return `[BINARY ${current.byteLength} bytes]`;
    if (current instanceof Error) return { name: current.name, message: redactString(current.message, secrets) };
    if (seen.has(current)) return '[CIRCULAR]';
    seen.add(current);
    if (Array.isArray(current)) return current.map(entry => walk(entry, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      result[key] = SENSITIVE_AUDIT_KEY.test(key) ? '[REDACTED]' : walk(nested, depth + 1);
    }
    return result;
  };
  return walk(value, 0) as T;
}

export class ModelValidationService {
  private readonly clock: () => number;
  private readonly nonceFactory: () => string;
  private readonly maxConcurrency: number;
  private readonly cache: ModelValidationCache;
  private readonly auditSink?: (event: ValidationAuditEvent) => void;
  private readonly redactionSecrets: readonly string[];

  constructor(options: ModelValidationServiceOptions = {}) {
    this.clock = options.clock || Date.now;
    this.nonceFactory = options.nonceFactory || defaultNonce;
    this.maxConcurrency = Math.max(1, Math.min(
      MODEL_VALIDATION_MAX_CONCURRENCY,
      Math.floor(options.maxConcurrency ?? MODEL_VALIDATION_MAX_CONCURRENCY),
    ));
    this.cache = options.cache || new InMemoryModelValidationCache();
    this.auditSink = options.auditSink;
    this.redactionSecrets = options.redactionSecrets || [];
  }

  getCached(model: ModelIdentity): ModelValidationRecord | undefined {
    return this.cache.get(modelKey(model));
  }

  invalidate(model: ModelIdentity): void {
    this.cache.delete?.(modelKey(model));
  }

  /** Lightweight provider/model health phase, independently schedulable. */
  async validateHealth(adapter: ModelValidationProbeAdapter): Promise<ModelHealthRecord | undefined> {
    const now = this.clock();
    return this.runHealthValidation(
      adapter,
      new Date(now).toISOString(),
      new Date(now + MODEL_VALIDATION_TTL_MS).toISOString(),
    );
  }

  /** Capability phase, independently schedulable from provider health checks. */
  async validateCapabilities(
    request: CapabilityValidationRequest,
  ): Promise<Partial<Record<ModelCapability, CapabilityValidationRecord>>> {
    const now = this.clock();
    return this.runCapabilityValidation(
      request,
      new Date(now).toISOString(),
      new Date(now + MODEL_VALIDATION_TTL_MS).toISOString(),
    );
  }

  async validate(request: ModelValidationRequest): Promise<ModelValidationRecord> {
    const key = modelKey(request.model);
    const now = this.clock();
    const cachedRaw = this.cache.get(key);
    const cached = repairLegacyAvailabilityStatus(cachedRaw);
    if (cached && cachedRaw && cached.status !== cachedRaw.status) this.cache.set(cached);
    if (
      !request.force
      && cached
      && isValidationFresh(cached, now)
      && hasFreshCapabilityEvidence(cached, request, now)
      && LEVEL_RANK[cached.level] >= LEVEL_RANK[request.level]
    ) {
      return { ...cached, cacheHit: true };
    }

    const checkedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + MODEL_VALIDATION_TTL_MS).toISOString();
    const audit: ValidationAuditEvent[] = [];
    const secrets = [...this.redactionSecrets, ...(request.redactionSecrets || [])];
    const emit = (event: Omit<ValidationAuditEvent, 'at' | 'modelKey' | 'level'>): void => {
      const sanitized = redactValidationAudit({
        ...event,
        at: new Date(this.clock()).toISOString(),
        modelKey: key,
        level: request.level,
      }, secrets) as ValidationAuditEvent;
      audit.push(sanitized);
      this.auditSink?.(sanitized);
    };
    emit({ event: 'validation_started' });

    if (request.level === 'discovered') {
      const discovered: ModelValidationRecord = {
        schemaVersion: 1,
        model: { ...request.model },
        modelKey: key,
        level: request.level,
        status: 'degraded',
        checkedAt,
        expiresAt,
        cacheHit: false,
        capabilities: {},
        audit,
      };
      emit({ event: 'validation_completed', status: discovered.status });
      this.cache.set(discovered);
      return discovered;
    }

    const adapter = request.adapter || {};
    const health = await this.runHealthValidation(adapter, checkedAt, expiresAt);
    if (health) {
      emit({
        event: 'health_completed',
        status: health.status,
        attempts: health.attempts,
        reasonCodes: health.reasonCodes,
      });
    }

    if (health?.status === 'auth_error' || health?.status === 'invalid_config') {
      const stopped: ModelValidationRecord = {
        schemaVersion: 1,
        model: { ...request.model },
        modelKey: key,
        level: request.level,
        status: health.status,
        checkedAt,
        expiresAt,
        cacheHit: false,
        health,
        // Capability evidence has its own timestamps and lifecycle. A failed
        // credential/config health check must not rewrite previously observed
        // support, but it must also not fan out more requests with the same bad
        // configuration.
        capabilities: cached ? cloneCapabilityEvidence(cached.capabilities) : {},
        audit,
      };
      emit({
        event: 'validation_completed',
        status: stopped.status,
        details: { capabilityProbes: 'skipped_after_permanent_health_failure' },
      });
      this.cache.set(stopped);
      return stopped;
    }

    if (
      cached
      && Object.keys(cached.capabilities).length > 0
      && (health?.status === 'unavailable' || health?.status === 'rate_limited')
    ) {
      const preserved: ModelValidationRecord = {
        schemaVersion: 1,
        model: { ...request.model },
        modelKey: key,
        level: LEVEL_RANK[cached.level] >= LEVEL_RANK[request.level] ? cached.level : request.level,
        status: health.status === 'rate_limited'
          ? 'rate_limited'
          : overallStatus(request.level, health, cached.capabilities),
        checkedAt,
        expiresAt,
        cacheHit: false,
        health,
        // Health has a new lifecycle, but capability evidence remains exactly
        // as observed. In particular, an expired seven-day capability record
        // must not receive a new checkedAt/expiresAt merely because health was
        // retried and failed transiently.
        capabilities: cloneCapabilityEvidence(cached.capabilities),
        audit,
      };
      emit({
        event: 'validation_completed',
        status: preserved.status,
        details: { capabilityProbes: 'skipped_after_transient_health_failure', capabilityEvidence: 'preserved_without_refresh' },
      });
      this.cache.set(preserved);
      return preserved;
    }

    const capabilities = await this.runCapabilityValidation({
      level: request.level,
      adapter,
      declaredCapabilities: request.declaredCapabilities,
      visionChallenge: request.visionChallenge,
      imageConstraints: request.imageConstraints,
    }, checkedAt, expiresAt, task => {
      emit({
        event: 'probe_completed',
        probe: task.probe,
        capability: task.capability,
        status: task.result.status,
        attempts: task.result.attempts,
        reasonCodes: task.result.reasonCodes,
      });
    });

    const record: ModelValidationRecord = {
      schemaVersion: 1,
      model: { ...request.model },
      modelKey: key,
      level: request.level,
      status: overallStatus(request.level, health, capabilities),
      checkedAt,
      expiresAt,
      cacheHit: false,
      health,
      capabilities,
      audit,
    };
    emit({ event: 'validation_completed', status: record.status });
    this.cache.set(record);
    return record;
  }

  private async runHealthValidation(
    adapter: ModelValidationProbeAdapter,
    checkedAt: string,
    expiresAt: string,
  ): Promise<ModelHealthRecord | undefined> {
    if (!adapter.health) return undefined;
    const result = await runMajorityProbe(async () => {
      const observation = await adapter.health!();
      return {
        ok: observation.ok,
        status: observation.status,
        latencyMs: observation.latencyMs,
        reasonCode: observation.reasonCode,
        permanent: observation.permanent,
      };
    });
    return {
      status: result.status,
      checkedAt,
      expiresAt,
      attempts: result.attempts,
      successes: result.successes,
      failures: result.failures,
      latencyMs: averageLatency(result.evidence),
      reasonCodes: result.reasonCodes,
    };
  }

  private async runCapabilityValidation(
    request: CapabilityValidationRequest,
    checkedAt: string,
    expiresAt: string,
    onProbe?: (task: ProbeTask & { result: MajorityProbeResult }) => void,
  ): Promise<Partial<Record<ModelCapability, CapabilityValidationRecord>>> {
    const adapter = request.adapter || {};
    const tasks = this.buildTasks(request, adapter, request.nonce || this.nonceFactory());
    const completed = await mapWithValidationConcurrency(tasks, async task => {
      const result = await runMajorityProbe(() => task.run());
      const completedTask = { ...task, result };
      onProbe?.(completedTask);
      return completedTask;
    }, this.maxConcurrency);

    const capabilities: Partial<Record<ModelCapability, CapabilityValidationRecord>> = {};
    const capabilityNames = [...new Set(completed.map(task => task.capability))];
    for (const capability of capabilityNames) {
      const capabilityTasks = completed.filter(task => task.capability === capability);
      capabilities[capability] = {
        capability,
        status: aggregateCapabilityStatus(capabilityTasks.map(task => task.result)),
        checkedAt,
        expiresAt,
        evidence: capabilityTasks.map(task => ({
          probe: task.probe,
          status: task.result.status,
          attempts: task.result.attempts,
          successes: task.result.successes,
          failures: task.result.failures,
          reasonCodes: task.result.reasonCodes,
        })),
      };
    }
    return capabilities;
  }

  private buildTasks(
    request: CapabilityValidationRequest,
    adapter: ModelValidationProbeAdapter,
    nonce: string,
  ): ProbeTask[] {
    const text: ProbeTask = {
      probe: 'text_nonce',
      capability: 'text',
      run: async () => {
        if (!adapter.textNonce) return missingAdapterMethod('textNonce');
        const observation = await adapter.textNonce({
          nonce,
          instruction: 'Return exactly the supplied nonce and no other characters.',
        });
        const output = String(observation.output || '').trim();
        return {
          ok: output === nonce,
          status: output ? 'degraded' : undefined,
          latencyMs: observation.latencyMs,
          reasonCode: output === nonce ? undefined : 'nonce_mismatch',
        };
      },
    };
    if (request.level === 'basic') return [text];

    const tasks: ProbeTask[] = [
      text,
      {
        probe: 'stream_integrity',
        capability: 'streaming',
        run: async () => {
          if (!adapter.streamNonce) return missingAdapterMethod('streamNonce');
          const observation = await adapter.streamNonce({
            nonce,
            instruction: 'Stream exactly the supplied nonce and emit a terminal completion event.',
          });
          const output = observation.chunks.map(chunk => String(chunk)).join('').trim();
          const terminalEvent = observation.completionEvent;
          const terminalEventVerified = terminalEvent === 'openai_done'
            || terminalEvent === 'openai_response_completed'
            || terminalEvent === 'anthropic_message_stop'
            || terminalEvent === 'provider_completed';
          return {
            ok: observation.completed === true && terminalEventVerified && output === nonce,
            latencyMs: observation.latencyMs,
            reasonCode: !observation.completed
              ? 'stream_not_completed'
              : !terminalEventVerified
                ? 'stream_terminal_event_missing'
                : output === nonce ? undefined : 'stream_content_mismatch',
          };
        },
      },
      {
        probe: 'strict_json',
        capability: 'strict_json',
        run: async () => {
          if (!adapter.strictJson) return missingAdapterMethod('strictJson');
          const observation = await adapter.strictJson({
            nonce,
            instruction: 'Return one strict JSON object with exactly the required nonce field and no Markdown or extra fields.',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['nonce'],
              properties: { nonce: { type: 'string', const: nonce } },
            },
          });
          return {
            ok: exactNonceObject(observation.raw, nonce),
            latencyMs: observation.latencyMs,
            reasonCode: exactNonceObject(observation.raw, nonce) ? undefined : 'strict_json_mismatch',
          };
        },
      },
    ];

    for (const kind of ['correct_tool', 'unknown_tool_exclusion', 'schema', 'tool_result'] as const) {
      tasks.push({
        probe: `tool_${kind}`,
        capability: 'tools',
        run: async () => {
          if (!adapter.tool) return missingAdapterMethod('tool');
          const scenario = toolScenario(kind, nonce);
          return validateToolProbe(scenario, await adapter.tool(scenario));
        },
      });
    }

    if (request.declaredCapabilities?.vision) {
      tasks.push({
        probe: 'declared_vision',
        capability: 'vision',
        run: async () => {
          if (!adapter.vision) return missingAdapterMethod('vision');
          if (!request.visionChallenge) {
            throw new ModelValidationProbeError('Declared vision requires a challenge fixture.', {
              status: 'invalid_config',
              permanent: true,
              code: 'missing_vision_challenge',
            });
          }
          const observation = await adapter.vision(request.visionChallenge);
          return {
            ok: String(observation.answer || '').trim() === request.visionChallenge.expectedAnswer,
            latencyMs: observation.latencyMs,
            reasonCode: String(observation.answer || '').trim() === request.visionChallenge.expectedAnswer
              ? undefined
              : 'vision_answer_mismatch',
          };
        },
      });
    }

    if (request.level === 'extended' && request.declaredCapabilities?.imageOutput) {
      tasks.push({
        probe: 'image_output',
        capability: 'image_output',
        run: async () => {
          if (!adapter.imageOutput) return missingAdapterMethod('imageOutput');
          const observation = await adapter.imageOutput({
            nonce,
            instruction: 'Generate a deterministic validation image and return the encoded image bytes with its MIME type.',
          });
          const image = validateImageOutput(observation, request.imageConstraints);
          return {
            ok: image.ok,
            latencyMs: observation.latencyMs,
            reasonCode: image.error,
          };
        },
      });
    }
    return tasks;
  }
}

function repairLegacyAvailabilityStatus(record: ModelValidationRecord | undefined): ModelValidationRecord | undefined {
  if (!record) return undefined;
  const baseTextUsable = record.capabilities.text?.status === 'verified' || record.capabilities.text?.status === 'degraded';
  const healthIsPermanentFailure = record.health?.status === 'auth_error' || record.health?.status === 'invalid_config';
  if (!baseTextUsable || healthIsPermanentFailure || (record.status !== 'invalid_config' && record.status !== 'unavailable')) return record;
  return { ...record, status: 'degraded' };
}
