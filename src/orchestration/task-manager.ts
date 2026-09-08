import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CodingTask, TaskStatus, TaskInstruction } from "../domain/task.js";
import { AgentTaskMode } from "../domain/agent.js";
import { WorkspaceStrategy, WorkspaceDescriptor } from "../domain/repository.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { RepositoryRegistry } from "../repositories/repository-registry.js";
import { WorkspaceManager } from "../repositories/workspace-manager.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { ProcessManager } from "./process-manager.js";
import { TaskStore } from "../persistence/task-store.js";
import { AuditStore } from "../persistence/audit-store.js";
import { sanitizeEnvironment } from "../security/environment-policy.js";
import { AppConfig } from "../config/schema.js";

export interface StartTaskParams {
  repository: string;
  agent: string;
  instruction: string;
  mode?: AgentTaskMode;
  workspace_strategy?: WorkspaceStrategy;
}

export interface ContinueTaskParams {
  task_id: string;
  instruction: string;
}

export interface TaskOutputResult {
  task_id: string;
  cursor: number;
  output: string;
  has_more: boolean;
  source_truncated: boolean;
  truncated: boolean;
  total_bytes: number;
}

export class TaskManager {
  private readonly config: AppConfig;
  private readonly repoRegistry: RepositoryRegistry;
  private readonly workspaceManager: WorkspaceManager;
  private readonly agentRegistry: AgentRegistry;
  private readonly processManager: ProcessManager;
  private readonly taskStore: TaskStore;
  private readonly auditStore: AuditStore;

  constructor(
    config: AppConfig,
    repoRegistry: RepositoryRegistry,
    workspaceManager: WorkspaceManager,
    agentRegistry: AgentRegistry,
    processManager: ProcessManager,
    taskStore: TaskStore,
    auditStore: AuditStore
  ) {
    this.config = config;
    this.repoRegistry = repoRegistry;
    this.workspaceManager = workspaceManager;
    this.agentRegistry = agentRegistry;
    this.processManager = processManager;
    this.taskStore = taskStore;
    this.auditStore = auditStore;
  }

