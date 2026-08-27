import assert from 'node:assert/strict';
import {
  EMPTY_RESPONSE_RETRY_DELAYS_MS,
  MAX_CONSECUTIVE_EMPTY_RESPONSES,
  MAX_EMPTY_RESPONSE_RETRIES,
  emptyResponseRetryDelayMs,
  observeEmptyResponseOutcome,
} from '../core/emptyResponseRetry';

let assertions = 0;
function ok(condition: boolean, message: string): void {
  assertions += 1;
  assert.ok(condition, message);
  console.log(`PASS: ${message}`);
}

let count = 0;
for (let index = 1; index <= MAX_EMPTY_RESPONSE_RETRIES; index += 1) {
  const state = observeEmptyResponseOutcome(count, true);
  count = state.consecutiveEmptyResponses;
  ok(state.retry && !state.terminate && count === index, `empty outcome ${index} retries without terminating`);
  ok(emptyResponseRetryDelayMs(index) === EMPTY_RESPONSE_RETRY_DELAYS_MS[index - 1], `empty retry ${index} uses the configured delay`);
}

const terminal = observeEmptyResponseOutcome(count, true);
ok(!terminal.retry && terminal.terminate && terminal.consecutiveEmptyResponses === MAX_CONSECUTIVE_EMPTY_RESPONSES,
  'the fifth retry failure terminates after six consecutive empty outcomes');

const resetByText = observeEmptyResponseOutcome(4, false);
ok(resetByText.consecutiveEmptyResponses === 0 && !resetByText.retry && !resetByText.terminate,
  'a normal text outcome resets the empty-response streak');

const resetByToolCall = observeEmptyResponseOutcome(4, false);
ok(resetByToolCall.consecutiveEmptyResponses === 0 && !resetByToolCall.retry && !resetByToolCall.terminate,
  'a valid tool-call outcome resets the empty-response streak');

console.log(`empty response retry verification passed (${assertions} assertions)`);
