import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CodingTask, TaskStatus, TaskInstruction } from "../domain/task.js";
import { AgentTaskMode } from "../domain/agent.js";
import { WorkspaceStrategy } from "../domain/repository.js";
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
    const repoConfig = this.repoRegistry.getRepository(params.repository);
    const agent = this.agentRegistry.getAgent(params.agent);

    const activeCount = this.processManager.getRunningProcessCount();
    if (activeCount >= this.config.server.max_concurrent_tasks) {
      throw new CodingAgentError(
        ErrorCodes.CONCURRENCY_LIMIT_REACHED,
        `Maximum concurrent tasks (${this.config.server.max_concurrent_tasks}) reached. Wait for an active task to finish.`
      );
    }

    const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const mode = params.mode ?? "implement";
    const workspaceStrategy = params.workspace_strategy ?? repoConfig.default_workspace_strategy;

    const workspace = await this.workspaceManager.createWorkspace(
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
    const task: CodingTask = {
      id: taskId,
      repositoryId: params.repository,
      agentId: params.agent,
      status: "starting",
      instruction: params.instruction,
      followUpInstructions: [],
      mode,
      workspaceStrategy: workspace.strategy,
      workspaceRoot: workspace.workspaceRoot,
      createdAt: new Date().toISOString(),
      logPath,
      sessionResumable: true,
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
    const timeoutMs = (agentConfig?.default_timeout_seconds ?? this.config.server.default_task_timeout_seconds) * 1000;

    const spawnInfo = await agent.prepareStart({
      taskId,
      repositoryRoot: repoConfig.root,
      workspaceRoot: workspace.workspaceRoot,
      instruction: params.instruction,
      mode,
      timeoutMs,
      environment: env,
    });

    task.sessionId = spawnInfo.sessionId;
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
      onExit: (code, signal, timedOut) => {
        this.handleProcessExit(task, code, signal, timedOut);
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

    if (this.processManager.isProcessRunning(task.id)) {
      throw new CodingAgentError(
        ErrorCodes.TASK_NOT_RUNNING,
        `Task '${params.task_id}' is currently running; wait for completion before continuing`,
        { task_id: params.task_id }
      );
    }

    const agent = this.agentRegistry.getAgent(task.agentId);
    if (!agent.prepareContinue) {
      throw new CodingAgentError(
        ErrorCodes.TASK_NOT_RESUMABLE,
        `Agent '${task.agentId}' does not support task continuation`,
        { agent: task.agentId }
      );
    }

    const activeCount = this.processManager.getRunningProcessCount();
    if (activeCount >= this.config.server.max_concurrent_tasks) {
      throw new CodingAgentError(
        ErrorCodes.CONCURRENCY_LIMIT_REACHED,
        `Maximum concurrent tasks (${this.config.server.max_concurrent_tasks}) reached.`
      );
    }

    const followUp: TaskInstruction = {
      id: crypto.randomUUID(),
      text: params.instruction,
      receivedAt: new Date().toISOString(),
    };

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
    const timeoutMs = (agentConfig?.default_timeout_seconds ?? this.config.server.default_task_timeout_seconds) * 1000;

    const spawnInfo = await agent.prepareContinue({
      taskId: task.id,
      workspaceRoot: task.workspaceRoot,
      sessionId: task.sessionId,
      instruction: params.instruction,
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
      onExit: (code, signal, timedOut) => {
        this.handleProcessExit(task, code, signal, timedOut);
      },
    });

    return {
      task_id: task.id,
      status: task.status,
      instruction: params.instruction,
    };
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
        truncated: false,
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
        truncated: false,
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
    const truncated = nextCursor < totalBytes;

    return {
      task_id: taskId,
      cursor: nextCursor,
      output: buffer.toString("utf-8"),
      truncated,
      total_bytes: totalBytes,
    };
  }

  public async cancelTask(taskId: string): Promise<{ task_id: string; cancelled: boolean }> {
    const task = this.getTask(taskId);

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
