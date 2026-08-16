"use strict";
// 打包前门禁：拉起"无功能 TUI"（--demo，无真实 runtime）做真实 PTY 光标追踪测试。
// 通过 NEWMARK_TUI_DEMO_MODELS 注入长模型列表，驱动按键流遍历模型选择长菜单，
// 断言每个按键后的选中高亮行始终在屏幕内，且两行一组的模型选项（主行+描述行）
// 同时可见——覆盖 dev-0.4.4 的居中跟随滚动。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { visibleLength } = require("../src/render");

const TUI_ROOT = path.join(__dirname, "..");
const DESKTOP_ROOT = path.join(TUI_ROOT, "..", "DESKTOP");
const PTY_PATH = path.join(DESKTOP_ROOT, "node_modules", "node-pty");

const SELECTED_BG = "\u001b[48;5;238m";
const SELECTED_BG_LIGHT = "\u001b[48;5;250m";
const CLEAR = "\u001b[2J";
// 窗口组合覆盖用户场景：终端窗口小于内部最小布局（52x20）时必须严格
// 裁剪到窗口内，否则帧会画到窗口之外（高亮行在窗口外不可见）。
const WINDOW_COMBOS = [
  { cols: 100, rows: 24, models: 60 },
  { cols: 40, rows: 12, models: 40 },
  { cols: 60, rows: 16, models: 40 }
];

function lastFrame(output) {
  const starts = [];
  let pos = -1;
  while ((pos = output.indexOf(CLEAR, pos + 1)) >= 0) starts.push(pos);
  return starts.length ? output.slice(starts[starts.length - 1]) : output;
}

function highlightRow(frame) {
  const lines = frame.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(SELECTED_BG) || lines[i].includes(SELECTED_BG_LIGHT)) return { row: i, line: lines[i] };
  }
  return { row: -1, line: "" };
}

function driveTui(pty, cols, rows, modelCount, steps, stepDelayMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = pty.spawn(process.execPath, [path.join(TUI_ROOT, "bin", "newmark-tui.js"), "--demo"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: TUI_ROOT,
        env: {
          ...process.env,
          NEWMARK_TUI_DEMO: "1",
          NEWMARK_TUI_DEMO_MODELS: String(modelCount),
          TERM: "xterm-256color"
        }
      });
    } catch (error) {
      resolve({ error });
      return;
    }
    let output = "";
    const marks = [];
    const timers = [];
    const finish = () => {
      timers.forEach(clearTimeout);
      try { proc.kill(); } catch {}
      resolve({ output, marks });
    };
    proc.onData((chunk) => { output += chunk; });
    proc.onExit(() => {
      timers.forEach(clearTimeout);
      resolve({ output, marks });
    });
    let index = 0;
    const step = () => {
      if (index >= steps.length) {
        timers.push(setTimeout(finish, 500));
        return;
      }
      marks.push({ key: steps[index], at: output.length });
      proc.write(steps[index]);
      index += 1;
      timers.push(setTimeout(step, stepDelayMs));
    };
    timers.push(setTimeout(step, 900));
  });
}

