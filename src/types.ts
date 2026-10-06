export type ModelProfile = { model: string; baseUrl: string; reviewModel: string; customModels: string[] };
export type Settings = {
  provider: 'openai' | 'deepseek' | 'glm' | 'kimi' | 'anthropic' | 'compatible';
  model: string;
  baseUrl: string;
  reviewBaseUrl: string;
  modelProfiles: Partial<Record<Settings['provider'], ModelProfile>>;
  reviewProvider: 'same' | Settings['provider'];
  reviewModel: string;
  workspace: string;
  permissionMode: 'ask' | 'read-only';
  webAccess: boolean;
  mcpEnabled: boolean;
  nativeToolsEnabled: boolean;
  commandTimeoutSeconds: 30 | 120 | 300;
  customInstructions: string;
  theme: 'system' | 'light' | 'dark';
  fontSize: 'small' | 'medium' | 'large';
  sendShortcut: 'enter' | 'mod-enter';
  completionNotifications: boolean;
  preventSleep: boolean;
  memoryEnabled: boolean;
  autoMemory: boolean;
  recentWorkspaces?: string[];
  hasKey: boolean;
  reviewHasKey: boolean;
  keyStatus: Record<Settings['provider'], boolean>;
};
export type ModelProvider = { id: Settings['provider']; name: string; baseUrl: string; keyUrl: string; defaultModel: string; reviewModel: string; models: { id: string; name: string }[] };
export type CustomAgent = { id: string; name: string; prompt: string; skills: string[]; mode: 'read-only' | 'full' };
export type SkillSummary = { name: string; title: string; description: string };
export type ExperienceEntry = { id: string; taskId: string; sessionId: string; summary: string; tools: string[]; sources: { path: string; hash: string }[]; status: 'candidate' | 'approved' | 'rejected'; createdAt: string };
export type MemoryEntry = { id: string; content: string; kind: 'preference' | 'fact'; scope: 'global' | 'workspace'; workspace: string; enabled: boolean; source: 'manual' | 'conversation'; sourceSessionId: string; createdAt: string; updatedAt: string; topic?: string; expiresAt?: string | null; conflictIds?: string[] };
export type MemoryDraft = Pick<MemoryEntry, 'content' | 'kind' | 'scope' | 'enabled'> & { id?: string; topic?: string; expiresAt?: string | null; resolveConflicts?: boolean };
export type McpService = { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; oauth?: boolean; enabled: boolean; hasCredentials: boolean; source: 'app' | 'project' };
export type McpServiceDraft = { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; enabled: boolean; env?: Record<string, string>; headers?: Record<string, string>; token?: string; oauth?: boolean; clearCredentials?: boolean };
export type McpRegistryEntry = { name: string; title: string; description: string; version: string; websiteUrl?: string; repositoryUrl?: string; options: { id: string; label: string; transport: 'http' | 'stdio' }[] };
export type McpRegistryResult = { source: string; query: string; terms: string[]; partial: boolean; servers: McpRegistryEntry[] };
export type McpRegistryPlan = { transport: 'http' | 'stdio'; label: string; summary: string; runtimeUrl?: string; fields: { id: string; label: string; description: string; required: boolean; secret: boolean; defaultValue: string; placeholder: string; choices?: string[] }[] };
export type McpTool = { name: string; description?: string; inputSchema: unknown };
export type JumpShortcut = { id: string; name: string; url: string; key: string; builtin: boolean };
export type AgentStatus = { id: string; name: string; phase: 'idle' | 'reviewing' | 'thinking' | 'reading' | 'writing' | 'command' | 'browsing' | 'tool' | 'replying'; detail: string };
export type ReviewMessage = { role: 'review'; id: string; originalPrompt: string; agent?: CustomAgent | null; reviewOnly?: boolean; contextFiles?: { id: string; name: string; text: string; truncated: boolean }[]; ready: boolean; gaps: string[]; question: string; recommendation: string; suggestedPrompt: string; decision?: 'original' | 'suggested' | 'edit' | 'reviewed'; effectivePrompt?: string };
export type Message = { role: 'user' | 'assistant'; content: string; mode?: 'plan' | 'ask' | 'steer' | 'approved' | 'workflow'; attachments?: { name: string; truncated: boolean }[] } | { role: 'tool'; name: string; state: string; args?: unknown; output?: string; callId: string } | ReviewMessage;
export type Session = { id: string; title: string; updatedAt: string; workspace: string; messages: Message[]; pendingReview?: string | null; pendingPlan?: { prompt: string; plan: string; agentId?: string | null } | null; pinned?: boolean; archived?: boolean };
export type SessionSummary = Pick<Session, 'id' | 'title' | 'updatedAt' | 'workspace' | 'pinned' | 'archived'> & { searchText?: string };
export type InputRequest = { requestId: string; server: string; message: string; sessionId: string; taskId: string; schema: { type: 'object'; required?: string[]; properties: Record<string, { type: string; title?: string; description?: string; default?: string | number | boolean; enum?: (string | number)[]; maxLength?: number; minimum?: number; maximum?: number }> } };
export type AgentEvent =
  | ({ type: 'input-request' } & InputRequest)
  | { type: 'input-request-closed'; requestId: string }
  | { type: 'runtime-task'; task: DurableTask }
  | { type: 'memory-notice'; message: string }
  | { type: 'message'; id: string; message: Message }
  | { type: 'message-complete'; id: string; message: Message }
  | { type: 'delta'; id: string; text: string }
  | { type: 'running'; id: string; running: boolean }
  | { type: 'error'; id: string; message: string }
  | { type: 'tool-update'; id: string; callId: string; state: string; output?: string }
  | { type: 'open-session'; id: string }
  | { type: 'review-decision'; id: string; reviewId: string; decision: 'original' | 'suggested'; effectivePrompt: string }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'agents'; agents: CustomAgent[] }
  | { type: 'shortcuts'; shortcuts: JumpShortcut[] }
  | { type: 'agent-status'; status: AgentStatus }
  | { type: 'approval-closed'; id: string }
  | { type: 'approval'; id: string; kind: 'app-open' | 'write' | 'edit' | 'command' | 'export' | 'mcp-start' | 'mcp-call' | 'email-draft' | 'email-send' | 'workflow-plan' | 'browser' | 'api-call'; detail: { taskId?: string; sessionId?: string; sandbox?: string; network?: boolean; path?: string; source?: string; preview?: string; oldText?: string; newText?: string; length?: number; command?: string; workspace?: string; verification?: boolean; script?: string; expectedOutput?: string; outputs?: string[]; server?: string; url?: string; args?: string[]; tool?: string; arguments?: Record<string, unknown>; app?: string; recipient?: string; subject?: string; body?: string } };

