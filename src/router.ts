/**
 * Provider routing.
 *
 * The router owns the decision "which adapter handles this request", the
 * checks that run before an adapter is asked to build anything, and the
 * registry that makes the provider set extensible.
 *
 * It is deliberately transport-free: `route()` returns everything needed to
 * make the call — path, query, headers, body — without making it. That keeps
 * routing testable without a network, and leaves credentials to phase 3.
 */

import { NimbleError } from './errors.js';
import type { Capability, ProviderAdapter, ProviderRoute } from './providers/adapter.js';
import { assertCapabilities, assertWithinLimits } from './providers/capabilities.js';
import { builtInAdapters } from './providers/index.js';
import type { NimbleRequest, ProviderId } from './types.js';

/** Everything needed to issue one provider call. */
export interface RoutedRequest {
  readonly provider: ProviderId;
  readonly adapter: ProviderAdapter;
  readonly route: ProviderRoute;
  /** The provider-native request body. */
  readonly payload: unknown;
}

export interface RouterOptions {
  /**
   * Adapters to register. Defaults to the built-in four. A later entry
   * replaces an earlier one with the same id, so a custom OpenAI adapter can
   * be dropped in without forking.
   */
  readonly adapters?: readonly ProviderAdapter[];
}

export class Router {
  readonly #adapters = new Map<ProviderId, ProviderAdapter>();

  constructor(options: RouterOptions = {}) {
    for (const adapter of options.adapters ?? builtInAdapters) {
      this.register(adapter);
    }
  }

  /** Add or replace the adapter for a provider. */
  register(adapter: ProviderAdapter): this {
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  /** Provider ids this router can route to, in registration order. */
  providers(): readonly ProviderId[] {
    return [...this.#adapters.keys()];
  }

  /**
   * Look up the adapter for a provider.
   *
   * @throws NimbleError - `unknown_provider` when nothing is registered
   */
  adapterFor(provider: ProviderId): ProviderAdapter {
    const adapter = this.#adapters.get(provider);
    if (adapter === undefined) {
      throw new NimbleError(
        `No adapter registered for provider "${provider}". Registered: ${this.providers().join(', ') || 'none'}.`,
        { code: 'unknown_provider', provider },
      );
    }
    return adapter;
  }

  /**
   * Select an adapter, verify the request against it, and build the call.
   *
   * Checks run in a deliberate order — capabilities first, then value ranges —
   * so that a request using a feature the provider lacks reports that, rather
   * than an incidental range complaint about the same request.
   *
   * @throws NimbleError - `unknown_provider`, `unsupported_feature`, or
   *   `invalid_request`
   *
   * @example
   * ```ts
   * const router = new Router();
   * const { route, payload } = router.route(
   *   normalizeRequest({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
   * );
   * route.path; // 'v1/chat/completions'
   * ```
   */
  route(request: NimbleRequest): RoutedRequest {
    const adapter = this.adapterFor(request.model.provider);

    assertCapabilities(request, adapter);
    assertWithinLimits(request, adapter);

    return {
      provider: adapter.id,
      adapter,
      route: adapter.describeRoute(request),
      payload: adapter.buildPayload(request),
    };
  }

  /**
   * Which registered providers could serve this request as written.
   *
   * Useful for fallback chains and for telling a caller where else a request
   * could go when their first choice rejects it.
   */
  candidatesFor(request: NimbleRequest): readonly ProviderId[] {
    return this.providers().filter((provider) => {
      try {
        const adapter = this.adapterFor(provider);
        assertCapabilities(request, adapter);
        assertWithinLimits(request, adapter);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Whether a provider can express a capability, without building anything. */
  supports(provider: ProviderId, capability: Capability): boolean {
    return this.adapterFor(provider).supports(capability);
  }
}

/** Convenience constructor, for callers who prefer not to use `new`. */
export function createRouter(options: RouterOptions = {}): Router {
  return new Router(options);
}
