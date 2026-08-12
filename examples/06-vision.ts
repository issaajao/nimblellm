/**
 * Images.
 *
 * Two source kinds, and they are not equally portable:
 *
 *   inline base64  works everywhere
 *   by URL         OpenAI, Azure and Vertex only — Bedrock cannot fetch images,
 *                  and Vertex wants a gs:// URI with a recognizable extension
 *
 * Inline is the portable choice; the router rejects a URL image bound for
 * Bedrock up front rather than letting it fail at the provider.
 *
 *   node examples/06-vision.ts
 */

import { readFile } from 'node:fs/promises';
import { createClient, NimbleError } from 'nimblellm';

const client = createClient();
const model = process.env['MODEL'] ?? 'openai/gpt-4o-mini';

// A 1x1 red PNG, so the example runs without any asset on disk. Swap in
// `await readFile('photo.png', { encoding: 'base64' })` for a real one.
const RED_DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const imageBase64 = process.env['IMAGE_PATH']
  ? await readFile(process.env['IMAGE_PATH'], { encoding: 'base64' })
  : RED_DOT;

const response = await client.complete({
  model,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What colour is this image? Answer in one word.' },
        { type: 'image', data: imageBase64, mediaType: 'image/png' },
      ],
    },
  ],
  maxOutputTokens: 50,
});

console.log(response.message.content.map((p) => (p.type === 'text' ? p.text : '')).join(''));

// The same request with a URL source, to show the portability difference.
try {
  await client.complete({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this.' },
          { type: 'image', url: 'https://example.test/photo.png' },
        ],
      },
    ],
    maxOutputTokens: 50,
  });
} catch (error) {
  if (error instanceof NimbleError && error.code === 'unsupported_feature') {
    console.log(`\nURL images rejected here, as expected: ${error.message}`);
  } else {
    console.log(`\nURL image call failed: ${(error as Error).message}`);
  }
}