  public async startTask(params: StartTaskParams): Promise<{
    task_id: string;
    status: TaskStatus;
    agent: string;
    repository: string;
  }> {
    const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    // Atomically reserve concurrency slot BEFORE any await to prevent race conditions
    this.processManager.reserveSlot(taskId, this.config.server.max_concurrent_tasks);

    let workspace: WorkspaceDescriptor | undefined;
    let task: CodingTask | undefined;

    try {
      const repoConfig = this.repoRegistry.getRepository(params.repository);

      // Validate agent availability
      const agent = await this.agentRegistry.validateAgentAvailable(params.agent);

      const mode = params.mode ?? "implement";
      const workspaceStrategy = params.workspace_strategy ?? repoConfig.default_workspace_strategy;

      workspace = await this.workspaceManager.createWorkspace(
        taskId,
        params.repository,
        repoConfig,
        workspaceStrategy
      );

      this.auditStore.append({
        type: "workspace.created",
        taskId,
        repositoryId: params.repository,
        details: { strategy: workspace.strategy, root: workspace.workspaceRoot },
      });

      const logPath = path.join(this.config.server.data_dir, "logs", `${taskId}.log`);
      task = {
        id: taskId,
        repositoryId: params.repository,
        agentId: params.agent,
        status: "starting",
        instruction: params.instruction,
        followUpInstructions: [],
        mode,
        workspaceStrategy: workspace.strategy,
        workspaceRoot: workspace.workspaceRoot,
        baseSha: workspace.baseSha,
        createdAt: new Date().toISOString(),
        logPath,
        // Agents that return sessions dynamically (like AGY) start as non-resumable until extracted
        sessionResumable: params.agent === "agy" ? false : true,
        outputTruncated: false,
      };

      this.taskStore.saveTask(task);
      this.auditStore.append({
        type: "task.created",
        taskId,
        repositoryId: params.repository,
        agentId: params.agent,
        details: { instruction: params.instruction, mode },
      });

      const agentConfig = this.config.agents[params.agent];
      const env = sanitizeEnvironment(agentConfig?.env_allowlist);
      const timeoutMs =
        (agentConfig?.default_timeout_seconds ?? this.config.server.default_task_timeout_seconds) * 1000;

      const spawnInfo = await agent.prepareStart({
        taskId,
        repositoryRoot: repoConfig.root,
        workspaceRoot: workspace.workspaceRoot,
        instruction: params.instruction,
        mode,
        timeoutMs,
        environment: env,
      });

      if (spawnInfo.sessionId) {
        task.sessionId = spawnInfo.sessionId;
        task.sessionResumable = true;
      }
      task.startedAt = new Date().toISOString();
      task.status = "running";
      this.taskStore.saveTask(task);

      this.auditStore.append({
        type: "task.started",
        taskId,
        agentId: params.agent,
        details: { command: spawnInfo.command },
      });

      this.processManager.spawnProcess({
        taskId,
        command: spawnInfo.command,
        args: spawnInfo.args,
        cwd: spawnInfo.cwd,
        env: spawnInfo.env,
        timeoutMs,
        logPath,
        maxOutputBytes: this.config.server.output_limit_bytes,
        onOutput: (chunk: string) => {
          if (!task!.sessionId && agent.extractSessionId) {
            const extracted = agent.extractSessionId(chunk, "");
            if (extracted) {
              task!.sessionId = extracted;
              task!.sessionResumable = true;
              this.taskStore.saveTask(task!);
            }
          }
        },
        onOutputTruncated: () => {
          task!.outputTruncated = true;
          this.taskStore.saveTask(task!);
          this.auditStore.append({
            type: "agent.output_truncated",
            taskId: task!.id,
            agentId: task!.agentId,
          });
        },
        onExit: (code, signal, timedOut) => {
          // Extract session ID from complete log if not yet captured
          if (!task!.sessionId && agent.extractSessionId && fs.existsSync(task!.logPath)) {
            try {
              const fullLog = fs.readFileSync(task!.logPath, "utf-8");
              const extracted = agent.extractSessionId(fullLog, "");
              if (extracted) {
                task!.sessionId = extracted;
                task!.sessionResumable = true;
              } else {
                task!.sessionResumable = false;
              }
            } catch {
              task!.sessionResumable = false;
            }
          } else if (!task!.sessionId && params.agent === "agy") {
            task!.sessionResumable = false;
          }
          this.handleProcessExit(task!, code, signal, timedOut);
        },
      });

      this.auditStore.append({
        type: "agent.process_spawned",
        taskId,
        agentId: params.agent,
      });

      return {
        task_id: taskId,
        status: task.status,
        agent: params.agent,
        repository: params.repository,
      };
    } catch (err) {
      this.processManager.releaseSlot(taskId);

      // Rollback on startup or spawn failure
      if (workspace) {
        try {
          await this.workspaceManager.cleanupWorkspace(taskId);
        } catch {
          // Non-blocking cleanup
        }
      }

      if (task) {
        task.status = "failed";
        task.finishedAt = new Date().toISOString();
        task.failure = {
          code: err instanceof CodingAgentError ? err.code : ErrorCodes.PROCESS_START_FAILED,
          message: err instanceof Error ? err.message : String(err),
        };
        this.taskStore.saveTask(task);
      }

      throw err;
    }
  }

