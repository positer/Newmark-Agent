"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createState, filteredCommands } = require("../src/state");
const { render } = require("../src/render");

function assertCursorFollow(viewportScroll, cursor, viewportSize, label) {
  assert.ok(Number.isInteger(viewportScroll), `${label}: scroll is an integer`);
  assert.ok(viewportScroll >= 0, `${label}: scroll is non-negative`);
  assert.ok(cursor >= viewportScroll && cursor < viewportScroll + viewportSize,
    `${label}: cursor ${cursor} is visible in [${viewportScroll}, ${viewportScroll + viewportSize})`);
}

test("chat conversation list follows the selected cursor under long-list stress", () => {
  const state = createState();
  const count = 800;
  state.view = "chat";
  state.focusRegion = "content";
  state.inputMode = false;
  state.snapshot.conversations = Array.from({ length: count }, (_, i) => ({
    id: `stress-conv-${i}`,
    title: `Conversation ${i}`,
    updatedAt: new Date(2026, 7, 15, 0, 0, i).toISOString(),
    pinned: false
  }));
  for (let i = 0; i < count; i++) {
    state.selected = i;
    render(state, 120, 30);
    assertCursorFollow(state.conversationListScroll, state.selected, 27 - 3, `chat row ${i}`);
  }
  for (let i = 0; i < 2000; i++) {
    state.selected = (i * 37 + 11) % count;
    render(state, 120, 30);
    assertCursorFollow(state.conversationListScroll, state.selected, 27 - 3, `chat random ${i}`);
  }
});

test("command palette overlay follows the cursor under long-list stress", () => {
  const state = createState();
  state.overlay = "palette";
  state.paletteQuery = "";
  state.paletteIndex = 0;
  const commands = filteredCommands(state);
  const count = Math.max(commands.length, 120);
  // Stress the actual command list; if the built-in catalog is shorter than
  // the stress target, the same math still covers its full length.
  for (let i = 0; i < count; i++) {
    state.paletteIndex = i % Math.max(1, commands.length);
    render(state, 100, 30);
    assertCursorFollow(state.paletteScroll, state.paletteIndex, Math.min(7, Math.max(1, commands.length)), `palette row ${i}`);
  }
});

test("flow-select overlay follows the cursor under long-list stress", () => {
  const state = createState();
  const count = 500;
  state.flows = Array.from({ length: count }, (_, i) => `Stress Flow ${i}`);
  state.overlay = "flow-select";
  state.flowSelectionIndex = 0;
  for (let i = 0; i < count; i++) {
    state.flowSelectionIndex = i;
    render(state, 100, 30);
    assertCursorFollow(state.flowSelectionScroll, state.flowSelectionIndex, Math.min(7, Math.max(1, count)), `flow-select row ${i}`);
  }
  for (let i = 0; i < 2000; i++) {
    state.flowSelectionIndex = (i * 53 + 7) % count;
    render(state, 100, 30);
    assertCursorFollow(state.flowSelectionScroll, state.flowSelectionIndex, Math.min(7, Math.max(1, count)), `flow-select random ${i}`);
  }
});

test("flowtask view follows the cursor under mixed-component long-list stress", () => {
  const state = createState();
  const count = 400;
  state.view = "flowtask";
  state.focusRegion = "content";
  state.currentFlow = {
    name: "Cursor Follow Stress Flow",
    pc: 0,
    components: Array.from({ length: count }, (_, i) => ({
      id: String(i + 1).padStart(2, "0"),
      type: i % 3 === 0 ? "logic" : "dialog",
      mode: "build",
      prompt: `Stress component ${i} with a reasonably long prompt so the flowtask list can overflow the terminal viewport`,
      goto_true: "1",
      goto_false: "2"
    }))
  };
  const bodyHeight = 30 - 3;
  for (let i = 0; i < count; i++) {
    state.selected = i;
    render(state, 100, 30);
    const focus = Number(state.contentFocusLine);
    assert.ok(Number.isInteger(focus) && focus >= 0, `flowtask row ${i}: focus line is concrete`);
    assert.ok(focus >= state.contentScroll && focus < state.contentScroll + bodyHeight,
      `flowtask row ${i}: focus ${focus} is visible in [${state.contentScroll}, ${state.contentScroll + bodyHeight})`);
  }
});

test("long-list stress never leaves NaN or out-of-range scroll cursors", () => {
  const state = createState();
  state.view = "chat";
  state.focusRegion = "content";
  state.inputMode = false;
  state.snapshot.conversations = Array.from({ length: 1200 }, (_, i) => ({
    id: `nan-stress-${i}`,
    title: `NaN Stress ${i}`,
    updatedAt: new Date(2026, 7, 15, 0, 0, i).toISOString(),
    pinned: false
  }));
  for (let i = 0; i < 5000; i++) {
    state.selected = (i * 97 + 13) % 1200;
    render(state, 120, 34);
    assert.ok(Number.isFinite(state.conversationListScroll), `iteration ${i}: conversationListScroll is finite`);
    assert.ok(Number.isFinite(state.contentScroll), `iteration ${i}: contentScroll is finite`);
    assert.ok(Number.isFinite(state.paletteScroll), `iteration ${i}: paletteScroll is finite`);
    assert.ok(Number.isFinite(state.flowSelectionScroll), `iteration ${i}: flowSelectionScroll is finite`);
  }
});
