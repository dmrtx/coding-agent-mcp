import fs from "node:fs";
import path from "node:path";
import { AuditEvent } from "../domain/audit.js";

export class AuditStore {
  private readonly logPath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.logPath = path.join(dataDir, "audit.jsonl");
  }

  public append(event: Omit<AuditEvent, "timestamp">): void {
    const fullEvent: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    const line = JSON.stringify(fullEvent) + "\n";
    try {
      fs.appendFileSync(this.logPath, line, "utf-8");
    } catch {
      // Non-blocking audit failure
    }
  }
}