  public async continueTask(params: ContinueTaskParams): Promise<{
    task_id: string;
    status: TaskStatus;
    instruction: string;
  }> {
    const task = this.taskStore.getTask(params.task_id);
    if (!task) {
      throw new CodingAgentError(
        ErrorCodes.TASK_NOT_FOUND,
        `Task with ID '${params.task_id}' was not found`,
        { task_id: params.task_id }
      );
    }

    if (task.status !== "completed") {
      throw new CodingAgentError(
        ErrorCodes.TASK_NOT_RESUMABLE,
        `Task '${params.task_id}' has status '${task.status}' and cannot be continued. Only completed tasks are resumable.`,
        { task_id: params.task_id, status: task.status }
      );
    }

    if (!task.sessionResumable || !task.sessionId) {
      throw new CodingAgentError(
        ErrorCodes.TASK_NOT_RESUMABLE,
        `Task '${params.task_id}' cannot be resumed (no valid session identifier was captured from initial execution)`,
        { task_id: params.task_id }
      );
    }

    // Atomically reserve concurrency slot BEFORE any await to prevent race conditions
    this.processManager.reserveSlot(task.id, this.config.server.max_concurrent_tasks);

    const previousStatus = task.status;
    const previousStartedAt = task.startedAt;
    const previousFinishedAt = task.finishedAt;
    const previousExitCode = task.exitCode;
    const previousFailure = task.failure;

    const followUp: TaskInstruction = {
      id: crypto.randomUUID(),
      text: params.instruction,
      receivedAt: new Date().toISOString(),
    };

    try {
      // Validate agent availability
      const agent = await this.agentRegistry.validateAgentAvailable(task.agentId);
      if (!agent.prepareContinue) {
        throw new CodingAgentError(
          ErrorCodes.TASK_NOT_RESUMABLE,
          `Agent '${task.agentId}' does not support task continuation`,
          { agent: task.agentId }
        );
      }
      task.followUpInstructions.push(followUp);
      task.status = "running";
      task.startedAt = new Date().toISOString();
      task.finishedAt = undefined;
      task.exitCode = undefined;
      task.failure = undefined;

      this.taskStore.saveTask(task);
      this.auditStore.append({
        type: "task.instruction_added",
        taskId: task.id,
        agentId: task.agentId,
        details: { instruction: params.instruction },
      });

      const agentConfig = this.config.agents[task.agentId];
      const env = sanitizeEnvironment(agentConfig?.env_allowlist);
      const timeoutMs =
        (agentConfig?.default_timeout_seconds ?? this.config.server.default_task_timeout_seconds) * 1000;

      // Pass task.mode to prepareContinue so safety flags (--disable-write, --disable-shell, --mode plan) are preserved
      const spawnInfo = await agent.prepareContinue({
        taskId: task.id,
        workspaceRoot: task.workspaceRoot,
        sessionId: task.sessionId,
        instruction: params.instruction,
        mode: task.mode,
        timeoutMs,
        environment: env,
      });

      this.processManager.spawnProcess({
        taskId: task.id,
        command: spawnInfo.command,
        args: spawnInfo.args,
        cwd: spawnInfo.cwd,
        env: spawnInfo.env,
        timeoutMs,
        logPath: task.logPath,
        maxOutputBytes: this.config.server.output_limit_bytes,
        onOutput: (chunk: string) => {
          if (agent.extractSessionId) {
            const extracted = agent.extractSessionId(chunk, "");
            if (extracted) {
              task!.sessionId = extracted;
              this.taskStore.saveTask(task!);
            }
          }
        },
        onOutputTruncated: () => {
          task!.outputTruncated = true;
          this.taskStore.saveTask(task!);
          this.auditStore.append({
            type: "agent.output_truncated",
            taskId: task!.id,
            agentId: task!.agentId,
          });
        },
        onExit: (code, signal, timedOut) => {
          if (agent.extractSessionId && fs.existsSync(task!.logPath)) {
            try {
              const fullLog = fs.readFileSync(task!.logPath, "utf-8");
              const extracted = agent.extractSessionId(fullLog, "");
              if (extracted) {
                task!.sessionId = extracted;
              }
            } catch {
              // Non-blocking log reading
            }
          }
          this.handleProcessExit(task!, code, signal, timedOut);
        },
      });

      return {
        task_id: task.id,
        status: task.status,
        instruction: params.instruction,
      };
    } catch (err) {
      this.processManager.releaseSlot(task.id);

      // Complete rollback on continue failure: remove the unexecuted instruction and restore previous timestamps/status
      task.followUpInstructions.pop();
      task.startedAt = previousStartedAt;
      task.status = previousStatus;
      task.finishedAt = previousFinishedAt;
      task.exitCode = previousExitCode;
      task.failure = previousFailure;
      this.taskStore.saveTask(task);
      throw err;
    }
  }

  public getTask(taskId: string): CodingTask {
    const task = this.taskStore.getTask(taskId);
    if (!task) {
      throw new CodingAgentError(
        ErrorCodes.TASK_NOT_FOUND,
        `Task with ID '${taskId}' was not found`,
        { task_id: taskId }
      );
    }
    return task;
  }

