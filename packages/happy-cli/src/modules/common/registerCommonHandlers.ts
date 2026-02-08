import { logger } from '@/ui/logger';
import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { run as runRipgrep } from '@/modules/ripgrep/index';
import { run as runDifftastic } from '@/modules/difftastic/index';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { validatePath } from './pathSecurity';

const execAsync = promisify(exec);

interface BashRequest {
    command: string;
    cwd?: string;
    timeout?: number; // timeout in milliseconds
}

interface BashResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
}

interface ReadFileRequest {
    path: string;
}

interface ReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

interface WriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null; // null for new files, hash for existing files
}

interface WriteFileResponse {
    success: boolean;
    hash?: string; // hash of written file
    error?: string;
}

interface ListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number; // timestamp
}

interface ListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

interface GetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[]; // Only present for directories
}

interface GetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

interface RipgrepRequest {
    args: string[];
    cwd?: string;
}

interface RipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface DifftasticRequest {
    args: string[];
    cwd?: string;
}

interface DifftasticResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface ListModelsRequest {
    provider?: 'codex';
    limit?: number;
}

interface ModelListItem {
    id: string;
    model: string;
    displayName: string;
    description: string;
    isDefault: boolean;
}

interface ListModelsResponse {
    success: boolean;
    data?: ModelListItem[];
    source?: 'remote' | 'fallback';
    error?: string;
}

const CODEX_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

const CODEX_FALLBACK_MODELS: ModelListItem[] = [
    {
        id: 'gpt-5.3-codex',
        model: 'gpt-5.3-codex',
        displayName: 'GPT-5.3 Codex',
        description: 'Latest recommended coding model',
        isDefault: true
    },
    {
        id: 'gpt-5.2-codex',
        model: 'gpt-5.2-codex',
        displayName: 'GPT-5.2 Codex',
        description: 'Balanced coding model',
        isDefault: false
    },
    {
        id: 'gpt-5.2',
        model: 'gpt-5.2',
        displayName: 'GPT-5.2',
        description: 'General GPT-5.2 model',
        isDefault: false
    },
    {
        id: 'gpt-5-codex',
        model: 'gpt-5-codex',
        displayName: 'GPT-5 Codex',
        description: 'Legacy GPT-5 coding model',
        isDefault: false
    },
    {
        id: 'gpt-5',
        model: 'gpt-5',
        displayName: 'GPT-5',
        description: 'Legacy GPT-5 model',
        isDefault: false
    }
];

let cachedCodexModels: { expiresAt: number; data: ModelListItem[] } | null = null;

