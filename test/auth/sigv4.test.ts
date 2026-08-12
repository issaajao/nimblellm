import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalQuery,
  canonicalUri,
  deriveSigningKey,
  sha256Hex,
  signRequest,
  toAmzDate,
} from '../../src/auth/sigv4.js';
import { Secret } from '../../src/config/secret.js';

const credentials = {
  accessKeyId: new Secret('AKIDEXAMPLE'),
  secretAccessKey: new Secret('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'),
};

const DATE = new Date('2026-08-05T12:34:56.789Z');

const sign = (overrides: Partial<Parameters<typeof signRequest>[0]> = {}) =>
  signRequest({
    method: 'POST',
    url: new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/my-model/converse'),
    headers: { 'content-type': 'application/json' },
    body: '{"messages":[]}',
    region: 'us-east-1',
    service: 'bedrock',
    credentials,
    date: DATE,
    ...overrides,
  });

describe('toAmzDate', () => {
  it('formats as YYYYMMDDTHHMMSSZ, dropping milliseconds', () => {
    expect(toAmzDate(DATE)).toBe('20260805T123456Z');
  });
});

describe('canonicalUri', () => {
  it('defaults an empty path to /', () => {
    expect(canonicalUri('')).toBe('/');
  });

  it('leaves an already-safe path alone', () => {
    expect(canonicalUri('/model/my-model/converse')).toBe('/model/my-model/converse');
  });

  // SigV4 requires the canonical URI to be URI-encoded *twice* for every
  // service except S3. Getting this wrong is invisible until a path actually
  // contains a character that needs encoding — which is why the original
  // version of these tests, written around clean paths, passed while real
  // Bedrock calls failed with SignatureDoesNotMatch.
  describe('double encoding', () => {
    it('encodes a colon twice, so %3A on the wire becomes %253A when signed', () => {
      expect(canonicalUri('/model/anthropic.claude-v1%3A0/converse')).toBe(
        '/model/anthropic.claude-v1%253A0/converse',
      );
    });

    it('produces the same canonical URI whether the input was raw or encoded', () => {
      expect(canonicalUri('/model/anthropic.claude-v1:0/converse')).toBe(
        canonicalUri('/model/anthropic.claude-v1%3A0/converse'),
      );
    });

    it('double-encodes the inference profile id that first exposed this', () => {
      const model = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
      const wirePath = `/model/${encodeURIComponent(model)}/converse-stream`;

      expect(wirePath).toContain('v1%3A0'); // single-encoded on the wire
      expect(canonicalUri(wirePath)).toBe(
        '/model/us.anthropic.claude-3-5-haiku-20241022-v1%253A0/converse-stream',
      );
    });

    it('encodes characters that encodeURIComponent leaves alone, also twice', () => {
      expect(canonicalUri("/a'b(c)")).toBe('/a%2527b%2528c%2529');
    });

    it('escapes the percent sign itself on the second pass', () => {
      expect(canonicalUri('/a b')).toBe('/a%2520b');
    });

    it('leaves a path needing no encoding untouched by either pass', () => {
      expect(canonicalUri('/model/anthropic.claude-sonnet-4-v1/converse')).toBe(
        '/model/anthropic.claude-sonnet-4-v1/converse',
      );
    });

    it('tolerates a malformed escape rather than throwing from the signer', () => {
      expect(() => canonicalUri('/model/100%/converse')).not.toThrow();
    });
  });
});

describe('canonicalQuery', () => {
  it('sorts parameters by name', () => {
    expect(canonicalQuery(new URLSearchParams('b=2&a=1'))).toBe('a=1&b=2');
  });

  it('sorts repeated parameters by value', () => {
    expect(canonicalQuery(new URLSearchParams('a=2&a=1'))).toBe('a=1&a=2');
  });

  it('encodes names and values', () => {
    expect(canonicalQuery(new URLSearchParams({ 'a b': 'c/d' }))).toBe('a%20b=c%2Fd');
  });

  it('is empty when there are no parameters', () => {
    expect(canonicalQuery(new URLSearchParams())).toBe('');
  });
});

