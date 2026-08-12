/**
 * AWS Signature Version 4.
 *
 * Implemented here rather than pulled from the AWS SDK so that the package
 * stays dependency-light: signing a Bedrock request needs HMAC-SHA256 and
 * string assembly, both of which `node:crypto` already provides.
 *
 * @see https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html
 */

import { createHash, createHmac } from 'node:crypto';
import type { Secret } from '../config/secret.js';

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SigV4Credentials {
  readonly accessKeyId: Secret;
  readonly secretAccessKey: Secret;
  readonly sessionToken?: Secret | undefined;
}

export interface SignRequestInput {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign. `host` is added automatically. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly region: string;
  /** AWS service name, e.g. `bedrock`. */
  readonly service: string;
  readonly credentials: SigV4Credentials;
  /** Signing time. Injectable so signatures are reproducible in tests. */
  readonly date?: Date;
}

export interface SignedRequest {
  /** Headers to send, including `authorization` and the `x-amz-*` set. */
  readonly headers: Record<string, string>;
  /** The canonical request, exposed for debugging signature mismatches. */
  readonly canonicalRequest: string;
  /** The string that was signed. */
  readonly stringToSign: string;
  readonly signature: string;
}

/**
 * Sign a request, returning the headers to send with it.
 *
 * @example
 * ```ts
 * const { headers } = signRequest({
 *   method: 'POST',
 *   url: new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse'),
 *   headers: { 'content-type': 'application/json' },
 *   body: '{}',
 *   region: 'us-east-1',
 *   service: 'bedrock',
 *   credentials,
 * });
 * headers['authorization']; // 'AWS4-HMAC-SHA256 Credential=…, SignedHeaders=…, Signature=…'
 * ```
 */
export function signRequest(input: SignRequestInput): SignedRequest {
  const date = input.date ?? new Date();
  const amzDate = toAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  // The signed header set must include everything sent that AWS cares about,
  // and must match the `SignedHeaders` list exactly.
  const headers: Record<string, string> = {
    ...lowercaseKeys(input.headers),
    host: input.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (input.credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = input.credentials.sessionToken.reveal();
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${collapseWhitespace(headers[name] ?? '')}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url.pathname),
    canonicalQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = deriveSigningKey(
    input.credentials.secretAccessKey.reveal(),
    dateStamp,
    input.region,
    input.service,
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  headers['authorization'] =
    `${ALGORITHM} Credential=${input.credentials.accessKeyId.reveal()}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers, canonicalRequest, stringToSign, signature };
}

/**
 * `kSigning = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request")`
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp, 'utf8').digest();
  const kRegion = createHmac('sha256', kDate).update(region, 'utf8').digest();
  const kService = createHmac('sha256', kRegion).update(service, 'utf8').digest();
  return createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
}

/** `YYYYMMDDTHHMMSSZ`, the only timestamp format SigV4 accepts. */
export function toAmzDate(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

/**
 * Percent-encode each path segment **twice**, leaving the separators alone.
 *
 * The double encoding is not a mistake. SigV4 requires the canonical URI to be
 * URI-encoded twice for every service except S3, so a Bedrock model id such as
 * `us.anthropic.claude-3-5-haiku-20241022-v1:0` travels on the wire as
 * `…v1%3A0` but must appear in the string-to-sign as `…v1%253A0`. Encoding it
 * once produces a signature AWS rejects with `SignatureDoesNotMatch`.
 *
 * Only this canonical representation is double-encoded; the request path sent
 * over the wire stays single-encoded, and this function never touches it.
 *
 * Segments are decoded first so the result is identical whether the caller
 * supplied a raw or an already-encoded path. Encoding follows RFC 3986, which
 * differs from `encodeURIComponent` in that `!'()*` must also be encoded.
 *
 * @see https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 */
export function canonicalUri(pathname: string): string {
  if (pathname === '') return '/';
  return pathname
    .split('/')
    .map((segment) => rfc3986(rfc3986(decodeSegment(segment))))
    .join('/');
}

/**
 * Decode a path segment, tolerating one that is not valid percent-encoding.
 * A malformed path is a bug elsewhere; throwing a `URIError` from inside the
 * signer would report it as an unrelated failure.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Query parameters sorted by name, then by value, each RFC 3986 encoded. */
export function canonicalQuery(params: URLSearchParams): string {
  const pairs: [string, string][] = [];
  params.forEach((value, name) => pairs.push([rfc3986(name), rfc3986(value)]));

  pairs.sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));

  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function lowercaseKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/** Header values are trimmed and internal runs of spaces collapsed to one. */
function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
