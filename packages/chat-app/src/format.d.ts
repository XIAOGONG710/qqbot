import type { Part } from './types.d.ts';

export function dayIndex(at: number): number;
export function formatClock(at: number): string;
export function formatDay(at: number, now: number): string;
export function formatStamp(at: number, now: number): string;
export function formatDuration(ms: number | undefined): string;
export function faceDisplay(id: number, name?: string): { text: string; label: string; emoji: boolean };
export function reactionDisplay(id: number): { text: string; label: string; emoji: boolean };
export function previewText(message: { parts: Part[] }, max?: number): string;
export function copyText(message: { parts: Part[] }): string;
export function formatBytes(bytes: number): string;