describe('signRequest', () => {
  it('builds the canonical request exactly as the specification lays it out', () => {
    const signed = sign();
    const payloadHash = sha256Hex('{"messages":[]}');

    // Assembled by hand from the SigV4 spec rather than from the implementation:
    // method, path, query, sorted headers, blank line, signed header list, hash.
    expect(signed.canonicalRequest).toBe(
      [
        'POST',
        '/model/my-model/converse',
        '',
        'content-type:application/json\n' +
          'host:bedrock-runtime.us-east-1.amazonaws.com\n' +
          `x-amz-content-sha256:${payloadHash}\n` +
          'x-amz-date:20260805T123456Z\n',
        'content-type;host;x-amz-content-sha256;x-amz-date',
        payloadHash,
      ].join('\n'),
    );
  });

  it('builds the string to sign from the algorithm, timestamp, scope and hash', () => {
    const signed = sign();

    expect(signed.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20260805T123456Z',
        '20260805/us-east-1/bedrock/aws4_request',
        sha256Hex(signed.canonicalRequest),
      ].join('\n'),
    );
  });

  it('signs the string with the derived key', () => {
    const signed = sign();
    const key = deriveSigningKey(
      credentials.secretAccessKey.reveal(),
      '20260805',
      'us-east-1',
      'bedrock',
    );

    expect(signed.signature).toBe(
      createHmac('sha256', key).update(signed.stringToSign, 'utf8').digest('hex'),
    );
  });

  it('formats the authorization header AWS expects', () => {
    const signed = sign();

    expect(signed.headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260805/us-east-1/bedrock/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
        `Signature=${signed.signature}`,
    );
  });

  it('sets the host, date and payload hash headers', () => {
    const signed = sign();

    expect(signed.headers).toMatchObject({
      host: 'bedrock-runtime.us-east-1.amazonaws.com',
      'x-amz-date': '20260805T123456Z',
      'x-amz-content-sha256': sha256Hex('{"messages":[]}'),
    });
  });

  it('includes the session token in the signature when one is present', () => {
    const signed = sign({
      credentials: { ...credentials, sessionToken: new Secret('session-token') },
    });

    expect(signed.headers['x-amz-security-token']).toBe('session-token');
    expect(signed.canonicalRequest).toContain('x-amz-security-token:session-token');
    expect(signed.headers['authorization']).toContain('x-amz-security-token');
  });

  it('signs query parameters, which the streaming endpoints use', () => {
    const signed = sign({
      url: new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse?b=2&a=1'),
    });
    expect(signed.canonicalRequest.split('\n')[2]).toBe('a=1&b=2');
  });

  it('normalizes header names and collapses whitespace in values', () => {
    const signed = sign({ headers: { 'Content-Type': '  application/json   charset ' } });
    expect(signed.canonicalRequest).toContain('content-type:application/json charset\n');
  });

  describe('paths needing percent-encoding', () => {
    const model = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
    const url = new URL(
      `https://bedrock-runtime.us-east-2.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
    );

    it('signs over the double-encoded path', () => {
      const signed = sign({ url, region: 'us-east-2' });

      expect(signed.canonicalRequest.split('\n')[1]).toBe(
        '/model/us.anthropic.claude-3-5-haiku-20241022-v1%253A0/converse',
      );
    });

    it('leaves the request URL single-encoded, since that is what goes on the wire', () => {
      sign({ url, region: 'us-east-2' });

      expect(url.pathname).toBe('/model/us.anthropic.claude-3-5-haiku-20241022-v1%3A0/converse');
    });

    it('signs a colon-bearing path differently from an unencoded one', () => {
      const plain = new URL(
        'https://bedrock-runtime.us-east-2.amazonaws.com/model/plain-model/converse',
      );
      expect(sign({ url, region: 'us-east-2' }).signature).not.toBe(
        sign({ url: plain, region: 'us-east-2' }).signature,
      );
    });
  });

  it('produces a different signature for a different body', () => {
    expect(sign({ body: '{"a":1}' }).signature).not.toBe(sign({ body: '{"a":2}' }).signature);
  });

  it('produces a different signature for a different key', () => {
    const other = { ...credentials, secretAccessKey: new Secret('another-secret-key') };
    expect(sign({ credentials: other }).signature).not.toBe(sign().signature);
  });

  it('produces a different signature on a different day', () => {
    expect(sign({ date: new Date('2026-08-06T12:34:56Z') }).signature).not.toBe(sign().signature);
  });

  it('is deterministic for identical inputs', () => {
    expect(sign().signature).toBe(sign().signature);
  });
});

describe('deriveSigningKey', () => {
  it('chains HMACs over date, region, service and the terminator', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

    const kDate = createHmac('sha256', `AWS4${secret}`).update('20260805', 'utf8').digest();
    const kRegion = createHmac('sha256', kDate).update('us-east-1', 'utf8').digest();
    const kService = createHmac('sha256', kRegion).update('bedrock', 'utf8').digest();
    const expected = createHmac('sha256', kService).update('aws4_request', 'utf8').digest();

    expect(deriveSigningKey(secret, '20260805', 'us-east-1', 'bedrock')).toEqual(expected);
  });
});
