// js-yaml 4（MIT）没带类型定义，这里只声明用到的几个
declare module 'js-yaml' {
    export interface Schema {}
    export const CORE_SCHEMA: Schema;
    export function load(text: string, options?: { schema?: Schema; filename?: string }): unknown;
    export function dump(value: unknown, options?: {
        schema?: Schema;
        lineWidth?: number;
        noRefs?: boolean;
        quotingType?: '"' | '\'';
        forceQuotes?: boolean;
        sortKeys?: boolean;
    }): string;
}