  public getTaskOutput(
    taskId: string,
    cursor = 0,
    maxBytes = 20_000
  ): TaskOutputResult {
    const task = this.getTask(taskId);

    if (!fs.existsSync(task.logPath)) {
      return {
        task_id: taskId,
        cursor: 0,
        output: "",
        has_more: false,
        source_truncated: Boolean(task.outputTruncated),
        truncated: Boolean(task.outputTruncated),
        total_bytes: 0,
      };
    }

    const stat = fs.statSync(task.logPath);
    const totalBytes = stat.size;

    if (cursor >= totalBytes) {
      return {
        task_id: taskId,
        cursor: totalBytes,
        output: "",
        has_more: false,
        source_truncated: Boolean(task.outputTruncated),
        truncated: Boolean(task.outputTruncated),
        total_bytes: totalBytes,
      };
    }

    const readLength = Math.min(maxBytes, totalBytes - cursor);
    const buffer = Buffer.alloc(readLength);

    const fd = fs.openSync(task.logPath, "r");
    try {
      fs.readSync(fd, buffer, 0, readLength, cursor);
    } finally {
      fs.closeSync(fd);
    }

    const nextCursor = cursor + readLength;
    const hasMore = nextCursor < totalBytes;
    const sourceTruncated = Boolean(task.outputTruncated);

    return {
      task_id: taskId,
      cursor: nextCursor,
      output: buffer.toString("utf-8"),
      has_more: hasMore,
      source_truncated: sourceTruncated,
      truncated: hasMore || sourceTruncated,
      total_bytes: totalBytes,
    };
  }

  public async cancelTask(taskId: string): Promise<{ task_id: string; cancelled: boolean }> {
    const task = this.getTask(taskId);

    // Enforce that task is currently running or starting
    if (task.status !== "running" && task.status !== "starting") {
      throw new CodingAgentError(
        ErrorCodes.TASK_NOT_RUNNING,
        `Task '${taskId}' cannot be cancelled because it is not currently running (status: ${task.status})`,
        { task_id: taskId, status: task.status }
      );
    }

    this.auditStore.append({
      type: "task.cancel_requested",
      taskId,
      agentId: task.agentId,
    });

    const stopped = await this.processManager.cancelProcess(taskId);
    task.status = "cancelled";
    task.finishedAt = new Date().toISOString();
    task.failure = {
      code: ErrorCodes.TASK_CANCELLED,
      message: "Task was explicitly cancelled by caller",
    };

    this.taskStore.saveTask(task);
    this.auditStore.append({
      type: "task.cancelled",
      taskId,
      agentId: task.agentId,
    });

    return {
      task_id: taskId,
      cancelled: stopped,
    };
  }

  private handleProcessExit(
    task: CodingTask,
    code: number | null,
    signal: string | null,
    timedOut: boolean
  ): void {
    task.finishedAt = new Date().toISOString();
    task.exitCode = code ?? undefined;

    if (timedOut) {
      task.status = "timed_out";
      task.failure = {
        code: ErrorCodes.TASK_TIMEOUT,
        message: `Task timed out`,
      };
      this.auditStore.append({
        type: "task.timed_out",
        taskId: task.id,
        agentId: task.agentId,
      });
    } else if (signal === "SIGTERM" || signal === "SIGKILL" || task.status === "cancelled") {
      task.status = "cancelled";
      task.failure = {
        code: ErrorCodes.TASK_CANCELLED,
        message: `Task process was terminated with signal ${signal}`,
      };
      this.auditStore.append({
        type: "task.cancelled",
        taskId: task.id,
        agentId: task.agentId,
      });
    } else if (code === 0) {
      task.status = "completed";
      this.auditStore.append({
        type: "task.completed",
        taskId: task.id,
        agentId: task.agentId,
        details: { exitCode: 0 },
      });
    } else {
      task.status = "failed";
      task.failure = {
        code: ErrorCodes.INTERNAL_ERROR,
        message: `Agent process exited with non-zero code ${code}`,
        details: { exitCode: code },
      };
      this.auditStore.append({
        type: "task.failed",
        taskId: task.id,
        agentId: task.agentId,
        details: { exitCode: code },
      });
    }

    this.taskStore.saveTask(task);
  }
}
