import * as fs from 'fs';
import * as path from 'path';
import { ModelIdentity, ModelValidationCache, ModelValidationRecord } from './modelValidation';

function key(model: ModelIdentity): string {
  return `${model.provider}\u0000${model.model}`;
}

/** Durable validation evidence. The file contains probe metadata only, never prompts, tool arguments or credentials. */
export class FileModelValidationCache implements ModelValidationCache {
  private readonly filePath: string;
  private readonly records = new Map<string, ModelValidationRecord>();

  constructor(rootPath: string) {
    this.filePath = path.join(rootPath, 'model-validation', 'records.json');
    this.load();
  }

  get(modelKey: string): ModelValidationRecord | undefined {
    const record = this.records.get(modelKey);
    return record ? JSON.parse(JSON.stringify(record)) as ModelValidationRecord : undefined;
  }

  set(record: ModelValidationRecord): void {
    this.records.set(record.modelKey || key(record.model), JSON.parse(JSON.stringify(record)) as ModelValidationRecord);
    this.save();
  }

  delete(modelKey: string): void {
    if (!this.records.delete(modelKey)) return;
    this.save();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as { schemaVersion?: number; records?: ModelValidationRecord[] };
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) return;
      for (const record of parsed.records) {
        if (record?.schemaVersion !== 1 || !record.modelKey || !record.model?.provider || !record.model?.model) continue;
        this.records.set(record.modelKey, record);
      }
    } catch {
      this.records.clear();
    }
  }

  private save(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const payload = JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] }, null, 2);
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, payload, 'utf-8');
    try {
      fs.renameSync(temporary, this.filePath);
    } catch {
      fs.rmSync(this.filePath, { force: true });
      fs.renameSync(temporary, this.filePath);
    }
  }
}
