/** Ensures the retired Auto rating/history feature is absent end-to-end. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const productionSources = [
  'src/core/agent.ts',
  'src/core/conversationKernel.ts',
  'src/core/electronUtilityAgentClient.ts',
  'src/core/electronUtilityRuntimePool.ts',
  'src/core/utilityAgentProtocol.ts',
  'src/core/wslAgentClient.ts',
  'src/core/wslAgentRuntimePool.ts',
  'src/core/wslAgentProtocol.ts',
  'src/conversation-utility-host.ts',
  'src/wsl-agent-host.ts',
  'src/main.ts',
  'src/preload.ts',
  'src/server.ts',
  'src/ui/index.html',
];
const retiredMarkers = [
  'rateAutoRoute',
  'rate_auto_route',
  'AutoRouteRating',
  'autoRouteRating',
  'ratings.jsonl',
  'feedback.jsonl',
  'clearLearnedAutoPreferences',
  'clearLearnedModelPreferences',
  'Auto feedback history',
  'Auto 反馈历史',
];

const root = process.cwd();
const source = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf-8');
const allProduction = productionSources.map(source).join('\n');
for (const marker of retiredMarkers) {
  assert.ok(!allProduction.includes(marker), `retired Auto feedback/history marker remains: ${marker}`);
}

const ui = source('src/ui/index.html');
assert.ok(ui.includes("'model.conservativeTendency': '保守'")
  && ui.includes("'model.balancedTendency': '均衡'")
  && ui.includes("'model.aggressiveTendency': '激进'"), 'the Auto setting exposes conservative, balanced, and aggressive');
assert.ok(!/损失带|loss\s*band/i.test(ui), 'the Auto setting contains no percentage-band wording');
assert.ok(ui.includes('当前符合条件的模型决策') && ui.includes('不替模型选择部署'),
  'the setting explains that the current model decides while tendency remains guidance');

const jev = source('src/core/jevDecision.ts');
assert.ok(jev.includes('objective.tendency')
  && jev.includes('conservative avoids an unnecessary switch')
  && jev.includes('aggressive favors a materially better task specialist'),
'JEV receives model-directed semantics for all three tendencies');

console.log(`Auto feedback-history removal verification passed (${retiredMarkers.length + 4} assertions)`);
