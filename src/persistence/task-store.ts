import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodingTask, TaskStatus, TaskInstruction, TaskFailure } from "../domain/task.js";
import { AgentTaskMode } from "../domain/agent.js";
import { WorkspaceStrategy } from "../domain/repository.js";

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "tasks.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        instruction TEXT NOT NULL,
        follow_up_instructions TEXT NOT NULL,
        mode TEXT NOT NULL,
        workspace_strategy TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        base_sha TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        session_id TEXT,
        workspace_id TEXT,
        exit_code INTEGER,
        failure TEXT,
        log_path TEXT NOT NULL,
        session_resumable INTEGER NOT NULL DEFAULT 0,
        output_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `);

    // Ensure columns exist if table was already created
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN base_sha TEXT;");
    } catch {
      // Column already exists
    }

    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN output_truncated INTEGER NOT NULL DEFAULT 0;");
    } catch {
      // Column already exists
    }
  }

  public saveTask(task: CodingTask): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, repository_id, agent_id, status, instruction, follow_up_instructions,
        mode, workspace_strategy, workspace_root, base_sha, created_at, started_at, finished_at,
        session_id, workspace_id, exit_code, failure, log_path, session_resumable, output_truncated
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        follow_up_instructions = excluded.follow_up_instructions,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        session_id = excluded.session_id,
        exit_code = excluded.exit_code,
        failure = excluded.failure,
        log_path = excluded.log_path,
        session_resumable = excluded.session_resumable,
        output_truncated = excluded.output_truncated;
    `);

    stmt.run(
      task.id,
      task.repositoryId,
      task.agentId,
      task.status,
      task.instruction,
      JSON.stringify(task.followUpInstructions),
      task.mode ?? "implement",
      task.workspaceStrategy,
      task.workspaceRoot,
      task.baseSha ?? null,
      task.createdAt,
      task.startedAt ?? null,
      task.finishedAt ?? null,
      task.sessionId ?? null,
      task.workspaceId ?? null,
      task.exitCode ?? null,
      task.failure ? JSON.stringify(task.failure) : null,
      task.logPath,
      task.sessionResumable ? 1 : 0,
      task.outputTruncated ? 1 : 0
    );
  }

  public getTask(id: string): CodingTask | null {
    const stmt = this.db.prepare("SELECT * FROM tasks WHERE id = ?");
    const row = stmt.get(id) as Record<string, any> | undefined;
    if (!row) {
      return null;
    }
    return this.rowToTask(row);
  }

  public listTasks(): CodingTask[] {
    const stmt = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC");
    const rows = stmt.all() as Record<string, any>[];
    return rows.map((r) => this.rowToTask(r));
  }

  public recoverOnStartup(): number {
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'failed',
          finished_at = ?,
          failure = ?
      WHERE status IN ('queued', 'starting', 'running', 'waiting_for_agent')
    `);

    const failure: TaskFailure = {
      code: "TASK_CANCELLED",
      message: "Server restarted while task was running",
    };

    const result = stmt.run(new Date().toISOString(), JSON.stringify(failure));
    return Number(result.changes);
  }

  private rowToTask(row: Record<string, any>): CodingTask {
    return {
      id: row.id,
      repositoryId: row.repository_id,
      agentId: row.agent_id,
      status: row.status as TaskStatus,
      instruction: row.instruction,
      followUpInstructions: JSON.parse(row.follow_up_instructions || "[]") as TaskInstruction[],
      mode: row.mode as AgentTaskMode,
      workspaceStrategy: row.workspace_strategy as WorkspaceStrategy,
      workspaceRoot: row.workspace_root,
      baseSha: row.base_sha ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      sessionId: row.session_id ?? undefined,
      workspaceId: row.workspace_id ?? undefined,
      exitCode: row.exit_code !== null ? row.exit_code : undefined,
      failure: row.failure ? (JSON.parse(row.failure) as TaskFailure) : undefined,
      logPath: row.log_path,
      sessionResumable: Boolean(row.session_resumable),
      outputTruncated: Boolean(row.output_truncated),
    };
  }

  public close(): void {
    this.db.close();
  }
}
