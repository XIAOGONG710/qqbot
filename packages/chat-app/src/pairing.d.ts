import type { Credentials } from './types.d.ts';

export const CODE_LENGTH: number;
export const DEVICE_NAME_MAX: number;

export function normalizeCode(input: string): string;
export function displayCode(input: string): string;
export function normalizeDeviceName(input: string): string;
export function defaultDeviceName(userAgent: string): string;
export function buildPairRequest(code: string, deviceName: string):
    | { ok: true; body: { code: string; deviceName: string } }
    | { ok: false; field: 'code' | 'deviceName'; message: string };
export type PairFailure = 'invalid' | 'expired' | 'locked' | 'rate_limited' | 'server' | 'malformed';
export function readPairResponse(status: number, body: unknown):
    | { ok: true; credentials: Credentials }
    | { ok: false; reason: PairFailure; message: string };