function toModelsEndpoint(baseUrl: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    if (!normalized) {
        return 'https://api.openai.com/v1/models';
    }
    if (normalized.endsWith('/models')) {
        return normalized;
    }
    if (/\/v\d+$/i.test(normalized)) {
        return `${normalized}/models`;
    }
    return `${normalized}/v1/models`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readCodexApiKey(): Promise<string | null> {
    const envKey = process.env.OPENAI_API_KEY?.trim();
    if (envKey) {
        return envKey;
    }

    const authPath = join(homedir(), '.codex', 'auth.json');
    try {
        const raw = await readFile(authPath, 'utf8');
        const parsed = JSON.parse(raw) as { OPENAI_API_KEY?: string };
        const fileKey = parsed.OPENAI_API_KEY?.trim();
        return fileKey || null;
    } catch {
        return null;
    }
}

async function readCodexBaseUrl(): Promise<string> {
    const configPath = join(homedir(), '.codex', 'config.toml');
    try {
        const raw = await readFile(configPath, 'utf8');
        const providerMatch = raw.match(/^\s*model_provider\s*=\s*["']([^"']+)["']\s*$/m);
        const providerId = providerMatch?.[1];
        if (!providerId) {
            return 'https://api.openai.com/v1';
        }

        const sectionPattern = new RegExp(`^\\s*\\[model_providers\\.${escapeRegExp(providerId)}\\]\\s*$`, 'm');
        const sectionMatch = sectionPattern.exec(raw);
        if (!sectionMatch) {
            return 'https://api.openai.com/v1';
        }

        const sectionStart = sectionMatch.index + sectionMatch[0].length;
        const afterSection = raw.slice(sectionStart);
        const nextSectionMatch = afterSection.match(/^\s*\[.*\]\s*$/m);
        const sectionBody = nextSectionMatch
            ? afterSection.slice(0, nextSectionMatch.index)
            : afterSection;

        const baseUrlMatch = sectionBody.match(/^\s*base_url\s*=\s*["']([^"']+)["']\s*$/m);
        return baseUrlMatch?.[1] || 'https://api.openai.com/v1';
    } catch {
        return 'https://api.openai.com/v1';
    }
}

async function fetchCodexModels(limit?: number): Promise<ModelListItem[]> {
    if (cachedCodexModels && cachedCodexModels.expiresAt > Date.now()) {
        return cachedCodexModels.data;
    }

    const apiKey = await readCodexApiKey();
    if (!apiKey) {
        throw new Error('Missing OpenAI API key in environment or ~/.codex/auth.json');
    }

    const baseUrl = await readCodexBaseUrl();
    const endpoint = toModelsEndpoint(baseUrl);
    const url = new URL(endpoint);
    if (limit && Number.isFinite(limit) && limit > 0) {
        url.searchParams.set('limit', String(Math.min(Math.floor(limit), 200)));
    }

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Failed to fetch models (${response.status}): ${detail.slice(0, 240)}`);
    }

    const payload = await response.json() as {
        data?: Array<{ id?: string; created?: number }>;
    };

    const models = (payload.data || [])
        .filter((item): item is { id: string; created?: number } => typeof item.id === 'string' && item.id.length > 0)
        .filter((item) => item.id.startsWith('gpt-'))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((item, index) => ({
            id: item.id,
            model: item.id,
            displayName: item.id,
            description: index === 0 ? 'Most recent model from provider' : 'Available provider model',
            isDefault: index === 0
        }));

    if (models.length === 0) {
        throw new Error('Provider returned no GPT models');
    }

    cachedCodexModels = {
        data: models,
        expiresAt: Date.now() + CODEX_MODELS_CACHE_TTL_MS
    };

    return models;
}

/*
 * Spawn Session Options and Result
 * This rpc type is used by the daemon, all other RPCs here are for sessions
*/

export interface SpawnSessionOptions {
    machineId?: string;
    directory: string;
    sessionId?: string;
    approvedNewDirectoryCreation?: boolean;
    agent?: 'claude' | 'codex' | 'gemini';
    token?: string;
    environmentVariables?: {
        // Anthropic Claude API configuration
        ANTHROPIC_BASE_URL?: string;        // Custom API endpoint (overrides default)
        ANTHROPIC_AUTH_TOKEN?: string;      // API authentication token
        ANTHROPIC_MODEL?: string;           // Model to use (e.g., claude-3-5-sonnet-20241022)

        // Tmux session management environment variables
        // Based on tmux(1) manual and common tmux usage patterns
        TMUX_SESSION_NAME?: string;         // Name for tmux session (creates/attaches to named session)
        TMUX_TMPDIR?: string;               // Temporary directory for tmux server socket files
        // Note: TMUX_TMPDIR is used by tmux to store socket files when default /tmp is not suitable
        // Common use case: When /tmp has limited space or different permissions
    };
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

/**
 * Register all RPC handlers with the session
 */
export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string) {

    // Shell command handler - executes commands in the default shell
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async (data) => {
        logger.debug('Shell command request:', data.command);

        // Validate cwd if provided
        // Special case: "/" means "use shell's default cwd" (used by CLI detection)
        // Security: Still validate all other paths to prevent directory traversal
        if (data.cwd && data.cwd !== '/') {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
        }

        try {
            // Build options with shell enabled by default
            // Note: ExecOptions doesn't support boolean for shell, but exec() uses the default shell when shell is undefined
            // If cwd is "/", use undefined to let shell use its default (respects user's PATH)
            const options: ExecOptions = {
                cwd: data.cwd === '/' ? undefined : data.cwd,
                timeout: data.timeout || 30000, // Default 30 seconds timeout
            };

            logger.debug('Shell command executing...', { cwd: options.cwd, timeout: options.timeout });
            const { stdout, stderr } = await execAsync(data.command, options);
            logger.debug('Shell command executed, processing result...');

            const result = {
                success: true,
                stdout: stdout ? stdout.toString() : '',
                stderr: stderr ? stderr.toString() : '',
                exitCode: 0
            };
            logger.debug('Shell command result:', {
                success: true,
                exitCode: 0,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        } catch (error) {
            const execError = error as NodeJS.ErrnoException & {
                stdout?: string;
                stderr?: string;
                code?: number | string;
                killed?: boolean;
            };

            // Check if the error was due to timeout
            if (execError.code === 'ETIMEDOUT' || execError.killed) {
                const result = {
                    success: false,
                    stdout: execError.stdout || '',
                    stderr: execError.stderr || '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: 'Command timed out'
                };
                logger.debug('Shell command timed out:', {
                    success: false,
                    exitCode: result.exitCode,
                    error: 'Command timed out'
                });
                return result;
            }

            // If exec fails, it includes stdout/stderr in the error
            const result = {
                success: false,
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
                exitCode: typeof execError.code === 'number' ? execError.code : 1,
                error: execError.message || 'Command failed'
            };
            logger.debug('Shell command failed:', {
                success: false,
                exitCode: result.exitCode,
                error: result.error,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        }
    });

    // Read file handler - returns base64 encoded content
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async (data) => {
        logger.debug('Read file request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            const buffer = await readFile(data.path);
            const content = buffer.toString('base64');
            return { success: true, content };
        } catch (error) {
            logger.debug('Failed to read file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
        }
    });

    // Write file handler - with hash verification
    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async (data) => {
        logger.debug('Write file request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            // If expectedHash is provided (not null), verify existing file
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(data.path);
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex');

                    if (existingHash !== data.expectedHash) {
                        return {
                            success: false,
                            error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`
                        };
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist but hash was provided
                    return {
                        success: false,
                        error: 'File does not exist but hash was provided'
                    };
                }
            } else {
                // expectedHash is null - expecting new file
                try {
                    await stat(data.path);
                    // File exists but we expected it to be new
                    return {
                        success: false,
                        error: 'File already exists but was expected to be new'
                    };
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist - this is expected
                }
            }

            // Write the file
            const buffer = Buffer.from(data.content, 'base64');
            await writeFile(data.path, buffer);

            // Calculate and return hash of written file
            const hash = createHash('sha256').update(buffer).digest('hex');

            return { success: true, hash };
        } catch (error) {
            logger.debug('Failed to write file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
        }
    });

    // List directory handler
    rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>('listDirectory', async (data) => {
        logger.debug('List directory request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            const entries = await readdir(data.path, { withFileTypes: true });

            const directoryEntries: DirectoryEntry[] = await Promise.all(
                entries.map(async (entry) => {
                    const fullPath = join(data.path, entry.name);
                    let type: 'file' | 'directory' | 'other' = 'other';
                    let size: number | undefined;
                    let modified: number | undefined;

                    if (entry.isDirectory()) {
                        type = 'directory';
                    } else if (entry.isFile()) {
                        type = 'file';
                    }

                    try {
                        const stats = await stat(fullPath);
                        size = stats.size;
                        modified = stats.mtime.getTime();
                    } catch (error) {
                        // Ignore stat errors for individual files
                        logger.debug(`Failed to stat ${fullPath}:`, error);
                    }

                    return {
                        name: entry.name,
                        type,
                        size,
                        modified
                    };
                })
            );

            // Sort entries: directories first, then files, alphabetically
            directoryEntries.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });

            return { success: true, entries: directoryEntries };
        } catch (error) {
            logger.debug('Failed to list directory:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
        }
    });

    // Get directory tree handler - recursive with depth control
    rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>('getDirectoryTree', async (data) => {
        logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        // Helper function to build tree recursively
        async function buildTree(path: string, name: string, currentDepth: number): Promise<TreeNode | null> {
            try {
                const stats = await stat(path);

                // Base node information
                const node: TreeNode = {
                    name,
                    path,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    modified: stats.mtime.getTime()
                };

                // If it's a directory and we haven't reached max depth, get children
                if (stats.isDirectory() && currentDepth < data.maxDepth) {
                    const entries = await readdir(path, { withFileTypes: true });
                    const children: TreeNode[] = [];

                    // Process entries in parallel, filtering out symlinks
                    await Promise.all(
                        entries.map(async (entry) => {
                            // Skip symbolic links completely
                            if (entry.isSymbolicLink()) {
                                logger.debug(`Skipping symlink: ${join(path, entry.name)}`);
                                return;
                            }

                            const childPath = join(path, entry.name);
                            const childNode = await buildTree(childPath, entry.name, currentDepth + 1);
                            if (childNode) {
                                children.push(childNode);
                            }
                        })
                    );

                    // Sort children: directories first, then files, alphabetically
                    children.sort((a, b) => {
                        if (a.type === 'directory' && b.type !== 'directory') return -1;
                        if (a.type !== 'directory' && b.type === 'directory') return 1;
                        return a.name.localeCompare(b.name);
                    });

                    node.children = children;
                }

                return node;
            } catch (error) {
                // Log error but continue traversal
                logger.debug(`Failed to process ${path}:`, error instanceof Error ? error.message : String(error));
                return null;
            }
        }

        try {
            // Validate maxDepth
            if (data.maxDepth < 0) {
                return { success: false, error: 'maxDepth must be non-negative' };
            }

            // Get the base name for the root node
            const baseName = data.path === '/' ? '/' : data.path.split('/').pop() || data.path;

            // Build the tree starting from the requested path
            const tree = await buildTree(data.path, baseName, 0);

            if (!tree) {
                return { success: false, error: 'Failed to access the specified path' };
            }

            return { success: true, tree };
        } catch (error) {
            logger.debug('Failed to get directory tree:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to get directory tree' };
        }
    });

    // Ripgrep handler - raw interface to ripgrep
    rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>('ripgrep', async (data) => {
        logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
        }

        try {
            const result = await runRipgrep(data.args, { cwd: data.cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run ripgrep:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run ripgrep'
            };
        }
    });

    // Difftastic handler - raw interface to difftastic
    rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>('difftastic', async (data) => {
        logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
        }

        try {
            const result = await runDifftastic(data.args, { cwd: data.cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run difftastic:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run difftastic'
            };
        }
    });

    // Dynamic model list handler (used by mobile/web app)
    rpcHandlerManager.registerHandler<ListModelsRequest, ListModelsResponse>('listModels', async (data) => {
        const provider = data?.provider || 'codex';
        if (provider !== 'codex') {
            return {
                success: false,
                error: `Unsupported provider: ${provider}`
            };
        }

        try {
            const models = await fetchCodexModels(data?.limit);
            return {
                success: true,
                data: models,
                source: 'remote'
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[listModels] Falling back to built-in model list:', message);

            return {
                success: true,
                data: CODEX_FALLBACK_MODELS,
                source: 'fallback',
                error: message
            };
        }
    });
}
