"use strict";
// 打包前门禁：拉起"无功能 TUI"（--demo，无真实 runtime）做真实 PTY 光标追踪测试。
// 通过 NEWMARK_TUI_DEMO_MODELS 注入长模型列表，驱动按键流遍历模型选择长菜单，
// 断言每个按键后的选中高亮行始终在屏幕内，且两行一组的模型选项（主行+描述行）
// 同时可见；同时验证备用屏幕缓冲（alternate screen）契约与退出恢复。
//
// 本文件是普通脚本（非 node:test）：Windows 上 node-pty 的 ConPTY 辅助进程会
// 在进程退出后残留句柄，导致 node --test runner 永不退出；脚本在 main() 末尾
// 显式 process.exit(0/1)，确保门禁能确定性结束。
const path = require("node:path");
const fs = require("node:fs");
const { visibleLength } = require("../src/render");

const TUI_ROOT = path.join(__dirname, "..");
const DESKTOP_ROOT = path.join(TUI_ROOT, "..", "DESKTOP");
const PTY_PATH = path.join(DESKTOP_ROOT, "node_modules", "node-pty");

const SELECTED_BG = "\u001b[48;5;238m";
const SELECTED_BG_LIGHT = "\u001b[48;5;250m";
const CLEAR = "\u001b[2J";
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

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  ✖ ${message}`);
};

async function cursorFollowGate(pty) {
  for (const combo of WINDOW_COMBOS) {
    const steps = [
      "\r",
      "\u001b[B", "\u001b[B",
      "\r",
      "\u001b[C",
      ...Array.from({ length: combo.models + 8 }, () => "\u001b[B")
    ];
    const { output, marks, error } = await driveTui(pty, combo.cols, combo.rows, combo.models, steps, 70);
    if (error) {
      fail(`could not spawn demo TUI (${combo.cols}x${combo.rows}): ${error.message}`);
      return;
    }
    if (!output.includes("\u001b[?1049h")) {
      fail(`${combo.cols}x${combo.rows}: TUI did not enter the alternate screen buffer (?1049h)`);
    }
    let modelListSteps = 0;
    let offscreen = 0;
    let descriptionClipped = 0;
    let framesMissing = 0;
    let wideRows = 0;
    marks.forEach((mark, i) => {
      if (i < 4) return;
      const frame = lastFrame(output.slice(0, mark.at));
      const { row, line } = highlightRow(frame);
      const plainLines = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
      const screenRows = plainLines.length;
      if (screenRows > combo.rows) offscreen += 1;
      plainLines.forEach((plain) => {
        if (visibleLength(plain) > combo.cols) wideRows += 1;
      });
      if (row < 0) { framesMissing += 1; return; }
      if (row >= screenRows || row >= combo.rows) { offscreen += 1; return; }
      modelListSteps += 1;
      if (line.includes("Stress Model")) {
        const nextPlain = plainLines[row + 1] || "";
        if (!nextPlain.includes("description")) descriptionClipped += 1;
      }
    });
    if (modelListSteps === 0) fail(`${combo.cols}x${combo.rows}: no model-list frames with a visible highlight`);
    if (offscreen > 0) fail(`${combo.cols}x${combo.rows}: frame/highlight left the window in ${offscreen} frame(s)`);
    if (framesMissing > 0) fail(`${combo.cols}x${combo.rows}: no highlight in ${framesMissing} frame(s)`);
    if (wideRows > 0) fail(`${combo.cols}x${combo.rows}: ${wideRows} row(s) wider than the window`);
    if (descriptionClipped > 0) fail(`${combo.cols}x${combo.rows}: description clipped in ${descriptionClipped} frame(s)`);
    console.log(`  ✓ cursor-follow ${combo.cols}x${combo.rows} (${modelListSteps} model frames)`);
  }
}

async function resizeGate(pty) {
  const proc = pty.spawn(process.execPath, [path.join(TUI_ROOT, "bin", "newmark-tui.js"), "--demo"], {
    name: "xterm-256color", cols: 100, rows: 24, cwd: TUI_ROOT,
    env: { ...process.env, NEWMARK_TUI_DEMO: "1", NEWMARK_TUI_DEMO_MODELS: "40", TERM: "xterm-256color" }
  });
  const seen = await new Promise((resolve) => {
    const output = [];
    const frames = [];
    const timers = [];
    let index = 0;
    proc.onData((chunk) => { output.push(chunk); });
    proc.onExit(() => { timers.forEach(clearTimeout); resolve(frames); });
    const capture = (cols, rows) => frames.push({ cols, rows, frame: lastFrame(output.join("")) });
    const step = () => {
      const schedule = [
        { key: "\r", delay: 900 },
        { key: "\u001b[B", delay: 80 }, { key: "\u001b[B", delay: 80 }, { key: "\r", delay:80 },
        { key: "\u001b[C", delay: 80 },
        { key: "\u001b[B", delay: 80 }, { key: "\u001b[B", delay: 80 }, { key: "\u001b[B", delay: 80 },
        { resize: [40, 12], delay: 500 },
        { key: "\u001b[B", delay: 120 }, { key: "\u001b[B", delay: 120 }, { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 }, { key: "\u001b[B", delay: 120 },
        { resize: [90, 28], delay: 500 },
        { key: "\u001b[B", delay: 120 }, { key: "\u001b[B", delay: 120 }, { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 }, { key: "\u001b[B", delay: 120 },
        { resize: [52, 15], delay: 500 },
        { key: "\u001b[B", delay: 120 }, { key: "\u001b[B", delay: 120 }, { key: "\u001b[B", delay: 120 },
        { key: "\u001b[B", delay: 120 }, { key: "\u001b[B", delay: 120 }
      ];
      if (index >= schedule.length) { timers.push(setTimeout(() => { try { proc.kill(); } catch {} }, 500)); return; }
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
    plainLines.forEach((plain) => { if (visibleLength(plain) > cols) overwide += 1; });
    const { row } = highlightRow(frame);
    if (row < 0 || row >= rows) offscreen += 1;
  });
  if (seen.length < 3) fail(`resize walk captured only ${seen.length} frame(s)`);
  if (offscreen > 0) fail(`resize walk: ${offscreen} frame(s) exceeded the live window`);
  if (overwide > 0) fail(`resize walk: ${overwide} row(s) wider than the live window`);
  console.log(`  ✓ resize adapt (${seen.length} frames)`);
}

async function quitGate(pty) {
  const output = await new Promise((resolve) => {
    const proc = pty.spawn(process.execPath, [path.join(TUI_ROOT, "bin", "newmark-tui.js"), "--demo"], {
      name: "xterm-256color", cols: 80, rows: 24, cwd: TUI_ROOT,
      env: { ...process.env, NEWMARK_TUI_DEMO: "1", NEWMARK_TUI_DEMO_MODELS: "20", TERM: "xterm-256color" }
    });
    let data = "";
    proc.onData((chunk) => { data += chunk; });
    proc.onExit(() => resolve(data));
    setTimeout(() => proc.write("q"), 1500);
  });
  if (!output.includes("\u001b[?1049h")) fail("quit gate: startup did not enter alternate screen");
  if (!output.includes("\u001b[?1049l")) fail("quit gate: quit did not restore primary screen");
  if (!output.includes("\u001b[?25h")) fail("quit gate: quit did not restore cursor");
  if (!output.includes("Newmark TUI demo closed")) fail("quit gate: closing message missing");
  console.log("  ✓ quit restores primary screen + cursor + closing message");
}

async function main() {
  let pty;
  try {
    pty = require(PTY_PATH);
  } catch {
    console.log("SKIP: node-pty unavailable; live-PTY cursor gate not run");
    process.exit(0);
    return;
  }
  await cursorFollowGate(pty);
  await resizeGate(pty);
  await quitGate(pty);
  console.log(failures === 0 ? "cursor-follow-pty: ALL PASS" : `cursor-follow-pty: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("cursor-follow-pty gate error:", error);
  process.exit(1);
});
