import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../core/config';
import { configPatchAffectsConversationRuntime } from '../core/configRuntimeImpact';

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-visual-preferences-'));
  try {
    const preferences = require('../core/uiPreferences') as {
      normalizeUiBackgroundColor(value: unknown): string;
      normalizeUiFontFamily(value: unknown): string;
      normalizeUiTheme(value: unknown): string;
    };
    assert.equal(preferences.normalizeUiBackgroundColor('#12aBcD'), '#12ABCD');
    assert.equal(preferences.normalizeUiBackgroundColor('red; background:url(file:///secret)'), '');
    assert.equal(preferences.normalizeUiFontFamily('思源黑体'), '思源黑体');
    assert.equal(preferences.normalizeUiFontFamily('Arial; color:red'), '');
    assert.equal(preferences.normalizeUiTheme('system'), 'system');
    assert.equal(preferences.normalizeUiTheme('hostile'), 'dark');
    assert.equal(configPatchAffectsConversationRuntime({
      theme: 'light',
      backgroundColor: '#123456',
      fontFamily: '思源黑体',
      layoutState: { leftCollapsed: true },
      gradientColors: ['#123456'],
      dialogStyle: 'compact',
      defaultFlow: 'default',
    }), false, 'visual and layout preferences do not invalidate conversation runtimes');
    assert.equal(configPatchAffectsConversationRuntime({ experimentalUiDensity: 'compact' }), false, 'unknown structured UI preferences follow the UI persistence fallback without invalidating runtimes');
    assert.equal(configPatchAffectsConversationRuntime({ providers: [] }), true, 'provider changes invalidate an idle conversation kernel');
    assert.equal(configPatchAffectsConversationRuntime({ language: 'zh' }), true, 'reply language changes affect the Agent system prompt');
    assert.equal(configPatchAffectsConversationRuntime('{}'), true, 'a raw config document is conservatively runtime-affecting');

    const config = new ConfigManager(root);
    assert.equal(config.getStr('ui', 'background_color'), '', 'custom background defaults to theme background');
    assert.equal(config.getStr('ui', 'font_family'), '', 'custom font defaults to the built-in font stack');
    assert.equal(config.getNum('ui', 'glass_alpha'), 0.85, 'glass opacity defaults to 85 percent');
    config.set('ui', 'dark_mode', 'light');
    config.set('ui', 'background_color', '#123456');
    config.set('ui', 'font_family', '思源黑体');
    config.set('ui', 'glass_alpha', 0);
    config.save();

    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'config.json'), JSON.stringify({ ui: {
      dark_mode: { value: 'dark' },
      background_color: { value: '#FFFFFF' },
      font_family: { value: 'Untrusted Workspace Font' },
    } }), 'utf-8');
    const reloaded = new ConfigManager(root);
    reloaded.loadWorkspaceConfig(workspace);
    assert.equal(reloaded.getStr('ui', 'dark_mode'), 'light', 'workspace config cannot override the user theme');
    assert.equal(reloaded.getStr('ui', 'background_color'), '#123456', 'workspace config cannot override the user background');
    assert.equal(reloaded.getStr('ui', 'font_family'), '思源黑体', 'workspace config cannot override the user font');
    assert.equal(reloaded.getNum('ui', 'glass_alpha'), 0, 'a legitimate fully transparent glass value survives reload');

    const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf-8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
    const mainSource = fs.readFileSync(path.join(process.cwd(), 'src', 'main.ts'), 'utf-8');
    const serverSource = fs.readFileSync(path.join(process.cwd(), 'src', 'server.ts'), 'utf-8');
    const iconBuildSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'build-ui-icons.cjs'), 'utf-8');
    assert.ok(ui.includes('--app-bg') && ui.includes('applyUiAppearance'), 'renderer applies a separate semantic application background');
    assert.ok(ui.includes('setBackgroundColor') && ui.includes('setFontFamily'), 'General settings expose background and font controls');
    assert.ok(ui.includes('settings.backgroundColor') && ui.includes('settings.fontFamily'), 'appearance controls are localized');
    assert.ok(main.includes('backgroundColor') && main.includes('fontFamily'), 'Electron state and save paths expose visual preferences');
    assert.ok(/if \([^\r\n]*configPatchAffectsConversationRuntime\)\(cfg\)\)\s*resetConversationKernel\(\)/.test(main), 'Electron only invalidates the conversation kernel for runtime-affecting config');

    const glassSliderMatches = ui.match(/<input[^>]+id="settings-glass-opacity"[^>]+type="range"[^>]*>/g) || [];
    assert.equal(glassSliderMatches.length, 1, 'General settings keep one glass/opacity slider');
    const glassSlider = glassSliderMatches[0] || '';
    assert.ok(glassSlider.includes('oninput="window.previewGlassOpacity(this.value)"')
      && glassSlider.includes('onchange="window.commitGlassOpacity(this.value)"'), 'slider input previews only while change commits explicitly');
    assert.ok(ui.includes('api.saveConfig({ glassAlpha: presentation.alpha })'), 'glass change saves the normalized glassAlpha field');
    assert.ok(mainSource.includes("case 'glassAlpha': agent.config.set('ui', 'glass_alpha', value); break;")
      && serverSource.includes("case 'glassAlpha': agent.config.set('ui', 'glass_alpha', value); break;"), 'Electron and HTTP save paths map glassAlpha explicitly to ui.glass_alpha');
    assert.ok(mainSource.includes("agent.config.getNum('ui', 'glass_alpha') ?? 0.85")
      && ui.includes('s.glassAlpha ?? 0.85'), 'backend and renderer hydration preserve a legitimate zero instead of falling back to 85 percent');

    const glassFunction = ui.match(/function glassPresentationForOpacity\(value\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(glassFunction, 'renderer exposes a deterministic glass presentation function');
    const glassPresentationForOpacity = new Function('value', glassFunction![1]) as (value: unknown) => {
      opacityPercent: number;
      transparencyPercent: number;
      blur1: number;
      blur2: number;
      blur3: number;
      alpha1: number;
      alpha2: number;
      alpha3: number;
      alpha: number;
    };
    const anchors = [
      { opacity: 0, transparency: 100, blur: [8, 16, 20], alpha: [0, 0, 0] },
      { opacity: 25, transparency: 75, blur: [6, 12, 15], alpha: [0.1875, 0.2, 0.2125] },
      { opacity: 50, transparency: 50, blur: [4, 8, 10], alpha: [0.375, 0.4, 0.425] },
      { opacity: 85, transparency: 15, blur: [1.2, 2.4, 3], alpha: [0.6375, 0.68, 0.7225] },
      { opacity: 100, transparency: 0, blur: [0, 0, 0], alpha: [0.75, 0.8, 0.85] },
    ];
    for (const anchor of anchors) {
      const result = glassPresentationForOpacity(anchor.opacity);
      assert.equal(result.opacityPercent, anchor.opacity, `glass opacity anchor ${anchor.opacity} is retained`);
      assert.equal(result.transparencyPercent, anchor.transparency, `glass transparency anchor ${anchor.opacity} is inverted`);
      assert.deepEqual([result.blur1, result.blur2, result.blur3], anchor.blur, `glass blur anchor ${anchor.opacity} follows 0.4B/0.8B/B`);
      assert.deepEqual([result.alpha1, result.alpha2, result.alpha3], anchor.alpha, `glass alpha anchor ${anchor.opacity} follows 0.75A/0.80A/0.85A`);
    }
    assert.ok(ui.includes('--glass-rgb-1:')
      && ui.includes('rgb(var(--glass-rgb-1) / var(--glass-alpha-1))')
      && ui.includes("root.style.setProperty('--glass-alpha-1'")
      && !ui.includes("var bg1 = 'rgba(10,10,26,"), 'glass opacity updates numeric variables while theme palettes own RGB channels');
    assert.ok(!/backdrop-filter:\s*blur\(\d/.test(ui), 'glass surfaces use the three tunable blur variables instead of fixed pixel widths');
    const cssBlock = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(ui)?.[1] || '';
    };
    assert.ok(!/backdrop-filter|translateZ/.test(cssBlock('#input-area textarea'))
      && !/backdrop-filter|translateZ/.test(cssBlock('.tool-select'))
      && /backdrop-filter:\s*blur\(var\(--glass-blur-3\)\)/.test(cssBlock('#input-area')),
    'input controls reuse the parent level-3 glass surface without nested offscreen filters or forced layers');
    for (const selector of ['#app', '#topbar', '#topbar .title', '#main', '#left', '#right', '#bottom', '#center-stack', '#center', '#chat-area', '#input-area', '#submit-btn', '.sub-win-overlay']) {
      assert.ok(!/translateZ/.test(cssBlock(selector)), `${selector} does not force a permanent compositor layer`);
    }
    for (const selector of ['#left', '#left-content', '#left-thumb', '#left-secondary', '#right', '.tab-panel', '#submit-btn', '.sub-win-overlay', '.sub-win']) {
      assert.ok(!/will-change/.test(cssBlock(selector)), `${selector} does not reserve a compositor layer while idle`);
    }
    assert.ok(ui.includes("return !!(els.prompt && /\\S/.test(String(els.prompt.value || '')))"),
      'large prompt presence checks short-circuit without trimming and copying the whole value');
    assert.ok(ui.includes("if (!isCurrentConversationRunning()) return;")
      && ui.includes("btn.getAttribute('data-visual-key') === visualKey"),
    'idle prompt input avoids redundant animation-frame work and submit-button DOM rewrites are cached');
    assert.ok(iconBuildSource.includes('collectUsedIconNames')
      && iconBuildSource.includes('filterLucideSprite')
      && iconBuildSource.includes('embedded ${usedIconNames.size} used Lucide symbols'), 'UI build embeds only Lucide symbols actually referenced by the source');
    assert.ok(ui.includes('appendDomNodesInBatches')
      && ui.includes('schedulePromptInputRefresh')
      && ui.includes('scheduleEditorInputRefresh'), 'large sidebar lists are batched and high-frequency input rendering is merged through animation frames');

    console.log('Visual preferences verification passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
