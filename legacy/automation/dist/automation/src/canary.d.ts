export interface CanaryResult {
    ok: boolean;
    missing: string[];
    notes: string[];
}
export declare function runCanary(): Promise<CanaryResult>;
