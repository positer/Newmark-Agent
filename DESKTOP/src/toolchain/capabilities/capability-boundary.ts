import { CapabilityDescriptor } from '../../context/domain/types';
import { sha256 } from '../../context/serializers/deterministic';

/**
 * Capability Boundary Summary — layer 1 of the four-layer tool exposure model.
 *
 * Always injected, byte-stable, extremely short. It describes capability
 * domains and boundaries WITHOUT full schemas. It is separate from the
 * tool definitions hash so it can be cached independently.
 */
export class CapabilityBoundary {
  constructor(
    private readonly capabilities: () => CapabilityDescriptor[],
    private readonly forbiddenCapabilities: string[] = [],
  ) {}

  /** Boundaries that are always visible (known + discoverable). */
  available(): CapabilityDescriptor[] {
    return this.capabilities().filter(capability =>
      capability.discoverability === 'always' || capability.discoverability === 'task_relevant');
  }

  hidden(): CapabilityDescriptor[] {
    return this.capabilities().filter(capability => capability.discoverability === 'hidden');
  }

  /** The injected boundary text. Must be byte-stable for caching. */
  render(): string {
    const available = this.available();
    const lines = available.map(capability =>
      `- ${capability.capabilityId}: ${capability.shortDescription}`);
    const restricted = this.forbiddenCapabilities.length
      ? `\nRestricted:\n${this.forbiddenCapabilities.map(id => `- ${id}: 禁止直接访问或默认不可用`).join('\n')}`
      : '';
    return [
      '<capability_boundary version="1">',
      'Available capability domains:',
      ...lines,
      restricted,
      '</capability_boundary>',
    ].join('\n');
  }

  renderHash(): string {
    return sha256(this.render());
  }
}

/** Build a boundary from a catalog plus explicit forbidden list. */
export function buildCapabilityBoundary(
  catalog: { all(): CapabilityDescriptor[] },
  forbiddenCapabilities: string[] = [],
): CapabilityBoundary {
  return new CapabilityBoundary(() => catalog.all(), forbiddenCapabilities);
}
