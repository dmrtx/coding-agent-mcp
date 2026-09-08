import fs from "node:fs";
import { AppConfig, RepositoryConfig } from "../config/schema.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

export interface RepositorySummary {
  id: string;
  writable: boolean;
  default_workspace_strategy: string;
  verification_profiles: string[];
}

export class RepositoryRegistry {
  private readonly repositories: Map<string, RepositoryConfig> = new Map();

  constructor(config: AppConfig) {
    for (const [alias, repoConfig] of Object.entries(config.repositories)) {
      this.registerRepository(alias, repoConfig);
    }
  }

  public registerRepository(alias: string, repoConfig: RepositoryConfig): void {
    if (!fs.existsSync(repoConfig.root)) {
      // We allow warning or registering, but let's ensure it's recorded
    }
    this.repositories.set(alias, repoConfig);
  }

  public getRepository(alias: string): RepositoryConfig {
    const repo = this.repositories.get(alias);
    if (!repo) {
      throw new CodingAgentError(
        ErrorCodes.REPOSITORY_NOT_FOUND,
        `Repository with alias '${alias}' is not configured`,
        { repository: alias }
      );
    }
    if (!fs.existsSync(repo.root)) {
      throw new CodingAgentError(
        ErrorCodes.REPOSITORY_NOT_FOUND,
        `Repository root path does not exist for alias '${alias}': ${repo.root}`,
        { repository: alias }
      );
    }
    return repo;
  }

  public listRepositories(): RepositorySummary[] {
    const list: RepositorySummary[] = [];
    for (const [id, repo] of this.repositories.entries()) {
      list.push({
        id,
        writable: repo.writable,
        default_workspace_strategy: repo.default_workspace_strategy,
        verification_profiles: Object.keys(repo.verification_profiles),
      });
    }
    return list;
  }
}
