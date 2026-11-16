import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { ExpressionOpportunity } from './expression-opportunity.ts';

interface OpportunityFile { version: 1; opportunities: ExpressionOpportunity[] }
const valid = (value: unknown): value is ExpressionOpportunity => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Partial<ExpressionOpportunity>).driveId === 'string' && typeof (value as Partial<ExpressionOpportunity>).eligible === 'boolean'
    && Array.isArray((value as Partial<ExpressionOpportunity>).blocks) && typeof (value as Partial<ExpressionOpportunity>).reason === 'string');
export interface ExpressionOpportunityLedger { opportunities(): readonly ExpressionOpportunity[]; append(item: ExpressionOpportunity): boolean }
export function readExpressionOpportunityLedger(path: string, log: (message: string) => void = () => undefined): ExpressionOpportunityLedger {
    mkdirSync(dirname(path), { recursive: true });
    const loaded = readJsonOr<OpportunityFile>(path, { version: 1, opportunities: [] }, log, { validate: (v): v is OpportunityFile => Boolean(v && typeof v === 'object' && (v as Partial<OpportunityFile>).version === 1 && Array.isArray((v as Partial<OpportunityFile>).opportunities) && (v as OpportunityFile).opportunities.every(valid)), invalid: 'throw', label: '表达机会账' });
    let values = loaded.opportunities;
    return { opportunities: () => values, append: item => { if (!valid(item) || values.some(x => x.driveId === item.driveId)) return false; values = [...values, item]; writeJsonAtomic(path, { version: 1, opportunities: values }); return true; } };
}
