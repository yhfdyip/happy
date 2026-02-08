import { machineListModels, sessionListModels, SessionModelItem } from './ops';

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface DynamicModelOption {
    id: string;
    label: string;
    description?: string;
}

interface ModelCacheEntry {
    expiresAt: number;
    models: DynamicModelOption[];
}

const cacheByKey = new Map<string, ModelCacheEntry>();

const STATIC_FALLBACK_MODELS: DynamicModelOption[] = [
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex (Latest)' },
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'gpt-5-codex-high', label: 'GPT-5 Codex High (Alias)' },
    { id: 'gpt-5-codex-medium', label: 'GPT-5 Codex Medium (Alias)' },
    { id: 'gpt-5-codex-low', label: 'GPT-5 Codex Low (Alias)' },
    { id: 'gpt-5-minimal', label: 'GPT-5 Minimal (Alias)' },
    { id: 'gpt-5-low', label: 'GPT-5 Low (Alias)' },
    { id: 'gpt-5-medium', label: 'GPT-5 Medium (Alias)' },
    { id: 'gpt-5-high', label: 'GPT-5 High (Alias)' }
];

const LEGACY_CODEX_LABELS: Record<string, string> = {
    'gpt-5-codex-high': 'gpt-5-codex high',
    'gpt-5-codex-medium': 'gpt-5-codex medium',
    'gpt-5-codex-low': 'gpt-5-codex low',
    'gpt-5-minimal': 'GPT-5 Minimal',
    'gpt-5-low': 'GPT-5 Low',
    'gpt-5-medium': 'GPT-5 Medium',
    'gpt-5-high': 'GPT-5 High'
};

function normalizeModelLabel(item: SessionModelItem): string {
    if (item.displayName?.trim()) {
        return item.displayName;
    }
    if (item.model?.trim()) {
        return item.model;
    }
    return item.id;
}

function humanizeModelId(modelId: string): string {
    if (LEGACY_CODEX_LABELS[modelId]) {
        return LEGACY_CODEX_LABELS[modelId];
    }

    if (modelId.startsWith('gpt-') || modelId.startsWith('o') || modelId.startsWith('omni-')) {
        return modelId.toUpperCase().replace(/-CODEX\b/, ' Codex');
    }

    return modelId;
}

function toDynamicOptions(models: SessionModelItem[]): DynamicModelOption[] {
    const dedup = new Map<string, DynamicModelOption>();
    for (const model of models) {
        const id = model.model || model.id;
        if (!id) continue;
        if (dedup.has(id)) continue;

        dedup.set(id, {
            id,
            label: normalizeModelLabel(model),
            description: model.description || undefined
        });
    }

    const remote = Array.from(dedup.values())
        .filter((item) => item.id.startsWith('gpt-'))
        .map((item) => ({
            ...item,
            label: humanizeModelId(item.id)
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    if (remote.length === 0) {
        return STATIC_FALLBACK_MODELS;
    }

    const aliases = STATIC_FALLBACK_MODELS.filter((item) => item.id.includes('codex-') || item.id.includes('minimal') || item.id.endsWith('-low') || item.id.endsWith('-medium') || item.id.endsWith('-high'))
        .filter((alias) => !dedup.has(alias.id));

    return [...remote, ...aliases];
}

function getCached(cacheKey: string): DynamicModelOption[] | null {
    const entry = cacheByKey.get(cacheKey);
    if (!entry) {
        return null;
    }
    if (entry.expiresAt <= Date.now()) {
        cacheByKey.delete(cacheKey);
        return null;
    }
    return entry.models;
}

function setCache(cacheKey: string, models: DynamicModelOption[]) {
    cacheByKey.set(cacheKey, {
        models,
        expiresAt: Date.now() + CACHE_TTL_MS
    });
}

export async function fetchCodexModelsForSession(sessionId: string): Promise<DynamicModelOption[]> {
    const cacheKey = `session:${sessionId}`;
    const cached = getCached(cacheKey);
    if (cached) {
        return cached;
    }

    const response = await sessionListModels(sessionId, { provider: 'codex', limit: 200 });
    const models = response.success && response.data
        ? toDynamicOptions(response.data)
        : STATIC_FALLBACK_MODELS;

    setCache(cacheKey, models);
    return models;
}

export async function fetchCodexModelsForMachine(machineId: string): Promise<DynamicModelOption[]> {
    const cacheKey = `machine:${machineId}`;
    const cached = getCached(cacheKey);
    if (cached) {
        return cached;
    }

    const response = await machineListModels(machineId, { provider: 'codex', limit: 200 });
    const models = response.success && response.data
        ? toDynamicOptions(response.data)
        : STATIC_FALLBACK_MODELS;

    setCache(cacheKey, models);
    return models;
}

export function getStaticCodexFallbackModels(): DynamicModelOption[] {
    return STATIC_FALLBACK_MODELS;
}