declare global {
  interface Window {
    zhuge: {
      initialize(): Promise<{ settings: Settings; providers: ModelProvider[]; sessions: SessionSummary[]; agents: CustomAgent[]; shortcuts: JumpShortcut[]; statuses: AgentStatus[]; runtimeWarnings: RuntimeWarning[] }>;
      answerInputRequest(id: string, action: 'accept' | 'decline' | 'cancel', values: Record<string, string | number | boolean>): Promise<boolean>;
      runtimeSettings(): Promise<{ models: EffectiveModel[]; providers: ModelProvider[]; workspace: string; verification: VerificationConfig | null; backups: { retainDays: number }; warnings: RuntimeWarning[]; agent: AgentConfig; sandbox: { available: boolean; backend: string | null; reason: string } }>;
      saveAgentConfig(draft: AgentConfig): Promise<AgentConfig>;
      runWorkflow(id: string, prompt: string, attachments?: string[], agentId?: string | null): Promise<boolean>;
      saveVerificationConfig(workspace: string, draft: VerificationConfig): Promise<VerificationConfig>;
      saveBackupPolicy(retainDays: number): Promise<{ retainDays: number }>;
      previewBackupCleanup(): Promise<BackupPreview>;
      applyBackupCleanup(id: string): Promise<{ tasks: number; blobs: number; bytes: number; errors: string[] }>;
      openRuntimeFolder(): Promise<boolean>;
      listTasks(sessionId: string): Promise<DurableTask[]>;
      getTask(id: string): Promise<DurableTask>;
      pauseTask(id: string): Promise<boolean>;
      resumeTask(id: string): Promise<boolean>;
      cancelTask(id: string): Promise<boolean>;
      taskCheckpoints(id: string): Promise<TaskCheckpoint[]>;
      checkpointDiff(id: string, checkpointId: string): Promise<string>;
      undoTask(id: string): Promise<string[]>;
      restoreTask(id: string): Promise<string[]>;
      exportTaskDiagnostics(id: string): Promise<string | null>;
      listExperiences(): Promise<ExperienceEntry[]>;
      decideExperience(id: string, status: 'approved' | 'rejected'): Promise<ExperienceEntry[]>;
      listMemories(): Promise<MemoryEntry[]>;
      saveMemory(draft: MemoryDraft): Promise<MemoryEntry[]>;
      deleteMemory(id: string): Promise<MemoryEntry[]>;
      listMcpServices(): Promise<McpService[]>;
      searchMcpRegistry(query: string): Promise<McpRegistryResult>;
      prepareMcpRegistry(name: string, version: string, optionId: string): Promise<McpRegistryPlan>;
      addMcpRegistry(name: string, version: string, optionId: string, values: Record<string, string>): Promise<{ services: McpService[]; addedName: string }>;
      saveMcpService(draft: McpServiceDraft): Promise<McpService[]>;
      deleteMcpService(name: string): Promise<McpService[]>;
      loginMcpService(name: string): Promise<boolean>;
      logoutMcpService(name: string): Promise<boolean>;
      testMcpService(name: string): Promise<McpTool[]>;
      selectWorkspace(): Promise<string | null>;
      createDefaultWorkspace(): Promise<string>;
      saveSettings(settings: { provider: Settings['provider']; model: string; baseUrl: string; apiKey: string; reviewProvider: Settings['reviewProvider']; reviewModel: string; reviewBaseUrl?: string; reviewApiKey: string; modelProfiles?: Settings['modelProfiles']; permissionMode: Settings['permissionMode']; webAccess: boolean; mcpEnabled: boolean; nativeToolsEnabled: boolean; commandTimeoutSeconds: Settings['commandTimeoutSeconds']; customInstructions: string; theme?: Settings['theme']; fontSize?: Settings['fontSize']; sendShortcut?: Settings['sendShortcut']; completionNotifications?: boolean; preventSleep?: boolean; memoryEnabled?: boolean; autoMemory?: boolean }): Promise<Settings>;
      createSession(): Promise<Session>;
      updateSession(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }): Promise<Session>;
      forkSession(id: string): Promise<Session>;
      exportSession(id: string): Promise<string | null>;
      switchWorkspace(workspace: string): Promise<Settings>;
      pickAttachments(): Promise<Attachment[]>;
      listWorkspaceFiles(path: string): Promise<DirectoryListing>;
      previewFile(path: string): Promise<FilePreview>;
      workspaceDiff(): Promise<{ status: string; working: string; staged: string }>;
      copyText(text: string): Promise<boolean>;
      loadSession(id: string): Promise<Session | null>;
      reviewPrompt(id: string, prompt: string, agentId?: string | null, attachments?: string[]): Promise<Session>;
      listSkills(): Promise<SkillSummary[]>;
      importSkillZip(): Promise<SkillSummary | null>;
      saveAgent(draft: Omit<CustomAgent, 'id'> & { id?: string }): Promise<CustomAgent[]>;
      deleteAgent(id: string): Promise<CustomAgent[]>;
      saveShortcut(draft: { id?: string; name: string; url: string; key: string }): Promise<JumpShortcut[]>;
      deleteShortcut(id: string): Promise<JumpShortcut[]>;
      openShortcut(id: string): Promise<boolean>;
      reviseReview(id: string, reviewId: string): Promise<Session>;
      completeReview(id: string, reviewId: string): Promise<Session>;
      sendReviewedPrompt(id: string, reviewId: string, choice: 'original' | 'suggested'): Promise<boolean>;
      runDirectPrompt(id: string, prompt: string, mode: 'plan' | 'ask', agentId?: string | null, attachments?: string[]): Promise<boolean>;
      executePlan(id: string): Promise<boolean>;
      dismissPlan(id: string): Promise<Session>;
      steerPrompt(id: string, prompt: string, expectedTaskId?: string, nodeId?: string): Promise<boolean>;
      stop(sessionId?: string): Promise<boolean>;
      answerApproval(id: string, approved: boolean): Promise<boolean>;
      onEvent(listener: (event: AgentEvent) => void): () => void;
    };
  }
}

