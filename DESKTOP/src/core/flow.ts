import * as fs from 'fs';
import * as path from 'path';

export interface DialogComponent {
  type: 'dialog';
  id: number;
  mode: 'build' | 'plan' | 'goal';
  prompt: string;
}

export interface LogicComponent {
  type: 'logic';
  id: number;
  prompt: string;
  goto_true: number;
  goto_false: number;
}

export type FlowComponent = DialogComponent | LogicComponent;

export interface FlowWorkflow {
  name: string;
  components: FlowComponent[];
}

export interface FlowStep {
  id: number;
  mode?: string;
  prompt: string;
  isLogic: boolean;
  gotoTrue?: number;
  gotoFalse?: number;
}

export interface ValidationError {
  componentId?: number;
  message: string;
}

export class FlowEngine {
  static load(dir: string, name: string): FlowWorkflow | null {
    const p = path.join(dir, `${name}.Flow.json`);
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''));
    } catch { return null; }
  }

  static save(dir: string, workflow: FlowWorkflow): void {
    const p = path.join(dir, `${workflow.name}.Flow.json`);
    fs.writeFileSync(p, JSON.stringify(workflow, null, 2), 'utf-8');
  }

  static delete(dir: string, name: string): void {
    const p = path.join(dir, `${name}.Flow.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  static listAll(dir: string): string[] {
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.Flow.json'))
        .map(f => f.replace('.Flow.json', ''))
        .sort();
    } catch { return []; }
  }

  static describeWorkflow(wf: FlowWorkflow): string {
    const comps = [...wf.components].sort((a, b) => a.id - b.id);
    if (comps.length === 0) return '';
    const parts: string[] = [];
    for (const c of comps) {
      if (c.type === 'dialog') {
        parts.push(c.mode.charAt(0).toUpperCase() + c.mode.slice(1));
      } else {
        const label = c.prompt.replace(/\{#prompt#\}/g, '<i>').replace(/\n/g, ' ').slice(0, 22);
        parts.push(`?${label}?`);
      }
    }
    return parts.join(' \u2192 ');
  }

  static validate(wf: FlowWorkflow): ValidationError[] {
    const errors: ValidationError[] = [];
    if (!wf.components || wf.components.length === 0) {
      errors.push({ message: 'No components defined.' });
      return errors;
    }

    const ids = new Set<number>();
    for (const c of wf.components) {
      if (typeof c.id === 'number') ids.add(c.id);
    }
    const seenIds = new Set<number>();
    for (const c of wf.components) {
      if (seenIds.has(c.id)) {
        errors.push({ componentId: c.id, message: `Duplicate component ID: ${c.id}` });
      }
      seenIds.add(c.id);

      if (c.type === 'dialog') {
        const mode = c.mode.toLowerCase();
        if (!['build', 'plan', 'goal'].includes(mode)) {
          errors.push({ componentId: c.id, message: `Invalid dialog mode '${c.mode}' (must be build/plan/goal)` });
        }
      } else if (c.type === 'logic') {
        if (!ids.has(c.goto_true)) {
          errors.push({ componentId: c.id, message: `goto_true=${c.goto_true} not found` });
        }
        if (!ids.has(c.goto_false)) {
          errors.push({ componentId: c.id, message: `goto_false=${c.goto_false} not found` });
        }
      } else {
        errors.push({ componentId: (c as any).id, message: `Unknown component type '${(c as any).type}'` });
      }
    }

    if (wf.components.length > 0 && wf.components[0].id !== 0) {
      errors.push({ message: `First component should ideally be ID 0 (found ${wf.components[0].id})` });
    }

    return errors;
  }

  static detectCycles(wf: FlowWorkflow): number[][] {
    const comps = [...wf.components].sort((a, b) => a.id - b.id);
    if (comps.length === 0) return [];

    const idToIdx = new Map<number, number>();
    comps.forEach((c, i) => idToIdx.set(c.id, i));

    const graph = new Map<number, number[]>();
    for (const c of comps) {
      graph.set(c.id, []);
      if (c.type === 'dialog') {
        const nxt = c.id + 1;
        if (idToIdx.has(nxt)) graph.get(c.id)!.push(nxt);
      } else if (c.type === 'logic') {
        if (idToIdx.has(c.goto_true)) graph.get(c.id)!.push(c.goto_true);
        if (idToIdx.has(c.goto_false)) graph.get(c.id)!.push(c.goto_false);
      }
    }

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<number, number>();
    for (const c of comps) color.set(c.id, WHITE);

    const cycles: number[][] = [];
    const dfsPath: number[] = [];

    function dfs(node: number) {
      color.set(node, GRAY);
      dfsPath.push(node);
      for (const nb of graph.get(node) || []) {
        if (!color.has(nb)) continue;
        if (color.get(nb) === GRAY) {
          const start = dfsPath.indexOf(nb);
          cycles.push(dfsPath.slice(start));
        } else if (color.get(nb) === WHITE) {
          dfs(nb);
        }
      }
      dfsPath.pop();
      color.set(node, BLACK);
    }

    for (const c of comps) {
      if (color.get(c.id) === WHITE) dfs(c.id);
    }

    const unique: number[][] = [];
    const seen = new Set<string>();
    for (const cyc of cycles) {
      const key = [...cyc].sort((a, b) => a - b).join(',');
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(cyc);
      }
    }
    return unique;
  }

  static getCycleWarnings(wf: FlowWorkflow): string[] {
    const cycles = FlowEngine.detectCycles(wf);
    return cycles.map(cyc =>
      `[!] Potential logic cycle in '${wf.name}': components [${cyc.join(', ')}] can form a loop.`
    );
  }

  static findWorkflow(name: string, dir: string): string | null {
    const names = FlowEngine.listAll(dir);
    if (names.length === 0) return null;
    if (names.includes(name)) return name;
    const nameLower = name.toLowerCase();
    for (const n of names) {
      if (n.toLowerCase() === nameLower) return n;
    }
    for (const n of names) {
      if (n.toLowerCase().includes(nameLower)) return n;
    }
    return null;
  }

  static autoTrigger(text: string, dir: string): Array<{ name: string; score: number }> {
    const names = FlowEngine.listAll(dir);
    const textLower = text.toLowerCase();
    const results: Array<{ name: string; score: number }> = [];

    for (const n of names) {
      const nLower = n.toLowerCase();
      if (nLower === textLower) {
        results.push({ name: n, score: 1.0 });
      } else if (textLower.includes(nLower) || nLower.includes(textLower)) {
        const longer = nLower.length > textLower.length ? nLower : textLower;
        const shorter = nLower.length > textLower.length ? textLower : nLower;
        const ratio = shorter.length / Math.max(longer.length, 1);
        results.push({ name: n, score: 0.5 + 0.4 * Math.min(ratio, 1.0) });
      } else {
        const words = nLower.split(/[\s_-]+/).filter(w => w.length > 0);
        const matchCount = words.filter(w => textLower.includes(w)).length;
        if (matchCount > 0) {
          results.push({ name: n, score: 0.2 + 0.6 * (matchCount / Math.max(words.length, 1)) });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  static buildDialogPrompt(component: DialogComponent, userInput: string): string {
    const raw = component.prompt;
    const ui = userInput || '';
    const hasPlaceholder = raw.includes('{#prompt#}');

    if (component.mode === 'plan' && ui) {
      if (hasPlaceholder) {
        return raw.replace(/\{#prompt#\}/g, ui);
      } else {
        return `Plan: ${raw}\nUser context: ${ui}`;
      }
    }

    return hasPlaceholder ? raw.replace(/\{#prompt#\}/g, ui) : raw;
  }

  static generateSequence(workflow: FlowWorkflow, start: number, input: string): FlowStep[] {
    const seq: FlowStep[] = [];
    let cur = start;
    let count = 0;
    const max = workflow.components.length + 10;

    while (count < max) {
      count++;
      const comp = workflow.components.find(c => c.id === cur);
      if (!comp) break;

      if (comp.type === 'dialog') {
        const expanded = FlowEngine.buildDialogPrompt(comp, input);
        seq.push({ id: comp.id, mode: comp.mode, prompt: expanded, isLogic: false });
        cur++;
      } else {
        seq.push({
          id: comp.id,
          prompt: comp.prompt.replace(/\{#prompt#\}/g, input),
          isLogic: true,
          gotoTrue: comp.goto_true,
          gotoFalse: comp.goto_false,
        });
        break;
      }
    }
    return seq;
  }

  static resolveGoto(workflow: FlowWorkflow, cur: number, cond: boolean): number {
    const comp = workflow.components.find(c => c.id === cur);
    if (comp?.type === 'logic') {
      return cond ? comp.goto_true : comp.goto_false;
    }
    return cur + 1;
  }
}
