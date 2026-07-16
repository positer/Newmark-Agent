/**
 * Structured renderer configuration keys whose values are read by the Agent
 * while preparing or executing a conversation turn. UI-only preferences must
 * not invalidate the conversation kernel.
 */
const CONVERSATION_RUNTIME_CONFIG_KEYS = new Set([
  'feedbackLevel',
  'language',
  'autoSwitch',
  'autoSwitchScope',
  'fallbackOnUnavailable',
  'switchTendency',
  'openAIApiMode',
  'nativeTools',
  'providers',
]);

export function configPatchAffectsConversationRuntime(
  patch: string | Record<string, unknown>,
): boolean {
  // A raw config document can change any section, so it cannot be classified
  // safely without parsing and validating the whole document.
  if (typeof patch === 'string') return true;
  return Object.keys(patch || {}).some(key => CONVERSATION_RUNTIME_CONFIG_KEYS.has(key));
}