export type Attachment = { id: string; name: string; chars: number; truncated: boolean };
export type DirectoryListing = { path: string; truncated: boolean; entries: { name: string; path: string; directory: boolean }[] };
export type FilePreview = { path: string; text: string; truncated: boolean };
export type TaskStatus = 'queued' | 'planning' | 'running' | 'waiting_approval' | 'paused' | 'verifying' | 'completed' | 'failed' | 'cancelled';
export type DurableTask = {
  id: string; sessionId: string; workspace: string; mode: string; model: string; provider: string; status: TaskStatus;
  createdAt: string; updatedAt: string; startedAt: string | null; completedAt: string | null; currentStep: string | null;
  interrupted: boolean; summary: string; error: { code: string; message: string } | null;
  parentId?: string; workflow?: { summary: string; nodes: { id: string; title: string; role: string; status: string; summary: string; taskId?: string; dependencies: string[]; outputs: string[] }[] };
  modelLedger?: ModelCall[]; workflowOutcome?: { peakWorkers: number; completed: number; total: number };
  checkpointsExpiredAt?: string | null;
  diagnostics: { modelCalls: number; toolCalls: number; retries: number; verificationAttempts: number; failures: number; cancelledReason: string | null; inputTokens?: number; outputTokens?: number };
  steps: { id: string; tool: string; inputSummary: string; status: string; startedAt: string; completedAt: string | null; durationMs: number | null;
    result: { ok: boolean; summary: string; exitCode?: number; changedFiles?: string[]; warnings?: string[]; error?: { code: string; message: string } } | null }[];
  events: { id: string; type: string; timestamp: string; payload: { attempt?: number; summary?: string; changedFiles?: string[]; reason?: string } }[];
  verification: { attempt: number; result: { ok: boolean; summary: string; warnings?: string[]; scope?: string; checks: { name: string; ok: boolean; error?: string; exitCode?: number; summary?: string }[] } }[];
};
export type RuntimeWarning = { id: string; file: string; message: string; kind?: 'invalid' | 'recovered' | 'projection-pending'; blocksCleanup?: boolean };
export type VerificationCommand = { id: string; name: string; command: string; args: string[]; cwd: string; timeoutSeconds: number; expectedOutput: string; outputs: string[] };
export type VerificationConfig = { mode: 'auto' | 'custom' | 'files'; commands: VerificationCommand[] };
export type BackupPreview = { id: string; expiresAt: string; retainDays: number; tasks: { id: string; status: string; completedAt: string; files: number }[]; bytes: number; blobs: number; protectedTasks: number };
export type TaskCheckpoint = { id: string; taskId: string; stepId: string; path: string; status: 'prepared' | 'applied' | 'restored' | 'unchanged'; timestamp: string; before: { exists: boolean; size: number; hash: string | null }; after: { exists: boolean; size: number; hash: string | null } | null };

export type ModelCapabilities = { contextWindow?: number; maxTokens?: number; reasoning?: boolean; tools?: boolean; vision?: boolean };
export type EffectiveModel = ModelCapabilities & { key: string; role: string; provider: string; model: string; source: string; metadataKnown: boolean };
export type AgentConfig = { workerProvider: 'same' | Settings['provider']; workerModel: string; workerBaseUrl: string; modelCapabilities: Record<string, ModelCapabilities>; maxPlanRevisions: number; schemaVersion: number; maxWorkers: number; maxCalls: number; maxTokens: number; maxCost: number | null; modelTimeoutSeconds: number; contextWindow: number; maxOutputTokens: number; prices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>; sandbox: boolean; network: boolean; allowedOrigins: string[]; apiEndpoints: { name: string; url: string; methods: string[] }[] };
export type ModelCall = { id: string; provider: string; model: string; stage: string; status: string; totalTokens?: number; reservedTokens: number; costUsd: number | null; estimatedCostUsd?: number; usageSource: string; budgetSource?: 'reservation'; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
