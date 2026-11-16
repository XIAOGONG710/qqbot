// 世界联想账：持久化只包含受限线索，不包含回忆正文或模型自由联想文本。

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { appendWorldAssociations, validWorldAssociation, type WorldAssociation } from './associations.ts';
import type { WorldEvent } from './events.ts';

interface AssociationFile { version: 1; associations: WorldAssociation[] }

export interface WorldAssociationLedger {
    associations(): readonly WorldAssociation[];
    append(incoming: readonly WorldAssociation[]): number;
}

const validFile = (value: unknown): value is AssociationFile => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as Partial<AssociationFile>).version === 1 && Array.isArray((value as Partial<AssociationFile>).associations)
    && (value as Partial<AssociationFile>).associations!.every(validWorldAssociation));

export function readWorldAssociationLedger(path: string, events: () => readonly WorldEvent[], log: (message: string) => void = () => undefined): WorldAssociationLedger {
    mkdirSync(dirname(path), { recursive: true });
    const loaded = readJsonOr<AssociationFile>(path, { version: 1, associations: [] }, log, { validate: validFile, invalid: 'throw', label: '世界联想账' });
    let values = appendWorldAssociations(events(), [], loaded.associations);
    const persist = () => writeJsonAtomic(path, { version: 1, associations: values } satisfies AssociationFile);
    return {
        associations: () => values,
        append: incoming => {
            const next = appendWorldAssociations(events(), values, incoming);
            const added = next.length - values.length;
            if (added) { values = next; persist(); }
            return added;
        },
    };
}