test("featureless --demo TUI keeps the model-selection cursor on screen under PTY stress", { timeout: 240000 }, async (t) => {
  let pty;
  try {
    pty = require(PTY_PATH);
  } catch {
    t.skip("node-pty is unavailable in this environment; skipping live-PTY cursor-follow gate");
    return;
  }
  assert.ok(fs.existsSync(path.join(TUI_ROOT, "src", "data.js")), "TUI sources present");
  for (const combo of WINDOW_COMBOS) {
    const steps = [
      "\r",                          // expand the first workspace
      "\u001b[B", "\u001b[B",        // child menu: chat -> model
      "\r",                          // open the model view (tier column)
      "\u001b[C",                    // move to the Deployment column
      ...Array.from({ length: combo.models + 8 }, () => "\u001b[B") // walk the full list + wrap
    ];
    const { output, marks, error } = await driveTui(pty, combo.cols, combo.rows, combo.models, steps, 70);
    if (error) {
      t.skip(`could not spawn the demo TUI via node-pty: ${error.message}`);
      return;
    }
    let modelListSteps = 0;
    let offscreen = 0;
    let descriptionClipped = 0;
    let framesMissing = 0;
    let wideRows = 0;
    marks.forEach((mark, i) => {
      if (i < 4) return; // startup + navigation frames are not model-list assertions
      const frame = lastFrame(output.slice(0, mark.at));
      const { row, line } = highlightRow(frame);
      const plainLines = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
      const screenRows = plainLines.length;
      // 严格窗口约束：帧行数不得超过窗口高度，每行可见宽度不得超过窗口宽度。
      if (screenRows > combo.rows) offscreen += 1;
      plainLines.forEach((plain) => {
        if (visibleLength(plain) > combo.cols) wideRows += 1;
      });
      if (row < 0) {
        framesMissing += 1;
        return;
      }
      if (row >= screenRows || row >= combo.rows) {
        offscreen += 1;
        return;
      }
      modelListSteps += 1;
      // The focused model option is rendered as a two-row group (label + description);
      // the description row must stay on screen together with the highlighted label.
      // Auto (the router option) has its own description wording, so only assert the
      // two-row group for the injected stress models.
      if (line.includes("Stress Model")) {
        const nextPlain = plainLines[row + 1] || "";
        if (!nextPlain.includes("description")) descriptionClipped += 1;
      }
      void line;
    });
    assert.ok(modelListSteps > 0, `${combo.cols}x${combo.rows}: PTY produced model-list frames with a visible highlight`);
    assert.equal(offscreen, 0, `${combo.cols}x${combo.rows}: frame or highlight left the window in ${offscreen} frame(s)`);
    assert.equal(framesMissing, 0, `${combo.cols}x${combo.rows}: no highlight found in ${framesMissing} frame(s)`);
    assert.equal(wideRows, 0, `${combo.cols}x${combo.rows}: ${wideRows} rendered row(s) wider than the window`);
    assert.equal(descriptionClipped, 0,
      `${combo.cols}x${combo.rows}: focused model description row was clipped off-screen in ${descriptionClipped} frame(s) — cursor-follow must keep both rows visible`);
  }
});

test("the live TUI adapts to PTY window resizes while walking the model list", { timeout: 120000 }, async (t) => {
  let pty;
  try {
    pty = require(PTY_PATH);
  } catch {
    t.skip("node-pty is unavailable in this environment; skipping live-PTY resize gate");
    return;
  }
  const seen = await new Promise((resolve) => {
    const proc = pty.spawn(process.execPath, [path.join(TUI_ROOT, "bin", "newmark-tui.js"), "--demo"], {
      name: "xterm-256color",
      cols: 100,
      rows: 24,
      cwd: TUI_ROOT,
      env: {
        ...process.env,
        NEWMARK_TUI_DEMO: "1",
        NEWMARK_TUI_DEMO_MODELS: String(40),
        TERM: "xterm-256color"
      }
    });
    const output = [];
    const frames = [];
    const timers = [];
    let index = 0;
    proc.onData((chunk) => { output.push(chunk); });
    proc.onExit(() => {
      timers.forEach(clearTimeout);
      resolve(frames);
    });
    const capture = (cols, rows) => {
      frames.push({ cols, rows, frame: lastFrame(output.join("")) });
    };
    const step = () => {
      const schedule = [
        { key: "\r", delay: 900 },
        { key: "\u001b[B", delay: 80 },
        { key: "\u001b[B", delay: 80 },
        { key: "\r", delay: 80 },
        { key: "\u001b[C", delay: 80 },
        { key: "\u001b[B", delay: 80 },
        { key: "\u001b[B", delay: 80 },
        { key: "\u001b[B", delay: 80 },
        { resize: [40, 12], delay: 500 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { resize: [90, 28], delay: 500 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { resize: [52, 15], delay: 500 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 }
      ];
      if (index >= schedule.length) {
        timers.push(setTimeout(() => {
          try { proc.kill(); } catch {}
        }, 500));
        return;
      }
      const item = schedule[index];
      if (item.resize) {
        try { proc.resize(item.resize[0], item.resize[1]); } catch {}
        timers.push(setTimeout(capture, 350, item.resize[0], item.resize[1]));
      } else {
        proc.write(item.key);
      }
      index += 1;
      timers.push(setTimeout(step, item.delay));
    };
    timers.push(setTimeout(step, 900));
  });
  let offscreen = 0;
  let overwide = 0;
  seen.forEach(({ cols, rows, frame }) => {
    const plainLines = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
    if (plainLines.length > rows) offscreen += 1;
    plainLines.forEach((plain) => {
      if (visibleLength(plain) > cols) overwide += 1;
    });
    const { row } = highlightRow(frame);
    if (row < 0 || row >= rows) offscreen += 1;
  });
  assert.ok(seen.length >= 3, `resize walk captured frames after each resize (got ${seen.length})`);
  assert.equal(offscreen, 0, `resize walk: ${offscreen} frame(s) exceeded the live window after resizing`);
  assert.equal(overwide, 0, `resize walk: ${overwide} row(s) wider than the live window after resizing`);
});
