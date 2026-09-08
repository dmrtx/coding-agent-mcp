export interface VerificationProfile {
  command: string[];
  timeoutSeconds: number;
  env?: Record<string, string>;
}

export interface VerificationResult {
  profile: string;
  passed: boolean;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
