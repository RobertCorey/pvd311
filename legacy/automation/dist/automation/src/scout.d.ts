import type { Report } from '../../shared/types.js';
export interface PortalControl {
    id: string;
    label: string;
    tag: 'select' | 'input' | 'textarea';
    type: string | null;
    required: boolean;
    options?: string[];
    name?: string;
}
export interface ScoutInput {
    category: string;
    caseTypeName: string;
    report: Report & {
        id: string;
    };
    controls: PortalControl[];
}
export interface ScoutResult {
    values: Record<string, string>;
    confidence: number;
    notes: string;
}
export declare function scoutFields(input: ScoutInput): Promise<ScoutResult>;
