/**
 * Newmark dev-0.3.0 version protocol constants.
 *
 * The application version, the context schema version, the agent protocol
 * version, and the tool capability protocol version are deliberately four
 * independent numbers. They must never share one field.
 */
export interface NewmarkVersionInfo {
  applicationVersion: 'dev-0.3.0';
  contextSchemaVersion: number;
  agentProtocolVersion: string;
  toolCapabilityProtocolVersion: string;
}

export const VERSION_INFO: NewmarkVersionInfo = {
  applicationVersion: 'dev-0.3.0',
  contextSchemaVersion: 2,
  agentProtocolVersion: '0.3',
  toolCapabilityProtocolVersion: '1',
};

/** Numeric package version used for packaging (product.version in package.json). */
export const PACKAGE_APP_VERSION = '0.3.0';

/** Human-readable application label. */
export const APPLICATION_VERSION_LABEL = 'dev-0.3.0';

export function versionInfoJson(): string {
  return JSON.stringify(VERSION_INFO, null, 2);
}
