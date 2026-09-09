import fs from "node:fs";
import { AppConfig, RepositoryConfig } from "../config/schema.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { canonicalizePath } from "../security/path-policy.js";

export interface RepositorySummary {
  id: string;
  writable: boolean;
  allow_in_place: boolean;
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
    const canonicalRoot = canonicalizePath(repoConfig.root);
    this.repositories.set(alias, {
      ...repoConfig,
      root: canonicalRoot,
    });
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
        allow_in_place: repo.allow_in_place,
        default_workspace_strategy: repo.default_workspace_strategy,
        verification_profiles: Object.keys(repo.verification_profiles),
      });
    }
    return list;
  }

  /**
   * Returns an iterable of [alias, RepositoryConfig] pairs for T3 authorization.
   * Unlike getRepository(), does NOT validate filesystem existence — used only
   * for canonical workspaceRoot matching.
   */
  public listRepositoriesInternal(): Iterable<[string, RepositoryConfig]> {
    return this.repositories.entries();
  }

  /**
   * Resolves a configured repository by canonical workspace root.
   * Compares canonical paths using canonicalizePath.
   * Returns { alias, config } if found, or undefined if no configured repository matches.
   */
  public resolveRepositoryByWorkspaceRoot(
    workspaceRoot: string
  ): { alias: string; config: RepositoryConfig } | undefined {
    const canonicalTarget = canonicalizePath(workspaceRoot);
    for (const [alias, config] of this.repositories.entries()) {
      const canonicalRepoRoot = canonicalizePath(config.root);
      if (canonicalTarget === canonicalRepoRoot) {
        return { alias, config };
      }
    }
    return undefined;
  }
}

